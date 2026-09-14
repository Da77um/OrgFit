import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { assertProcessEnvironment, databaseUrl, guardMessage } from "../src/runtime-guard";

// The anonymous answer database has its own migrator credential and its own
// ledger. It is deliberately not reachable from scripts/migrate.ts, so a core
// migration can never create a staff-visible path into finalized answers.
export async function migrateAnonymous(url: string, through?: string) {
  // Refuses a production URL without verified TLS before connecting (RC-004).
  const db = new pg.Client({ connectionString: databaseUrl(url, "orgfit_anon_migrator") });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE orgfit_anon_owner");
    await db.query("SELECT pg_advisory_xact_lock(80202)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS public.orgfit_anonymous_migrations(name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
    );
    for (const name of (await readdir(resolve("db/anonymous")))
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort()) {
      if (through && name > through) break;
      const source = await readFile(resolve("db/anonymous", name), "utf8"),
        hash = createHash("sha256").update(source).digest("hex");
      const old = await db.query(
        "SELECT digest FROM public.orgfit_anonymous_migrations WHERE name=$1",
        [name],
      );
      if (old.rowCount) {
        if (old.rows[0].digest !== hash)
          throw new Error("Migration checksum mismatch");
        continue;
      }
      await db.query(source);
      await db.query(
        "INSERT INTO public.orgfit_anonymous_migrations(name,digest) VALUES($1,$2)",
        [name, hash],
      );
    }
    await db.query("COMMIT");
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
    assertProcessEnvironment("operator");
    if (!process.env.ANONYMOUS_MIGRATION_DATABASE_URL) throw new Error();
    await migrateAnonymous(process.env.ANONYMOUS_MIGRATION_DATABASE_URL);
    console.log("Anonymous migrations applied.");
  } catch (e) {
    console.error(
      guardMessage(e) ?? "Anonymous migration failed. Inspect configuration through the restricted operator channel.",
    );
    process.exitCode = 1;
  }
}
