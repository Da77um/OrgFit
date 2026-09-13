// ---------------------------------------------------------------------------
// Provision a PERSISTENT local development database.
//
// The test harness (tests/database.ts) makes a randomly named throwaway
// database per run, and the showcase makes its own. Neither survives, so
// neither can hold the development administrator account that
// scripts/bootstrap-dev-admin.ts creates. This script makes the one that does.
//
//     node --env-file=.env.bootstrap --import tsx scripts/provision-dev.ts
//
// It needs DEV_ADMIN_DATABASE_URL: a cluster-administrator connection to a
// LOOPBACK PostgreSQL 18 cluster. It refuses anything else, exactly as the test
// harness does, because it sets role passwords.
//
// What it does, all of it idempotent:
//   1. applies db/roles.sql when a role a later phase introduced is missing;
//   2. sets the LOGIN roles' passwords, from DEV_ROLE_PASSWORD if supplied or
//      generated and written to the ignored file work/dev-environment.json;
//   3. creates the core and anonymous databases if they are absent, with the
//      same REVOKE/GRANT shape the operator instructions require;
//   4. applies every migration, and the anonymous migration;
//   5. writes work/dev-environment.json with the connection strings.
//
// It never drops or resets anything. It prints no credential.
// ---------------------------------------------------------------------------

import pg from "pg";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate } from "./migrate";
import { migrateAnonymous } from "./migrate-anonymous";

const LOGIN_ROLES = [
  "orgfit_migrator",
  "orgfit_staff",
  "orgfit_auth",
  "orgfit_gateway",
  "orgfit_processor",
  "orgfit_anon_migrator",
  "orgfit_report",
  "orgfit_scanner",
];

export async function provisionDev(
  adminUrl: string,
  name = "orgfit_dev",
  password = randomBytes(24).toString("hex"),
) {
  if (process.env.NODE_ENV === "production")
    throw new Error("Refused: development provisioning only.");
  const base = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(base.hostname))
    throw new Error("Refused: the development cluster must be loopback.");
  if (!/^orgfit[a-z0-9_]*$/.test(name)) throw new Error("Unsafe database name");
  const anonName = `${name}_anonymous`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query(
      "SELECT rolname FROM pg_roles WHERE rolname = ANY($1)",
      [[...LOGIN_ROLES, "orgfit_core_owner", "orgfit_anon_owner"]],
    );
    if (rows.length < LOGIN_ROLES.length + 2)
      await admin.query(await readFile("db/roles.sql", "utf8"));
    for (const role of LOGIN_ROLES)
      await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);

    const present = async (database: string) =>
      (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [database]))
        .rowCount === 1;

    if (!(await present(name))) {
      await admin.query(`CREATE DATABASE ${name}`);
      await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
      await admin.query(
        `GRANT CONNECT ON DATABASE ${name} TO orgfit_migrator,orgfit_staff,orgfit_auth,orgfit_gateway,orgfit_processor,orgfit_report,orgfit_scanner`,
      );
      await admin.query(`GRANT CREATE ON DATABASE ${name} TO orgfit_core_owner`);
    }
    if (!(await present(anonName))) {
      await admin.query(`CREATE DATABASE ${anonName}`);
      await admin.query(`REVOKE ALL ON DATABASE ${anonName} FROM PUBLIC`);
      await admin.query(
        `GRANT CONNECT ON DATABASE ${anonName} TO orgfit_anon_migrator,orgfit_processor`,
      );
      await admin.query(
        `GRANT CREATE ON DATABASE ${anonName} TO orgfit_anon_owner`,
      );
    }
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
  for (const [database, owner] of [
    [name, "orgfit_core_owner"],
    [anonName, "orgfit_anon_owner"],
  ] as const) {
    const u = new URL(base);
    u.pathname = `/${database}`;
    const client = new pg.Client({ connectionString: u.href });
    await client.connect();
    await client.query(`GRANT CREATE,USAGE ON SCHEMA public TO ${owner}`);
    await client.end();
  }

  await migrate(at("orgfit_migrator", name));
  await migrateAnonymous(at("orgfit_anon_migrator", anonName));

  return {
    migration: at("orgfit_migrator", name),
    staff: at("orgfit_staff", name),
    auth: at("orgfit_auth", name),
    gateway: at("orgfit_gateway", name),
    processor: at("orgfit_processor", name),
    report: at("orgfit_report", name),
    scanner: at("orgfit_scanner", name),
    anonymous: at("orgfit_processor", anonName),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const adminUrl =
    process.env.DEV_ADMIN_DATABASE_URL ?? process.env.TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) {
    console.error(
      "DEV_ADMIN_DATABASE_URL is required: a cluster-administrator connection to a loopback PostgreSQL 18 cluster.",
    );
    process.exitCode = 1;
  } else {
    const connections = await provisionDev(
      adminUrl,
      process.env.DEV_DATABASE_NAME ?? "orgfit_dev",
      process.env.DEV_ROLE_PASSWORD ?? randomBytes(24).toString("hex"),
    );
    await mkdir("work", { recursive: true });
    // Written to the ignored work/ directory, not printed: these carry role
    // passwords. .gitignore covers work/.
    await writeFile(
      "work/dev-environment.json",
      JSON.stringify(connections, null, 2),
    );
    console.log(
      "Development database provisioned and migrated. Connection strings written to work/dev-environment.json (ignored). Nothing was printed and nothing was reset.",
    );
  }
}
