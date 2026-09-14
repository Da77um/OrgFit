import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import pg from "pg";
import { databaseUrl } from "../src/runtime-guard";
import { runJob } from "../src/job-run";

// Expiry janitor for temporary respondent state: drafts past their idle TTL and
// respondent sessions past their absolute limit. It deletes by expiry only and
// cannot select, read or report a draft's content.
export async function expireTemporary(url = process.env.MIGRATION_DATABASE_URL) {
  // Login, password and production TLS are checked before connecting (RC-004).
  const db = new pg.Client({ connectionString: databaseUrl(url, "orgfit_migrator") });
  await db.connect();
  try {
    await db.query("SET ROLE orgfit_core_owner");
    const { rows } = await db.query<{ data: { drafts: number; sessions: number } }>(
      "SELECT intake.expire_temporary($1) AS data",
      [1000],
    );
    return rows[0].data;
  } finally {
    await db.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runJob(
    "drafts:expire",
    "Expiry failed. Inspect through the restricted operator channel.",
    async () => {
      const result = await expireTemporary();
      console.log(`Expired drafts: ${result.drafts}; sessions: ${result.sessions}.`);
      return { outcome: "SUCCESS", counts: { drafts: result.drafts, sessions: result.sessions } };
    },
  );
}
