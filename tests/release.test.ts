import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { checkEnvironment, compareLedger, loadManifest, migrationDigests, parseEnvFile } from "../src/preflight";
import { readiness } from "../src/db";
import { exchange, instrument, finalize } from "../src/respondent";
import { processCampaign } from "../src/processor";
import { markRestorePending, reapplyTombstones, storeInconsistencies } from "../src/operations";
import { respondentFixture } from "./respondent-fixture";
import type { Instrument } from "../src/instrument-input";

// Phase 15 release suite: the process manifest and preflight, migration
// immutability against previous gate-passed commits, and cross-store
// reconciliation after a restore. The populated upgrade from the previous
// release lives in tests/release-upgrade.test.ts (its own process, because the
// staff pool is per process); the physical rollback/restore drill is
// tests/ops/rollback-drill.ts and the production-build rehearsal is
// tests/release/rehearsal.ts.

const hex = () => randomBytes(32).toString("hex");
const db = (role: string, name = "orgfit") =>
  `postgresql://${role}:${randomBytes(12).toString("hex")}@db.internal.example:5432/${name}?sslmode=verify-full`;

function productionEnv(process: string): Record<string, string> {
  const manifest = loadManifest();
  const spec = manifest.processes[process];
  const env: Record<string, string> = { NODE_ENV: "production" };
  for (const key of spec.required) {
    if (key === "NODE_ENV") continue;
    if (manifest.databaseUrls[key]) env[key] = db(manifest.databaseUrls[key], key.startsWith("ANONYMOUS") ? "orgfit_anonymous" : "orgfit");
    else if (manifest.keys.hex64.includes(key)) env[key] = hex();
    else env[key] = "value-" + key.toLowerCase();
  }
  Object.assign(env, {
    ...(env.STAFF_ORIGIN ? { STAFF_ORIGIN: "https://staff.orgfit.example" } : {}),
    ...(env.RESPONDENT_ORIGIN ? { RESPONDENT_ORIGIN: "https://survey.orgfit.example" } : {}),
    ...(env.OIDC_ISSUER ? { OIDC_ISSUER: "https://id.orgfit.example" } : {}),
    ...(env.CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY ? { CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY: randomBytes(32).toString("base64") } : {}),
  });
  for (const kind of spec.storage ?? []) env[manifest.storage[kind][0]] = `private-${kind.toLowerCase().replace(/_/g, "-")}`;
  for (const key of spec.recommended ?? []) env[key] = "x-forwarded-for";
  if (process === "operator") env.BACKUP_DIRECTORY = env.OPS_DISK_PATH = "/var/backups/orgfit";
  // Post-Audit Repair Pass 4: a maintained engine adapter for the scanner and an
  // Object Lock retention for the operator's tombstone bucket.
  if (process === "scanner") Object.assign(env, { ATTACHMENT_SCAN_ENGINE: "clamd", ATTACHMENT_SCAN_CLAMD_ADDRESS: "unix:/run/clamav/clamd.sock" });
  if (process === "operator") env.TOMBSTONE_LEDGER_OBJECT_LOCK_DAYS = "36";
  return env;
}
const failures = (findings: { outcome: string; check: string }[]) =>
  findings.filter((f) => f.outcome === "FAIL").map((f) => f.check);

