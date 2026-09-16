import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { setupDatabase } from "./database";
import { ids } from "../scripts/seed";
import { withStaff } from "../src/db";
import { digest, secret, AppError } from "../src/security";
import { configureGateway, gatewayReadiness } from "../src/gateway-db";
import { messageContext, sendMessage, rateLimit, RateLimited } from "../src/respondent";
import { messageRoute } from "../src/employee-messages";
import { reapplyTombstones, runRetention, shipTombstones } from "../src/operations";

// Employee messages (migration 025) against a real PostgreSQL cluster: the
// link lifecycle, the gateway routines, the staff inbox, what is and is not
// stored, retention and the restore replay. Nothing here touches the
// anonymous store, and one test asserts that it cannot.

const failure = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (e) {
    return e instanceof AppError ? e.code : (e as Error).message;
  }
  return "NO_ERROR";
};

async function fixture() {
  const f = await setupDatabase();
  Object.assign(process.env, {
    NODE_ENV: "test",
    STAFF_ORIGIN: "http://127.0.0.1:3000",
    RESPONDENT_ORIGIN: "http://localhost:3001",
    DATABASE_URL: f.url("orgfit_staff"),
    AUTH_DATABASE_URL: f.url("orgfit_auth"),
    OIDC_ISSUER: "http://127.0.0.1:4010",
    OIDC_CLIENT_ID: "test",
    OIDC_CLIENT_SECRET: "synthetic-test-secret",
    OIDC_MFA_ACR: "urn:test:mfa",
    INVITATION_DIGEST_KEY: "a".repeat(64),
    INVITATION_DIGEST_KEY_VERSION: "test-v1",
    RATE_LIMIT_MESSAGE_SEND_PER_LINK: "3",
  });
  delete process.env.MIGRATION_DATABASE_URL;
  configureGateway(f.url("orgfit_gateway"));
  const auth = new pg.Client({ connectionString: f.url("orgfit_auth") });
  const operator = new pg.Client({ connectionString: f.url("orgfit_migrator") });
  await Promise.all([auth.connect(), operator.connect()]);
  await operator.query("SET ROLE orgfit_core_owner");
  const session = async (subject: string) => {
    const token = secret();
    await auth.query("select access.issue_session($1,$2,$3)", [process.env.OIDC_ISSUER, subject, digest(token)]);
    return token;
  };
  const deptA = randomUUID(),
    deptArchived = randomUUID(),
    deptB = randomUUID();
  for (const [id, org, code, name, status] of [
    [deptA, ids.orgA, "ENG", "الهندسة", "ACTIVE"],
    [deptArchived, ids.orgA, "OLD", "قسم مؤرشف", "ARCHIVED"],
    [deptB, ids.orgB, "FIN", "المالية", "ACTIVE"],
  ] as const)
    await operator.query(
      "insert into core.department(id,organization_id,code,name_ar,status) values($1,$2,$3,$4,$5)",
      [id, org, code, name, status],
    );
  const call = (token: string, method: string, path: string, headers: Record<string, string> = {}) =>
    withStaff(token, async (tx) => {
      const res = await messageRoute(
        new Request(`http://127.0.0.1:3000/api/v1/${path}`, { method, headers }),
        // The catch-all route hands over the path without its query string.
        path.split("?")[0],
        tx,
      );
      if (!res) throw new Error("NO_ROUTE");
      return { status: res.status, body: (await res.json()).data };
    });
  return { f, auth, operator, session, deptA, deptArchived, deptB, call };
}
const tokenOf = (url: string) => url.slice(url.indexOf("#") + 1);

