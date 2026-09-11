import pg from "pg";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Durable schedule normalization. This job makes stored state catch up with the
// clock; it is NOT what enforces the boundary. Every request already evaluates
// the boundary itself, so a late or stopped scheduler can only delay bookkeeping,
// never keep a campaign open past its end or open one before its start.
export async function normalizeCampaigns(url: string, maxRows = 200) {
  if (new URL(url).username !== "orgfit_migrator")
    throw new Error("Operator credential required");
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE orgfit_core_owner");
    // One scheduler at a time; a second run waits rather than racing.
    const lock = await db.query("SELECT pg_try_advisory_xact_lock(80600) ok");
    if (!lock.rows[0].ok) {
      await db.query("ROLLBACK");
      return 0;
    }
    const { rows } = await db.query("SELECT core.normalize_due($1) n", [
      maxRows,
    ]);
    await db.query("COMMIT");
    return Number(rows[0].n);
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    await db.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (!process.env.MIGRATION_DATABASE_URL) throw new Error();
    console.log(
      `Campaigns normalized: ${await normalizeCampaigns(process.env.MIGRATION_DATABASE_URL)}`,
    );
  } catch {
    console.error(
      "Campaign scheduling unavailable. Inspect the restricted operator channel.",
    );
    process.exitCode = 1;
  }
}
