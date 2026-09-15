import pg from "pg";
import { deleteAttachment } from "./attachment-storage";
import { destroyCampaignKey } from "./key-custody";
import { RuntimeGuardError, databaseUrl } from "./runtime-guard";
import { localFileSink, sealHash, type Tombstone, type TombstoneSink } from "./tombstone-ledger";

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
  const staffRate = await core(coreUrl, async (c) => {
    for (const x of campaigns)
      await c.query("SELECT ops.record_anonymous_purge($1,$2)", [x.organizationId, x.campaignId]);
    // Staff-side rate counters (024), on the same retention class.
    return (await c.query("SELECT ops.purge_staff_rate_limit(5000) AS n")).rows[0].n as number;
  });
  return {
    ...coreResult.purged,
    rate_limit_window: (coreResult.purged.rate_limit_window ?? 0) + staffRate,
    anonymous_campaigns: campaigns.length,
  } as Record<string, number>;
}

// ---- tombstone ledger ---------------------------------------------------------
//
// The ledger lives OUTSIDE the database and outside database backups, so it
// survives the very restore it exists to correct. Where and how it is kept —
// a local directory in development, an S3-compatible bucket with conditional
// creates and Object Lock in production — is src/tombstone-ledger.ts. A plain
// directory path is accepted wherever a sink is, for the local drills.

const sinkOf = (target: string | TombstoneSink) => (typeof target === "string" ? localFileSink(target) : target);

/** Every tombstone in the ledger, after verifying its seals. */
export async function readLedger(target: string | TombstoneSink): Promise<Tombstone[]> {
  return (await sinkOf(target).read()).tombstones;
}

/**
 * Ship new tombstones to the ledger, batch by sealed batch, and record in the
 * core database how far the ledger is known to reach (the TOMBSTONE_SHIPPING_
 * BEHIND alert reads it). Refuses — without writing — when the database's
 * tombstone sequence is behind what the ledger already holds (PR4-001): a
 * restored database that has not been replayed would give new tombstones
 * sequence numbers the cursor has already passed, and they would never ship.
 */
export async function shipTombstones(coreUrl: string, target: string | TombstoneSink) {
  const sink = sinkOf(target);
  const ledger = await sink.read();
  let previous = await sink.repair(ledger);
  const after = await sink.cursor(ledger);
  const sequence = await core(coreUrl, async (c) =>
    Number(
      (await c.query("SELECT coalesce(pg_sequence_last_value(pg_get_serial_sequence('ops.deletion_tombstone','seq')::regclass),0) AS v"))
        .rows[0].v,
    ),
  );
  if (sequence < Math.max(after, ledger.maxSeq)) throw new RuntimeGuardError("TOMBSTONE_SEQUENCE_BEHIND_LEDGER");
  let cursor = after,
    shipped = 0;
  for (;;) {
    const batch = await core(coreUrl, async (c) =>
      (await c.query("SELECT ops.tombstones_after($1,1000) AS data", [cursor])).rows[0].data as Tombstone[],
    );
    if (!batch.length) break;
    previous = sealHash(await sink.append(batch, previous));
    cursor = batch[batch.length - 1].seq;
    shipped += batch.length;
    await sink.saveCursor(cursor);
  }
  await core(coreUrl, (c) => c.query("SELECT ops.record_tombstone_shipment($1,$2,$3)", [cursor, sink.kind, shipped]));
  return { shipped, cursor, sink: sink.kind };
}

