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

// ---------------------------------------------------------------------------
// The scan loop.
//
// Claim a quarantined attachment, read the bytes back out of private storage,
// prove what they actually are, record the verdict. It reaches nothing else:
// there is no organization parameter it chose, no visit lookup, no participant
// query and no anonymous connection anywhere in this file, because the
// credential it runs under could not execute one.
//
// Failure is fail-closed in both directions. A scanner that cannot read the
// object records FAILED, which the database turns back into QUARANTINED until
// the attempt budget is spent — an unscanned file is never downloadable and
// never quietly becomes downloadable. A rejected file loses its bytes at the
// next retention pass and keeps its row as audit.
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
  /** In-process diagnostic only. Never stored and never printed by the operator
   * script: a driver message can quote a value. */
  note?: string;
};

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
) {
  const { rows } = await db.query<{
    data: { scanStatus: string; contentType: string | null };
  }>("SELECT core.record_scan($1,$2,$3,$4,$5::interval) AS data", [
    id,
    verdict,
    contentType,
    code,
    `${ATTACHMENT_RETENTION_DAYS} days`,
  ]);
  return rows[0].data;
}

export async function scanClaimedAttachment(
  db: pg.Pool,
  claimed: ClaimedAttachment,
): Promise<ScanOutcome> {
  let bytes: Buffer;
  try {
    bytes = await getAttachment(claimed.organizationId, claimed.id);
  } catch (error) {
    // The object is unreadable — missing, truncated, or written under a key this
    // process does not hold. That is an outage, not a verdict.
    const state = await record(db, claimed.id, "FAILED", null, null);
    return {
      attachmentId: claimed.id,
      state: state.scanStatus === "FAILED" ? "FAILED" : "QUARANTINED",
      contentType: null,
      rejectionCode: null,
      note: error instanceof Error ? error.message : undefined,
    };
  }
  // The digest the upload route recorded is re-computed here over the bytes
  // that actually came back, so storage tampering between upload and scan is a
  // rejection rather than a clean file.
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (claimed.checksum && digest !== claimed.checksum) {
    await record(db, claimed.id, "REJECTED", null, "CHECKSUM_MISMATCH");
    return {
      attachmentId: claimed.id,
      state: "REJECTED",
      contentType: null,
      rejectionCode: "CHECKSUM_MISMATCH",
    };
  }
  const result = await verifyAttachment({
    bytes,
    filename: claimed.originalName,
    declaredType: claimed.declaredType,
  });
  if (result.verdict === "REJECTED") {
    await record(db, claimed.id, "REJECTED", null, result.code);
    // Rejected bytes are of no further use to anyone. The row stays as audit.
    await deleteAttachment(claimed.organizationId, claimed.id).catch(() => {});
    return {
      attachmentId: claimed.id,
      state: "REJECTED",
      contentType: null,
      rejectionCode: result.code,
    };
  }
  await record(db, claimed.id, "CLEAN", result.contentType, null);
  return {
    attachmentId: claimed.id,
    state: "CLEAN",
    contentType: result.contentType,
    rejectionCode: null,
  };
}

export async function scanDueAttachments(
  db: pg.Pool,
  limit = 4,
): Promise<ScanOutcome[]> {
  const claimed = await claimAttachments(db, limit);
  const outcomes: ScanOutcome[] = [];
  // Sequential on purpose: bounded memory for 20 MiB buffers, and a predictable
  // order in the operator log.
  for (const item of claimed)
    outcomes.push(await scanClaimedAttachment(db, item));
  return outcomes;
}