test("R-1 the process manifest describes a complete, separated deployment and preflight refuses every unsafe environment", () => {
  const manifest = loadManifest();
  assert.deepEqual(Object.keys(manifest.processes).sort(), ["operator", "processor", "report", "respondent", "scanner", "staff"]);

  // A well-formed production environment passes for every process — except
  // key custody. Changed deliberately in Post-Audit Repair Pass 4 (D-158): no
  // managed custody provider is integrated (P-003), so the staff and processor
  // environments FAIL "key-custody" until one is, and no deployment passes
  // preflight on the development stand-in.
  for (const name of Object.keys(manifest.processes)) {
    const findings = checkEnvironment(name, productionEnv(name), { production: true, manifest });
    const expected = ["staff", "processor"].includes(name) ? ["key-custody"] : [];
    assert.deepEqual(failures(findings), expected, `${name}: ${JSON.stringify(findings.filter((f) => f.outcome === "FAIL"))}`);
  }

  // Trust boundaries: a web process holding another process's credential.
  const boundary: [string, string][] = [
    ["staff", "GATEWAY_DATABASE_URL"],
    ["staff", "CAMPAIGN_KEY_CUSTODY_SECRET_KEY"],
    ["staff", "REPORT_DATABASE_URL"],
    ["respondent", "DATABASE_URL"],
    ["respondent", "REPORT_ENCRYPTION_KEY"],
    ["processor", "INVITATION_DIGEST_KEY"],
    ["report", "PARTICIPATION_EXPORT_ENCRYPTION_KEY"],
    ["scanner", "PROCESSOR_DATABASE_URL"],
    ["operator", "CAMPAIGN_KEY_CUSTODY_SECRET_KEY"],
  ];
  for (const [name, key] of boundary) {
    const env = { ...productionEnv(name), [key]: manifest.databaseUrls[key] ? db(manifest.databaseUrls[key]) : hex() };
    assert.ok(failures(checkEnvironment(name, env, { production: true, manifest })).includes("forbidden"), `${name} + ${key}`);
  }

  // Each unsafe production setting is its own failure.
  const staff = productionEnv("staff");
  const cases: [string, Record<string, string | undefined>, string][] = [
    ["missing key", { ATTACHMENT_ENCRYPTION_KEY: undefined }, "required"],
    ["placeholder", { OIDC_CLIENT_SECRET: "CHANGE_ME" }, "placeholders"],
    ["reused key", { REPORT_ENCRYPTION_KEY: staff.ATTACHMENT_ENCRYPTION_KEY }, "key-separation"],
    ["short key", { IMPORT_ENCRYPTION_KEY: "abc" }, "key-format"],
    ["no TLS to the database", { DATABASE_URL: staff.DATABASE_URL.replace("verify-full", "require") }, "db:DATABASE_URL"],
    ["wrong database identity", { AUTH_DATABASE_URL: db("orgfit_staff") }, "db:AUTH_DATABASE_URL"],
    ["http origin", { STAFF_ORIGIN: "http://staff.orgfit.example" }, "origin:STAFF_ORIGIN"],
    ["same host", { RESPONDENT_ORIGIN: "https://staff.orgfit.example" }, "origin-separation"],
    ["http issuer", { OIDC_ISSUER: "http://id.orgfit.example" }, "oidc-issuer"],
    ["local storage", { REPORT_S3_BUCKET: undefined, REPORT_LOCAL_DIRECTORY: "/tmp/reports" }, "storage:REPORT"],
    ["development node env", { NODE_ENV: "development" }, "node-env"],
  ];
  for (const [label, change, check] of cases) {
    const env = { ...staff, ...change };
    for (const [k, v] of Object.entries(change)) if (v === undefined) delete env[k];
    assert.ok(failures(checkEnvironment("staff", env, { production: true, manifest })).includes(check), label);
  }
  // The respondent without a trusted proxy header is warned, not silently accepted (SEC-M2).
  const respondent = productionEnv("respondent");
  delete respondent.RATE_LIMIT_CLIENT_IP_HEADER;
  const warned = checkEnvironment("respondent", respondent, { production: true, manifest });
  assert.ok(warned.some((f) => f.check === "recommended" && f.outcome === "WARN" && f.detail.includes("RATE_LIMIT_CLIENT_IP_HEADER")));
  // …and, since Pass 4, refused in production: the operator must name the header or say `none`.
  assert.ok(warned.some((f) => f.check === "trusted-proxy" && f.outcome === "FAIL"));
  // Development mode accepts local storage and http loopback origins.
  const dev = { ...staff, NODE_ENV: "development", STAFF_ORIGIN: "http://127.0.0.1:3000", RESPONDENT_ORIGIN: "http://localhost:3001", REPORT_S3_BUCKET: "", REPORT_LOCAL_DIRECTORY: "/tmp/r" };
  assert.deepEqual(failures(checkEnvironment("staff", dev, { production: false, manifest })), []);

  // The migration ledger comparison refuses a pending, an altered and — for a
  // code rollback onto a newer schema — a foreign migration.
  const files = [{ name: "001.sql", digest: "a" }, { name: "002.sql", digest: "b" }];
  assert.equal(compareLedger(files, files)[0], "PASS");
  assert.match(compareLedger(files.slice(0, 1), files)[1], /not applied: 002/);
  assert.match(compareLedger([files[0], { name: "002.sql", digest: "c" }], files)[1], /digest differs/);
  assert.match(compareLedger([...files, { name: "003.sql", digest: "d" }], files)[1], /applied but not in this release: 003/);

  assert.deepEqual(parseEnvFile("# c\nA=1\nB = \"two\"\n\nC='3'\nbad\n"), { A: "1", B: "two", C: "3" });
});

