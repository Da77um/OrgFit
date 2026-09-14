import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";
import { deleteAttachment } from "./attachment-storage";
import { destroyCampaignKey } from "./key-custody";
import { databaseUrl } from "./runtime-guard";

// ---------------------------------------------------------------------------
// Operations (Phase 14): retention, tombstone shipping, the restore replay and
// alert evaluation.
//
// These run as OPERATOR jobs, never inside a web process: the core side uses
// orgfit_migrator acting as orgfit_core_owner and the anonymous side uses
// orgfit_anon_migrator acting as orgfit_anon_owner. Nothing here selects an
// answer, a draft's content, a token or a participant. Every value it moves is
// a count, an object identifier or a campaign identifier.
// ---------------------------------------------------------------------------

type Tombstone = {
  seq: number;
  class:
    | "ATTACHMENT"
    | "REPORT_ARTIFACT"
    | "PRIVATE_EXPORT"
    | "CAMPAIGN_INTAKE"
    | "CAMPAIGN_KEY"
    | "ANONYMOUS_CAMPAIGN"
    // Post-Audit Repair Pass 3 (022): a withdrawn release, subject = snapshot.
    | "RELEASE_REVOCATION";
  organizationId: string;
  subjectId: string;
  recordedAt: string;
};

// Login, password and — in production — verified TLS, checked before any
// connection (RC-004; src/runtime-guard.ts).
export function operatorUrl(url = process.env.MIGRATION_DATABASE_URL) {
  return databaseUrl(url, "orgfit_migrator");
}
export function anonymousOperatorUrl(url = process.env.ANONYMOUS_MIGRATION_DATABASE_URL) {
  return databaseUrl(url, "orgfit_anon_migrator");
}

async function as<T>(url: string, role: string, work: (c: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`SET ROLE ${role}`);
    return await work(client);
  } finally {
    await client.end();
  }
}
const core = <T>(url: string, work: (c: pg.Client) => Promise<T>) =>
  as(operatorUrl(url), "orgfit_core_owner", work);
const anonymous = <T>(url: string, work: (c: pg.Client) => Promise<T>) =>
  as(anonymousOperatorUrl(url), "orgfit_anon_owner", work);

// ---- retention --------------------------------------------------------------

/** One retention pass. Core classes are purged by time; anonymous campaigns
 *  whose batch is older than the policy are purged whole and tombstoned. */
export async function runRetention(coreUrl: string, anonUrl: string) {
  const coreResult = await core(coreUrl, async (c) => {
    const purged = (await c.query("SELECT ops.purge_core(5000) AS data")).rows[0].data as Record<string, number>;
    const retain = (await c.query("SELECT retain::text AS retain FROM ops.retention_policy WHERE class='anonymous_response'"))
      .rows[0].retain as string;
    return { purged, retain };
  });
  const campaigns = await anonymous(anonUrl, async (c) =>
    (await c.query("SELECT anonymous.purge_expired($1::interval, 50) AS data", [coreResult.retain])).rows[0]
      .data as { organizationId: string; campaignId: string }[],
  );
  await core(coreUrl, async (c) => {
    for (const x of campaigns)
      await c.query("SELECT ops.record_anonymous_purge($1,$2)", [x.organizationId, x.campaignId]);
  });
  return { ...coreResult.purged, anonymous_campaigns: campaigns.length } as Record<string, number>;
}

// ---- tombstone ledger ---------------------------------------------------------
//
// The ledger lives OUTSIDE the database and outside database backups, so it
// survives the very restore it exists to correct. It is append-only JSONL with
// an fsync per batch and a cursor written by rename.

const ledgerFile = (dir: string) => join(resolve(dir), "tombstones.jsonl");
const cursorFile = (dir: string) => join(resolve(dir), "cursor");

export async function readLedger(dir: string): Promise<Tombstone[]> {
  const text = await readFile(ledgerFile(dir), "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  const seen = new Map<number, Tombstone>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const t = JSON.parse(line) as Tombstone;
    seen.set(t.seq, t);
  }
  return [...seen.values()].sort((a, b) => a.seq - b.seq);
}

