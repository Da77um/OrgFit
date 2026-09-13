import { operatorUrl, shipTombstones } from "../src/operations";

// Copies new deletion tombstones to the ledger kept outside database backups.
// Run at least as often as the backup RPO; see retention-backup-runbook.md.
try {
  const dir = process.env.TOMBSTONE_LEDGER_DIRECTORY;
  if (!dir) throw new Error("TOMBSTONE_LEDGER_DIRECTORY required");
  const result = await shipTombstones(operatorUrl(), dir);
  console.log(`Tombstones shipped: ${result.shipped}; cursor ${result.cursor}.`);
} catch {
  console.error("Tombstone shipping failed. Deletions since the last run are not yet protected against a restore.");
  process.exitCode = 1;
}
