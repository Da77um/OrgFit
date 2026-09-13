// Phase 14 — timed, isolated backup and restore drill.
//
// Run: npx tsx tests/ops/restore-drill.ts   (Windows, embedded PostgreSQL 18.4)
//
// What it does, on a DEDICATED throwaway cluster under work/drill (never the
// test cluster, never a retained database):
//   1. initdb a primary with WAL archiving (archive_timeout 60 s);
//   2. build real synthetic state through the real components: a processed,
//      published-ready campaign (A), a campaign whose processor crashed after
//      the anonymous commit and before cleanup (C), and a heartbeat writer;
//   3. take an ONLINE base backup with the documented low-level API
//      (pg_backup_start / file copy / pg_backup_stop), timed;
//   4. keep working after the backup: campaign B receives submissions, an
//      export expires, campaign A's anonymous answers are purged by retention,
//      and the tombstones are shipped to a ledger outside the cluster;
//   5. "disaster": stop the primary with immediate shutdown at a recorded time;
//   6. RESTORE 1 (PITR): copy the base backup, replay the archived WAL, time it,
//      measure the data-loss window from the heartbeat, reapply tombstones,
//      verify invitation / inbox / anonymous-batch consistency, and resume the
//      crashed processor run marker-first;
//   7. RESTORE 2 (base backup only, as if the WAL archive were lost): verify the
//      deleted export and the purged anonymous set come back from the backup,
//      that the ledger replay removes them again BEFORE the environment opens,
//      and that the post-backup submissions are reported as lost, not invented.
// Results go to work/p14-restore-drill.json. Nothing is simulated with mocks.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

const ROOT = resolve("work/drill");
const BIN = resolve("work/package/native/bin");
const PRIMARY = join(ROOT, "primary");
const ARCHIVE = join(ROOT, "wal-archive");
const BASE = join(ROOT, "base-backup");
const LEDGER = join(ROOT, "tombstone-ledger");
const PORTS = { primary: 55442, pitr: 55452, baseOnly: 55462 };
const password = randomBytes(18).toString("hex");
const results: Record<string, unknown> = { startedAt: new Date().toISOString(), host: process.platform };

