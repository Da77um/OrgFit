import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { Supervisor, SupervisorError, type SupervisorStatus } from "../src/supervisor";
import type { AlertPayload, AlertSink } from "../src/alert-delivery";
import { withStaff } from "../src/db";
import { exchange, instrument, finalize } from "../src/respondent";
import { reportRoute } from "../src/reports";
import { visitRoute } from "../src/visits";
import { ids } from "../scripts/seed";
import type { Instrument } from "../src/instrument-input";
import { respondentFixture, wait } from "./respondent-fixture";

// ---------------------------------------------------------------------------
// Post-Audit Repair Pass 3: the job supervisor (audit finding 6).
//
// SV-1 … SV-8 drive the real Supervisor with stand-in jobs (tests/supervisor/
// fake-job.ts) started exactly as real jobs are — node --env-file=<file>
// --import tsx — to prove order, overlap, bounded retries, timeouts, shutdown,
// credential isolation, the single-instance lock and crash recovery.
//
// SV-9 runs the real command (scripts/supervise.ts) against a real synthetic
// database with one environment file per job process, and shows a closed
// campaign processed and published, reports drawn (including one abandoned by
// a crashed worker) and an attachment scanned — with no job invoked by hand.
// ---------------------------------------------------------------------------

const FAKE = resolve("tests/supervisor/fake-job.ts");
type Event = { job: string; event: "start" | "end"; at: number; pid: number; keys: string[] };

