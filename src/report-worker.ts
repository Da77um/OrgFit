import { createHash } from "node:crypto";
import type pg from "pg";
import type { Browser } from "playwright";
import { buildReportModel, type ReportSource } from "./report-model";
import { openReportBrowser, renderReportPdf } from "./report-pdf";
import { renderReportWorkbook } from "./report-xlsx";
import { putReport, deleteReport, REPORT_TTL_HOURS } from "./report-storage";

// ---------------------------------------------------------------------------
// The renderer loop.
//
// Claim a job, read its frozen source, draw it, store the bytes, record the
// outcome. It reaches nothing else: there is no organization parameter, no
// campaign lookup, no participant query and no anonymous connection anywhere in
// this file, because the credential it runs under could not execute one.
//
// Retries are idempotent because the source is immutable. A job that already
// reached READY keeps the artifact staff may already hold; a job that failed
// mid-render leaves at most an orphaned encrypted object, which the local
// janitor and the bucket lifecycle rule remove. Nothing is ever sent anywhere:
// the only output is an encrypted private object and a row.
// ---------------------------------------------------------------------------

export type ClaimedJob = {
  id: string;
  organizationId: string;
  format: "PDF" | "XLSX";
  locale: "ar" | "en";
  attempt: number;
  maxAttempts: number;
};

export type RenderOutcome = {
  jobId: string;
  format: "PDF" | "XLSX";
  locale: "ar" | "en";
  state: "READY" | "REUSED" | "QUEUED" | "FAILED" | "REVOKED";
  byteCount: number | null;
  pageCount: number | null;
  networkAttempts: number | null;
  failureCode?: string;
  /** In-process diagnostic only. Never stored, never printed by the operator
   * script, and never sent anywhere: a driver message can quote a value. */
  note?: string;
};

const FAILURE_CODES: Record<string, string> = {
  SOURCE_UNAVAILABLE: "SOURCE_UNAVAILABLE",
  RENDER_FAILED: "RENDER_FAILED",
  STORAGE_FAILED: "STORAGE_FAILED",
};

export async function claimReportJobs(
  db: pg.Pool,
  limit = 4,
): Promise<ClaimedJob[]> {
  const { rows } = await db.query<{ data: ClaimedJob[] }>(
    "SELECT publication.claim_report_jobs($1) AS data",
    [limit],
  );
  return rows[0].data;
}

export async function renderClaimedJob(
  db: pg.Pool,
  job: ClaimedJob,
  browser: Browser | null,
): Promise<RenderOutcome> {
  const base = {
    jobId: job.id,
    format: job.format,
    locale: job.locale,
    byteCount: null as number | null,
    pageCount: null as number | null,
    networkAttempts: null as number | null,
  };
  let stage = "SOURCE_UNAVAILABLE";
  try {
    const { rows } = await db.query<{ data: ReportSource }>(
      "SELECT publication.report_job_source($1) AS data",
      [job.id],
    );
    const source = rows[0].data;
    stage = "RENDER_FAILED";
    const model = buildReportModel(source);
    let bytes: Buffer;
    let pageCount: number | null = null;
    let networkAttempts: number | null = null;
    if (job.format === "PDF") {
      if (!browser) throw new Error("browser required");
      const rendered = await renderReportPdf(browser, model);
      bytes = rendered.bytes;
      pageCount = rendered.pageCount;
      networkAttempts = rendered.networkAttempts;
      // A rendered report that tried to fetch anything is refused rather than
      // stored: the attempt itself is the defect worth failing on.
      if (networkAttempts > 0) throw new Error("network attempted");
    } else {
      bytes = await renderReportWorkbook(model);
    }
    stage = "STORAGE_FAILED";
    const storageKey = await putReport(job.organizationId, job.id, bytes);
    const hash = createHash("sha256").update(bytes).digest();
    const { rows: done } = await db.query<{ state: string }>(
      "SELECT publication.complete_report_job($1,$2,$3,$4,$5,$6::interval) AS state",
      [job.id, storageKey, bytes.length, hash, pageCount, `${REPORT_TTL_HOURS} hours`],
    );
    if (done[0].state === "REUSED") {
      // Another worker already delivered this job. The bytes just written are
      // not the ones staff will download, so they are removed rather than left
      // behind as an unreferenced private object.
      await deleteReport(job.organizationId, job.id).catch(() => {});
      return { ...base, state: "REUSED", networkAttempts };
    }
    if (done[0].state === "REVOKED") {
      // The release was withdrawn while this job rendered. No row points at
      // these bytes and none ever will; they are removed now, and the purge
      // queue the revocation wrote removes them again if this delete failed.
      await deleteReport(job.organizationId, job.id).catch(() => {});
      return { ...base, state: "REVOKED", networkAttempts };
    }
    return {
      ...base,
      state: "READY",
      byteCount: bytes.length,
      pageCount,
      networkAttempts,
    };
  } catch (error) {
    // A driver message can quote a value, so only the stage code is RECORDED.
    // The message is returned in process for an operator to read live.
    const code = FAILURE_CODES[stage] ?? "RENDER_FAILED";
    const { rows } = await db.query<{ state: string }>(
      "SELECT publication.fail_report_job($1,$2) AS state",
      [job.id, code],
    );
    // A job revoked mid-render cannot read its source any more; that is the
    // revocation working, not a render failure.
    if (rows[0].state === "REVOKED") return { ...base, state: "REVOKED" };
    return {
      ...base,
      state: rows[0].state === "FAILED" ? "FAILED" : "QUEUED",
      failureCode: code,
      note: error instanceof Error ? error.message : undefined,
    };
  }
}

// Bytes of reports whose release was revoked. The row already refuses every
// download; this removes the object and confirms, one job at a time, so a
// crash between the two only repeats an idempotent delete.
export async function purgeRevokedReports(db: pg.Pool, limit = 100) {
  const { rows } = await db.query<{ data: { organizationId: string; id: string }[] }>(
    "SELECT publication.pending_report_purges($1) AS data",
    [limit],
  );
  let purged = 0;
  for (const item of rows[0].data) {
    await deleteReport(item.organizationId, item.id);
    await db.query("SELECT publication.confirm_report_purge($1,$2)", [item.organizationId, item.id]);
    purged++;
  }
  return purged;
}

export async function renderDueReports(
  db: pg.Pool,
  limit = 4,
): Promise<RenderOutcome[]> {
  const jobs = await claimReportJobs(db, limit);
  if (!jobs.length) return [];
  const needsBrowser = jobs.some((job) => job.format === "PDF");
  const browser = needsBrowser ? await openReportBrowser() : null;
  try {
    const outcomes: RenderOutcome[] = [];
    // Sequential on purpose: one browser, bounded memory, and a predictable
    // order in the operator log.
    for (const job of jobs) outcomes.push(await renderClaimedJob(db, job, browser));
    return outcomes;
  } finally {
    await browser?.close().catch(() => {});
  }
}
