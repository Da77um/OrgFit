import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { reportPool, reportReadiness, closeReportPool } from "../src/report-db";
import { deleteReport, cleanLocalReports } from "../src/report-storage";

// Report retention. The row is the authority: publication.expire_report_jobs
// marks every READY artifact past its expiry as EXPIRED and hands back the
// storage keys it just retired, which are then deleted. The local sweep is a
// development convenience for bytes whose job never reached READY; in a bucket
// that job belongs to a lifecycle rule on reports/.
export async function expireReports(limit = 100) {
  await reportReadiness();
  try {
    const { rows } = await reportPool().query<{
      data: { id: string; organizationId: string; storageKey: string | null }[];
    }>("SELECT publication.expire_report_jobs($1) AS data", [limit]);
    let removed = 0;
    for (const row of rows[0].data) {
      await deleteReport(row.organizationId, row.id);
      removed++;
    }
    return removed;
  } finally {
    await closeReportPool();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const expired = await expireReports();
    const orphans = process.env.REPORT_S3_BUCKET ? 0 : await cleanLocalReports();
    console.log(`Expired report artifacts removed: ${expired}; orphans removed: ${orphans}`);
  } catch {
    console.error(
      "Report cleanup unavailable. Check the report credential and artifact storage configuration.",
    );
    process.exitCode = 1;
  }
}