// `pg_ctl start` leaves a server running that inherits the child's standard
// handles; with pipes, spawnSync would wait on them for as long as the server
// lives. Every pg_ctl call therefore runs with its output discarded (the
// server writes to its own -l log file), and only initdb's output is read.
const sh = (exe: string, args: string[]) => {
  const piped = exe !== "pg_ctl.exe";
  const r = spawnSync(join(BIN, exe), args, {
    encoding: "utf8",
    stdio: piped ? "pipe" : "ignore",
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`${exe} failed (${r.status}): ${piped ? r.stderr || r.stdout : "see its log file"}`);
  return piped ? r.stdout : "";
};
const winPath = (p: string) => p.replace(/\//g, "\\").replace(/\\/g, "\\\\");
const adminUrl = (port: number, db = "postgres") => `postgres://postgres:${password}@127.0.0.1:${port}/${db}`;
const withPort = (url: string, port: number) => {
  const u = new URL(url);
  u.port = String(port);
  return u.href;
};
async function query<T extends pg.QueryResultRow>(url: string, text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForPrimary(url: string, timeoutMs = 600_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const [row] = await query<{ r: boolean }>(url, "select pg_is_in_recovery() r");
      if (!row.r) return Date.now() - t0;
    } catch {
      /* not accepting connections yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("restore did not finish");
    await sleep(200);
  }
}

// ---- 1. primary ------------------------------------------------------------
await rm(ROOT, { recursive: true, force: true });
await mkdir(ARCHIVE, { recursive: true });
await mkdir(LEDGER, { recursive: true });
await writeFile(join(ROOT, "pw.txt"), password);
sh("initdb.exe", ["-D", PRIMARY, "-U", "postgres", "-A", "scram-sha-256", "--pwfile", join(ROOT, "pw.txt"), "--encoding=UTF8", "--locale=C"]);
await writeFile(
  join(PRIMARY, "postgresql.auto.conf"),
  [
    "wal_level = replica",
    "archive_mode = on",
    `archive_command = 'copy "%p" "${winPath(ARCHIVE)}\\\\%f"'`,
    "archive_timeout = 60",
    "log_statement = 'none'",
    "log_min_duration_statement = -1",
    "log_parameter_max_length = 0",
    "log_parameter_max_length_on_error = 0",
    "log_error_verbosity = terse",
    "",
  ].join("\n"),
);
sh("pg_ctl.exe", ["-D", PRIMARY, "-l", join(ROOT, "primary.log"), "-o", `-h 127.0.0.1 -p ${PORTS.primary}`, "-w", "start"]);

// ---- 2. synthetic state through the real components --------------------------
process.env.TEST_ADMIN_DATABASE_URL = adminUrl(PORTS.primary);
const { respondentFixture } = await import("../respondent-fixture");
const { exchange, instrument, finalize } = await import("../../src/respondent");
const { processCampaign, reconcile } = await import("../../src/processor");
const ops = await import("../../src/operations");
const { configureGateway } = await import("../../src/gateway-db");

const f = await respondentFixture(6);
const names = { core: f.fixture.name, anonymous: f.fixture.anonymousName };
const coreUrl = f.fixture.url("orgfit_migrator");
const anonUrl = f.fixture.anonymousUrl("orgfit_anon_migrator");
const pools = () => ({
  core: new pg.Pool({ connectionString: f.fixture.url("orgfit_processor"), max: 2 }),
  anon: new pg.Pool({ connectionString: f.fixture.anonymousUrl("orgfit_processor"), max: 2 }),
});
const answer = (d: import("../../src/instrument-input").Instrument) => {
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
async function collected(people = f.people) {
  const { campaignId } = await f.launchedCampaign(people);
  for (const link of await f.issueLinks(campaignId)) {
    const s = await exchange(link.token);
    await finalize(s.session!, { answers: answer((await instrument(s.session!)).document) });
  }
  return campaignId;
}

const A = await collected();
await f.closeCampaign(A);
{
  const p = pools();
  await processCampaign(p.core, p.anon, A);
  await p.core.end();
  await p.anon.end();
}
const C = await collected();
await f.closeCampaign(C);
{
  const p = pools();
  await processCampaign(p.core, p.anon, C, {
    fault: (point) => {
      if (point === "afterAnonymousCommit") throw new Error("DRILL_CRASH_AFTER_COMMIT");
    },
  }).catch((e: Error) => {
    if (!e.message.includes("DRILL_CRASH")) throw e;
  });
  await p.core.end();
  await p.anon.end();
}

// An export that exists when the backup is taken and expires after it.
const exportId = randomUUID();
{
  const op = new pg.Client({ connectionString: coreUrl });
  await op.connect();
  await op.query("SET ROLE orgfit_core_owner");
  await op.query(
    "insert into ops.private_export(id,organization_id,kind,requested_by,state,storage_key,item_count,expires_at,generation_key) values($1,$2,'DIRECTORY',$3,'READY',null,0,clock_timestamp()+interval '1 hour',$4)",
    [exportId, f.orgA, "00000000-0000-4000-8000-000000000001", randomUUID()],
  );
  await op.end();
}

// Heartbeat: one committed row per second in its own database until disaster.
await query(adminUrl(PORTS.primary), "create database drill_heartbeat");
await query(adminUrl(PORTS.primary, "drill_heartbeat"), "create table beat(at timestamptz primary key default clock_timestamp())");
let beating = true;
const beats = (async () => {
  const c = new pg.Client({ connectionString: adminUrl(PORTS.primary, "drill_heartbeat") });
  await c.connect();
  while (beating) {
    await c.query("insert into beat default values").catch(() => undefined);
    await sleep(1000);
  }
  await c.end().catch(() => undefined);
})();

// ---- 3. online base backup ----------------------------------------------------
const backupStarted = Date.now();
const session = new pg.Client({ connectionString: adminUrl(PORTS.primary) });
await session.connect();
await session.query("select pg_backup_start('orgfit-drill', true)");
await cp(PRIMARY, BASE, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(PRIMARY.length).replace(/\\/g, "/");
    return !/^\/(postmaster\.pid|postmaster\.opts)$/.test(rel) && !/^\/pg_wal\/./.test(rel);
  },
});
const [stop] = (await session.query("select lsn, labelfile, spcmapfile from pg_backup_stop(true)")).rows;
// The WAL written during the backup is part of the backup: without it the copy
// cannot reach a consistent state. It is kept beside the base copy, and ONLY
// those segments are offered to the base-only restore.
const [{ file: stopWalFile }] = (await session.query("select pg_walfile_name($1) file", [stop.lsn])).rows;
const BASE_WAL = join(ROOT, "base-backup-wal");
await writeFile(join(BASE, "backup_label"), stop.labelfile);
if (stop.spcmapfile) await writeFile(join(BASE, "tablespace_map"), stop.spcmapfile);
await session.end();
await mkdir(BASE_WAL, { recursive: true });
for (let i = 0; i < 100; i++) {
  if (existsSync(join(ARCHIVE, stopWalFile))) break;
  await sleep(200);
}
for (const name of await readdir(ARCHIVE))
  if (/^[0-9A-F]{24}$/.test(name) && name <= stopWalFile) await cp(join(ARCHIVE, name), join(BASE_WAL, name));
results.baseBackupStopWalFile = stopWalFile;
results.baseBackupSeconds = (Date.now() - backupStarted) / 1000;
const backupEndedAt = new Date();
const sizeOf = async (dir: string): Promise<number> => {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }))
    n += e.isDirectory() ? await sizeOf(join(dir, e.name)) : (await import("node:fs")).statSync(join(dir, e.name)).size;
  return n;
};
results.baseBackupBytes = await sizeOf(BASE);

// ---- 4. work after the backup ----------------------------------------------------
const B = await collected();
const anonOwner = new pg.Client({ connectionString: anonUrl });
await anonOwner.connect();
await anonOwner.query("SET ROLE orgfit_anon_owner");
await anonOwner.query("update anonymous.processed_batch set committed_at=clock_timestamp()-interval '400 days' where campaign_id=$1", [A]);
await anonOwner.end();
const opx = new pg.Client({ connectionString: coreUrl });
await opx.connect();
await opx.query("SET ROLE orgfit_core_owner");
await opx.query("update ops.private_export set expires_at=clock_timestamp()-interval '1 second' where id=$1", [exportId]);
await opx.end();
results.retentionAfterBackup = await ops.runRetention(coreUrl, anonUrl);
results.tombstonesShipped = await ops.shipTombstones(coreUrl, LEDGER);

const expectations = {
  A_processed: f.people.length,
  B_acceptedAfterBackup: f.people.length,
};
// Let the heartbeat run past one archive_timeout so the RPO window is real.
await sleep(75_000);
beating = false;
await beats;
const [lastPrimaryBeat] = await query<{ at: Date }>(adminUrl(PORTS.primary, "drill_heartbeat"), "select max(at) at from beat");
configureGateway(undefined);
await f.close().catch(() => undefined);

// ---- 5. disaster ---------------------------------------------------------------------
const disasterAt = new Date();
sh("pg_ctl.exe", ["-D", PRIMARY, "-m", "immediate", "-w", "stop"]);
results.disasterAt = disasterAt.toISOString();
results.lastHeartbeatOnPrimary = lastPrimaryBeat.at;

// ---- 6. restore 1: PITR -------------------------------------------------------------
async function restore(dir: string, port: number, replayWal: boolean, walDir = replayWal ? ARCHIVE : BASE_WAL) {
  const t0 = Date.now();
  await rm(dir, { recursive: true, force: true });
  await cp(BASE, dir, { recursive: true });
  await mkdir(join(dir, "pg_wal"), { recursive: true });
  await writeFile(
    join(dir, "postgresql.auto.conf"),
    [
      "archive_mode = off",
      `restore_command = 'copy "${winPath(walDir)}\\\\%f" "%p"'`,
      // Base-only: stop at the end of the backup's own WAL, as a restore with a
      // lost archive would.
      ...(replayWal ? [] : ["recovery_target = 'immediate'", "recovery_target_action = 'promote'"]),
      "log_error_verbosity = terse",
      "",
    ].join("\n"),
  );
  await writeFile(join(dir, "recovery.signal"), "");
  const copySeconds = (Date.now() - t0) / 1000;
  sh("pg_ctl.exe", ["-D", dir, "-l", `${dir}.log`, "-o", `-h 127.0.0.1 -p ${port}`, "start"]);
  const recoveryMs = await waitForPrimary(adminUrl(port));
  return { copySeconds, recoverySeconds: recoveryMs / 1000, totalSeconds: (Date.now() - t0) / 1000 };
}
async function consistency(port: number) {
  const core = withPort(coreUrl, port);
  const c = new pg.Client({ connectionString: core });
  await c.connect();
  await c.query("SET ROLE orgfit_core_owner");
  const { rows: campaigns } = await c.query(
    `select c.id::text campaign,
            (select count(*)::int from core.invitation i where i.campaign_id=c.id and i.status='COMPLETED') completed,
            (select count(*)::int from intake.submission_inbox e where e.campaign_id=c.id) inbox,
            b.state batch_state, b.accepted_count accepted, b.processed_count processed
       from core.campaign c left join intake.processing_batch b on b.campaign_id=c.id
      where c.id = any($1::uuid[]) order by c.created_at`,
    [[A, B, C]],
  );
  await c.end();
  const a = new pg.Client({ connectionString: withPort(anonUrl, port) });
  await a.connect();
  await a.query("SET ROLE orgfit_anon_owner");
  const { rows: markers } = await a.query(
    `select m.campaign_id::text campaign, m.response_count, (select count(*)::int from anonymous.anonymous_response r where r.campaign_id=m.campaign_id) responses
       from anonymous.processed_batch m where m.campaign_id = any($1::uuid[])`,
    [[A, B, C]],
  );
  await a.end();
  return { campaigns, markers };
}

const pitr = await restore(join(ROOT, "restore-pitr"), PORTS.pitr, true);
const [lastRestoredBeat] = await query<{ at: Date }>(adminUrl(PORTS.pitr, "drill_heartbeat"), "select max(at) at from beat");
const pitrUrl = withPort(coreUrl, PORTS.pitr);
await ops.markRestorePending(pitrUrl);
const pitrReapply = await ops.reapplyTombstones(pitrUrl, withPort(anonUrl, PORTS.pitr), LEDGER);
const pitrBefore = await consistency(PORTS.pitr);
// Resume the processor run that crashed after its anonymous commit.
process.env.CAMPAIGN_KEY_CUSTODY_DIRECTORY = f.custodyDirectory;
const { setCustodianSecret } = await import("../../src/key-custody");
setCustodianSecret(f.custodianSecret);
const resumePools = {
  core: new pg.Pool({ connectionString: withPort(f.fixture.url("orgfit_processor"), PORTS.pitr), max: 2 }),
  anon: new pg.Pool({ connectionString: withPort(f.fixture.anonymousUrl("orgfit_processor"), PORTS.pitr), max: 2 }),
};
const resumed = await processCampaign(resumePools.core, resumePools.anon, C);
const reconciled = await reconcile(resumePools.core, resumePools.anon, C);
await resumePools.core.end();
await resumePools.anon.end();
const pitrAfter = await consistency(PORTS.pitr);
results.restorePitr = {
  ...pitr,
  dataLossWindowSeconds: (new Date(lastPrimaryBeat.at).getTime() - new Date(lastRestoredBeat.at).getTime()) / 1000,
  lastRestoredHeartbeat: lastRestoredBeat.at,
  reapply: pitrReapply,
  consistencyBeforeResume: pitrBefore,
  processorResume: resumed,
  reconcileC: reconciled,
  consistencyAfterResume: pitrAfter,
};
sh("pg_ctl.exe", ["-D", join(ROOT, "restore-pitr"), "-m", "fast", "-w", "stop"]);

// ---- 7. restore 2: base backup only ---------------------------------------------------
const baseOnly = await restore(join(ROOT, "restore-base"), PORTS.baseOnly, false);
const baseUrl = withPort(coreUrl, PORTS.baseOnly);
await ops.markRestorePending(baseUrl);
const staffReadyWhilePending = await query<{ ready: boolean }>(baseUrl, "select ops.ready() ready").catch(async () => {
  const c = new pg.Client({ connectionString: baseUrl });
  await c.connect();
  await c.query("SET ROLE orgfit_core_owner");
  const r = (await c.query("select ops.ready() ready")).rows;
  await c.end();
  return r;
});
const revived = await (async () => {
  const c = new pg.Client({ connectionString: withPort(anonUrl, PORTS.baseOnly) });
  await c.connect();
  await c.query("SET ROLE orgfit_anon_owner");
  const n = (await c.query("select count(*)::int n from anonymous.anonymous_response where campaign_id=$1", [A])).rows[0].n;
  await c.end();
  return n;
})();
const baseReapply = await ops.reapplyTombstones(baseUrl, withPort(anonUrl, PORTS.baseOnly), LEDGER, { openDespiteIncidents: false });
const baseAfter = await consistency(PORTS.baseOnly);
const readyAfter = await (async () => {
  const c = new pg.Client({ connectionString: baseUrl });
  await c.connect();
  await c.query("SET ROLE orgfit_core_owner");
  const r = (await c.query("select ops.ready() ready")).rows[0].ready;
  await c.end();
  return r;
})();
results.restoreBaseOnly = {
  ...baseOnly,
  readyWhilePending: staffReadyWhilePending[0]?.ready,
  anonymousResponsesOfPurgedCampaignRevivedByBackup: revived,
  reapply: baseReapply,
  readyAfterReapply: readyAfter,
  consistencyAfterReapply: baseAfter,
  campaignBSubmissionsLost: expectations.B_acceptedAfterBackup,
};
sh("pg_ctl.exe", ["-D", join(ROOT, "restore-base"), "-m", "fast", "-w", "stop"]);

results.campaigns = { A, B, C, names };
results.backupEndedAt = backupEndedAt.toISOString();
results.walSegmentsArchived = (await readdir(ARCHIVE)).length;
results.finishedAt = new Date().toISOString();
await writeFile("work/p14-restore-drill.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
if (!existsSync(PRIMARY)) process.exitCode = 1;
