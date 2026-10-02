// ---------------------------------------------------------------------------
// Development-only password reset for the bootstrap administrator.
//
// scripts/bootstrap-dev-admin.ts deliberately never touches an account that
// already exists. This is its companion for the one thing it will not do: set a
// new password on the local Super Admin it created, so a forgotten development
// password does not force deleting the account and its audit history.
//
//     node --env-file=.env.bootstrap --import tsx scripts/reset-dev-admin-password.ts
//
// Reads the same private inputs as the bootstrap (MIGRATION_DATABASE_URL,
// BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD). The password is never
// printed or logged.
//
// Refusals, mirroring the bootstrap:
//
//   * NODE_ENV=production           -> refuse.
//   * a non-loopback database host  -> refuse.
//   * a credential that is not
//     orgfit_migrator               -> refuse.
//   * no such account, an account that authenticates through the identity
//     provider, a role other than SUPER_ADMIN, or a status other than ACTIVE
//                                   -> report and change nothing.
//   * the password fails the policy -> report and change nothing.
//
// PASSWORD_SET is audited and earlier lockouts are cleared. Existing sessions are not revoked.
// ---------------------------------------------------------------------------

import pg from "pg";
import { z } from "zod";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashPassword, checkPasswordPolicy, PASSWORD_POLICY } from "../src/password";
import { LOCAL_ISSUER } from "../src/local-auth";

const input = z
  .object({
    email: z.email().max(320),
    password: z.string().min(1).max(PASSWORD_POLICY.maxLength),
  })
  .strict();

export type ResetOutcome =
  | { result: "RESET"; id: string }
  | { result: "NOT_FOUND" }
  | { result: "MISMATCH"; id: string; detail: string }
  | { result: "POLICY_CONFLICT"; detail: string };

export async function resetDevAdminPassword(
  url: string,
  data: z.input<typeof input>,
  env: Record<string, string | undefined> = process.env,
): Promise<ResetOutcome> {
  const d = input.parse(data);
  if (env.NODE_ENV === "production")
    throw new Error("Refused: this reset is development only.");
  const connection = new URL(url);
  if (connection.username !== "orgfit_migrator")
    throw new Error("Migration credential required");
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(connection.hostname))
    throw new Error("Refused: a known-password account may only be changed on a loopback database.");

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
      has_password: boolean;
    }>(
      `SELECT u.id, u.issuer, u.role, u.status,
              (p.staff_user_id IS NOT NULL) AS has_password
       FROM access.staff_user u
       LEFT JOIN access.staff_password p ON p.staff_user_id = u.id
       WHERE u.email = $1`,
      [email],
    );
    if (!existing.rowCount) {
      await db.query("ROLLBACK");
      return { result: "NOT_FOUND" };
    }
    const row = existing.rows[0];
    const problems: string[] = [];
    if (row.issuer !== LOCAL_ISSUER)
      problems.push("it authenticates through the identity provider and has no local credential");
    else if (!row.has_password) problems.push("it is a local account with no password credential");
    if (row.role !== "SUPER_ADMIN") problems.push(`its role is ${row.role}, not SUPER_ADMIN`);
    if (row.status !== "ACTIVE") problems.push(`its status is ${row.status}`);
    if (problems.length) {
      await db.query("ROLLBACK");
      return { result: "MISMATCH", id: row.id, detail: problems.join("; ") };
    }

    const hash = await hashPassword(d.password);
    await db.query(
      "UPDATE access.staff_password SET password_hash=$2, updated_at=clock_timestamp(), updated_by=$1 WHERE staff_user_id=$1",
      [row.id, hash],
    );
    // A lockout from earlier failed attempts must not outlive the reset.
    await db.query("DELETE FROM access.password_attempt");
    await db.query(
      "INSERT INTO ops.audit_log(actor_id,action,target_id,field_names) VALUES($1,'PASSWORD_SET',$1,ARRAY['password'])",
      [row.id],
    );
    await db.query("COMMIT");
    return { result: "RESET", id: row.id };
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
    const outcome = await resetDevAdminPassword(process.env.MIGRATION_DATABASE_URL ?? "", {
      email: process.env.BOOTSTRAP_ADMIN_EMAIL ?? "",
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "",
    });
    switch (outcome.result) {
      case "RESET":
        console.log(`Password reset for the development Super Admin (${outcome.id}). No credential was printed.`);
        break;
      case "NOT_FOUND":
        console.error("No account exists for that address. Run the bootstrap instead.");
        process.exitCode = 1;
        break;
      case "MISMATCH":
        console.error(`The account (${outcome.id}) does not match: ${outcome.detail}. Nothing was changed.`);
        process.exitCode = 1;
        break;
      case "POLICY_CONFLICT":
        console.error(`Refused: ${outcome.detail}. Nothing was changed.`);
        process.exitCode = 1;
        break;
    }
  } catch (e) {
    console.error(
      `Reset refused: ${e instanceof Error ? e.message : "verify the private operator inputs"}.`,
    );
    process.exitCode = 1;
  }
}