async function sandbox(schedule: Record<string, unknown>, files: Record<string, Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), "orgfit-sv-"));
  const envDir = join(root, "env");
  const stateDir = join(root, "state");
  const log = join(root, "events.jsonl");
  await mkdir(envDir);
  await writeFile(log, "");
  for (const [name, env] of Object.entries(files))
    await writeFile(join(envDir, `${name}.env`), Object.entries({ NODE_ENV: "test", FAKE_LOG: log, ...env }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  const manifest = {
    keys: { hex64: [], mustDiffer: [] },
    databaseUrls: {},
    storage: {},
    processes: {
      alpha: { kind: "job", required: ["NODE_ENV", "FAKE_LOG", "ALPHA_SECRET"], optional: [], forbidden: ["BETA_SECRET"] },
      beta: { kind: "job", required: ["NODE_ENV", "FAKE_LOG", "BETA_SECRET"], optional: [], forbidden: ["ALPHA_SECRET"] },
    },
    schedule: { retry: { maxRetries: 2, retryBaseSeconds: 1 }, shutdownGraceSeconds: 1, groups: {}, ...schedule },
    supervisor: JSON.parse(readFileSync("deploy/processes.json", "utf8")).supervisor,
  };
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const events = () =>
    readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Event);
  const status = () => readStatus(stateDir);
  return { root, envDir, stateDir, log, manifest, manifestPath, events, status };
}
// status.json is replaced by rename; on Windows a read can meet the swap.
function readStatus(stateDir: string): SupervisorStatus {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")) as SupervisorStatus;
    } catch (e) {
      if (i >= 5) throw e;
      const until = Date.now() + 20;
      while (Date.now() < until) {
        /* brief synchronous retry */
      }
    }
  }
}
const alphaEnv = { ALPHA_SECRET: "alpha-" + randomBytes(8).toString("hex") };
const betaEnv = { BETA_SECRET: "beta-" + randomBytes(8).toString("hex") };
const job = (process: string, everySeconds: number, extra: Record<string, unknown> = {}) => ({ process, script: FAKE, everySeconds, timeoutSeconds: 30, ...extra });
const cleanEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
const quiet = { log: () => {}, tickMs: 100, handleSignals: false, supervisorEnv: cleanEnv, graceSeconds: 1 };
const until = async (condition: () => boolean, ms: number, label: string) => {
  const deadline = Date.now() + ms;
  const holds = () => {
    try {
      return condition();
    } catch {
      return false; // e.g. status.json not written yet
    }
  };
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await wait(100);
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("SV-1 a group runs in manifest order and nothing overlaps itself", async () => {
  const s = await sandbox(
    {
      groups: { chain: { everySeconds: 1, jobs: ["chain:first", "chain:second"] } },
      jobs: {
        "chain:first": job("alpha", 1, { group: "chain" }),
        "chain:second": job("beta", 1, { group: "chain" }),
        "solo:slow": job("alpha", 1),
      },
    },
    { alpha: { ...alphaEnv, FAKE_MODE_chain_first: "sleep:400", FAKE_MODE_solo_slow: "sleep:1500" }, beta: betaEnv },
  );
  const sup = new Supervisor({ ...quiet, manifest: s.manifest as never, envDir: s.envDir, stateDir: s.stateDir });
  const done = sup.start();
  await until(() => s.events().filter((e) => e.job === "chain:second" && e.event === "end").length >= 3, 30_000, "three chain runs");
  await until(() => s.events().filter((e) => e.job === "solo:slow" && e.event === "end").length >= 2, 30_000, "two slow runs");
  await sup.stop();
  await done;
  const ev = s.events();
  // Order: every second-step start follows a first-step end that follows the
  // previous second-step end.
  const chain = ev.filter((e) => e.job.startsWith("chain:"));
  for (let i = 0; i + 3 < chain.length; i += 4) {
    assert.deepEqual(chain.slice(i, i + 4).map((e) => `${e.job}:${e.event}`), ["chain:first:start", "chain:first:end", "chain:second:start", "chain:second:end"]);
    assert.ok(chain[i + 2].at >= chain[i + 1].at);
  }
  // No overlap: each slow run starts after the previous one ended, although its
  // interval (1 s) is shorter than its duration (1.5 s).
  const slow = ev.filter((e) => e.job === "solo:slow");
  for (let i = 2; i < slow.length; i += 2) assert.ok(slow[i].at >= slow[i - 1].at, "a slow run overlapped the previous one");
  const status = s.status();
  assert.equal(status.jobs["chain:first"].lastOutcome, "SUCCESS");
  assert.ok(status.jobs["solo:slow"].runs >= 2);
  assert.equal(existsSync(join(s.stateDir, "supervisor.lock")), false, "lock released on stop");
});

test("SV-2 retries are bounded and back off; a recovering job resets; failures reach the alert sink", async () => {
  const s = await sandbox(
    { jobs: { "job:broken": job("alpha", 60), "job:flaky": job("beta", 60) } },
    { alpha: { ...alphaEnv, FAKE_MODE: "fail" }, beta: { ...betaEnv, FAKE_MODE: "fail-until:2" } },
  );
  const delivered: AlertPayload[] = [];
  const sink: AlertSink = { kind: "memory", deliver: async (p) => void delivered.push(p) };
  const sup = new Supervisor({ ...quiet, manifest: s.manifest as never, envDir: s.envDir, stateDir: s.stateDir, sink });
  const done = sup.start();
  await until(() => s.status().units["job:broken"]?.health === "FAILING", 30_000, "broken job reported FAILING");
  await until(() => s.status().jobs["job:flaky"].lastOutcome === "SUCCESS", 30_000, "flaky job recovers");
  await wait(2500);
  await sup.stop();
  await done;
  const starts = (name: string) => s.events().filter((e) => e.job === name && e.event === "start");
  // Initial attempt + maxRetries (2) retries, then back to the 60 s cadence.
  assert.equal(starts("job:broken").length, 3, "exactly three attempts before falling back to the cadence");
  const at = starts("job:broken").map((e) => e.at);
  assert.ok(at[2] - at[1] > at[1] - at[0], `backoff grows: ${at[1] - at[0]} then ${at[2] - at[1]}`);
  const status = s.status();
  assert.equal(status.jobs["job:broken"].consecutiveFailures, 3);
  assert.equal(status.jobs["job:broken"].lastReason, "EXIT");
  assert.equal(status.jobs["job:flaky"].consecutiveFailures, 0);
  assert.equal(starts("job:flaky").length, 3, "failed twice, succeeded on the third attempt");
  assert.equal(status.units["job:flaky"].health, "OK");
  assert.ok(delivered.some((p) => p.source === "supervisor" && p.alerts.some((a) => a.code === "SUPERVISED_JOB_FAILING" && a.value === "job:broken")));
  assert.ok(!JSON.stringify(delivered).includes(alphaEnv.ALPHA_SECRET));
});

test("SV-3 a job past its timeout is terminated and recorded TIMEOUT", async () => {
  const s = await sandbox({ jobs: { "job:hang": job("alpha", 60, { timeoutSeconds: 1 }) } }, { alpha: { ...alphaEnv, FAKE_MODE: "hang" } });
  const sup = new Supervisor({ ...quiet, manifest: s.manifest as never, envDir: s.envDir, stateDir: s.stateDir });
  const done = sup.start();
  await until(() => s.status().jobs["job:hang"].lastReason === "TIMEOUT", 20_000, "timeout recorded");
  const pid = s.events().find((e) => e.job === "job:hang")!.pid;
  await until(() => !alive(pid), 10_000, "hung child terminated");
  await sup.stop();
  await done;
  assert.equal(s.status().jobs["job:hang"].lastOutcome, "FAILURE");
});

test("SV-4 a STOP request lets running jobs finish within the grace period, then interrupts them and releases the lock", async () => {
  const s = await sandbox({ jobs: { "job:hang": job("alpha", 60, { timeoutSeconds: 120 }) } }, { alpha: { ...alphaEnv, FAKE_MODE: "hang" } });
  const sup = new Supervisor({ ...quiet, manifest: s.manifest as never, envDir: s.envDir, stateDir: s.stateDir });
  const done = sup.start();
  await until(() => s.events().some((e) => e.job === "job:hang"), 20_000, "job started");
  assert.equal(existsSync(join(s.stateDir, "supervisor.lock")), true);
  await writeFile(join(s.stateDir, "STOP"), "");
  await done;
  const pid = s.events()[0].pid;
  await until(() => !alive(pid), 10_000, "interrupted child ended");
  const status = s.status();
  assert.equal(status.stopping, true);
  assert.equal(status.jobs["job:hang"].lastReason, "INTERRUPTED");
  assert.equal(status.jobs["job:hang"].running, false);
  assert.equal(existsSync(join(s.stateDir, "supervisor.lock")), false);
});

test("SV-5 each child receives only its own process file; mixed files and a credentialed supervisor are refused", async () => {
  const s = await sandbox(
    { jobs: { "job:alpha": job("alpha", 60), "job:beta": job("beta", 60) } },
    { alpha: alphaEnv, beta: betaEnv },
  );
  const sup = new Supervisor({ ...quiet, manifest: s.manifest as never, envDir: s.envDir, stateDir: s.stateDir, supervisorEnv: { ...cleanEnv, ALERT_SINK: "none" } });
  const done = sup.start();
  await until(() => s.events().filter((e) => e.event === "end").length >= 2, 20_000, "both jobs ran");
  await sup.stop();
  await done;
  const keysOf = (name: string) => s.events().find((e) => e.job === name)!.keys;
  assert.ok(keysOf("job:alpha").includes("ALPHA_SECRET"));
  assert.ok(!keysOf("job:alpha").includes("BETA_SECRET"), "alpha must not see beta's credential");
  assert.ok(keysOf("job:beta").includes("BETA_SECRET"));
  assert.ok(!keysOf("job:beta").includes("ALPHA_SECRET"), "beta must not see alpha's credential");
  assert.ok(!keysOf("job:alpha").includes("ALERT_SINK"), "the supervisor's own settings do not reach a job");

  // A supervisor whose own environment holds a database credential refuses to start.
  assert.throws(
    () => new Supervisor({ ...quiet, manifest: s.manifest as never, envDir: s.envDir, stateDir: s.stateDir, supervisorEnv: { ...cleanEnv, REPORT_DATABASE_URL: "postgresql://orgfit_report:x@127.0.0.1/orgfit" } }),
    (e: SupervisorError) => e.code === "SUPERVISOR_HOLDS_CREDENTIAL",
  );
  // A process file holding another process's credential is refused before anything runs.
  await writeFile(join(s.envDir, "alpha.env"), readFileSync(join(s.envDir, "alpha.env"), "utf8") + `BETA_SECRET=${betaEnv.BETA_SECRET}\n`);
  assert.throws(
    () => new Supervisor({ ...quiet, manifest: s.manifest as never, envDir: s.envDir, stateDir: s.stateDir }),
    (e: SupervisorError) => e.code === "ENVIRONMENT_INVALID" && e.details.some((d) => d.includes("alpha: forbidden")) && !e.details.join().includes(betaEnv.BETA_SECRET),
  );
  // The interval scale is a nonproduction tool.
  await writeFile(join(s.envDir, "alpha.env"), `NODE_ENV=production\nFAKE_LOG=${s.log}\nALPHA_SECRET=x\n`);
  assert.throws(
    () => new Supervisor({ ...quiet, manifest: s.manifest as never, envDir: s.envDir, stateDir: s.stateDir, intervalScale: 0.1, only: ["job:alpha"] }),
    (e: SupervisorError) => e.code === "INTERVAL_SCALE_NONPRODUCTION_ONLY",
  );
});

test("SV-6 one supervisor per state directory", async () => {
  const s = await sandbox({ jobs: { "job:hang": job("alpha", 60, { timeoutSeconds: 120 }) } }, { alpha: { ...alphaEnv, FAKE_MODE: "hang" } });
  // The first supervisor in its own process, as it would run.
  const first = spawn(process.execPath, ["--import", "tsx", "tests/supervisor/run-supervisor.ts", s.manifestPath, s.envDir, s.stateDir], {
    env: cleanEnv as unknown as NodeJS.ProcessEnv,
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await until(() => s.events().some((e) => e.job === "job:hang"), 30_000, "first supervisor running a job");
    const second = new Supervisor({ ...quiet, manifest: s.manifest as never, envDir: s.envDir, stateDir: s.stateDir });
    await assert.rejects(second.start(), (e: SupervisorError) => e.code === "ALREADY_RUNNING");
    assert.equal(s.events().filter((e) => e.event === "start").length, 1, "the refused supervisor started nothing");
    // A second instance inside one process is refused the same way.
    const inProcess = await sandbox({ jobs: { "job:hang": job("alpha", 60, { timeoutSeconds: 120 }) } }, { alpha: { ...alphaEnv, FAKE_MODE: "hang" } });
    const a = new Supervisor({ ...quiet, manifest: inProcess.manifest as never, envDir: inProcess.envDir, stateDir: inProcess.stateDir });
    const aDone = a.start();
    await until(() => existsSync(join(inProcess.stateDir, "supervisor.lock")), 10_000, "lock taken");
    const b = new Supervisor({ ...quiet, manifest: inProcess.manifest as never, envDir: inProcess.envDir, stateDir: inProcess.stateDir });
    await assert.rejects(b.start(), (e: SupervisorError) => e.code === "ALREADY_RUNNING");
    await a.stop();
    await aDone;
  } finally {
    await writeFile(join(s.stateDir, "STOP"), "");
    await until(() => first.exitCode !== null, 30_000, "first supervisor stopped");
  }
});

test("SV-7 after a supervisor crash, the next one records the interruption and never overlaps a surviving run", async () => {
  // Part 1: a real crash. The supervisor process is killed abruptly while its
  // job runs; no shutdown handler runs and the lock stays behind.
  const s = await sandbox({ jobs: { "job:hang": job("alpha", 1, { timeoutSeconds: 120 }) } }, { alpha: { ...alphaEnv, FAKE_MODE: "hang" } });
  const crashed: ChildProcess = spawn(process.execPath, ["--import", "tsx", "tests/supervisor/run-supervisor.ts", s.manifestPath, s.envDir, s.stateDir], {
    env: cleanEnv as unknown as NodeJS.ProcessEnv,
    stdio: "ignore",
    windowsHide: true,
  });
  await until(() => s.events().some((e) => e.job === "job:hang" && e.event === "start"), 30_000, "job started under the first supervisor");
  const firstRun = s.events().find((e) => e.event === "start")!.pid;
  crashed.kill("SIGKILL");
  await until(() => crashed.exitCode !== null || crashed.signalCode !== null, 10_000, "supervisor gone");
  assert.equal(existsSync(join(s.stateDir, "supervisor.lock")), true, "stale lock left behind");
  // On Windows the job dies with its supervisor (Node places children in a job
  // object); on Linux and macOS it survives as an orphan. Both are handled.
  await wait(500);
  const orphanSurvived = alive(firstRun);
  const next = new Supervisor({ ...quiet, manifest: s.manifest as never, envDir: s.envDir, stateDir: s.stateDir });
  const done = next.start();
  await until(() => s.status().pid === process.pid, 10_000, "new supervisor took the stale lock");
  if (orphanSurvived) {
    assert.equal(s.status().jobs["job:hang"].lastReason, "SKIPPED_ORPHAN");
    await wait(2000);
    assert.equal(s.events().filter((e) => e.event === "start").length, 1, "no second run while the orphan lives");
    process.kill(firstRun);
  } else {
    assert.equal(s.status().jobs["job:hang"].lastOutcome, "FAILURE");
  }
  await until(() => s.events().filter((e) => e.event === "start").length === 2, 20_000, "the job runs again under the new supervisor");
  await next.stop();
  await done;
  assert.equal(alive(s.events().filter((e) => e.event === "start")[1].pid), false, "stopped cleanly");

  // Part 2: a surviving run on every platform. A live process recorded as the
  // job's running child by a crashed supervisor is waited out, not overlapped.
  const o = await sandbox({ jobs: { "job:hang": job("alpha", 1, { timeoutSeconds: 120 }) } }, { alpha: { ...alphaEnv, FAKE_MODE: "ok" } });
  const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true });
  survivor.unref();
  await mkdir(o.stateDir, { recursive: true });
  await writeFile(join(o.stateDir, "supervisor.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: new Date().toISOString() }));
  const recorded = {
    process: "alpha", running: true, pid: survivor.pid, lastStartedAt: new Date().toISOString(), lastFinishedAt: null,
    lastSuccessAt: null, lastFailureAt: null, lastOutcome: null, lastReason: null, lastExitCode: null, lastDurationMs: null,
    consecutiveFailures: 0, runs: 1, stderrLinesSuppressed: 0,
  };
  await writeFile(join(o.stateDir, "status.json"), JSON.stringify({ schemaVersion: 1, pid: 2 ** 22 + 12345, jobs: { "job:hang": recorded }, units: {} }));
  const waiting = new Supervisor({ ...quiet, manifest: o.manifest as never, envDir: o.envDir, stateDir: o.stateDir });
  const waited = waiting.start();
  try {
    await until(() => o.status().pid === process.pid, 10_000, "stale lock taken");
    assert.equal(o.status().jobs["job:hang"].lastReason, "SKIPPED_ORPHAN");
    await wait(2500);
    assert.equal(o.events().length, 0, "nothing started while the recorded run is alive");
  } finally {
    process.kill(survivor.pid!);
  }
  await until(() => o.events().some((e) => e.event === "end"), 20_000, "runs once the recorded run has ended");
  await waiting.stop();
  await waited;
});
test("SV-8 the schedule matches the manifest cadences and every job script exists", () => {
  const manifest = JSON.parse(readFileSync("deploy/processes.json", "utf8")) as {
    processes: Record<string, { commands?: Record<string, string> }>;
    schedule: { jobs: Record<string, { process: string; script: string; everySeconds: number }> };
  };
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  for (const [name, spec] of Object.entries(manifest.schedule.jobs)) {
    assert.ok(existsSync(spec.script), `${name}: ${spec.script}`);
    assert.equal(pkg.scripts[name], `tsx ${spec.script}`, `${name} is the same script npm runs`);
    const cadence = manifest.processes[spec.process].commands?.[`npm run ${name}`];
    assert.ok(cadence, `${name} is listed under ${spec.process}`);
    const range = /every (\d+)(?:-(\d+))? min/.exec(cadence);
    const proposed = /proposed (\d+) min/.exec(cadence);
    const [low, high] = cadence.startsWith("hourly")
      ? [3600, 3600]
      : cadence.startsWith("daily")
        ? [86400, 86400]
        : range
          ? [Number(range[1]) * 60, Number(range[2] ?? range[1]) * 60]
          : proposed
            ? [Number(proposed[1]) * 60, Number(proposed[1]) * 60]
            : [NaN, NaN];
    assert.ok(spec.everySeconds >= low && spec.everySeconds <= high, `${name}: ${spec.everySeconds} s vs "${cadence}"`);
  }
});

// ---- the real thing ----------------------------------------------------------------

function answersFor(document: Instrument, seed: number) {
  const answers: Record<string, string | string[]> = {};
  for (const q of document.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    if (q.type === "SHORT_TEXT" || q.type === "LONG_TEXT") answers[q.id] = `comment ${seed}`;
    else if (q.type === "RATING_5") answers[q.id] = String((seed % 5) + 1);
    else if (q.type === "RATING_10") answers[q.id] = String((seed % 10) + 1);
    else if (q.type === "NUMBER") answers[q.id] = String(seed % 10);
    else if (q.type === "DATE") answers[q.id] = "2026-06-15";
    else if (q.type === "CHECKBOXES") answers[q.id] = [q.options[seed % q.options.length].id];
    else if (q.type === "MATRIX") for (const row of q.rows) answers[row.id] = q.columns[seed % q.columns.length].id;
    else answers[q.id] = q.options[seed % q.options.length].id;
  }
  return answers;
}

test("SV-9 the supervisor processes, publishes, draws reports and scans attachments with no job run by hand", async (t) => {
  const f = await respondentFixture(6);
  const root = await mkdtemp(join(tmpdir(), "orgfit-sv9-"));
  const envDir = join(root, "env");
  const stateDir = join(root, "state");
  const reports = join(root, "reports");
  const attachments = join(root, "attachments");
  const ledger = join(root, "ledger");
  for (const d of [envDir, reports, attachments, ledger]) await mkdir(d, { recursive: true });
  const reportKey = randomBytes(32).toString("hex");
  const attachmentKey = randomBytes(32).toString("hex");
  // The staff half of this test reads what the jobs write.
  Object.assign(process.env, {
    REPORT_ENCRYPTION_KEY: reportKey,
    REPORT_LOCAL_DIRECTORY: reports,
    ATTACHMENT_ENCRYPTION_KEY: attachmentKey,
    ATTACHMENT_LOCAL_DIRECTORY: attachments,
  });
  const files: Record<string, Record<string, string>> = {
    processor: {
      NODE_ENV: "development",
      PROCESSOR_DATABASE_URL: f.fixture.url("orgfit_processor"),
      ANONYMOUS_DATABASE_URL: f.fixture.anonymousUrl("orgfit_processor"),
      CAMPAIGN_KEY_CUSTODY_SECRET_KEY: f.custodianSecret,
      CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY: process.env.CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY!,
      CAMPAIGN_KEY_CUSTODY_DIRECTORY: f.custodyDirectory,
    },
    report: { NODE_ENV: "development", REPORT_DATABASE_URL: f.fixture.url("orgfit_report"), REPORT_ENCRYPTION_KEY: reportKey, REPORT_LOCAL_DIRECTORY: reports },
    scanner: { NODE_ENV: "development", SCANNER_DATABASE_URL: f.fixture.url("orgfit_scanner"), ATTACHMENT_ENCRYPTION_KEY: attachmentKey, ATTACHMENT_LOCAL_DIRECTORY: attachments },
    operator: {
      NODE_ENV: "development",
      MIGRATION_DATABASE_URL: f.fixture.url("orgfit_migrator"),
      ANONYMOUS_MIGRATION_DATABASE_URL: f.fixture.anonymousUrl("orgfit_anon_migrator"),
      TOMBSTONE_LEDGER_DIRECTORY: ledger,
      BACKUP_DIRECTORY: ledger,
    },
  };
  for (const [name, env] of Object.entries(files))
    await writeFile(join(envDir, `${name}.env`), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");

  const children: ChildProcess[] = [];
  const logs: string[] = [];
  const supervise = (args: string[]) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/supervise.ts", "--env-dir", envDir, "--state-dir", stateDir, ...args], {
      env: { ...cleanEnv, ALERT_SINK: "file", ALERT_FILE: join(root, "alerts.jsonl") } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let text = "";
    child.stdout!.on("data", (d) => (text += d));
    child.stderr!.on("data", (d) => (text += d));
    child.on("close", () => logs.push(text));
    children.push(child);
    return { child, output: () => text };
  };
  const stopSupervisor = async (child: ChildProcess) => {
    const stop = spawn(process.execPath, ["--import", "tsx", "scripts/supervise.ts", "--stop", "--state-dir", stateDir], { env: cleanEnv as unknown as NodeJS.ProcessEnv, stdio: "ignore", windowsHide: true });
    await new Promise((r) => stop.on("close", r));
    await until(() => child.exitCode !== null, 90_000, "supervisor exits after --stop");
    assert.equal(child.exitCode, 0);
  };
  const reportPool = new pg.Pool({ connectionString: f.fixture.url("orgfit_report"), max: 2 });
  t.after(async () => {
    for (const c of children) if (c.exitCode === null) c.kill();
    await reportPool.end();
    await f.close();
    await writeFile(resolve("work/pass3-supervisor-sv9.log"), logs.join("\n----\n")).catch(() => {});
  });

  const staff = f.staff;
  const org = f.orgA;
  const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(body) });
  const staffCall = async (handler: typeof reportRoute, target: string, init?: RequestInit) => {
    const [path] = target.split("?");
    const res = await withStaff(staff, (tx) => handler(new Request(`http://127.0.0.1:3000/api/v1/${target}`, init), path, tx));
    assert.ok(res);
    return res;
  };
  const q = async <T>(sql: string, params: unknown[] = []) => (await f.operator.query(sql, params)).rows as T[];

  // A campaign collected and closed by staff and respondents. Nothing below
  // calls the processor, the publication job, the renderer or the scanner.
  const { roundId, campaignId } = await f.launchedCampaign();
  const links = await f.issueLinks(campaignId);
  for (let i = 0; i < links.length; i++) {
    const s = await exchange(links[i].token);
    await finalize(s.session!, { answers: answersFor((await instrument(s.session!)).document, i) });
  }
  await f.closeCampaign(campaignId);

  // ---- run 1: collection, scanning and the alert check only ----
  const first = supervise(["--interval-scale", "0.02", "--only", "collection,attachments:scan,ops:check"]);
  const deadline = Date.now() + 180_000;
  for (;;) {
    const [row] = await q<{ release_state: string }>("select release_state from core.campaign where id=$1", [campaignId]);
    if (row.release_state === "PUBLISHED") break;
    if (Date.now() > deadline || first.child.exitCode !== null) assert.fail(`not published: ${row.release_state}\n${first.output()}`);
    await wait(500);
  }
  // An attachment uploaded while the supervisor runs is scanned by it.
  const visit = (await (await withStaff(staff, (tx) =>
    visitRoute(new Request(`http://127.0.0.1:3000/api/v1/organizations/${org}/visits`, post({
      relatedRoundId: null, assignedConsultantId: ids.staff, scheduledStart: "2026-09-20T07:00:00.000Z", scheduledEnd: "2026-09-20T12:00:00.000Z",
      timezone: "Asia/Riyadh", purpose: "زيارة ميدانية للتحقق من تشغيل المهام", notes: null, findings: null, recommendations: null, followUpDate: null, amendmentReason: null,
    })), `organizations/${org}/visits`, tx),
  ))!.json()).data as { id: string };
  const started = (await (await withStaff(staff, (tx) =>
    visitRoute(new Request(`http://127.0.0.1:3000/api/v1/organizations/${org}/visits/${visit.id}/attachments`, post({ filename: "minutes.pdf", declaredType: "application/pdf" })), `organizations/${org}/visits/${visit.id}/attachments`, tx),
  ))!.json()).data as { id: string };
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
  const put = await withStaff(staff, (tx) =>
    visitRoute(new Request(`http://127.0.0.1:3000/api/v1/organizations/${org}/visits/${visit.id}/attachments/${started.id}/content`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(pdf) }), `organizations/${org}/visits/${visit.id}/attachments/${started.id}/content`, tx),
  );
  assert.equal(put!.status, 202);
  const scanDeadline = Date.now() + 90_000;
  for (;;) {
    const [row] = await q<{ scan_status: string }>("select scan_status from core.attachment where id=$1", [started.id]);
    if (row.scan_status === "CLEAN") break;
    if (Date.now() > scanDeadline || first.child.exitCode !== null) assert.fail(`not scanned: ${row.scan_status}\n${first.output()}`);
    await wait(500);
  }
  await stopSupervisor(first.child);

  // ---- between runs: a report job abandoned by a crashed renderer ----
  const requested = async (format: "PDF" | "XLSX", locale: "ar" | "en") =>
    ((await (await staffCall(reportRoute, `organizations/${org}/reports`, post({ roundId, format, locale, comparisonId: null }))).json()).data as { id: string }).id;
  const abandoned = await requested("XLSX", "en");
  const claimed = await reportPool.query("select publication.claim_report_jobs(1, interval '1 second') as data");
  assert.equal(claimed.rows[0].data[0].id, abandoned, "a worker claimed it and then crashed without completing");
  const pdfJob = await requested("PDF", "ar");

  // ---- run 2: every scheduled job ----
  const second = supervise(["--interval-scale", "0.02"]);
  const reportDeadline = Date.now() + 240_000;
  for (;;) {
    const rows = await q<{ id: string; state: string }>("select id, state from ops.report_job where id = any($1)", [[abandoned, pdfJob]]);
    if (rows.every((r) => r.state === "READY")) break;
    if (Date.now() > reportDeadline || second.child.exitCode !== null) assert.fail(`reports not ready: ${JSON.stringify(rows)}\n${second.output()}`);
    await wait(500);
  }
  const [recovered] = await q<{ attempt: number }>("select attempt from ops.report_job where id=$1", [abandoned]);
  assert.equal(recovered.attempt, 2, "the abandoned job was reclaimed after its lease expired and drawn once more");
  for (const id of [abandoned, pdfJob]) {
    const res = await staffCall(reportRoute, `organizations/${org}/reports/${id}/download`);
    assert.equal(res.status, 200);
  }
  // Give the hourly and daily jobs (scaled) their first run, then stop.
  await until(() => {
    const status = readStatus(stateDir);
    return ["reports:expire", "attachments:expire", "drafts:expire", "retention:run", "tombstones:ship", "ops:check", "campaigns:normalize"].every((j) => status.jobs[j]?.lastOutcome);
  }, 120_000, "every job ran at least once");
  await stopSupervisor(second.child);

  // ---- what the database and the status file say ----
  const health = await q<{ job: string; last_success_at: Date | null; last_outcome: string | null; consecutive_failures: number }>(
    "select job, last_success_at, last_outcome, consecutive_failures from ops.job_status order by job",
  );
  for (const row of health) {
    assert.equal(row.last_outcome, "SUCCESS", `${row.job}: ${JSON.stringify(row)}`);
    assert.ok(row.last_success_at);
  }
  // The cadences the database judges staleness by equal the manifest's.
  const manifest = JSON.parse(readFileSync("deploy/processes.json", "utf8")) as { schedule: { jobs: Record<string, { everySeconds: number }> } };
  for (const r of await q<{ job: string; expected_interval_seconds: number }>("select job, expected_interval_seconds from ops.job_status"))
    assert.equal(r.expected_interval_seconds, manifest.schedule.jobs[r.job].everySeconds, r.job);
  const status = JSON.parse(await readFile(join(stateDir, "status.json"), "utf8")) as SupervisorStatus;
  for (const [name, js] of Object.entries(status.jobs)) assert.equal(js.running, false, name);
  assert.equal(existsSync(join(stateDir, "supervisor.lock")), false);
  const output = logs.join("\n");
  for (const env of Object.values(files))
    for (const [k, v] of Object.entries(env))
      if (/URL|KEY|SECRET/.test(k)) assert.ok(!output.includes(v), `${k} value appeared in supervisor output`);
  assert.match(output, /\[publication:release\] campaign=.* state=PUBLISHED/);
});
