import pg from "pg";
import { z } from "zod";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const input = z
  .object({
    issuer: z.url().max(500),
    subject: z.string().min(1).max(500),
    email: z.email().max(320),
    displayName: z.string().trim().min(1).max(500),
  })
  .strict();
export async function bootstrap(url: string, data: z.infer<typeof input>) {
  const d = input.parse(data);
  if (new URL(url).username !== "orgfit_migrator")
    throw new Error("Migration credential required");
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE orgfit_core_owner");
    await db.query("SELECT pg_advisory_xact_lock(80202)");
    if ((await db.query("SELECT 1 FROM access.staff_user LIMIT 1")).rowCount)
      throw new Error("Bootstrap already performed");
    const { rows } = await db.query(
      "INSERT INTO access.staff_user(issuer,provider_subject,email,display_name,role) VALUES($1,$2,$3,$4,'SUPER_ADMIN') RETURNING id",
      [d.issuer, d.subject, d.email.toLowerCase(), d.displayName],
    );
    await db.query(
      "INSERT INTO ops.audit_log(actor_id,action,target_id,field_names) VALUES($1,'BOOTSTRAP',$1,ARRAY['membership'])",
      [rows[0].id],
    );
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
    await bootstrap(process.env.MIGRATION_DATABASE_URL ?? "", {
      issuer: process.env.BOOTSTRAP_ISSUER ?? "",
      subject: process.env.BOOTSTRAP_SUBJECT ?? "",
      email: process.env.BOOTSTRAP_EMAIL ?? "",
      displayName: process.env.BOOTSTRAP_NAME ?? "",
    });
    console.log(
      "First administrator provisioned. No password or message generated.",
    );
  } catch {
    console.error(
      "Bootstrap refused. Verify private operator inputs and whether staff already exist.",
    );
    process.exitCode = 1;
  }
}