export type TombstoneDeliveryStatus = {
  maxSeq: number;
  shippedThrough: number;
  lastShippedAt: string | null;
  unshipped: number;
  oldestUnshippedSeconds: number;
};
export const tombstoneDeliveryStatus = (coreUrl: string) =>
  core(coreUrl, async (c) => (await c.query("SELECT ops.tombstone_delivery_status() AS data")).rows[0].data as TombstoneDeliveryStatus);

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
  target: string | TombstoneSink,
  options: { openDespiteIncidents?: boolean } = {},
): Promise<ReapplyReport> {
  // A ledger whose seals do not verify is refused here: the environment stays
  // closed rather than being opened on a ledger that may have lost entries.
  const read = await sinkOf(target).read();
  const ledger = read.tombstones;
  // PR4-001: before anything below records a tombstone, move the restored
  // database's sequence past every number the ledger already holds.
  await core(coreUrl, (c) => c.query("SELECT ops.advance_tombstone_sequence($1)", [read.maxSeq]));
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
      const decision = await intakeDecision(coreUrl, anonUrl, t, purgedAnonymously);
      if (decision.kind === "NOTHING") continue;
      if (decision.kind === "ERASE") {
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

// Intake may be erased again only where erasing it loses nothing the restore
// did not already lose: the anonymous marker exists, the campaign was below its
// threshold, or the anonymous output was itself purged. Otherwise it is the
// incident ANONYMOUS_OUTPUT_MISSING_FOR_ERASED_INTAKE, decided by a person.
async function intakeDecision(
  coreUrl: string,
  anonUrl: string,
  t: Pick<Tombstone, "organizationId" | "subjectId">,
  purgedAnonymously: Set<string>,
): Promise<{ kind: "NOTHING" } | { kind: "ERASE" | "INCIDENT"; inbox: number }> {
  const found = await core(coreUrl, async (c) => {
    const { rows } = await c.query(
      `SELECT c.threshold,(SELECT count(*)::int FROM intake.submission_inbox e WHERE e.campaign_id=c.id) inbox
         FROM core.campaign c WHERE c.id=$1 AND c.organization_id=$2`,
      [t.subjectId, t.organizationId],
    );
    return rows[0] as { threshold: number; inbox: number } | undefined;
  });
  if (!found || found.inbox === 0) return { kind: "NOTHING" };
  const marker = await anonymous(anonUrl, async (c) =>
    (await c.query("SELECT 1 FROM anonymous.processed_batch WHERE organization_id=$1 AND campaign_id=$2", [t.organizationId, t.subjectId])).rowCount,
  );
  if (marker || found.inbox < found.threshold || purgedAnonymously.has(t.subjectId)) return { kind: "ERASE", inbox: found.inbox };
  return { kind: "INCIDENT", inbox: found.inbox };
}

// ---- whole-campaign intake erasure for an approved restore incident (SEC-M6) ----

export type IntakeErasureInput = {
  organizationId: string;
  campaignId: string;
  approverEmail: string;
  incidentReference: string;
  reason: string;
  /** The number of envelopes the operator saw in the incident report and
   *  expects to erase; any other number refuses (CONFIRMATION_MISMATCH). */
  expectedEnvelopes: number;
};
export type IntakeErasureResult = {
  id: string;
  campaignId: string;
  replayed: boolean;
  envelopesErased: number;
  draftsErased: number;
  sessionsErased: number;
};

/**
 * Erase the encrypted intake a restore brought back for ONE campaign, after the
 * owner has decided the incident. It refuses unless the verified ledger reports
 * exactly ANONYMOUS_OUTPUT_MISSING_FOR_ERASED_INTAKE for that campaign right
 * now; the database routine then requires the restore gate, a closed campaign,
 * an active Super Admin approver, the incident reference, a reason and the
 * expected envelope count, and records the erasure, its audit row and the
 * CAMPAIGN_INTAKE tombstone. A retried command with the same incident
 * reference returns the same record. Nothing anonymous is touched and no
 * envelope is read.
 */
export async function eraseCampaignIntake(
  coreUrl: string,
  anonUrl: string,
  target: string | TombstoneSink,
  input: IntakeErasureInput,
): Promise<IntakeErasureResult> {
  const ledger = await readLedger(target);
  const stone = ledger.find(
    (t) => t.class === "CAMPAIGN_INTAKE" && t.subjectId === input.campaignId && t.organizationId === input.organizationId,
  );
  const purged = new Set(ledger.filter((x) => x.class === "ANONYMOUS_CAMPAIGN").map((x) => x.subjectId));
  const replay = async () =>
    core(coreUrl, async (c) => {
      const { rows } = await c.query(
        `SELECT id, campaign_id, envelopes_erased, drafts_erased, sessions_erased FROM ops.intake_erasure
          WHERE organization_id=$1 AND campaign_id=$2 AND incident_reference=$3`,
        [input.organizationId, input.campaignId, input.incidentReference.trim()],
      );
      return rows[0]
        ? ({
            id: rows[0].id,
            campaignId: rows[0].campaign_id,
            replayed: true,
            envelopesErased: rows[0].envelopes_erased,
            draftsErased: rows[0].drafts_erased,
            sessionsErased: rows[0].sessions_erased,
          } as IntakeErasureResult)
        : null;
    });
  if (!stone) throw new Error("NOT_A_RESTORE_INCIDENT");
  const decision = await intakeDecision(coreUrl, anonUrl, stone, purged);
  if (decision.kind !== "INCIDENT") {
    // Already erased by this same decision: the retry gets the record.
    const earlier = await replay();
    if (earlier) return earlier;
    throw new Error("NOT_A_RESTORE_INCIDENT");
  }
  return core(coreUrl, async (c) =>
    (
      await c.query("SELECT ops.erase_campaign_intake($1,$2,$3,$4,$5,$6) AS data", [
        input.organizationId,
        input.campaignId,
        input.approverEmail,
        input.incidentReference,
        input.reason,
        input.expectedEnvelopes,
      ])
    ).rows[0].data as IntakeErasureResult,
  );
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
  /** Pass 4 (024): age of the oldest tombstone not yet recorded as shipped. */
  tombstoneOldestUnshippedSeconds?: number;
  /** Pass 4 (024): staff requests refused by the application limits, last 10 min. */
  staffPreSessionLimited?: number;
  staffApiLimited?: number;
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
  // Three times the proposed 5-minute shipping cadence: past this, a restore
  // could resurrect deletions no ledger knows about.
  tombstoneUnshippedSeconds: 15 * 60,
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
  if ((input.tombstoneOldestUnshippedSeconds ?? 0) > ALERT_THRESHOLDS.tombstoneUnshippedSeconds)
    add("TOMBSTONE_SHIPPING_BEHIND", "critical", input.tombstoneOldestUnshippedSeconds!);
  if ((input.staffPreSessionLimited ?? 0) > 0) add("STAFF_SIGN_IN_ABUSE_SUSPECTED", "warning", input.staffPreSessionLimited!);
  if ((input.staffApiLimited ?? 0) > 0) add("STAFF_API_RATE_LIMITED", "warning", input.staffApiLimited!);
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
  core(coreUrl, async (c) => {
    const base = (await c.query("SELECT ops.alert_inputs() AS data")).rows[0].data as AlertInputs;
    const delivery = (await c.query("SELECT ops.tombstone_delivery_status() AS data")).rows[0].data as TombstoneDeliveryStatus;
    const staff = (await c.query("SELECT ops.staff_rate_limited_recent() AS data")).rows[0].data as { preSession: number; api: number };
    return {
      ...base,
      tombstoneOldestUnshippedSeconds: delivery.oldestUnshippedSeconds,
      staffPreSessionLimited: Number(staff.preSession),
      staffApiLimited: Number(staff.api),
    } as AlertInputs;
  });

export const jobHealth = (coreUrl: string) =>
  core(coreUrl, async (c) =>
    (await c.query("SELECT ops.job_health() AS data")).rows[0].data as {
      jobs: JobHealth[];
      backlog: Record<string, number>;
    },
  );
