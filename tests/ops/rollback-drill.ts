// Phase 15 — rollback and restore drill with assertions.
//
// Run: npx tsx tests/ops/rollback-drill.ts   (Windows, embedded PostgreSQL 18)
//
// Phase 14's restore drill measured RPO/RTO. This drill proves, on the release
// candidate's code and against real physical restores of a dedicated throwaway
// cluster, the four things Phase 15 requires a rollback or restore never does:
//
//   1. reopen a consumed invitation;
//   2. duplicate an accepted submission;
//   3. lose committed intake silently;
//   4. expose data that had expired or been deleted.
//
// Timeline on the primary (synthetic, one organization, threshold 5):
//   A  six accepted, open                       — all before the backup
//   B  six links, three accepted before the backup, three after
//   D  six accepted and closed before the backup; processed, cleaned and its
//      keys destroyed AFTER the backup (intake and key tombstones shipped)
//   E  an export expired by retention after the backup (tombstone shipped)
//   F  an export whose expiry time passes after the backup (no tombstone)
// Then: disaster. Restore 1 rolls back to the base backup; restore 2 replays the
// WAL archive to the end. Both run at once so that the two stores can also be
// mixed across restore points, which is what separate backup sets allow.
// Any failed assertion exits 1. Results: work/p15-rollback-drill.json.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

const ROOT = resolve("work/rollback-drill");
const BIN = resolve(process.env.PG_BIN ?? "work/package/native/bin");
const PRIMARY = join(ROOT, "primary");
const ARCHIVE = join(ROOT, "wal-archive");
const BASE = join(ROOT, "base-backup");
const BASE_WAL = join(ROOT, "base-backup-wal");
const LEDGER = join(ROOT, "tombstone-ledger");
const PORTS = { primary: 55443, base: 55453, pitr: 55463 };
const password = randomBytes(18).toString("hex");
const results: Record<string, unknown> = { startedAt: new Date().toISOString() };
const checks: string[] = [];
const ok = (label: string) => {
  checks.push(label);
  console.log(`PASS ${label}`);
};

