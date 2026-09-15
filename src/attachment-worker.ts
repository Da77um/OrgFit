import { createHash } from "node:crypto";
import type pg from "pg";
import {
  verifyAttachment,
  type RejectionCode,
  type AllowedType,
} from "./attachment-scan";
import {
  getAttachment,
  deleteAttachment,
  ATTACHMENT_RETENTION_DAYS,
} from "./attachment-storage";
import { engineFromEnvironment, type EngineName, type MalwareEngine } from "./malware-engine";

// ---------------------------------------------------------------------------
// The scan loop.
//
// Claim a quarantined attachment, read the bytes back out of private storage,
// prove what they actually are, have a malware engine look at them, record the
// verdict. It reaches nothing else: there is no organization parameter it
// chose, no visit lookup, no participant query and no anonymous connection
// anywhere in this file, because the credential it runs under could not
// execute one.
//
// Two separate controls decide a file (Post-Audit Repair Pass 4):
//   * type, size, container and active-document policy (attachment-scan.ts);
//   * the malware engine (malware-engine.ts).
// CLEAN needs both: the type check passed AND the engine answered
// NO_THREAT_FOUND. Every verdict records the engine's name, so a file passed
// only by the development heuristic is never indistinguishable from one a
// maintained engine looked at.
//
// Failure is fail-closed in both directions. An unreadable object, an engine
// timeout or an answer that is not a verdict records FAILED, which the database
// turns back into QUARANTINED until the attempt budget is spent. An engine that
// cannot be reached at all is checked BEFORE anything is claimed, and a claim
// it interrupts is released without spending an attempt: an outage says
// nothing about the file. An unscanned file is never downloadable.
// ---------------------------------------------------------------------------

export type ClaimedAttachment = {
  id: string;
  organizationId: string;
  storageKey: string;
  originalName: string;
  declaredType: string;
  size: number | string | null;
  checksum: string | null;
  attempt: number;
};

export type ScanOutcome = {
  attachmentId: string;
  state: "CLEAN" | "REJECTED" | "QUARANTINED" | "FAILED";
  contentType: AllowedType | null;
  rejectionCode: RejectionCode | string | null;
  /** The engine whose verdict was recorded, if one was. */
  engine: EngineName | null;
  /** A fixed code when the engine gave no verdict (outage, timeout, no verdict). */
  engineCode?: string;
  /** In-process diagnostic only. Never stored and never printed by the operator
   * script: a driver message can quote a value. */
  note?: string;
};

/** Thrown before any claim when the engine cannot be reached. */
export class ScanEngineUnavailable extends Error {
  constructor(readonly code: string) {
    super("SCAN_ENGINE_UNAVAILABLE");
  }
}

export async function claimAttachments(
  db: pg.Pool,
  limit = 4,
): Promise<ClaimedAttachment[]> {
  const { rows } = await db.query<{ data: ClaimedAttachment[] }>(
    "SELECT core.claim_attachments($1) AS data",
    [limit],
  );
  return rows[0].data;
}

async function record(
  db: pg.Pool,
  id: string,
  verdict: "CLEAN" | "REJECTED" | "FAILED",
  contentType: string | null,
  code: string | null,
  engine: { name: EngineName; version: string | null } | null,
) {
  const { rows } = await db.query<{
    data: { scanStatus: string; contentType: string | null };
  }>("SELECT core.record_scan_result($1,$2,$3,$4,$5::interval,$6,$7) AS data", [
    id,
    verdict,
    contentType,
    code,
    `${ATTACHMENT_RETENTION_DAYS} days`,
    engine?.name ?? null,
    engine?.version ?? null,
  ]);
  return rows[0].data;
}

async function release(db: pg.Pool, id: string) {
  await db.query("SELECT core.release_scan_claim($1) AS data", [id]);
}

