import { operatorUrl, shipTombstones } from "../src/operations";
import { runJob } from "../src/job-run";

// Copies new deletion tombstones to the ledger kept outside database backups.
// Run at least as often as the backup RPO; see retention-backup-runbook.md.
await runJob(
  "tombstones:ship",
  "Tombstone shipping failed. Deletions since the last run are not yet protected against a restore.",
  async () => {
    const dir = process.env.TOMBSTONE_LEDGER_DIRECTORY;
    if (!dir) throw new Error("TOMBSTONE_LEDGER_DIRECTORY required");
    const result = await shipTombstones(operatorUrl(), dir);
    console.log(`Tombstones shipped: ${result.shipped}; cursor ${result.cursor}.`);
    return { outcome: "SUCCESS", counts: { shipped: result.shipped, cursor: result.cursor } };
  },
);