export async function shipTombstones(coreUrl: string, dir: string) {
  await mkdir(resolve(dir), { recursive: true });
  const after = Number((await readFile(cursorFile(dir), "utf8").catch(() => "0")).trim() || "0");
  let cursor = after,
    shipped = 0;
  for (;;) {
    const batch = await core(coreUrl, async (c) =>
      (await c.query("SELECT ops.tombstones_after($1,1000) AS data", [cursor])).rows[0].data as Tombstone[],
    );
    if (!batch.length) break;
    const handle = await open(ledgerFile(dir), "a");
    try {
      await handle.write(batch.map((t) => JSON.stringify(t)).join("\n") + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    cursor = batch[batch.length - 1].seq;
    shipped += batch.length;
    await writeFile(cursorFile(dir) + ".tmp", String(cursor));
    await rename(cursorFile(dir) + ".tmp", cursorFile(dir));
  }
  return { shipped, cursor };
}

// ---- restore -------------------------------------------------------------------

/** The first statement a restored core database runs, before any application
 *  is pointed at it. Staff readiness fails from here until the replay ends. */
export const markRestorePending = (coreUrl: string) =>
  core(coreUrl, (c) => c.query("SELECT ops.set_restore_state('REAPPLY_PENDING')"));

export type ReapplyReport = {
  applied: Record<Tombstone["class"], number>;
  incidents: { campaignId: string; reason: string }[];
  retention: Record<string, number>;
  opened: boolean;
};

/** Replay the external ledger into a restored environment, re-run retention,
 *  and open the environment only if no incident needs a human decision. */
export async function reapplyTombstones(
  coreUrl: string,
  anonUrl: string,
  dir: string,
  options: { openDespiteIncidents?: boolean } = {},
): Promise<ReapplyReport> {
  const ledger = await readLedger(dir);
  const applied: ReapplyReport["applied"] = {
    ATTACHMENT: 0,
    REPORT_ARTIFACT: 0,
    PRIVATE_EXPORT: 0,
    CAMPAIGN_INTAKE: 0,
    CAMPAIGN_KEY: 0,
    ANONYMOUS_CAMPAIGN: 0,
    RELEASE_REVOCATION: 0,
  };
  const incidents: ReapplyReport["incidents"] = [];

  // Anonymous purges first: whether intake may be deleted depends on whether
  // the restored anonymous store still holds the campaign's committed output.
  for (const t of ledger.filter((x) => x.class === "ANONYMOUS_CAMPAIGN")) {
    const n = await anonymous(anonUrl, async (c) =>
      (await c.query("SELECT anonymous.purge_campaign($1,$2) AS n", [t.organizationId, t.subjectId])).rows[0].n as number,
    );
    if (n > 0) applied.ANONYMOUS_CAMPAIGN++;
  }
  const purgedAnonymously = new Set(
    ledger.filter((x) => x.class === "ANONYMOUS_CAMPAIGN").map((x) => x.subjectId),
  );

  for (const t of ledger) {
    if (t.class === "ATTACHMENT") {
      const changed = await core(coreUrl, async (c) =>
        (await c.query("UPDATE core.attachment SET scan_status='EXPIRED',expires_at=coalesce(expires_at,clock_timestamp()) WHERE id=$1 AND organization_id=$2 AND scan_status<>'EXPIRED'", [t.subjectId, t.organizationId])).rowCount ?? 0,
      );
      await deleteAttachment(t.organizationId, t.subjectId);
      if (changed) applied.ATTACHMENT++;
    } else if (t.class === "REPORT_ARTIFACT") {
      const changed = await core(coreUrl, async (c) =>
        (await c.query("UPDATE ops.report_job SET state='EXPIRED',storage_key=NULL WHERE id=$1 AND organization_id=$2 AND state='READY'", [t.subjectId, t.organizationId])).rowCount ?? 0,
      );
      if (changed) applied.REPORT_ARTIFACT++;
    } else if (t.class === "PRIVATE_EXPORT") {
      const changed = await core(coreUrl, async (c) =>
        (await c.query("UPDATE ops.private_export SET state='EXPIRED' WHERE id=$1 AND organization_id=$2 AND state NOT IN ('EXPIRED','REVOKED')", [t.subjectId, t.organizationId])).rowCount ?? 0,
      );
      if (changed) applied.PRIVATE_EXPORT++;
    } else if (t.class === "CAMPAIGN_INTAKE") {
      // Intake may be erased again only where erasing it loses nothing the
      // restore did not already lose: the anonymous marker exists, the campaign
      // was below its threshold, or the anonymous output was itself purged.
      const decision = await core(coreUrl, async (c) => {
        const { rows } = await c.query(
          `SELECT c.threshold,(SELECT count(*)::int FROM intake.submission_inbox e WHERE e.campaign_id=c.id) inbox
             FROM core.campaign c WHERE c.id=$1 AND c.organization_id=$2`,
          [t.subjectId, t.organizationId],
        );
        return rows[0] as { threshold: number; inbox: number } | undefined;
      });
      if (!decision || decision.inbox === 0) continue;
      const marker = await anonymous(anonUrl, async (c) =>
        (await c.query("SELECT 1 FROM anonymous.processed_batch WHERE organization_id=$1 AND campaign_id=$2", [t.organizationId, t.subjectId])).rowCount,
      );
      if (marker || decision.inbox < decision.threshold || purgedAnonymously.has(t.subjectId)) {
        await core(coreUrl, async (c) => {
          await c.query("BEGIN");
          await c.query("DELETE FROM intake.submission_inbox WHERE campaign_id=$1", [t.subjectId]);
          await c.query("DELETE FROM intake.draft_blob WHERE campaign_id=$1", [t.subjectId]);
          await c.query("DELETE FROM intake.respondent_session WHERE campaign_id=$1", [t.subjectId]);
          await c.query("COMMIT");
        });
        applied.CAMPAIGN_INTAKE++;
      } else {
        // Accepted envelopes whose anonymous output the restore lost, for a
        // campaign whose intake had already been erased once. This is the
        // blueprint's "unrecoverable accepted payload": it is reported, the
        // envelopes are kept, and the environment is not opened automatically.
        incidents.push({ campaignId: t.subjectId, reason: "ANONYMOUS_OUTPUT_MISSING_FOR_ERASED_INTAKE" });
      }
    } else if (t.class === "CAMPAIGN_KEY") {
      const refs = await core(coreUrl, async (c) => {
        const { rows } = await c.query(
          "UPDATE intake.campaign_key SET state='DESTROYED' WHERE campaign_id=$1 AND organization_id=$2 AND state<>'DESTROYED' RETURNING key_reference",
          [t.subjectId, t.organizationId],
        );
        return rows.map((r) => r.key_reference as string);
      });
      // A restored custody store may hold the sealed key again; it is removed
      // again. That is the local stand-in's whole erasure story (P-003).
      for (const ref of refs) await destroyCampaignKey(ref).catch(() => undefined);
      if (refs.length) applied.CAMPAIGN_KEY++;
    } else if (t.class === "RELEASE_REVOCATION") {
      // A release withdrawn after the backup was taken is published again in
      // the restored database. It is withdrawn again, with its dependent report
      // jobs, before either readiness opens.
      const changed = await core(coreUrl, async (c) =>
        (await c.query("SELECT publication.reapply_revocation($1,$2) AS changed", [t.organizationId, t.subjectId]))
          .rows[0].changed as boolean,
      );
      if (changed) applied.RELEASE_REVOCATION++;
    }
  }

  // The two stores are backed up separately, so a restore can bring them back
  // to different points. Neither direction may pass silently (Phase 15, D-123).
  incidents.push(...(await storeInconsistencies(coreUrl, anonUrl, ledger)));

  const retention = await runRetention(coreUrl, anonUrl);
  const opened = incidents.length === 0 || !!options.openDespiteIncidents;
  if (opened) await core(coreUrl, (c) => c.query("SELECT ops.set_restore_state('NORMAL')"));
  return { applied, incidents, retention, opened };
}

// ---- cross-store reconciliation ------------------------------------------------
//
// The core batch record and the anonymous batch marker must agree:
//  * a core batch whose output was committed (OUTPUT_COMMITTED, CLEANUP_PENDING,
//    CLEANED) needs its marker with the same batch id and count, unless the
//    anonymous set was purged on purpose (an ANONYMOUS_CAMPAIGN tombstone).
//    Otherwise an anonymous store restored to an earlier point than the core
//    has lost accepted answers whose intake was already erased — silently,
//    because every core-side count still agrees;
//  * a marker with no core batch of the same id means the anonymous store is
//    ahead of the core: invitations may be READY again, and the processor
//    would refuse the campaign with MARKER_MISMATCH.
// Identifiers and counts only; nothing here reads an answer.

export async function storeInconsistencies(coreUrl: string, anonUrl: string, ledger?: Tombstone[]) {
  const coreSide = await core(coreUrl, async (c) => ({
    batches: (
      await c.query(
        "SELECT id::text AS id, campaign_id::text AS campaign, state, processed_count FROM intake.processing_batch",
      )
    ).rows as { id: string; campaign: string; state: string; processed_count: number | null }[],
    purged: (
      await c.query("SELECT subject_id::text AS id FROM ops.deletion_tombstone WHERE class='ANONYMOUS_CAMPAIGN'")
    ).rows.map((r) => r.id as string),
  }));
  const markers = await anonymous(anonUrl, async (c) =>
    (await c.query("SELECT id::text AS id, campaign_id::text AS campaign, response_count FROM anonymous.processed_batch"))
      .rows as { id: string; campaign: string; response_count: number }[],
  );
  const purged = new Set([
    ...coreSide.purged,
    ...(ledger ?? []).filter((t) => t.class === "ANONYMOUS_CAMPAIGN").map((t) => t.subjectId),
  ]);
  const markerOf = new Map(markers.map((m) => [m.campaign, m]));
  const batchOf = new Map(coreSide.batches.map((b) => [b.campaign, b]));
  const found: { campaignId: string; reason: string }[] = [];
  for (const b of coreSide.batches) {
    if (!["OUTPUT_COMMITTED", "CLEANUP_PENDING", "CLEANED"].includes(b.state) || !b.processed_count) continue;
    if (purged.has(b.campaign)) continue;
    const m = markerOf.get(b.campaign);
    if (!m) found.push({ campaignId: b.campaign, reason: "ANONYMOUS_OUTPUT_MISSING_FOR_COMMITTED_BATCH" });
    else if (m.id !== b.id || m.response_count !== b.processed_count)
      found.push({ campaignId: b.campaign, reason: "ANONYMOUS_MARKER_MISMATCH" });
  }
  for (const m of markers) {
    const b = batchOf.get(m.campaign);
    if (!b || b.id !== m.id) found.push({ campaignId: m.campaign, reason: "ANONYMOUS_OUTPUT_AHEAD_OF_CORE" });
  }
  return found;
}

// ---- alerts ----------------------------------------------------------------------

export type AlertInputs = {
  restoreState: string;
  countMismatch: number;
  blockedReleases: number;
  closedUnprocessedOverdue: number;
  insufficientIntakeOverdue: number;
  reportQueueOldestSeconds: number;
  reportFailedLastDay: number;
  attachmentQuarantineOldestSeconds: number;
  rateLimitedLastWindow: number;
  lastRetentionRun: string | null;
  unapprovedRetentionClasses: number;
  /** Cross-store disagreements; present only when the check can reach both stores. */
  storeInconsistencies?: number;
  /** Per-job health from ops.job_health() (023); present when it was read. */
  jobs?: JobHealth[];
};
export type JobHealth = {
  job: string;
  process: string;
  expectedIntervalSeconds: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  consecutiveFailures: number;
  health: "OK" | "FAILING" | "STALE" | "NEVER_RUN";
};
export type Alert = { code: string; severity: "critical" | "warning"; value: number | string };

export const ALERT_THRESHOLDS = {
  reportQueueSeconds: 15 * 60,
  attachmentQuarantineSeconds: 60 * 60,
  retentionStaleHours: 26,
  backupStaleHours: 26,
  freeDiskFraction: 0.1,
};

/** Pure evaluation, so every alert can be drilled without waiting for time. */
export function evaluateAlerts(
  input: AlertInputs,
  host: { backupAgeHours: number | null; freeDiskFraction: number | null },
  now = Date.now(),
): Alert[] {
  const alerts: Alert[] = [];
  const add = (code: string, severity: Alert["severity"], value: number | string) =>
    alerts.push({ code, severity, value });
  if (input.restoreState !== "NORMAL") add("RESTORE_REAPPLY_PENDING", "critical", input.restoreState);
  if (input.countMismatch > 0) add("INTAKE_PROCESSED_COUNT_MISMATCH", "critical", input.countMismatch);
  if (input.storeInconsistencies) add("ANONYMOUS_STORE_INCONSISTENT", "critical", input.storeInconsistencies);
  if (input.blockedReleases > 0) add("PUBLICATION_BLOCKED", "critical", input.blockedReleases);
  if (input.closedUnprocessedOverdue > 0) add("CLOSED_CAMPAIGN_UNPROCESSED", "warning", input.closedUnprocessedOverdue);
  if (input.insufficientIntakeOverdue > 0) add("INSUFFICIENT_INTAKE_RETENTION_OVERDUE", "critical", input.insufficientIntakeOverdue);
  if (input.reportQueueOldestSeconds > ALERT_THRESHOLDS.reportQueueSeconds) add("REPORT_QUEUE_BACKLOG", "warning", input.reportQueueOldestSeconds);
  if (input.reportFailedLastDay > 0) add("EXPORT_FAILURES", "warning", input.reportFailedLastDay);
  if (input.attachmentQuarantineOldestSeconds > ALERT_THRESHOLDS.attachmentQuarantineSeconds) add("SCAN_BACKLOG", "warning", input.attachmentQuarantineOldestSeconds);
  if (input.rateLimitedLastWindow > 0) add("TOKEN_ABUSE_SUSPECTED", "warning", input.rateLimitedLastWindow);
  if (!input.lastRetentionRun || now - Date.parse(input.lastRetentionRun) > ALERT_THRESHOLDS.retentionStaleHours * 3600_000)
    add("RETENTION_NOT_RUNNING", "warning", input.lastRetentionRun ?? "never");
  if (input.unapprovedRetentionClasses > 0) add("RETENTION_POLICY_UNAPPROVED", "warning", input.unapprovedRetentionClasses);
  if (host.backupAgeHours === null || host.backupAgeHours > ALERT_THRESHOLDS.backupStaleHours)
    add("BACKUP_STALE_OR_MISSING", "critical", host.backupAgeHours ?? "none");
  if (host.freeDiskFraction !== null && host.freeDiskFraction < ALERT_THRESHOLDS.freeDiskFraction)
    add("LOW_DISK", "critical", Number(host.freeDiskFraction.toFixed(3)));
  // Job health (Post-Audit Repair Pass 3). A job that stopped succeeding is
  // critical for the privacy processor and publication — accepted answers wait
  // and results never appear — and a warning elsewhere. The value is the job
  // name, never an identifier of anything the job touched. ops:check itself is
  // not judged here: if it is not running, nothing evaluates this.
  for (const job of input.jobs ?? []) {
    if (job.job === "ops:check" || job.health === "OK") continue;
    const important = job.process === "processor" || job.job === "tombstones:ship";
    if (job.health === "FAILING")
      add("JOB_FAILING", important && job.consecutiveFailures >= JOB_FAILURES_CRITICAL ? "critical" : "warning", job.job);
    else if (job.health === "STALE") add("JOB_STALE", important ? "critical" : "warning", job.job);
    else add("JOB_NEVER_RUN", "warning", job.job);
  }
  return alerts;
}
/** Consecutive failures after which a processor job's failure is critical. */
export const JOB_FAILURES_CRITICAL = 3;

export const alertInputs = (coreUrl: string) =>
  core(coreUrl, async (c) => (await c.query("SELECT ops.alert_inputs() AS data")).rows[0].data as AlertInputs);

export const jobHealth = (coreUrl: string) =>
  core(coreUrl, async (c) =>
    (await c.query("SELECT ops.job_health() AS data")).rows[0].data as {
      jobs: JobHealth[];
      backlog: Record<string, number>;
    },
  );