test("E-1 employee messages: link, gateway, inbox, retention and restore replay", async () => {
  const x = await fixture();
  const { operator, call } = x;
  const org = ids.orgA;
  const idem = () => ({ "idempotency-key": randomUUID() });
  try {
    // --- the schema --------------------------------------------------------
    const columns = (
      await operator.query(
        "select column_name from information_schema.columns where table_schema='core' and table_name='employee_message' order by ordinal_position",
      )
    ).rows.map((r) => r.column_name);
    assert.deepEqual(columns, ["id", "organization_id", "department_id", "other_department", "body", "received_on"]);
    const dataType = (
      await operator.query(
        "select data_type from information_schema.columns where table_schema='core' and table_name='employee_message' and column_name='received_on'",
      )
    ).rows[0].data_type;
    assert.equal(dataType, "date", "a day, never an instant");
    // The gateway still holds no table privilege at all.
    await gatewayReadiness();

    // --- reading needs messages.read; issuing needs a Super Admin ---------
    let staff = await x.session("staff");
    assert.equal(await failure(() => call(staff, "GET", `organizations/${org}/messages`)), "FORBIDDEN");
    await operator.query(
      "insert into access.staff_capability(staff_user_id,capability) values($1,'messages.read') on conflict do nothing",
      [ids.staff],
    );
    staff = await x.session("staff");
    const admin = await x.session("admin");
    const empty = await call(staff, "GET", `organizations/${org}/messages`);
    assert.deepEqual(empty.body, { items: [], next: null });
    const status0 = await call(staff, "GET", `organizations/${org}/messages/link`);
    assert.equal(status0.body.active, false);
    assert.equal(status0.body.canManage, false);
    assert.equal(await failure(() => call(staff, "POST", `organizations/${org}/messages/link`, idem())), "FORBIDDEN");
    // The digest is not a column staff can select.
    const staffDb = new pg.Client({ connectionString: x.f.url("orgfit_staff") });
    await staffDb.connect();
    try {
      await assert.rejects(staffDb.query("select token_digest from core.message_link"), /permission denied/);
    } finally {
      await staffDb.end();
    }

    // --- issue, and a retry that cannot hand the link out again ----------
    const key = idem();
    const issued = await call(admin, "POST", `organizations/${org}/messages/link`, key);
    assert.equal(issued.status, 201);
    assert.match(issued.body.url, /^http:\/\/localhost:3001\/m#[A-Za-z0-9_-]{43}$/);
    const replay = await call(admin, "POST", `organizations/${org}/messages/link`, key);
    assert.deepEqual([replay.body.replayed, replay.body.url], [true, null]);
    const token = tokenOf(issued.body.url);
    const stored = await operator.query("select encode(token_digest,'hex') d from core.message_link");
    assert.ok(!stored.rows.some((r) => r.d.includes(Buffer.from(token).toString("hex"))), "the raw token is not stored");

    // --- the gateway: this organization and its ACTIVE departments only ---
    const context = await messageContext(token);
    assert.equal(context.access, "OPEN");
    if (context.access !== "OPEN") throw new Error("unreachable");
    assert.deepEqual(context.departments.map((d) => d.id), [x.deptA]);
    assert.deepEqual(Object.keys(context).sort(), ["access", "departments", "organization"]);
    assert.equal((await messageContext("b".repeat(43))).access, "UNAVAILABLE");

    const base = { token, otherDepartment: null };
    assert.deepEqual(await sendMessage({ ...base, departmentId: x.deptA, body: "  رسالة أولى  " }), { accepted: true });
    await sendMessage({ token, departmentId: null, otherDepartment: " الوردية الليلية ", body: "second" });
    // Another organization's department, an archived one, and an oversize body.
    assert.equal(await failure(() => sendMessage({ ...base, departmentId: x.deptB, body: "x" })), "VALIDATION_FAILED");
    assert.equal(await failure(() => sendMessage({ ...base, departmentId: x.deptArchived, body: "x" })), "VALIDATION_FAILED");
    assert.equal(
      await failure(() => sendMessage({ ...base, departmentId: x.deptA, body: "x".repeat(2001) })),
      "VALIDATION_FAILED",
    );
    // Messages are immutable.
    await assert.rejects(operator.query("update core.employee_message set body='changed'"), /MESSAGE_IMMUTABLE/);

    // --- rate limit: a flood on one link is refused ------------------------
    for (let i = 0; i < 3; i++) await rateLimit("message_send", new Headers(), { token });
    await assert.rejects(rateLimit("message_send", new Headers(), { token }), (e) => e instanceof RateLimited);

    // --- the inbox --------------------------------------------------------
    const page = await call(staff, "GET", `organizations/${org}/messages`);
    assert.equal(page.body.items.length, 2);
    const today = (await operator.query("select (clock_timestamp() at time zone timezone)::date::text d from core.organization where id=$1", [org])).rows[0].d;
    for (const item of page.body.items) {
      assert.deepEqual(Object.keys(item).sort(), [
        "body", "departmentId", "departmentNameAr", "departmentNameEn", "id", "otherDepartment", "receivedOn",
      ]);
      assert.equal(item.receivedOn, today);
    }
    assert.ok(page.body.items.some((i: { body: string; departmentNameAr: string }) => i.body === "رسالة أولى" && i.departmentNameAr === "الهندسة"));
    assert.ok(page.body.items.some((i: { otherDepartment: string }) => i.otherDepartment === "الوردية الليلية"));
    const other = await call(staff, "GET", `organizations/${org}/messages?department=OTHER`);
    assert.equal(other.body.items.length, 1);
    const first = await withStaff(staff, async (tx) =>
      (await messageRoute(new Request(`http://t/api/v1/organizations/${org}/messages`), `organizations/${org}/messages`, tx))!,
    );
    assert.equal(first.status, 200);
    // Organization B sees nothing of A.
    assert.deepEqual((await call(admin, "GET", `organizations/${ids.orgB}/messages`)).body.items, []);

    // --- rotate, archive, revoke -------------------------------------------
    const rotated = await call(admin, "POST", `organizations/${org}/messages/link`, idem());
    assert.equal((await messageContext(token)).access, "UNAVAILABLE", "rotation closes the old link");
    const token2 = tokenOf(rotated.body.url);
    assert.equal((await messageContext(token2)).access, "OPEN");
    await operator.query("update core.organization set status='ARCHIVED' where id=$1", [org]);
    assert.equal((await messageContext(token2)).access, "UNAVAILABLE", "an archived organization's link does not resolve");
    assert.equal(
      await failure(() => sendMessage({ token: token2, departmentId: x.deptA, otherDepartment: null, body: "x" })),
      "MESSAGE_LINK_UNAVAILABLE",
    );
    await operator.query("update core.organization set status='ACTIVE' where id=$1", [org]);
    await call(admin, "DELETE", `organizations/${org}/messages/link`, idem());
    assert.equal((await messageContext(token2)).access, "UNAVAILABLE");
    assert.equal(await failure(() => call(admin, "DELETE", `organizations/${org}/messages/link`, idem())), "STATE_CONFLICT");
    const stones = await operator.query("select count(*)::int n from ops.deletion_tombstone where class='MESSAGE_LINK' and organization_id=$1", [org]);
    assert.equal(stones.rows[0].n, 2, "one tombstone per revoked link (rotation and revocation)");
    const audit = await operator.query(
      "select action, count(*)::int n from ops.audit_log where action like 'MESSAGE_LINK_%' group by action order by action",
    );
    assert.deepEqual(audit.rows, [
      { action: "MESSAGE_LINK_ISSUED", n: 2 },
      { action: "MESSAGE_LINK_REVOKED", n: 2 },
    ]);

    // --- retention -----------------------------------------------------------
    await operator.query(
      "insert into core.employee_message(organization_id,department_id,body,received_on) values($1,$2,'old',current_date-400)",
      [org, x.deptA],
    );
    const coreUrl = x.f.url("orgfit_migrator"),
      anonUrl = x.f.anonymousUrl("orgfit_anon_migrator");
    const retention = await runRetention(coreUrl, anonUrl);
    assert.equal(retention.employee_message, 1);
    assert.equal((await operator.query("select count(*)::int n from core.employee_message")).rows[0].n, 2);

    // --- restore replay: a revoked link that a restore brought back ----------
    const ledger = await mkdtemp(join(tmpdir(), "orgfit-message-ledger-"));
    await shipTombstones(coreUrl, ledger);
    const last = (await operator.query("select id from core.message_link where organization_id=$1 order by created_at desc limit 1", [org])).rows[0].id;
    await operator.query("update core.message_link set state='ACTIVE',revoked_at=null,revoked_by=null where id=$1", [last]);
    assert.equal((await messageContext(token2)).access, "OPEN", "the simulated restore reopened the channel");
    const report = await reapplyTombstones(coreUrl, anonUrl, ledger);
    assert.equal(report.applied.MESSAGE_LINK, 1);
    assert.equal((await messageContext(token2)).access, "UNAVAILABLE");

    // --- the anonymous store holds nothing of this -----------------------------
    const anon = new pg.Client({ connectionString: anonUrl });
    await anon.connect();
    try {
      await anon.query("SET ROLE orgfit_anon_owner");
      const tables = await anon.query(
        "select table_name from information_schema.tables where table_schema='anonymous' and table_name ilike '%message%'",
      );
      assert.equal(tables.rows.length, 0);
    } finally {
      await anon.end();
    }
  } finally {
    await Promise.all([x.auth.end(), x.operator.end()]);
    configureGateway(undefined);
  }
});
