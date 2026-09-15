import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseUrl, assertProcessEnvironment, RuntimeGuardError } from "../src/runtime-guard";
import { corePool, anonymousPool } from "../src/processor";
import { operatorUrl, anonymousOperatorUrl, evaluateAlerts, type AlertInputs } from "../src/operations";
import {
  AlertDeduplicator,
  alertSinkFromEnvironment,
  sanitizeAlerts,
  WebhookSink,
  FileSink,
} from "../src/alert-delivery";
import {
  assertSupervisorEnvironment,
  childEnvironment,
  loadSchedule,
  nodeArguments,
  unitsOf,
  validateEnvironmentFiles,
  SupervisorError,
} from "../src/supervisor";
import { checkEnvironment, loadManifest } from "../src/preflight";
import { REHEARSAL_ACKNOWLEDGEMENT } from "../src/key-custody";

// ---------------------------------------------------------------------------
// Post-Audit Repair Pass 3: runtime safeguards that need no database.
//
// RG-*: the job, operator and migration entry points refuse a production
//       database URL without verified TLS BEFORE opening a connection, and
//       refuse a foreign credential, without relying on release preflight.
// CI-*: credential isolation of the supervisor and its children.
// AL-*: the alert adapter sends only codes and never leaves the machine unless
//       explicitly enabled (exercised here against a loopback server only).
// ---------------------------------------------------------------------------

const secret = () => randomBytes(12).toString("hex");
const url = (role: string, query = "") => `postgresql://${role}:${secret()}@db.internal.example:5432/orgfit${query}`;
const production = { NODE_ENV: "production" };

test("RG-1 databaseUrl refuses production URLs without verify-full and keeps nonproduction loopback working", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
      return "OK";
    } catch (e) {
      return e instanceof RuntimeGuardError ? e.code : String(e);
    }
  };
  // Production: only verify-full, with no verification override.
  assert.equal(code(() => databaseUrl(url("orgfit_processor"), "orgfit_processor", production)), "DATABASE_TLS_REQUIRED");
  for (const mode of ["disable", "allow", "prefer", "require", "verify-ca", "no-verify"])
    assert.equal(code(() => databaseUrl(url("orgfit_processor", `?sslmode=${mode}`), "orgfit_processor", production)), "DATABASE_TLS_REQUIRED", mode);
  assert.equal(code(() => databaseUrl(url("orgfit_processor", "?sslmode=verify-full"), "orgfit_processor", production)), "OK");
  assert.equal(
    code(() => databaseUrl(url("orgfit_processor", "?sslmode=verify-full"), "orgfit_processor", { ...production, NODE_TLS_REJECT_UNAUTHORIZED: "0" })),
    "DATABASE_TLS_REQUIRED",
  );
  assert.equal(code(() => databaseUrl(url("orgfit_processor", "?sslmode=verify-full&ssl=false"), "orgfit_processor", production)), "DATABASE_TLS_REQUIRED");
  // Identity and password, in every mode.
  assert.equal(code(() => databaseUrl(url("orgfit_staff", "?sslmode=verify-full"), "orgfit_processor", production)), "DATABASE_ROLE_MISMATCH");
  assert.equal(code(() => databaseUrl("postgresql://orgfit_processor@127.0.0.1/orgfit", "orgfit_processor", {})), "DATABASE_PASSWORD_MISSING");
  assert.equal(code(() => databaseUrl("postgresql://orgfit_processor:CHANGE_ME@127.0.0.1/orgfit", "orgfit_processor", {})), "DATABASE_PASSWORD_MISSING");
  assert.equal(code(() => databaseUrl("mysql://orgfit_processor:x@127.0.0.1/orgfit", "orgfit_processor", {})), "DATABASE_URL_INVALID");
  assert.equal(code(() => databaseUrl(undefined, "orgfit_processor", {})), "DATABASE_URL_MISSING");
  // Nonproduction loopback without TLS stays supported for local clusters.
  assert.equal(code(() => databaseUrl(`postgresql://orgfit_migrator:${secret()}@127.0.0.1:55432/orgfit`, "orgfit_migrator", { NODE_ENV: "development" })), "OK");
  // No value in the error.
  try {
    databaseUrl(url("orgfit_processor"), "orgfit_processor", production);
  } catch (e) {
    assert.doesNotMatch(String((e as Error).message), /postgres|internal|:\/\//);
  }
});

