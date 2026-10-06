import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { operatorUrl, shipTombstones } from "../src/operations";
import { tombstoneSinkFromEnvironment } from "../src/tombstone-ledger";
import { runDefinedJob, type JobDefinition } from "../src/job-run";

// Copies new deletion tombstones to the ledger kept outside database backups:
// a bucket with conditional creates and Object Lock in production, a local
// directory in development (src/tombstone-ledger.ts). Run at least as often as
// the backup RPO; see retention-backup-runbook.md. A failure leaves the job
// FAILING (retried by the supervisor) and ops:check raises
// TOMBSTONE_SHIPPING_BEHIND once the oldest unshipped deletion is 15 minutes old.
export const tombstonesShipJob: JobDefinition = {
  name: "tombstones:ship",
  unavailable:
    "Tombstone shipping failed. Deletions since the last run are not yet protected against a restore.",
  work: async () => {
    const url = operatorUrl();
    const sink = tombstoneSinkFromEnvironment();
    const result = await shipTombstones(url, sink);
    console.log(`Tombstones shipped: ${result.shipped}; cursor ${result.cursor}; sink ${result.sink}.`);
    return { outcome: "SUCCESS", counts: { shipped: result.shipped, cursor: result.cursor } };
  },
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runDefinedJob(tombstonesShipJob);
}
