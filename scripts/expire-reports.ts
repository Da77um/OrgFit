import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { reportPool, reportReadiness, closeReportPool } from "../src/report-db";
import { deleteReport, cleanLocalReports, reportStorageMode } from "../src/report-storage";
import { purgeRevokedReports } from "../src/report-worker";
import { runDefinedJob, type JobDefinition } from "../src/job-run";

// Report retention. The row is the authority: publication.expire_report_jobs
// marks every READY artifact past its expiry as EXPIRED and hands back the
// storage keys it just retired, which are then deleted. The local sweep is a
// development convenience for bytes whose job never reached READY; in a bucket
// that job belongs to a lifecycle rule on reports/.
//
// Since Post-Audit Repair Pass 3 it also removes the bytes of reports whose
// release was revoked (publication.pending_report_purges, migration 022).
export async function expireReports(limit = 100) {
  await reportReadiness();
  try {
    const { rows } = await reportPool().query<{
      data: { id: string; organizationId: string; storageKey: string | null }[];
    }>("SELECT publication.expire_report_jobs($1) AS data", [limit]);
    let removed = 0;
    for (const row of rows[0].data) {
      await deleteReport(row.organizationId, row.id, reportPool());
      removed++;
    }
    const revoked = await purgeRevokedReports(reportPool(), limit);
    // Database storage (D-191): bytes of jobs that never reached READY, or
    // that are past expiry, are swept by the routine; there is no local sweep.
    const orphans =
      reportStorageMode() === "database"
        ? (await reportPool().query<{ n: number }>("SELECT publication.sweep_report_blobs($1) AS n", [limit])).rows[0].n
        : null;
    return { expired: removed, revoked, orphans };
  } finally {
    await closeReportPool();
  }
}

export const reportsExpireJob: JobDefinition = {
  name: "reports:expire",
  unavailable:
    "Report cleanup unavailable. Check the report credential and artifact storage configuration.",
  work: async () => {
    const { expired, revoked, orphans: swept } = await expireReports();
    const orphans = swept ?? (reportStorageMode() === "s3" ? 0 : await cleanLocalReports());
    console.log(
      `Expired report artifacts removed: ${expired}; revoked artifacts removed: ${revoked}; orphans removed: ${orphans}`,
    );
    return { outcome: "SUCCESS", counts: { expired, revoked, orphans } };
  },
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runDefinedJob(reportsExpireJob);
}