const sh = (exe: string, args: string[]) => {
  const piped = exe !== "pg_ctl.exe";
  const r = spawnSync(join(BIN, exe), args, { encoding: "utf8", stdio: piped ? "pipe" : "ignore", windowsHide: true });
  if (r.status !== 0) throw new Error(`${exe} failed (${r.status}): ${piped ? r.stderr || r.stdout : "see its log file"}`);
};
const winPath = (p: string) => p.replace(/\//g, "\\").replace(/\\/g, "\\\\");
const adminUrl = (port: number, db = "postgres") => `postgres://postgres:${password}@127.0.0.1:${port}/${db}`;
const withPort = (url: string, port: number) => {
  const u = new URL(url);
  u.port = String(port);
  return u.href;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function one<T extends pg.QueryResultRow>(url: string, role: string | null, text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    if (role) await c.query(`SET ROLE ${role}`);
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}
async function waitForPrimary(url: string, timeoutMs = 600_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const [row] = await one<{ r: boolean }>(url, null, "select pg_is_in_recovery() r");
      if (!row.r) return Date.now() - t0;
    } catch {
      /* not accepting connections yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("restore did not finish");
    await sleep(200);
  }
}

// ---- primary --------------------------------------------------------------------
await rm(ROOT, { recursive: true, force: true });
await mkdir(ARCHIVE, { recursive: true });
await mkdir(LEDGER, { recursive: true });
await writeFile(join(ROOT, "pw.txt"), password);
sh("initdb.exe", ["-D", PRIMARY, "-U", "postgres", "-A", "scram-sha-256", "--pwfile", join(ROOT, "pw.txt"), "--encoding=UTF8", "--locale=C"]);
await writeFile(
  join(PRIMARY, "postgresql.auto.conf"),
  ["wal_level = replica", "archive_mode = on", `archive_command = 'copy "%p" "${winPath(ARCHIVE)}\\\\%f"'`, "archive_timeout = 60", "log_statement = 'none'", "log_error_verbosity = terse", ""].join("\n"),
);
// A failed assertion must not leave a drill server running on its port.
process.on("exit", () => {
  for (const dir of ["primary", "restore-base", "restore-pitr"])
    if (existsSync(join(ROOT, dir, "postmaster.pid")))
      spawnSync(join(BIN, "pg_ctl.exe"), ["-D", join(ROOT, dir), "-m", "immediate", "-w", "stop"], { stdio: "ignore", windowsHide: true });
});
sh("pg_ctl.exe", ["-D", PRIMARY, "-l", join(ROOT, "primary.log"), "-o", `-h 127.0.0.1 -p ${PORTS.primary}`, "-w", "start"]);

process.env.TEST_ADMIN_DATABASE_URL = adminUrl(PORTS.primary);
const { respondentFixture } = await import("../respondent-fixture");
const { exchange, instrument, finalize } = await import("../../src/respondent");
const { processCampaign } = await import("../../src/processor");
const ops = await import("../../src/operations");
const { configureGateway, gatewayReadiness } = await import("../../src/gateway-db");
const { setCustodianSecret } = await import("../../src/key-custody");
type Instrument = import("../../src/instrument-input").Instrument;

const f = await respondentFixture(6);
const coreUrl = f.fixture.url("orgfit_migrator");
const anonUrl = f.fixture.anonymousUrl("orgfit_anon_migrator");
const answer = (d: Instrument) => {
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
};
const submit = async (token: string) => {
  const s = await exchange(token);
  assert.equal((s.context as { access: string }).access, "OPEN");
  await finalize(s.session!, { answers: answer((await instrument(s.session!)).document) });
};
const launched = async () => {
  const { campaignId } = await f.launchedCampaign();
  return { campaignId, tokens: (await f.issueLinks(campaignId)).map((l) => l.token) };
};
const exportRow = async (id: string, expiresIn: string) =>
  one(coreUrl, "orgfit_core_owner", "insert into ops.private_export(id,organization_id,kind,requested_by,state,storage_key,item_count,expires_at,generation_key) values($1,$2,'DIRECTORY',$3,'READY',null,0,clock_timestamp()+$4::interval,$5)", [
    id,
    f.orgA,
    "00000000-0000-4000-8000-000000000001",
    expiresIn,
    randomUUID(),
  ]);

const A = await launched();
for (const t of A.tokens) await submit(t);
const B = await launched();
for (const t of B.tokens.slice(0, 3)) await submit(t);
const D = await launched();
for (const t of D.tokens) await submit(t);
await f.closeCampaign(D.campaignId);
const E = randomUUID(),
  F = randomUUID();
await exportRow(E, "1 hour");
await exportRow(F, "40 seconds");

// ---- online base backup -----------------------------------------------------------
const session = new pg.Client({ connectionString: adminUrl(PORTS.primary) });
await session.connect();
await session.query("select pg_backup_start('orgfit-rollback-drill', true)");
const backupAt = Date.now();
await cp(PRIMARY, BASE, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(PRIMARY.length).replace(/\\/g, "/");
    return !/^\/(postmaster\.pid|postmaster\.opts)$/.test(rel) && !/^\/pg_wal\/./.test(rel);
  },
});
const [stop] = (await session.query("select lsn, labelfile, spcmapfile from pg_backup_stop(true)")).rows;
const [{ file: stopWal }] = (await session.query("select pg_walfile_name($1) file", [stop.lsn])).rows;
await writeFile(join(BASE, "backup_label"), stop.labelfile);
if (stop.spcmapfile) await writeFile(join(BASE, "tablespace_map"), stop.spcmapfile);
await session.end();
await mkdir(BASE_WAL, { recursive: true });
for (let i = 0; i < 150 && !existsSync(join(ARCHIVE, stopWal)); i++) await sleep(200);
for (const name of await readdir(ARCHIVE)) if (/^[0-9A-F]{24}$/.test(name) && name <= stopWal) await cp(join(ARCHIVE, name), join(BASE_WAL, name));

// ---- work after the backup -----------------------------------------------------------
for (const t of B.tokens.slice(3)) await submit(t);
{
  const core = new pg.Pool({ connectionString: f.fixture.url("orgfit_processor"), max: 2 });
  const anon = new pg.Pool({ connectionString: f.fixture.anonymousUrl("orgfit_processor"), max: 2 });
  const outcome = await processCampaign(core, anon, D.campaignId);
  assert.equal(outcome.processedCount, 6);
  results.processedDAfterBackup = { state: outcome.state, processed: outcome.processedCount };
  await core.end();
  await anon.end();
}
await one(coreUrl, "orgfit_core_owner", "update ops.private_export set expires_at=clock_timestamp()-interval '1 second' where id=$1", [E]);
await ops.runRetention(coreUrl, anonUrl);
results.shipped = await ops.shipTombstones(coreUrl, LEDGER);
const shippedClasses = (await ops.readLedger(LEDGER)).map((t) => `${t.class}:${t.subjectId === D.campaignId ? "D" : t.subjectId === E ? "E" : "other"}`);
assert.ok(shippedClasses.includes("CAMPAIGN_INTAKE:D") && shippedClasses.includes("CAMPAIGN_KEY:D") && shippedClasses.includes("PRIVATE_EXPORT:E"), shippedClasses.join(","));
// F's expiry passes with no tombstone; then everything is archived.
while (Date.now() - backupAt < 45_000) await sleep(1000);
// Close the current WAL segment and wait until the archive holds it, so the
// point-in-time restore can reach the last committed transaction.
const [{ closed }] = await one<{ closed: string }>(adminUrl(PORTS.primary), null, "select pg_walfile_name(pg_switch_wal()) closed");
for (let i = 0; i < 300 && !existsSync(join(ARCHIVE, closed)); i++) await sleep(200);
assert.ok(existsSync(join(ARCHIVE, closed)), "final WAL segment archived");
configureGateway(undefined);
await f.close().catch(() => undefined);
sh("pg_ctl.exe", ["-D", PRIMARY, "-m", "immediate", "-w", "stop"]);
results.disasterAt = new Date().toISOString();

// ---- restores ---------------------------------------------------------------------------
async function restore(dir: string, port: number, walDir: string, immediate: boolean) {
  const t0 = Date.now();
  await rm(dir, { recursive: true, force: true });
  await cp(BASE, dir, { recursive: true });
  await mkdir(join(dir, "pg_wal"), { recursive: true });
  await writeFile(
    join(dir, "postgresql.auto.conf"),
    ["archive_mode = off", `restore_command = 'copy "${winPath(walDir)}\\\\%f" "%p"'`, ...(immediate ? ["recovery_target = 'immediate'", "recovery_target_action = 'promote'"] : []), "log_error_verbosity = terse", ""].join("\n"),
  );
  await writeFile(join(dir, "recovery.signal"), "");
  sh("pg_ctl.exe", ["-D", dir, "-l", `${dir}.log`, "-o", `-h 127.0.0.1 -p ${port}`, "start"]);
  await waitForPrimary(adminUrl(port));
  return (Date.now() - t0) / 1000;
}
results.baseRestoreSeconds = await restore(join(ROOT, "restore-base"), PORTS.base, BASE_WAL, true);
results.pitrRestoreSeconds = await restore(join(ROOT, "restore-pitr"), PORTS.pitr, ARCHIVE, false);

const at = (port: number) => ({
  core: withPort(coreUrl, port),
  anon: withPort(anonUrl, port),
  processorCore: withPort(f.fixture.url("orgfit_processor"), port),
  processorAnon: withPort(f.fixture.anonymousUrl("orgfit_processor"), port),
  gateway: withPort(f.fixture.url("orgfit_gateway"), port),
});
const inbox = async (url: string, campaign: string) =>
  (await one<{ n: number }>(url, "orgfit_core_owner", "select count(*)::int n from intake.submission_inbox where campaign_id=$1", [campaign]))[0].n;
const exportState = async (url: string, id: string) =>
  (await one<{ state: string }>(url, "orgfit_core_owner", "select state from ops.private_export where id=$1", [id]))[0].state;
const ready = async (url: string) => (await one<{ ready: boolean }>(url, "orgfit_core_owner", "select ops.ready() ready"))[0].ready;
const markers = async (url: string, campaign: string) =>
  (await one<{ n: number }>(url, "orgfit_anon_owner", "select count(*)::int n from anonymous.anonymous_response where campaign_id=$1", [campaign]))[0].n;
const access = async (token: string) => {
  const opened = await exchange(token);
  return { access: String((opened.context as { access: string }).access), session: opened.session };
};

process.env.CAMPAIGN_KEY_CUSTODY_DIRECTORY = f.custodyDirectory;
setCustodianSecret(f.custodianSecret);

// ======== Restore 1: roll back to the base backup ==========================================
{
  const r = at(PORTS.base);
  await ops.markRestorePending(r.core);
  configureGateway(r.gateway);
  assert.equal(await ready(r.core), false);
  await assert.rejects(gatewayReadiness(), /Unready/);
  ok("rollback: both readinesses are closed before the ledger replay");

  // What the backup brings back.
  assert.equal(await exportState(r.core, E), "READY");
  assert.equal(await exportState(r.core, F), "READY");
  assert.equal(await inbox(r.core, D.campaignId), 6);
  assert.equal(await inbox(r.core, B.campaignId), 3);

  const replay = await ops.reapplyTombstones(r.core, r.anon, LEDGER);
  results.baseReplay = replay;
  // (4) Expired and deleted data stay expired: by tombstone (E) and by time (F).
  assert.equal(await exportState(r.core, E), "EXPIRED");
  assert.equal(await exportState(r.core, F), "EXPIRED");
  ok("rollback: an export deleted after the backup (tombstone) and one that expired after it (time) are both expired again");
  // (3) D's intake was erased after its answers were committed to an anonymous
  // store this restore no longer has, and its keys are gone: reported, kept, closed.
  assert.deepEqual(replay.incidents, [{ campaignId: D.campaignId, reason: "ANONYMOUS_OUTPUT_MISSING_FOR_ERASED_INTAKE" }]);
  assert.equal(replay.opened, false);
  assert.equal(await ready(r.core), false);
  assert.equal(await inbox(r.core, D.campaignId), 6, "the envelopes are kept for the people deciding");
  ok("rollback: intake whose committed output the restore lost is an incident that keeps the environment closed, never a silent loss");

  const decided = await ops.reapplyTombstones(r.core, r.anon, LEDGER, { openDespiteIncidents: true });
  assert.equal(decided.opened, true);
  await gatewayReadiness();

  // (1)(2) Consumed before the backup: still consumed, and nothing is added.
  for (const token of [...A.tokens, ...B.tokens.slice(0, 3)]) {
    const x = await access(token);
    assert.notEqual(x.access, "OPEN");
    if (x.session) await finalize(x.session, { answers: {} }).catch(() => undefined);
  }
  assert.equal(await inbox(r.core, A.campaignId), 6);
  assert.equal(await inbox(r.core, B.campaignId), 3);
  ok("rollback: invitations consumed before the restore point cannot be reopened and add no submission");
  // Accepted after the backup: that acceptance no longer exists anywhere, so
  // the link is READY again — and it can be used exactly once.
  for (const token of B.tokens.slice(3)) {
    await submit(token);
    assert.notEqual((await access(token)).access, "OPEN");
  }
  assert.equal(await inbox(r.core, B.campaignId), 6);
  ok("rollback: a submission lost with the restore point can be made again exactly once; B has six envelopes, not nine");

  // D cannot be decrypted any more; processing fails loudly and appends nothing.
  const core = new pg.Pool({ connectionString: r.processorCore, max: 2 });
  const anon = new pg.Pool({ connectionString: r.processorAnon, max: 2 });
  const failure = await processCampaign(core, anon, D.campaignId).then(
    () => "NO_ERROR",
    (e: Error) => e.message,
  );
  await core.end();
  await anon.end();
  assert.notEqual(failure, "NO_ERROR");
  assert.equal(await markers(r.anon, D.campaignId), 0);
  results.baseProcessDFailure = failure;
  ok(`rollback: processing D fails closed (${failure}) and writes no anonymous row`);
}

// ======== Restore 2: replay the WAL archive to the end =======================================
{
  const r = at(PORTS.pitr);
  await ops.markRestorePending(r.core);
  const replay = await ops.reapplyTombstones(r.core, r.anon, LEDGER);
  results.pitrReplay = replay;
  assert.deepEqual(replay.incidents, []);
  assert.equal(replay.opened, true);
  assert.equal(await ready(r.core), true);
  assert.equal(await inbox(r.core, A.campaignId), 6);
  assert.equal(await inbox(r.core, B.campaignId), 6);
  assert.equal(await inbox(r.core, D.campaignId), 0);
  assert.equal(await markers(r.anon, D.campaignId), 6);
  assert.equal(await exportState(r.core, E), "EXPIRED");
  assert.equal(await exportState(r.core, F), "EXPIRED");
  assert.deepEqual(await ops.storeInconsistencies(r.core, r.anon), []);
  configureGateway(r.gateway);
  for (const token of B.tokens) assert.notEqual((await access(token)).access, "OPEN");
  ok("point-in-time restore: every acceptance survives, D is cleaned with its six anonymous rows, no link reopens, the environment opens with no incident");
}

// ======== Separate backup sets restored to different points ==================================
{
  const pitr = at(PORTS.pitr),
    base = at(PORTS.base);
  // Core at the end, anonymous store at the backup: D's committed output is gone.
  assert.deepEqual(await ops.storeInconsistencies(pitr.core, base.anon), [{ campaignId: D.campaignId, reason: "ANONYMOUS_OUTPUT_MISSING_FOR_COMMITTED_BATCH" }]);
  // Core at the backup, anonymous store at the end: the output is ahead of the core.
  const ahead = await ops.storeInconsistencies(base.core, pitr.anon);
  assert.ok(ahead.some((i) => i.campaignId === D.campaignId && i.reason === "ANONYMOUS_OUTPUT_AHEAD_OF_CORE"), JSON.stringify(ahead));
  // And the processor, given that pair, appends nothing to the anonymous store.
  const core = new pg.Pool({ connectionString: base.processorCore, max: 2 });
  const anon = new pg.Pool({ connectionString: pitr.processorAnon, max: 2 });
  const failure = await processCampaign(core, anon, D.campaignId).then(
    () => "NO_ERROR",
    (e: Error) => e.message,
  );
  await core.end();
  await anon.end();
  assert.notEqual(failure, "NO_ERROR");
  assert.equal(await markers(pitr.anon, D.campaignId), 6, "no duplicate anonymous rows");
  results.mixedProcessDFailure = failure;
  ok(`mixed restore points: both directions are reported, and processing refuses (${failure}) without duplicating D`);
}

configureGateway(undefined);
setCustodianSecret(undefined);
for (const dir of ["restore-base", "restore-pitr"]) sh("pg_ctl.exe", ["-D", join(ROOT, dir), "-m", "fast", "-w", "stop"]);
results.checks = checks;
results.finishedAt = new Date().toISOString();
await writeFile("work/p15-rollback-drill.json", JSON.stringify(results, null, 2));
console.log(`Rollback drill: ${checks.length} checks passed.`);
process.exit(0);
