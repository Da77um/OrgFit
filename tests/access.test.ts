import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "kysely";
import { setupDatabase } from "./database";
import { ids } from "../scripts/seed";
import { bootstrapDevAdmin } from "../scripts/bootstrap-dev-admin";
import { withStaff, authDatabase } from "../src/db";
import { digest, secret } from "../src/security";
import {
  activateInvitation,
  authenticate,
  inspectInvitation,
} from "../src/local-auth";
import { hashPassword, verifyPassword } from "../src/password";
import { checkPasswordPolicy } from "../src/password-policy";
import { failure } from "./respondent-fixture";

// ---------------------------------------------------------------------------
// Local password sign-in, invitation-only activation and the development
// administrator bootstrap, against a real database through the real routines.
//
// The properties that matter are the ones that would quietly widen access:
// a path that works while its switch is off, an unknown address that answers
// differently from a wrong password, an invitation that can be used twice or
// after it expires, an activation that lets the invitee choose their own role,
// a seed that resets a password or elevates an existing account, and a
// password session that survives the switch being turned off.
// ---------------------------------------------------------------------------

const ISSUER = "http://127.0.0.1:4010";
// A synthetic test credential. It is not the development administrator's.
const SYNTHETIC = `Synth${randomUUID().slice(0, 8)}1`;

const fixture = await setupDatabase(ISSUER);
Object.assign(process.env, {
  NODE_ENV: "test",
  STAFF_ORIGIN: "http://127.0.0.1:3000",
  RESPONDENT_ORIGIN: "http://localhost:3001",
  DATABASE_URL: fixture.url("orgfit_staff"),
  AUTH_DATABASE_URL: fixture.url("orgfit_auth"),
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: "test",
  OIDC_CLIENT_SECRET: "synthetic-test-secret",
  OIDC_MFA_ACR: "urn:test:mfa",
});
delete process.env.MIGRATION_DATABASE_URL;

async function operator<T>(fn: (db: pg.Client) => Promise<T>) {
  const db = new pg.Client({ connectionString: fixture.url("orgfit_migrator") });
  await db.connect();
  try {
    await db.query("SET ROLE orgfit_core_owner");
    return await fn(db);
  } finally {
    await db.end();
  }
}

// A real OIDC-path session for a seeded subject, minted by the real routine.
async function oidcSession(subject: string) {
  const token = secret();
  const { rows } = await sql<{ ok: boolean }>`
    select access.issue_session(${ISSUER},${subject},${digest(token)}) as ok`.execute(
    authDatabase(),
  );
  assert.equal(rows[0].ok, true);
  return token;
}

async function createInvitation(
  token: string,
  body: Record<string, unknown>,
  inviteToken = secret(),
) {
  await withStaff(token, async (tx) => {
    await sql`select access.create_invitation(${digest(inviteToken)},${JSON.stringify(body)}::jsonb,${randomUUID()}::uuid,${digest(JSON.stringify(body))})`.execute(
      tx,
    );
  });
  return inviteToken;
}

test("A-0 password hashing and policy", async () => {
  const hash = await hashPassword(SYNTHETIC);
  assert.match(hash, /^\$scrypt\$N=32768,r=8,p=1\$/);
  assert.ok(!hash.includes(SYNTHETIC));
  assert.equal(await verifyPassword(SYNTHETIC, hash), true);
  assert.equal(await verifyPassword(SYNTHETIC + "x", hash), false);
  assert.equal(await verifyPassword(SYNTHETIC, null), false);
  assert.equal(checkPasswordPolicy("short1"), "TOO_SHORT");
  assert.equal(checkPasswordPolicy("lettersonly"), "NEEDS_LETTER_AND_DIGIT");
  assert.equal(checkPasswordPolicy("12345678"), "NEEDS_LETTER_AND_DIGIT");
  assert.equal(checkPasswordPolicy("B7654321"), null);
  // The column refuses anything that is not the encoded hash.
  assert.equal(
    await failure(() =>
      operator((db) =>
        db.query(
          "INSERT INTO access.staff_password(staff_user_id,password_hash) VALUES($1,$2)",
          [ids.staff, "plaintext-password-123"],
        ),
      ),
    ),
    'new row for relation "staff_password" violates check constraint "staff_password_password_hash_check"',
  );
});