export async function scanClaimedAttachment(
  db: pg.Pool,
  claimed: ClaimedAttachment,
  engine: MalwareEngine = engineFromEnvironment(),
): Promise<ScanOutcome> {
  const base = { attachmentId: claimed.id, contentType: null, rejectionCode: null, engine: null };
  let bytes: Buffer;
  try {
    bytes = await getAttachment(claimed.organizationId, claimed.id);
  } catch (error) {
    // The object is unreadable — missing, truncated, or written under a key this
    // process does not hold. That is an outage, not a verdict.
    const state = await record(db, claimed.id, "FAILED", null, null, null);
    return {
      ...base,
      state: state.scanStatus === "FAILED" ? "FAILED" : "QUARANTINED",
      note: error instanceof Error ? error.message : undefined,
    };
  }
  // The digest the upload route recorded is re-computed here over the bytes
  // that actually came back, so storage tampering between upload and scan is a
  // rejection rather than a clean file.
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (claimed.checksum && digest !== claimed.checksum) {
    await record(db, claimed.id, "REJECTED", null, "CHECKSUM_MISMATCH", null);
    return { ...base, state: "REJECTED", rejectionCode: "CHECKSUM_MISMATCH" };
  }

  const scanned = await engine.scan(bytes);
  const typed = await verifyAttachment({
    bytes,
    filename: claimed.originalName,
    declaredType: claimed.declaredType,
  });
  // Provenance is recorded only when the engine actually gave a verdict.
  const verdictBy =
    scanned.outcome === "NO_THREAT_FOUND" || scanned.outcome === "THREAT_FOUND"
      ? { name: scanned.engine, version: scanned.engineVersion }
      : null;
  const reject = async (code: string) => {
    await record(db, claimed.id, "REJECTED", null, code, verdictBy);
    // Rejected bytes are of no further use to anyone. The row stays as audit.
    await deleteAttachment(claimed.organizationId, claimed.id).catch(() => {});
    return { ...base, state: "REJECTED" as const, rejectionCode: code, engine: verdictBy?.name ?? null };
  };

  // An engine detection takes precedence: it is the most specific thing known.
  if (scanned.outcome === "THREAT_FOUND") return reject("MALWARE_SIGNATURE");
  // A definite type or policy rejection needs no engine verdict.
  if (typed.verdict === "REJECTED") return reject(typed.code);
  if (scanned.outcome === "UNAVAILABLE") {
    // The engine went away after the pre-claim probe. Nothing is known about
    // the file; the claim is given back without spending an attempt.
    await release(db, claimed.id);
    return { ...base, state: "QUARANTINED", engineCode: scanned.code };
  }
  if (scanned.outcome === "TIMEOUT" || scanned.outcome === "INDETERMINATE") {
    // Something about this file stopped the engine from answering. That spends
    // an attempt, and after three the file stays FAILED — never CLEAN.
    const state = await record(db, claimed.id, "FAILED", null, null, null);
    return { ...base, state: state.scanStatus === "FAILED" ? "FAILED" : "QUARANTINED", engineCode: scanned.code };
  }
  await record(db, claimed.id, "CLEAN", typed.contentType, null, verdictBy);
  return {
    ...base,
    state: "CLEAN",
    contentType: typed.contentType,
    engine: scanned.engine,
  };
}

export async function scanDueAttachments(
  db: pg.Pool,
  limit = 4,
  engine: MalwareEngine = engineFromEnvironment(),
): Promise<ScanOutcome[]> {
  // Checked before claiming, so an engine outage leaves every waiting file
  // exactly as it was (QUARANTINED, attempts unchanged) and fails the job.
  const probe = await engine.probe();
  if (!probe.available) throw new ScanEngineUnavailable(probe.code);
  const claimed = await claimAttachments(db, limit);
  const outcomes: ScanOutcome[] = [];
  // Sequential on purpose: bounded memory for 20 MiB buffers, and a predictable
  // order in the operator log.
  for (const item of claimed)
    outcomes.push(await scanClaimedAttachment(db, item, engine));
  return outcomes;
}
