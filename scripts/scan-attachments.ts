import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  scannerPool,
  scannerReadiness,
  closeScannerPool,
} from "../src/scanner-db";
import { scanDueAttachments } from "../src/attachment-worker";
import { runJob } from "../src/job-run";

// The attachment scanner process. It runs under orgfit_scanner, which holds no
// table privilege anywhere and can execute three routines: claim, record and
// expire. It never learns an organization it did not claim, and it cannot read
// a visit, a participant or a report.
//
// Nothing is printed but counts and verdict codes. A file name, a note or a
// driver message could quote confidential consulting content, so none of them
// reaches the operator log.
export async function scanAttachments(limit = 4) {
  await scannerReadiness();
  try {
    return await scanDueAttachments(scannerPool(), limit);
  } finally {
    await closeScannerPool();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runJob(
    "attachments:scan",
    "Attachment scanning unavailable. Check the scanner credential and attachment storage configuration.",
    async () => {
      const outcomes = await scanAttachments();
      const counted = outcomes.reduce<Record<string, number>>((acc, o) => {
        acc[o.state] = (acc[o.state] ?? 0) + 1;
        return acc;
      }, {});
      console.log(
        `Attachments scanned: ${outcomes.length}` +
          (outcomes.length
            ? ` (${Object.entries(counted)
                .map(([state, n]) => `${state}=${n}`)
                .join(", ")})`
            : ""),
      );
      for (const o of outcomes)
        if (o.rejectionCode) console.log(`Rejected: ${o.rejectionCode}`);
      // A rejected file is the scanner working; only an inability to decide is
      // a failure of the job.
      const failed = counted.FAILED ?? 0;
      return {
        outcome: failed ? "FAILURE" : "SUCCESS",
        failureCode: "SCAN_FAILED",
        counts: {
          scanned: outcomes.length,
          clean: counted.CLEAN ?? 0,
          rejected: counted.REJECTED ?? 0,
          failed,
        },
      };
    },
  );
}