test("R-1b the preflight CLI never prints a value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orgfit-preflight-"));
  const env = productionEnv("staff");
  const marker = "f00d".repeat(16);
  env.ATTACHMENT_ENCRYPTION_KEY = marker;
  env.REPORT_ENCRYPTION_KEY = marker; // reused on purpose: the failure must name keys, not values
  env.DATABASE_URL = env.DATABASE_URL.replace("verify-full", "disable");
  const file = join(dir, "staff.env");
  await writeFile(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"));
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/release-preflight.ts", "--process", "staff", "--env-file", file, "--production"], { encoding: "utf8" });
  assert.equal(run.status, 1);
  const output = run.stdout + run.stderr;
  assert.match(output, /FAIL key-separation/);
  assert.match(output, /FAIL db:DATABASE_URL/);
  for (const value of Object.values(env).filter((v) => v.length > 12))
    for (const part of [value, ...(value.match(/:([0-9a-f]{24})@/)?.slice(1) ?? [])])
      assert.ok(!output.includes(part), "a value was printed");
});

test("R-2 no migration of a previous gate-passed commit was edited or removed; the candidate's schema additions are listed", () => {
  const available = (commit: string) => spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`]).status === 0;
  const current = new Map([...migrationDigests("db/migrations"), ...migrationDigests("db/anonymous").map((m) => ({ ...m, name: `anonymous/${m.name}` }))].map((m) => [m.name, m.digest]));
  const baselines = { "59c99e3": "Checkpoint F", b8d1bab: "Phase 14" };
  let compared = 0;
  for (const [commit, label] of Object.entries(baselines)) {
    if (!available(commit)) {
      console.log(`R-2 ${label} commit ${commit} not in this clone; skipped`);
      continue;
    }
    for (const [dir, prefix] of [["db/migrations", ""], ["db/anonymous", "anonymous/"]] as const) {
      const names = execFileSync("git", ["ls-tree", "--name-only", `${commit}:${dir}`], { encoding: "utf8" }).split("\n").filter((n) => n.endsWith(".sql"));
      for (const name of names) {
        const source = execFileSync("git", ["show", `${commit}:${dir}/${name}`], { encoding: "utf8" });
        const digest = createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
        const now = current.get(prefix + name);
        assert.ok(now, `${label}: ${prefix}${name} was removed`);
        // Migration files are checked out with LF (.gitattributes), which is what the ledger hashes.
        assert.equal(now, digest, `${label}: ${prefix}${name} changed since ${commit}`);
        compared++;
      }
    }
    const added = [...current.keys()].filter((n) => {
      const [dir, file] = n.startsWith("anonymous/") ? ["db/anonymous", n.slice(10)] : ["db/migrations", n];
      return spawnSync("git", ["cat-file", "-e", `${commit}:${dir}/${file}`]).status !== 0;
    });
    console.log(`R-2 since ${label} (${commit}): added ${added.length ? added.join(", ") : "no migration"}`);
  }
  if (available("b8d1bab")) assert.ok(compared > 30);
});

function answersFor(d: Instrument) {
  const out: Record<string, string | string[]> = {};
  for (const q of d.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    if (q.type === "CHECKBOXES") out[q.id] = [q.options[0].id];
    else if (q.type === "MATRIX") for (const r of q.rows) out[r.id] = q.columns[0].id;
    else if (["MULTIPLE_CHOICE", "DROPDOWN", "YES_NO"].includes(q.type)) out[q.id] = q.options[0].id;
    else if (q.type === "RATING_5") out[q.id] = "3";
    else if (q.type === "RATING_10") out[q.id] = "6";
    else if (q.type === "NUMBER") out[q.id] = "4";
    else if (q.type === "DATE") out[q.id] = "2026-06-15";
    else out[q.id] = "نص";
  }
  return out;
}

test("R-4 anonymous and core stores restored to different points never pass silently", async () => {
  const f = await respondentFixture(6);
  const coreUrl = f.fixture.url("orgfit_migrator");
  const anonUrl = f.fixture.anonymousUrl("orgfit_anon_migrator");
  const processorCore = new pg.Pool({ connectionString: f.fixture.url("orgfit_processor"), max: 2 });
  const processorAnon = new pg.Pool({ connectionString: f.fixture.anonymousUrl("orgfit_processor"), max: 2 });
  const anonOwner = new pg.Client({ connectionString: anonUrl });
  await anonOwner.connect();
  await anonOwner.query("SET ROLE orgfit_anon_owner");
  const ledger = await mkdtemp(join(tmpdir(), "orgfit-r4-ledger-"));
  const opsCheck = () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/ops-check.ts"], {
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MIGRATION_DATABASE_URL: coreUrl, ANONYMOUS_MIGRATION_DATABASE_URL: anonUrl },
    });
    return { status: r.status, codes: (JSON.parse(r.stdout).alerts as { code: string }[]).map((a) => a.code) };
  };
  async function processed() {
    const { campaignId } = await f.launchedCampaign();
    for (const link of await f.issueLinks(campaignId)) {
      const s = await exchange(link.token);
      await finalize(s.session!, { answers: answersFor((await instrument(s.session!)).document) });
    }
    await f.closeCampaign(campaignId);
    const outcome = await processCampaign(processorCore, processorAnon, campaignId);
    assert.equal(outcome.state, "CLEANED");
    return campaignId;
  }
  try {
    const X = await processed();
    const Y = await processed();
    assert.deepEqual(await storeInconsistencies(coreUrl, anonUrl), [], "consistent stores report nothing");
    assert.ok(!opsCheck().codes.includes("ANONYMOUS_STORE_INCONSISTENT"));

    // The anonymous store "restored" to before X was committed: X's intake is
    // already erased in the core, so its answers exist nowhere — and every
    // core-side count still agrees. This is the case that used to pass silently.
    const purged = await anonOwner.query("SELECT anonymous.purge_campaign($1,$2) AS n", [f.orgA, X]);
    assert.equal(purged.rows[0].n, f.people.length);
    assert.deepEqual(await storeInconsistencies(coreUrl, anonUrl), [{ campaignId: X, reason: "ANONYMOUS_OUTPUT_MISSING_FOR_COMMITTED_BATCH" }]);
    const check = opsCheck();
    assert.equal(check.status, 2);
    assert.ok(check.codes.includes("ANONYMOUS_STORE_INCONSISTENT"));
    await markRestorePending(coreUrl);
    const replay = await reapplyTombstones(coreUrl, anonUrl, ledger);
    assert.equal(replay.opened, false);
    assert.deepEqual(replay.incidents, [{ campaignId: X, reason: "ANONYMOUS_OUTPUT_MISSING_FOR_COMMITTED_BATCH" }]);
    await assert.rejects(readiness(), /Unready/);

    // A purge that retention recorded is intended, not an inconsistency.
    await f.operator.query("SELECT ops.record_anonymous_purge($1,$2)", [f.orgA, X]);
    assert.deepEqual(await storeInconsistencies(coreUrl, anonUrl), []);

    // Counts that disagree between the stores.
    await f.operator.query("UPDATE intake.processing_batch SET processed_count=processed_count-1 WHERE campaign_id=$1", [Y]);
    assert.deepEqual(await storeInconsistencies(coreUrl, anonUrl), [{ campaignId: Y, reason: "ANONYMOUS_MARKER_MISMATCH" }]);
    await f.operator.query("UPDATE intake.processing_batch SET processed_count=processed_count+1 WHERE campaign_id=$1", [Y]);

    // The core "restored" to before Y's batch existed while the anonymous
    // store kept Y's output: the anonymous store is ahead of the core.
    await f.operator.query("DELETE FROM intake.processing_batch WHERE campaign_id=$1", [Y]);
    assert.deepEqual(await storeInconsistencies(coreUrl, anonUrl), [{ campaignId: Y, reason: "ANONYMOUS_OUTPUT_AHEAD_OF_CORE" }]);
    const second = await reapplyTombstones(coreUrl, anonUrl, ledger);
    assert.equal(second.opened, false);
    assert.ok(second.incidents.some((i) => i.campaignId === Y && i.reason === "ANONYMOUS_OUTPUT_AHEAD_OF_CORE"));
  } finally {
    await anonOwner.end();
    await processorCore.end();
    await processorAnon.end();
    await f.close();
  }
});