test("A-1 with the switch off, every local path refuses", async () => {
  assert.equal((await authenticate("anyone@example.invalid", SYNTHETIC)).outcome, "REJECTED");
  assert.equal((await inspectInvitation(secret())).state, "INVALID");
  const admin = await oidcSession("admin");
  assert.equal(
    await failure(() =>
      createInvitation(admin, {
        email: "early@example.invalid",
        role: "STAFF",
        capabilities: [],
        organizationIds: [],
        locale: "ar",
        expiresInHours: 1,
      }),
    ),
    "FORBIDDEN",
  );
});

test("A-2 bootstrap refuses production, non-loopback and a weak password", async () => {
  const url = fixture.url("orgfit_migrator");
  await assert.rejects(
    bootstrapDevAdmin(url, { email: "a@example.invalid", password: SYNTHETIC, displayName: "x" }, { NODE_ENV: "production" }),
    /development only/,
  );
  const remote = new URL(url);
  remote.hostname = "db.example.invalid";
  await assert.rejects(
    bootstrapDevAdmin(remote.href, { email: "a@example.invalid", password: SYNTHETIC, displayName: "x" }, {}),
    /loopback/,
  );
  const weak = await bootstrapDevAdmin(
    url,
    { email: "weak@example.invalid", password: "abcdefgh", displayName: "x" },
    {},
  );
  assert.equal(weak.result, "POLICY_CONFLICT");
  const count = await operator((db) =>
    db.query("SELECT count(*)::int AS n FROM access.staff_user WHERE email='weak@example.invalid'"),
  );
  assert.equal(count.rows[0].n, 0);
});

let adminId = "";
test("A-3 bootstrap creates once, then reports and never overwrites", async () => {
  const url = fixture.url("orgfit_migrator");
  const input = { email: "Local.Admin@example.invalid", password: SYNTHETIC, displayName: "مسؤول النظام" };
  const first = await bootstrapDevAdmin(url, input, {});
  assert.equal(first.result, "CREATED");
  adminId = (first as { id: string }).id;
  const before = await operator((db) =>
    db.query("SELECT password_hash FROM access.staff_password WHERE staff_user_id=$1", [adminId]),
  );
  // Running again with a DIFFERENT password must not reset the credential.
  const again = await bootstrapDevAdmin(url, { ...input, password: SYNTHETIC + "Z9" }, {});
  assert.equal(again.result, "ALREADY_PRESENT");
  const after = await operator((db) =>
    db.query("SELECT password_hash FROM access.staff_password WHERE staff_user_id=$1", [adminId]),
  );
  assert.equal(after.rows[0].password_hash, before.rows[0].password_hash);
  const users = await operator((db) =>
    db.query("SELECT count(*)::int AS n FROM access.staff_user WHERE email='local.admin@example.invalid'"),
  );
  assert.equal(users.rows[0].n, 1);

  // An existing identity-provider account with the requested address is
  // reported, not converted or elevated.
  const mismatch = await bootstrapDevAdmin(
    url,
    { email: "staff@example.invalid", password: SYNTHETIC, displayName: "x" },
    {},
  );
  assert.equal(mismatch.result, "MISMATCH");
  assert.match((mismatch as { detail: string }).detail, /identity provider/);
  assert.match((mismatch as { detail: string }).detail, /STAFF, not SUPER_ADMIN/);
  const staff = await operator((db) =>
    db.query(
      "SELECT u.role, (SELECT count(*)::int FROM access.staff_password p WHERE p.staff_user_id=u.id) AS creds FROM access.staff_user u WHERE id=$1",
      [ids.staff],
    ),
  );
  assert.deepEqual(staff.rows[0], { role: "STAFF", creds: 0 });
});

