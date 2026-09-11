import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { sql } from "kysely";
import { readdirSync } from "node:fs";
import { setupDatabase } from "./database";
import { migrate } from "../scripts/migrate";
import { ids } from "../scripts/seed";
import { secret, digest } from "../src/security";
import { withStaff, requireAccess } from "../src/db";
import { bootstrap } from "../scripts/bootstrap";

const migrationCount = readdirSync("db/migrations").filter((n) =>
  /^\d+.*\.sql$/.test(n),
).length;
test("PostgreSQL foundation: migrations, RLS, guarded roles, access and revocation", async (t) => {
  const { url, anonymousUrl } = await setupDatabase();
  Object.assign(process.env, {
    NODE_ENV: "test",
    STAFF_ORIGIN: "http://127.0.0.1:3000",
    RESPONDENT_ORIGIN: "http://localhost:3001",
    DATABASE_URL: url("orgfit_staff"),
    AUTH_DATABASE_URL: url("orgfit_auth"),
    OIDC_ISSUER: "http://127.0.0.1:4010",
    OIDC_CLIENT_ID: "test",
    OIDC_CLIENT_SECRET: "synthetic-test-secret",
    OIDC_MFA_ACR: "urn:test:mfa",
  });
  delete process.env.MIGRATION_DATABASE_URL;
  const auth = new pg.Client({ connectionString: url("orgfit_auth") }),
    staff = new pg.Client({ connectionString: url("orgfit_staff") }),
    operator = new pg.Client({ connectionString: url("orgfit_migrator") });
  await Promise.all([auth.connect(), staff.connect(), operator.connect()]);
  const token = secret(),
    adminToken = secret();
  try {
    await operator.query("SET ROLE orgfit_core_owner");
    await auth.query("SELECT access.issue_session($1,$2,$3)", [
      "http://127.0.0.1:4010",
      "staff",
      digest(token),
    ]);
    await auth.query("SELECT access.issue_session($1,$2,$3)", [
      "http://127.0.0.1:4010",
      "admin",
      digest(adminToken),
    ]);
    await t.test(
      "fresh migration and populated upgrade/re-run preserve data and sessions",
      async () => {
        await migrate(url("orgfit_migrator"));
        assert.equal(
          (
            await operator.query(
              "SELECT count(*)::int n FROM core.organization",
            )
          ).rows[0].n,
          2,
        );
        assert.equal(
          (
            await operator.query(
              "SELECT count(*)::int n FROM public.orgfit_migrations",
            )
          ).rows[0].n,
          // Derived from the migration directory so that adding a phase does not
          // silently weaken, or spuriously fail, this ledger check.
          migrationCount,
        );
        assert.equal(
          (
            await operator.query(
              "SELECT count(*)::int n FROM access.staff_session",
            )
          ).rows[0].n,
          2,
        );
      },
    );
    await t.test(
      "runtime roles cannot own/bypass policies, write base tables or issue identities",
      async () => {
        const role = (
          await staff.query(
            "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
          )
        ).rows[0];
        assert.equal(role.rolsuper, false);
        assert.equal(role.rolbypassrls, false);
        assert.equal(
          (
            await staff.query(
              "SELECT pg_has_role(current_user,'orgfit_core_owner','MEMBER') b",
            )
          ).rows[0].b,
          false,
        );
        assert.equal(
          (await staff.query("SELECT * FROM core.organization")).rowCount,
          0,
        );
        for (const query of [
          "SELECT * FROM access.staff_user",
          "SELECT * FROM access.staff_session",
          "SELECT * FROM ops.audit_log",
          "SET ROLE orgfit_core_owner",
          "INSERT INTO core.organization(code,name_ar) VALUES('BAD','bad')",
          "SELECT access.issue_session('x','y',decode(repeat('00',32),'hex'))",
        ]) {
          await assert.rejects(staff.query(query));
        }
        for (const roleName of ["orgfit_staff", "orgfit_auth"]) {
          const denied = new pg.Client({
            connectionString: anonymousUrl(roleName),
          });
          try {
            await assert.rejects(
              denied.connect(),
              /permission denied for database/,
            );
          } finally {
            await denied.end();
          }
        }
        await assert.rejects(auth.query("SELECT * FROM core.organization"));
        await assert.rejects(auth.query("SELECT access.list_staff()"));
        assert.equal(
          (
            await operator.query(
              "SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('access','core','ops') AND c.relkind='r' AND (NOT relrowsecurity OR NOT relforcerowsecurity)",
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      "anonymous denial, organization substitution, capability checks and pool context cleanup",
      async () => {
        await assert.rejects(
          withStaff(undefined, async () => true),
          /SESSION_REQUIRED/,
        );
        const orgs = await withStaff(token, async (tx) =>
          tx.selectFrom("core.organization").selectAll().execute(),
        );
        assert.deepEqual(
          orgs.map((o) => o.id),
          [ids.orgA],
        );
        await withStaff(token, async (tx) =>
          requireAccess(tx, ids.orgA, "directory.manage"),
        );
        await assert.rejects(
          withStaff(token, async (tx) =>
            requireAccess(tx, ids.orgA, "reports.manage"),
          ),
          /FORBIDDEN/,
        );
        await assert.rejects(
          withStaff(token, async (tx) => requireAccess(tx, ids.orgB)),
          /NOT_FOUND/,
        );
        assert.equal(
          (
            await withStaff(adminToken, async (tx) =>
              tx.selectFrom("core.organization").selectAll().execute(),
            )
          ).length,
          2,
        );
        await assert.rejects(
          withStaff(secret(), async () => true),
          /SESSION_REQUIRED/,
        );
        await assert.rejects(
          withStaff(token, async (tx) =>
            sql`select access.list_staff()`.execute(tx),
          ),
          /FORBIDDEN/,
        );
      },
    );
    await t.test(
      "OIDC transient state is single-use; disabled and unknown identities cannot get sessions",
      async () => {
        const d = digest(secret());
        await auth.query("SELECT access.begin_oidc($1,$2,$3,$4)", [
          d,
          "state",
          "nonce",
          "verifier",
        ]);
        assert.equal(
          (await auth.query("SELECT * FROM access.consume_oidc($1)", [d]))
            .rowCount,
          1,
        );
        assert.equal(
          (await auth.query("SELECT * FROM access.consume_oidc($1)", [d]))
            .rowCount,
          0,
        );
        for (const sub of ["disabled", "unknown"])
          assert.equal(
            (
              await auth.query("SELECT access.issue_session($1,$2,$3) ok", [
                "http://127.0.0.1:4010",
                sub,
                digest(secret()),
              ])
            ).rows[0].ok,
            false,
          );
      },
    );
    await t.test(
      "admin updates are idempotent, revision-checked, audited and revoke immediately",
      async () => {
        const body = {
            role: "STAFF",
            status: "ACTIVE",
            capabilities: [],
            organizationIds: [ids.orgA],
          },
          id = crypto.randomUUID(),
          hash = digest(JSON.stringify(body));
        const save = () =>
          withStaff(adminToken, async (tx) =>
            sql`select access.save_staff(${ids.staff}::uuid,1,${JSON.stringify(body)}::jsonb,${id}::uuid,${hash})`.execute(
              tx,
            ),
          );
        await save();
        await save();
        await assert.rejects(
          withStaff(token, async () => true),
          /SESSION_REQUIRED/,
        );
        assert.equal(
          (
            await operator.query(
              "SELECT revision::int FROM access.staff_user WHERE id=$1",
              [ids.staff],
            )
          ).rows[0].revision,
          2,
        );
        const next = secret();
        await auth.query("SELECT access.issue_session($1,$2,$3)", [
          "http://127.0.0.1:4010",
          "staff",
          digest(next),
        ]);
        await assert.rejects(
          withStaff(next, async (tx) =>
            requireAccess(tx, ids.orgA, "directory.manage"),
          ),
          /FORBIDDEN/,
        );
        await operator.query(
          "UPDATE access.staff_user SET status='DISABLED' WHERE id=$1",
          [ids.staff],
        );
        await assert.rejects(
          withStaff(next, async () => true),
          /SESSION_REQUIRED/,
        );
        await operator.query(
          "UPDATE access.staff_user SET status='ACTIVE' WHERE id=$1",
          [ids.staff],
        );
        await assert.rejects(
          withStaff(next, async () => true),
          /SESSION_REQUIRED/,
        );
        const audits = await operator.query("SELECT * FROM ops.audit_log");
        assert.equal(audits.rowCount, 1);
        assert.doesNotMatch(
          JSON.stringify(audits.rows),
          /token_digest|provider_subject|nonce|verifier/,
        );
      },
    );
    await t.test(
      "last admin cannot be disabled and absolute/idle expiry are authoritative",
      async () => {
        const b = JSON.stringify({
          role: "STAFF",
          status: "DISABLED",
          capabilities: [],
          organizationIds: [],
        });
        await assert.rejects(
          withStaff(adminToken, async (tx) =>
            sql`select access.save_staff(${ids.admin}::uuid,1,${b}::jsonb,${crypto.randomUUID()}::uuid,${digest(b)})`.execute(
              tx,
            ),
          ),
          /LAST_ADMIN/,
        );
        await operator.query(
          "UPDATE access.staff_session SET idle_expires_at=clock_timestamp()-interval '1 second' WHERE token_digest=$1",
          [digest(adminToken)],
        );
        await assert.rejects(
          withStaff(adminToken, async () => true),
          /SESSION_REQUIRED/,
        );
      },
    );
  } finally {
    await Promise.all([auth.end(), staff.end(), operator.end()]);
  }
});
test("bootstrap creates only the first approved identity and refuses a second bootstrap", async () => {
  const { url } = await setupDatabase(
    "https://identity.example.invalid",
    false,
  );
  const data = {
    issuer: "https://identity.example.invalid",
    subject: "approved-synthetic-admin",
    email: "bootstrap@example.invalid",
    displayName: "مسؤول تجريبي",
  };
  await bootstrap(url("orgfit_migrator"), data);
  await assert.rejects(
    bootstrap(url("orgfit_migrator"), data),
    /Bootstrap already performed/,
  );
  const db = new pg.Client({ connectionString: url("orgfit_migrator") });
  await db.connect();
  try {
    await db.query("SET ROLE orgfit_core_owner");
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM access.staff_user")).rows[0]
        .n,
      1,
    );
    assert.equal(
      (await db.query("SELECT action FROM ops.audit_log")).rows[0].action,
      "BOOTSTRAP",
    );
  } finally {
    await db.end();
  }
});