test("RG-2 the processor and operator helpers apply the guard before a pool or client exists", () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    assert.throws(() => corePool(url("orgfit_processor", "?sslmode=require")), /DATABASE_TLS_REQUIRED/);
    assert.throws(() => anonymousPool(url("orgfit_processor")), /DATABASE_TLS_REQUIRED/);
    assert.throws(() => operatorUrl(url("orgfit_migrator", "?sslmode=prefer")), /DATABASE_TLS_REQUIRED/);
    assert.throws(() => anonymousOperatorUrl(url("orgfit_anon_migrator")), /DATABASE_TLS_REQUIRED/);
    assert.equal(operatorUrl(url("orgfit_migrator", "?sslmode=verify-full")).includes("verify-full"), true);
  } finally {
    env.NODE_ENV = previous;
  }
});

// A TCP listener standing in for PostgreSQL. A refused entry point must not
// even connect to it: the guard runs before the driver.
async function listener() {
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { port, connections: () => connections, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ambient = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };

function runAsync(script: string, args: string[], env: Record<string, string | undefined>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
  });
}

// Two unverified variants: a weaker sslmode, and verify-full with Node's global
// verification override (pg honours it; see src/runtime-guard.ts). The second
// variant caught the renderer and scanner pools, which checked sslmode only.
for (const variant of [
  { label: "sslmode=require", query: "?sslmode=require", env: {} as Record<string, string> },
  { label: "verify-full with NODE_TLS_REJECT_UNAUTHORIZED=0", query: "?sslmode=verify-full", env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
]) {
test(`RG-3 every job, operator and migration entry point refuses a production unverified URL without connecting (${variant.label})`, async () => {
  const db = await listener();
  const at = (role: string, name = "orgfit") => `postgresql://${role}:${secret()}@127.0.0.1:${db.port}/${name}${variant.query}`;
  const ledger = await mkdtemp(join(tmpdir(), "orgfit-rg3-"));
  const cases: [string, string[], Record<string, string>][] = [
    ["scripts/migrate.ts", [], { MIGRATION_DATABASE_URL: at("orgfit_migrator") }],
    ["scripts/migrate-anonymous.ts", [], { ANONYMOUS_MIGRATION_DATABASE_URL: at("orgfit_anon_migrator", "orgfit_anonymous") }],
    ["scripts/close-campaigns.ts", [], { MIGRATION_DATABASE_URL: at("orgfit_migrator") }],
    ["scripts/expire-drafts.ts", [], { MIGRATION_DATABASE_URL: at("orgfit_migrator") }],
    ["scripts/retention.ts", [], { MIGRATION_DATABASE_URL: at("orgfit_migrator"), ANONYMOUS_MIGRATION_DATABASE_URL: at("orgfit_anon_migrator", "orgfit_anonymous") }],
    ["scripts/ship-tombstones.ts", [], { MIGRATION_DATABASE_URL: at("orgfit_migrator"), TOMBSTONE_LEDGER_DIRECTORY: ledger }],
    ["scripts/ops-check.ts", [], { MIGRATION_DATABASE_URL: at("orgfit_migrator") }],
    ["scripts/restore-reapply.ts", ["--mark"], { MIGRATION_DATABASE_URL: at("orgfit_migrator"), TOMBSTONE_LEDGER_DIRECTORY: ledger }],
    // Pass 4: a custody provider and a scan engine are configured so that the refusal below is still the TLS guard, not the newer custody or engine guard that runs first.
    ["scripts/process-campaigns.ts", [], { PROCESSOR_DATABASE_URL: at("orgfit_processor"), ANONYMOUS_DATABASE_URL: at("orgfit_processor", "orgfit_anonymous"), CAMPAIGN_KEY_CUSTODY_SECRET_KEY: randomBytes(32).toString("base64"), CAMPAIGN_KEY_CUSTODY_PROVIDER: "development-file", CAMPAIGN_KEY_CUSTODY_REHEARSAL_ONLY: REHEARSAL_ACKNOWLEDGEMENT }],
    ["scripts/publish-campaigns.ts", [], { PROCESSOR_DATABASE_URL: at("orgfit_processor"), ANONYMOUS_DATABASE_URL: at("orgfit_processor", "orgfit_anonymous") }],
    ["scripts/generate-reports.ts", [], { REPORT_DATABASE_URL: at("orgfit_report"), REPORT_ENCRYPTION_KEY: "c".repeat(64) }],
    ["scripts/scan-attachments.ts", [], { SCANNER_DATABASE_URL: at("orgfit_scanner"), ATTACHMENT_ENCRYPTION_KEY: "e".repeat(64), ATTACHMENT_SCAN_ENGINE: "clamd", ATTACHMENT_SCAN_CLAMD_ADDRESS: `tcp://127.0.0.1:${db.port}` }],
    ["scripts/revoke-release.ts", ["--organization", "00000000-0000-4000-8000-000000000001", "--campaign", "00000000-0000-4000-8000-000000000002", "--approver", "a@example.invalid", "--reason-code", "PRIVACY_INCIDENT", "--reason", "synthetic test reason", "--incident", "RG-3", "--confirm", "abcdef01"], { MIGRATION_DATABASE_URL: at("orgfit_migrator") }],
  ];
  try {
    for (const [script, args, env] of cases) {
      // Asynchronous on purpose: spawnSync blocks this process's event loop, so
      // the listener above could never count a connection and the assertion
      // below could not fail (found in the Pass 3 verification).
      const run = await runAsync(script, args, { ...ambient, NODE_ENV: "production", ...variant.env, ...env });
      assert.equal(run.status, 1, `${script} exits 1: ${run.stdout}${run.stderr}`);
      const output = run.stdout + run.stderr;
      // The engine NAME is printed on purpose ("Scan engine: clamd."); it is a
      // choice, not a secret. Every other configured value must stay unprinted.
      for (const [key, value] of Object.entries(env)) if (key !== "ATTACHMENT_SCAN_ENGINE") assert.ok(!output.includes(value), `${script} printed a configured value`);
      assert.equal(db.connections(), 0, `${script} opened no connection`);
      assert.doesNotMatch(output, /SCAN_ENGINE_|KEY_CUSTODY_/, `${script} was refused by the TLS guard, not an earlier guard`);
    }
  } finally {
    await db.close();
  }
});
}

test("RG-6 release preflight fails a production environment that disables certificate verification", () => {
  const manifest = loadManifest();
  const env = { NODE_ENV: "production", REPORT_DATABASE_URL: url("orgfit_report", "?sslmode=verify-full"), REPORT_ENCRYPTION_KEY: "c".repeat(64), REPORT_S3_BUCKET: "reports" };
  const tls = (extra: Record<string, string>) =>
    checkEnvironment("report", { ...env, ...extra }, { production: true, manifest }).find((f) => f.check === "tls-verification");
  assert.equal(tls({ NODE_TLS_REJECT_UNAUTHORIZED: "0" })?.outcome, "FAIL");
  assert.equal(tls({}), undefined);
  // Nonproduction keeps loopback testing unaffected.
  assert.equal(
    checkEnvironment("report", { ...env, NODE_ENV: "development", NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { production: false, manifest }).some((f) => f.check === "tls-verification"),
    false,
  );
});

test("RG-4 job entry points refuse a foreign credential by name, never by value", () => {
  const manifest = loadManifest();
  const processor = { NODE_ENV: "test", PROCESSOR_DATABASE_URL: url("orgfit_processor"), REPORT_ENCRYPTION_KEY: "c".repeat(64) };
  assert.throws(() => assertProcessEnvironment("processor", processor, manifest.processes), /FOREIGN_CREDENTIAL:REPORT_ENCRYPTION_KEY/);
  assert.throws(() => assertProcessEnvironment("operator", { DATABASE_URL: url("orgfit_staff") }, manifest.processes), /FOREIGN_CREDENTIAL:DATABASE_URL/);
  assert.doesNotThrow(() => assertProcessEnvironment("report", { REPORT_DATABASE_URL: url("orgfit_report") }, manifest.processes));
  const leaked = "d".repeat(64);
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/publish-campaigns.ts"], {
    env: { ...ambient, NODE_ENV: "test", PROCESSOR_DATABASE_URL: url("orgfit_processor"), ANONYMOUS_DATABASE_URL: url("orgfit_processor"), ATTACHMENT_ENCRYPTION_KEY: leaked },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /FOREIGN_CREDENTIAL:ATTACHMENT_ENCRYPTION_KEY/);
  assert.ok(!(run.stdout + run.stderr).includes(leaked));
});

// ---- credential isolation -------------------------------------------------------

async function envDir(files: Record<string, Record<string, string>>) {
  const dir = await mkdtemp(join(tmpdir(), "orgfit-ci-"));
  for (const [name, env] of Object.entries(files))
    await writeFile(join(dir, `${name}.env`), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  return dir;
}
const hex = () => randomBytes(32).toString("hex");
function localEnvironments(ledger: string) {
  const loop = (role: string, name = "orgfit") => `postgresql://${role}:${secret()}@127.0.0.1:55432/${name}`;
  return {
    processor: { NODE_ENV: "development", PROCESSOR_DATABASE_URL: loop("orgfit_processor"), ANONYMOUS_DATABASE_URL: loop("orgfit_processor", "orgfit_anonymous"), CAMPAIGN_KEY_CUSTODY_SECRET_KEY: randomBytes(32).toString("base64"), CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY: randomBytes(32).toString("base64"), CAMPAIGN_KEY_CUSTODY_DIRECTORY: ledger },
    report: { NODE_ENV: "development", REPORT_DATABASE_URL: loop("orgfit_report"), REPORT_ENCRYPTION_KEY: hex(), REPORT_LOCAL_DIRECTORY: ledger },
    scanner: { NODE_ENV: "development", SCANNER_DATABASE_URL: loop("orgfit_scanner"), ATTACHMENT_ENCRYPTION_KEY: hex(), ATTACHMENT_LOCAL_DIRECTORY: ledger },
    operator: { NODE_ENV: "development", MIGRATION_DATABASE_URL: loop("orgfit_migrator"), ANONYMOUS_MIGRATION_DATABASE_URL: loop("orgfit_anon_migrator", "orgfit_anonymous"), TOMBSTONE_LEDGER_DIRECTORY: ledger },
  };
}

test("CI-1 the supervisor holds no credential, validates each process file separately and gives a child only its own file", async () => {
  const { schedule, supervisor, manifest } = loadSchedule();
  // The supervisor's own environment.
  assert.throws(() => assertSupervisorEnvironment({ DATABASE_URL: url("orgfit_staff") }, supervisor), (e: SupervisorError) => e.code === "SUPERVISOR_HOLDS_CREDENTIAL" && e.details.includes("DATABASE_URL"));
  for (const key of ["PROCESSOR_DATABASE_URL", "REPORT_ENCRYPTION_KEY", "CAMPAIGN_KEY_CUSTODY_SECRET_KEY", "INVITATION_DIGEST_KEY", "OIDC_CLIENT_SECRET", "MIGRATION_DATABASE_URL"])
    assert.throws(() => assertSupervisorEnvironment({ [key]: "x" }, supervisor), SupervisorError, key);
  assert.doesNotThrow(() => assertSupervisorEnvironment({ PATH: "x", ALERT_SINK: "file", ALERT_FILE: "a.jsonl" }, supervisor));

  // Every scheduled job belongs to a manifest process and a group keeps order.
  const units = unitsOf(schedule);
  assert.deepEqual(units[0].jobs.map((j) => j.name), ["campaigns:normalize", "privacy:process", "publication:release"]);
  for (const unit of units) for (const job of unit.jobs) assert.ok(manifest.processes[job.process], job.name);

  const ledger = await mkdtemp(join(tmpdir(), "orgfit-ci-ledger-"));
  const good = localEnvironments(ledger);
  const dir = await envDir(good);
  const validated = validateEnvironmentFiles(dir, ["processor", "report", "scanner", "operator"], manifest);
  assert.equal(validated.production, false);

  // A file holding another process's credential is refused, by name only.
  const bad = await envDir({ ...good, report: { ...good.report, PROCESSOR_DATABASE_URL: good.processor.PROCESSOR_DATABASE_URL } });
  try {
    validateEnvironmentFiles(bad, ["processor", "report", "scanner", "operator"], manifest);
    assert.fail("mixed report environment accepted");
  } catch (e) {
    assert.ok(e instanceof SupervisorError && e.code === "ENVIRONMENT_INVALID");
    assert.ok(e.details.some((d) => d.startsWith("report: forbidden")));
    assert.ok(!e.details.join(" ").includes(good.processor.PROCESSOR_DATABASE_URL));
  }
  // A missing file is refused rather than skipped.
  const partial = await envDir({ processor: good.processor });
  assert.throws(() => validateEnvironmentFiles(partial, ["processor", "report"], manifest), SupervisorError);

  // The child environment: ambient names plus the job name, nothing else; the
  // values arrive through --env-file from that process's own file.
  const child = childEnvironment(units[0].jobs[1], { PATH: "p", SystemRoot: "s", DATABASE_URL: "must-not-pass", ALERT_WEBHOOK_TOKEN: "must-not-pass" });
  assert.deepEqual(Object.keys(child).sort(), ["ORGFIT_SUPERVISED_JOB", "PATH", "SystemRoot"]);
  assert.deepEqual(nodeArguments(units[0].jobs[1], join(dir, "processor.env")), [`--env-file=${join(dir, "processor.env")}`, "--import", "tsx", "scripts/process-campaigns.ts"]);
});

test("CI-2 a child started the supervisor's way sees only its own file's variables", async () => {
  const ledger = await mkdtemp(join(tmpdir(), "orgfit-ci2-"));
  const envs = localEnvironments(ledger);
  const dir = await envDir(envs);
  const probe = join(ledger, "probe.ts");
  const out = join(ledger, "keys.json");
  await writeFile(probe, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(process.env).sort()));\n`);
  const job = { name: "reports:generate", process: "report", script: probe, everySeconds: 60, timeoutSeconds: 60 };
  const run = spawnSync(process.execPath, nodeArguments(job, join(dir, "report.env")), {
    env: childEnvironment(job, { ...process.env, PROCESSOR_DATABASE_URL: envs.processor.PROCESSOR_DATABASE_URL }) as NodeJS.ProcessEnv,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  const keys = JSON.parse(await readFile(out, "utf8")) as string[];
  for (const k of Object.keys(envs.report)) assert.ok(keys.includes(k), `own ${k}`);
  for (const other of ["processor", "scanner", "operator"] as const)
    for (const k of Object.keys(envs[other])) if (!(k in envs.report)) assert.ok(!keys.includes(k), `foreign ${k} reached the report job`);
});

// ---- alerts --------------------------------------------------------------------------

test("AL-1 alerts are sanitized, deduplicated, and job health is evaluated", () => {
  const cleaned = sanitizeAlerts([
    { code: "JOB_STALE", severity: "critical", value: "privacy:process" },
    { code: "REPORT_QUEUE_BACKLOG", severity: "warning", value: 1200 },
    { code: "lower", severity: "critical", value: 1 },
    { code: "X_OK", severity: "info", value: 1 },
    { code: "LEAK", severity: "warning", value: "postgresql://user:pass@host/db" },
  ]);
  assert.deepEqual(cleaned.map((a) => a.code), ["JOB_STALE", "REPORT_QUEUE_BACKLOG", "LEAK"]);
  assert.equal(cleaned[2].value, "", "a value that is not a code, job name or number is dropped");

  const d = new AlertDeduplicator(1000);
  const a = [{ code: "JOB_STALE", severity: "critical" as const, value: "privacy:process" }];
  assert.equal(d.shouldSend([], 0), false, "nothing to say at start");
  assert.equal(d.shouldSend(a, 10), true);
  assert.equal(d.shouldSend(a, 20), false, "unchanged critical not repeated early");
  assert.equal(d.shouldSend(a, 1100), true, "unchanged critical repeated after the interval");
  assert.equal(d.shouldSend([], 1200), true, "resolution is sent");

  const healthy: AlertInputs = {
    restoreState: "NORMAL", countMismatch: 0, blockedReleases: 0, closedUnprocessedOverdue: 0, insufficientIntakeOverdue: 0,
    reportQueueOldestSeconds: 0, reportFailedLastDay: 0, attachmentQuarantineOldestSeconds: 0, rateLimitedLastWindow: 0,
    lastRetentionRun: new Date().toISOString(), unapprovedRetentionClasses: 0,
  };
  const host = { backupAgeHours: 1, freeDiskFraction: 0.5 };
  const job = (job: string, process: string, health: "OK" | "FAILING" | "STALE" | "NEVER_RUN", consecutiveFailures = 0) =>
    ({ job, process, health, consecutiveFailures, expectedIntervalSeconds: 60, lastSuccessAt: null, lastFailureAt: null, lastFailureCode: null });
  assert.deepEqual(evaluateAlerts({ ...healthy, jobs: [job("reports:generate", "report", "OK")] }, host), []);
  const alerts = evaluateAlerts(
    {
      ...healthy,
      jobs: [
        job("privacy:process", "processor", "STALE"),
        job("reports:generate", "report", "STALE"),
        job("publication:release", "processor", "FAILING", 3),
        job("attachments:scan", "scanner", "FAILING", 1),
        job("drafts:expire", "operator", "NEVER_RUN"),
        job("ops:check", "operator", "STALE"),
      ],
    },
    host,
  );
  assert.deepEqual(
    alerts.map((x) => `${x.severity}:${x.code}:${x.value}`),
    [
      "critical:JOB_STALE:privacy:process",
      "warning:JOB_STALE:reports:generate",
      "critical:JOB_FAILING:publication:release",
      "warning:JOB_FAILING:attachments:scan",
      "warning:JOB_NEVER_RUN:drafts:expire",
    ],
  );
});

test("AL-2 the webhook sink is off unless enabled, https-only in production, and was exercised on loopback only", async () => {
  assert.equal(alertSinkFromEnvironment({}).kind, "none");
  assert.throws(() => alertSinkFromEnvironment({ ALERT_SINK: "webhook", ALERT_WEBHOOK_URL: "https://alerts.example.invalid/hook" }), /ALERT_DELIVERY_NOT_ENABLED/);
  assert.throws(() => alertSinkFromEnvironment({ ALERT_SINK: "webhook", ALERT_DELIVERY_ENABLED: "true", NODE_ENV: "production", ALERT_WEBHOOK_URL: "http://127.0.0.1:9/hook" }), /ALERT_WEBHOOK_URL_INVALID/);
  assert.throws(() => alertSinkFromEnvironment({ ALERT_SINK: "webhook", ALERT_DELIVERY_ENABLED: "true", ALERT_WEBHOOK_URL: "http://alerts.example.invalid/hook" }), /ALERT_WEBHOOK_URL_INVALID/);
  assert.throws(() => alertSinkFromEnvironment({ ALERT_SINK: "file" }), /ALERT_FILE_REQUIRED/);
  assert.throws(() => alertSinkFromEnvironment({ ALERT_SINK: "pager" }), /ALERT_SINK_UNKNOWN/);

  const received: { auth: string | undefined; body: string }[] = [];
  let failNext = 1;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (failNext-- > 0) {
        res.statusCode = 503;
        res.end();
        return;
      }
      received.push({ auth: req.headers.authorization, body });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const token = secret();
    const sink = alertSinkFromEnvironment({ ALERT_SINK: "webhook", ALERT_DELIVERY_ENABLED: "true", NODE_ENV: "test", ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/hook`, ALERT_WEBHOOK_TOKEN: token });
    assert.ok(sink instanceof WebhookSink);
    await sink.deliver({ source: "ops:check", environment: "test", at: new Date().toISOString(), alerts: [{ code: "JOB_STALE", severity: "critical", value: "privacy:process" }] });
    assert.equal(received.length, 1, "one 503, then delivered on retry");
    assert.equal(received[0].auth, `Bearer ${token}`);
    assert.deepEqual(Object.keys(JSON.parse(received[0].body)).sort(), ["alerts", "at", "environment", "source"]);
    // An unreachable destination fails with a code, not a URL.
    const dead = new WebhookSink(`http://127.0.0.1:${port + 1}/hook`, token, 300);
    await assert.rejects(dead.deliver({ source: "supervisor", environment: "test", at: "", alerts: [] }), (e: Error) => /^ALERT_WEBHOOK_/.test(e.message) && !e.message.includes("127.0.0.1"));
  } finally {
    server.close();
  }
  const file = join(await mkdtemp(join(tmpdir(), "orgfit-al2-")), "alerts.jsonl");
  await new FileSink(file).deliver({ source: "supervisor", environment: "test", at: "t", alerts: [] });
  assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 1);
});

test("RG-5 the browser harness creates its scratch directories before writing (CG-003)", async () => {
  const source = await readFile("tests/serve.ts", "utf8");
  const mkdirAt = source.indexOf("await mkdir(resolve(SCRATCH");
  const fixtureAt = source.indexOf("e2e-fixture.json");
  const setupAt = source.indexOf("await setupDatabase()");
  assert.ok(mkdirAt > 0 && mkdirAt < setupAt && mkdirAt < fixtureAt, "scratch directories are created before the database fixture and the fixture file");
  // The real behaviour is proven by a clean-clone browser start (phase-status.md).
  void spawn;
});