test("A-4 sign-in: one answer for wrong password and unknown address; PASSWORD sessions are labelled", async () => {
  assert.equal((await authenticate("local.admin@example.invalid", SYNTHETIC + "x")).outcome, "REJECTED");
  assert.equal((await authenticate("nobody@example.invalid", SYNTHETIC)).outcome, "REJECTED");
  // An identity-provider account has no password slot at all.
  assert.equal((await authenticate("admin@example.invalid", SYNTHETIC)).outcome, "REJECTED");

  const ok = await authenticate("  LOCAL.ADMIN@example.invalid ", SYNTHETIC);
  assert.equal(ok.outcome, "SIGNED_IN");
  const token = (ok as { token: string }).token;
  const profile = await withStaff(token, async (_tx, p) => p);
  assert.equal(profile.role, "SUPER_ADMIN");
  assert.equal(profile.displayName, "مسؤول النظام");
  const session = await operator((db) =>
    db.query("SELECT auth_method, mfa_verified FROM access.staff_session WHERE token_digest=$1", [digest(token)]),
  );
  assert.deepEqual(session.rows[0], { auth_method: "PASSWORD", mfa_verified: false });
  // The OIDC path still mints MFA-verified sessions.
  const oidc = await oidcSession("admin");
  const oidcRow = await operator((db) =>
    db.query("SELECT auth_method, mfa_verified FROM access.staff_session WHERE token_digest=$1", [digest(oidc)]),
  );
  assert.deepEqual(oidcRow.rows[0], { auth_method: "OIDC", mfa_verified: true });
});

test("A-5 five failures lock the address, including for the right password", async () => {
  const url = fixture.url("orgfit_migrator");
  const created = await bootstrapDevAdmin(
    url,
    { email: "locked@example.invalid", password: SYNTHETIC, displayName: "x" },
    {},
  );
  assert.equal(created.result, "CREATED");
  for (let i = 0; i < 5; i++)
    assert.equal((await authenticate("locked@example.invalid", "Wrong0000")).outcome, "REJECTED");
  assert.equal((await authenticate("locked@example.invalid", SYNTHETIC)).outcome, "RATE_LIMITED");
  // An address that does not exist locks identically, so the lock is no oracle.
  for (let i = 0; i < 5; i++) await authenticate("ghost@example.invalid", "Wrong0000");
  assert.equal((await authenticate("ghost@example.invalid", "Wrong0000")).outcome, "RATE_LIMITED");
});

