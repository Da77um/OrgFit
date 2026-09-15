import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  scannerPool,
  scannerReadiness,
  closeScannerPool,
} from "../src/scanner-db";
import { scanDueAttachments, ScanEngineUnavailable } from "../src/attachment-worker";
import { engineFromEnvironment, type MalwareEngine } from "../src/malware-engine";
import { runJob } from "../src/job-run";

// The attachment scanner process. It runs under orgfit_scanner, which holds no
// table privilege anywhere and can execute three routines: claim, record and
// expire. It never learns an organization it did not claim, and it cannot read
// a visit, a participant or a report.
//
// Nothing is printed but counts and verdict codes. A file name, a note or a
// driver message could quote confidential consulting content, so none of them
// reaches the operator log.
export async function scanAttachments(limit = 4, engine: MalwareEngine = engineFromEnvironment()) {
  await scannerReadiness();
  try {
    return await scanDueAttachments(scannerPool(), limit, engine);
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
      // Resolved first: in production an unset engine or the development
      // heuristic is refused here, before any database connection or claim.
      const engine = engineFromEnvironment();
      console.log(
        engine.assurance === "maintained-engine"
          ? `Scan engine: ${engine.name}.`
          : `Scan engine: ${engine.name} — NOT a malware scan (development only).`,
      );
      let outcomes;
      try {
        outcomes = await scanAttachments(4, engine);
      } catch (e) {
        if (!(e instanceof ScanEngineUnavailable)) throw e;
        // Nothing was claimed; every waiting file is still quarantined.
        console.log(`Scan engine unavailable (${e.code}); nothing claimed.`);
        return { outcome: "FAILURE" as const, failureCode: "SCAN_ENGINE_UNAVAILABLE", counts: { scanned: 0 } as Record<string, number> };
      }
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
      for (const o of outcomes) {
        if (o.rejectionCode) console.log(`Rejected: ${o.rejectionCode}`);
        if (o.engineCode) console.log(`No engine verdict: ${o.engineCode}`);
      }
      // A rejected file is the scanner working; only an inability to decide is
      // a failure of the job.
      const failed = counted.FAILED ?? 0;
      const undecided = outcomes.filter((o) => o.engineCode).length;
      return {
        outcome: failed || undecided ? "FAILURE" : "SUCCESS",
        failureCode: undecided ? "SCAN_ENGINE_NO_VERDICT" : "SCAN_FAILED",
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
