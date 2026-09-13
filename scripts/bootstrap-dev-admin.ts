// ---------------------------------------------------------------------------
// Development-only administrator bootstrap.
//
// Creates ONE local-password Super Admin so the product can be signed into
// before P-005 supplies a real identity provider, and turns on the local access
// switch that db/migrations/016_local_access.sql leaves off.
//
// Run it as:
//
//     node --env-file=.env.bootstrap --import tsx scripts/bootstrap-dev-admin.ts
//
// .env.bootstrap is ignored by git (.gitignore covers `.env.*`). Copy it from
// .env.bootstrap.example and put the password there. The password is never
// printed by this script, never written to a log, never placed in a comment and
// never returned by any API.
//
// Refusals, all of them deliberate:
//
//   * NODE_ENV=production           -> refuse. This account has a known-format
//                                     password and no second factor.
//   * a non-loopback database host  -> refuse. Same reason.
//   * a credential that is not
//     orgfit_migrator               -> refuse, as every other operator script.
//   * the address already exists    -> INSPECT AND REPORT. It never overwrites
//                                     a password, never changes a role, never
//                                     re-enables a disabled account and never
//                                     touches an account that authenticates
//                                     through the identity provider.
//   * the password fails the policy -> REPORT THE CONFLICT and stop. The policy
//                                     is not relaxed to accommodate an input.
// ---------------------------------------------------------------------------

import pg from "pg";
import { z } from "zod";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashPassword, checkPasswordPolicy, PASSWORD_POLICY } from "../src/password";
import { LOCAL_ISSUER } from "../src/local-auth";
import { secret } from "../src/security";

const input = z
  .object({
    email: z.email().max(320),
    password: z.string().min(1).max(PASSWORD_POLICY.maxLength),
    displayName: z.string().trim().min(1).max(500),
  })
  .strict();

export type BootstrapOutcome =
  | { result: "CREATED"; id: string }
  | { result: "ALREADY_PRESENT"; id: string }
  | { result: "MISMATCH"; id: string; detail: string }
  | { result: "POLICY_CONFLICT"; detail: string };

export async function bootstrapDevAdmin(
  url: string,
  data: z.input<typeof input>,
  env: Record<string, string | undefined> = process.env,
): Promise<BootstrapOutcome> {
  const d = input.parse(data);
  if (env.NODE_ENV === "production")
    throw new Error("Refused: this bootstrap is development only.");
  const connection = new URL(url);
  if (connection.username !== "orgfit_migrator")
    throw new Error("Migration credential required");
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(connection.hostname))
    throw new Error(
      "Refused: a known-password account may only be created on a loopback database.",
    );

  const failure = checkPasswordPolicy(d.password);
  if (failure)
    return {
      result: "POLICY_CONFLICT",
      detail:
        failure === "TOO_SHORT"
          ? `the supplied password is shorter than the enforced minimum of ${PASSWORD_POLICY.minLength} characters`
          : failure === "TOO_LONG"
            ? `the supplied password is longer than the permitted ${PASSWORD_POLICY.maxLength} characters`
            : "the supplied password does not contain both a letter and a digit",
    };

  const email = d.email.trim().toLowerCase();
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE orgfit_core_owner");
    await db.query("SELECT pg_advisory_xact_lock(80202)");

    const existing = await db.query<{
      id: string;
      issuer: string;
      role: string;
      status: string;
      display_name: string;
      has_password: boolean;
    }>(
      `SELECT u.id, u.issuer, u.role, u.status, u.display_name,
              (p.staff_user_id IS NOT NULL) AS has_password
       FROM access.staff_user u
       LEFT JOIN access.staff_password p ON p.staff_user_id = u.id
       WHERE u.email = $1`,
      [email],
    );

    if (existing.rowCount) {
      const row = existing.rows[0];
      const problems: string[] = [];
      if (row.issuer !== LOCAL_ISSUER)
        problems.push(
          "it authenticates through the identity provider and has no local credential slot",
        );
      else if (!row.has_password)
        problems.push("it is a local account with no password credential set");
      if (row.role !== "SUPER_ADMIN")
        problems.push(`its role is ${row.role}, not SUPER_ADMIN`);
      if (row.status !== "ACTIVE") problems.push(`its status is ${row.status}`);
      await db.query("ROLLBACK");
      return problems.length
        ? {
            result: "MISMATCH",
            id: row.id,
            detail: problems.join("; "),
          }
        : { result: "ALREADY_PRESENT", id: row.id };
    }

    // The switch. Recorded with a note so a reader of the table knows what put
    // it there and that it is not a production posture.
    await db.query(
      `INSERT INTO access.local_access_setting(enabled, note)
       VALUES(true, 'Enabled by scripts/bootstrap-dev-admin.ts on a loopback development database.')
       ON CONFLICT (only_row) DO UPDATE SET enabled = true, enabled_at = clock_timestamp()`,
    );

    const hash = await hashPassword(d.password);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO access.staff_user(issuer, provider_subject, email, display_name, role, status)
       VALUES($1, $2, $3, $4, 'SUPER_ADMIN', 'ACTIVE') RETURNING id`,
      [LOCAL_ISSUER, secret(), email, d.displayName],
    );
    const id = rows[0].id;
    await db.query(
      "INSERT INTO access.staff_password(staff_user_id, password_hash, updated_by) VALUES($1,$2,$1)",
      [id, hash],
    );
    await db.query(
      "INSERT INTO ops.audit_log(actor_id,action,target_id,field_names) VALUES($1,'BOOTSTRAP',$1,ARRAY['membership'])",
      [id],
    );
    await db.query(
      "INSERT INTO ops.audit_log(actor_id,action,target_id,field_names) VALUES($1,'PASSWORD_SET',$1,ARRAY['password'])",
      [id],
    );
    await db.query("COMMIT");
    return { result: "CREATED", id };
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
    const outcome = await bootstrapDevAdmin(
      process.env.MIGRATION_DATABASE_URL ?? "",
      {
        email: process.env.BOOTSTRAP_ADMIN_EMAIL ?? "",
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "",
        displayName: process.env.BOOTSTRAP_ADMIN_NAME ?? "",
      },
    );
    switch (outcome.result) {
      case "CREATED":
        console.log(
          `Development Super Admin created (${outcome.id}). Local password sign-in is now enabled on this database. No credential was printed and nothing was sent.`,
        );
        break;
      case "ALREADY_PRESENT":
        console.log(
          `An account for that address already exists (${outcome.id}) with the expected role, status and credential type. Nothing was changed; no password was reset.`,
        );
        break;
      case "MISMATCH":
        console.error(
          `An account for that address already exists (${outcome.id}) but does not match what was requested: ${outcome.detail}. Nothing was changed. Resolve it through the authenticated Super Admin APIs.`,
        );
        process.exitCode = 1;
        break;
      case "POLICY_CONFLICT":
        console.error(
          `Refused: ${outcome.detail}. The policy was not weakened and no account was created or modified.`,
        );
        process.exitCode = 1;
        break;
    }
  } catch (e) {
    console.error(
      `Bootstrap refused: ${e instanceof Error ? e.message : "verify the private operator inputs"}.`,
    );
    process.exitCode = 1;
  }
}