test("A-6 invitation: role and access come from the invitation, single use, expiry, revocation", async () => {
  const admin = await oidcSession("admin");
  const body = {
    email: "Invitee@example.invalid",
    role: "STAFF",
    capabilities: ["results.read"],
    organizationIds: [ids.orgA],
    locale: "en",
    expiresInHours: 24,
  };
  const token = await createInvitation(admin, body);

  const view = await inspectInvitation(token);
  assert.equal(view.state, "VALID");
  assert.equal(view.email, "invitee@example.invalid");
  assert.equal(view.role, "STAFF");

  assert.equal((await inspectInvitation("not-a-token")).state, "INVALID");
  assert.equal((await inspectInvitation(secret())).state, "INVALID");

  const done = await activateInvitation(token, "موظف مدعو", SYNTHETIC);
  assert.equal(done.state, "ACTIVATED");
  const account = await operator((db) =>
    db.query(
      `SELECT u.role, u.issuer, u.locale,
        ARRAY(SELECT capability FROM access.staff_capability WHERE staff_user_id=u.id) AS caps,
        ARRAY(SELECT organization_id::text FROM access.organization_access WHERE staff_user_id=u.id) AS orgs
       FROM access.staff_user u WHERE email='invitee@example.invalid'`,
    ),
  );
  assert.deepEqual(account.rows[0], {
    role: "STAFF",
    issuer: "urn:orgfit:local-password",
    locale: "en",
    caps: ["results.read"],
    orgs: [ids.orgA],
  });

  // Used once, then never again — inspection and activation both say so.
  assert.equal((await inspectInvitation(token)).state, "CONSUMED");
  assert.equal((await activateInvitation(token, "again", SYNTHETIC)).state, "CONSUMED");

  // The new account signs in and is scoped: no staff administration.
  const signIn = await authenticate("invitee@example.invalid", SYNTHETIC);
  assert.equal(signIn.outcome, "SIGNED_IN");
  const staffToken = (signIn as { token: string }).token;
  assert.equal(
    await failure(() =>
      withStaff(staffToken, (tx) => sql`select access.list_staff()`.execute(tx)),
    ),
    "FORBIDDEN",
  );
  // ...and cannot issue invitations, including one that would make it an admin.
  assert.equal(
    await failure(() =>
      createInvitation(staffToken, { ...body, email: "escalate@example.invalid", role: "SUPER_ADMIN" }),
    ),
    "FORBIDDEN",
  );

  // Expired.
  const expiring = await createInvitation(admin, { ...body, email: "late@example.invalid" });
  await operator((db) =>
    db.query(
      "UPDATE access.staff_invitation SET expires_at=clock_timestamp()-interval '1 minute' WHERE email='late@example.invalid'",
    ),
  );
  assert.equal((await inspectInvitation(expiring)).state, "EXPIRED");
  assert.equal((await activateInvitation(expiring, "late", SYNTHETIC)).state, "EXPIRED");

  // Revoked.
  const revoked = await createInvitation(admin, { ...body, email: "withdrawn@example.invalid" });
  const id = (
    await operator((db) =>
      db.query("SELECT id FROM access.staff_invitation WHERE email='withdrawn@example.invalid'"),
    )
  ).rows[0].id;
  await withStaff(admin, (tx) => sql`select access.revoke_invitation(${id}::uuid)`.execute(tx));
  assert.equal((await activateInvitation(revoked, "x", SYNTHETIC)).state, "REVOKED");

  // An invitation to an address that already has an account is refused at issue.
  assert.equal(
    await failure(() => createInvitation(admin, { ...body, email: "staff@example.invalid" })),
    "STATE_CONFLICT",
  );

  // Two simultaneous activations of one invitation: exactly one wins.
  const race = await createInvitation(admin, { ...body, email: "race@example.invalid" });
  const results = await Promise.all([
    activateInvitation(race, "one", SYNTHETIC),
    activateInvitation(race, "two", SYNTHETIC),
  ]);
  assert.deepEqual(results.map((r) => r.state).sort(), ["ACTIVATED", "CONSUMED"]);
});

test("A-7 turning the switch off ends every password session and path", async () => {
  const ok = await authenticate("local.admin@example.invalid", SYNTHETIC);
  assert.equal(ok.outcome, "SIGNED_IN");
  const token = (ok as { token: string }).token;
  await withStaff(token, async (_tx, p) => p);
  const oidc = await oidcSession("admin");
  await operator((db) => db.query("UPDATE access.local_access_setting SET enabled=false"));
  try {
    assert.equal(await failure(() => withStaff(token, async (_tx, p) => p)), "SESSION_REQUIRED");
    assert.equal((await authenticate("local.admin@example.invalid", SYNTHETIC)).outcome, "REJECTED");
    // The identity-provider session is unaffected.
    assert.equal((await withStaff(oidc, async (_tx, p) => p)).role, "SUPER_ADMIN");
  } finally {
    await operator((db) => db.query("UPDATE access.local_access_setting SET enabled=true"));
  }
});

test.after(async () => {
  await authDatabase().destroy();
});
