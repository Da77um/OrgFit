import pg from "pg";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { migrate } from "../scripts/migrate";
import { migrateAnonymous } from "../scripts/migrate-anonymous";
import { seed } from "../scripts/seed";
import { seedInstruments } from "../scripts/seed-instruments";
import { clusterRolePassword, passwordLiteral } from "../scripts/role-password";
// A dedicated test cluster only. New databases are retained; no reset/drop path.
const loginRoles = [
  "orgfit_migrator",
  "orgfit_staff",
  "orgfit_auth",
  "orgfit_gateway",
  "orgfit_processor",
  "orgfit_anon_migrator",
  "orgfit_report",
  "orgfit_scanner",
];
export async function setupDatabase(
  issuer = "http://127.0.0.1:4010",
  withSeed = true,
  through?: string,
) {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
  if (!adminUrl)
    throw new Error(
      "TEST_ADMIN_DATABASE_URL is required; use a dedicated PostgreSQL 18 test cluster.",
    );
  const base = new URL(adminUrl);
  if (!["localhost", "127.0.0.1"].includes(base.hostname))
    throw new Error("Test cluster must be loopback");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const suffix = randomBytes(6).toString("hex"),
    name = `orgfit_test_${suffix}`,
    anonName = `orgfit_anon_test_${suffix}`;
  // Roles are cluster-wide: a fresh random password here broke development
  // sign-in and any parallel run on the same cluster. One stable value instead.
  const password = clusterRolePassword(adminUrl);
  try {
    // db/roles.sql is idempotent, so it is applied whenever a role introduced
    // by a later phase is still missing on this cluster.
    const { rows } = await admin.query(
      "SELECT rolname FROM pg_roles WHERE rolname = ANY($1)",
      [[...loginRoles, "orgfit_core_owner", "orgfit_anon_owner"]],
    );
    if (rows.length < loginRoles.length + 2)
      await admin.query(await readFile("db/roles.sql", "utf8"));
    // Role credentials for this synthetic local cluster, never printed.
    for (const role of loginRoles)
      await admin.query(`ALTER ROLE ${role} PASSWORD ${passwordLiteral(password)}`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${name} TO orgfit_migrator,orgfit_staff,orgfit_auth,orgfit_gateway,orgfit_processor,orgfit_report,orgfit_scanner`,
    );
    await admin.query(`GRANT CREATE ON DATABASE ${name} TO orgfit_core_owner`);
    // The anonymous answer database. Only the anonymous migrator and the
    // privacy processor may connect; no staff, auth or gateway login can.
    await admin.query(`CREATE DATABASE ${anonName}`);
    await admin.query(`REVOKE ALL ON DATABASE ${anonName} FROM PUBLIC`);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${anonName} TO orgfit_anon_migrator,orgfit_processor`,
    );
    await admin.query(
      `GRANT CREATE ON DATABASE ${anonName} TO orgfit_anon_owner`,
    );
  } finally {
    await admin.end();
  }
  const at = (role: string, database: string) => {
    const u = new URL(base);
    u.username = role;
    u.password = password;
    u.pathname = `/${database}`;
    return u.href;
  };
  const url = (role: string) => at(role, name);
  const anonymousUrl = (role: string) => at(role, anonName);
  // public schema creation is required only for the migration ledger, not runtime.
  for (const [database, owner] of [
    [name, "orgfit_core_owner"],
    [anonName, "orgfit_anon_owner"],
  ] as const) {
    const dbAdmin = new URL(base);
    dbAdmin.pathname = `/${database}`;
    const client = new pg.Client({ connectionString: dbAdmin.href });
    await client.connect();
    await client.query(`GRANT CREATE,USAGE ON SCHEMA public TO ${owner}`);
    await client.end();
  }
  await migrate(url("orgfit_migrator"), "001_foundation.sql");
  if (withSeed) await seed(url("orgfit_migrator"), issuer);
  // Actual populated 001 -> 002 upgrade, followed by tests and idempotent re-run.
  await migrate(url("orgfit_migrator"), through);
  if (!through || through >= "005_instruments.sql")
    await seedInstruments(url("orgfit_migrator"));
  if (!through || through >= "009_intake.sql")
    await migrateAnonymous(anonymousUrl("orgfit_anon_migrator"));
  return { url, name, anonymousUrl, anonymousName: anonName };
}
