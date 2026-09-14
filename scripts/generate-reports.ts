import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { reportPool, reportReadiness, closeReportPool } from "../src/report-db";
import { renderDueReports } from "../src/report-worker";
import { runJob } from "../src/job-run";

// Operator entry point for report rendering. It runs under orgfit_report, which
// holds no table privilege and cannot connect to the anonymous database.
// Readiness asserts both against the live catalog before a single job is
// claimed, so a misgranted deployment fails loudly instead of rendering with
// more access than it should have.
//
// Output is job-level: an identifier, a format, a state and a size. It never
// prints an organization name, a metric, a value or a storage key.
export async function generateDueReports(limit = 4) {
  await reportReadiness();
  try {
    return await renderDueReports(reportPool(), limit);
  } finally {
    await closeReportPool();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runJob(
    "reports:generate",
    "Report generation unavailable. Inspect the report credential, its grants and local artifact storage.",
    async () => {
      const results = await generateDueReports();
      for (const r of results)
        console.log(
          `job=${r.jobId} format=${r.format} locale=${r.locale} state=${r.state} bytes=${r.byteCount ?? "-"} pages=${r.pageCount ?? "-"}${r.failureCode ? ` failure=${r.failureCode}` : ""}`,
        );
      const count = (state: string) => results.filter((r) => r.state === state).length;
      return {
        outcome: count("FAILED") ? "FAILURE" : "SUCCESS",
        failureCode: "REPORT_FAILED",
        counts: {
          claimed: results.length,
          ready: count("READY"),
          requeued: count("QUEUED"),
          failed: count("FAILED"),
          revoked: count("REVOKED"),
        },
      };
    },
  );
}
