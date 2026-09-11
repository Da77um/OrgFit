import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
export async function migrate(url: string, through?: string) {
  if (new URL(url).username !== "orgfit_migrator")
    throw new Error("Migration credential required");
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE orgfit_core_owner");
    await db.query("SELECT pg_advisory_xact_lock(80201)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS public.orgfit_migrations(name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
    );
    for (const name of (await readdir(resolve("db/migrations")))
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort()) {
      if (through && name > through) break;
      const source = await readFile(resolve("db/migrations", name), "utf8"),
        hash = createHash("sha256").update(source).digest("hex");
      const old = await db.query(
        "SELECT digest FROM public.orgfit_migrations WHERE name=$1",
        [name],
      );
      if (old.rowCount) {
        if (old.rows[0].digest !== hash)
          throw new Error("Migration checksum mismatch");
        continue;
      }
      await db.query(source);
      await db.query(
        "INSERT INTO public.orgfit_migrations(name,digest) VALUES($1,$2)",
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
    if (!process.env.MIGRATION_DATABASE_URL) throw new Error();
    await migrate(process.env.MIGRATION_DATABASE_URL);
    console.log("Migrations applied.");
  } catch {
    console.error(
      "Migration failed. Inspect configuration and migration state through the restricted operator channel.",
    );
    process.exitCode = 1;
  }
}
