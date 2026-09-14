import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "kysely";
import { setupDatabase } from "./database";
import { ids } from "../scripts/seed";
import { withStaff, authDatabase } from "../src/db";
import { digest, secret } from "../src/security";
import { administrationRoute, auditCsv, csvCell } from "../src/administration";
import { decodeCursor, cursorKinds, encodeCursor } from "../src/pagination";
import { identityAccountUrl } from "../src/config";
import { failure } from "./respondent-fixture";

// ---------------------------------------------------------------------------
// Post-Audit Repair Pass 1: staff administration, audit history, settings and
// own-session management, against a real database through the real routines
// and the real route module.
//
// The properties that matter are the ones the audit found missing or that a
// new screen could quietly weaken: rows past the hundredth that no request can
// reach, a page boundary that drops or repeats a row written in the same
// microsecond as its neighbour, an ordinary staff member reading administrator
// records, a profile operation that reaches someone else's session, a settings
// save that lowers the threshold floor, rewrites history or loses a concurrent
// update, and an invitation retry that hands out a link which opens nothing.
// ---------------------------------------------------------------------------

const ISSUER = "http://127.0.0.1:4010";
const ORIGIN = "http://127.0.0.1:3000";
const fixture = await setupDatabase(ISSUER);
Object.assign(process.env, {
  NODE_ENV: "test",
  STAFF_ORIGIN: ORIGIN,
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

async function session(subject: string) {
  const token = secret();
  const { rows } = await sql<{ ok: boolean }>`
    select access.issue_session(${ISSUER},${subject},${digest(token)}) as ok`.execute(
    authDatabase(),
  );
  assert.equal(rows[0].ok, true, subject);
  return token;
}

type Init = { method?: string; body?: unknown; headers?: Record<string, string> };
function request(target: string, init: Init = {}) {
  const method = init.method ?? "GET";
  return new Request(`${ORIGIN}/api/v1/${target}`, {
    method,
    headers: {
      ...(method === "GET" ? {} : { "content-type": "application/json", "idempotency-key": randomUUID() }),
      ...(init.headers ?? {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
  });
}
async function route(token: string, target: string, init: Init = {}) {
  const [path] = target.split("?");
  const res = await withStaff(token, (tx, profile) =>
    administrationRoute(request(target, init), path, tx, profile),
  );
  assert.ok(res, `${target} is not a route`);
  return res;
}
async function call<T = Record<string, unknown>>(token: string, target: string, init: Init = {}) {
  const res = await route(token, target, init);
  const text = await res.text();
  assert.ok(res.ok, `${target} -> ${res.status} ${text}`);
  return { status: res.status, data: (text ? JSON.parse(text).data : null) as T, res };
}
const deny = (token: string, target: string, init: Init = {}) =>
  failure(async () => {
    const res = await route(token, target, init);
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
  });

let admin = "";
let staff = "";
test.before(async () => {
  admin = await session("admin");
  staff = await session("staff");
});

type StaffItem = { id: string; email: string; role: string; status: string; revision: number };
type Paged<T> = { items: T[]; nextCursor: string | null };

test("AD-1 staff: more than 100 accounts, every one reachable exactly once, in order", async () => {
  await operator(async (db) => {
    for (let i = 0; i < 130; i++)
      await db.query(
        "INSERT INTO access.staff_user(issuer,provider_subject,email,display_name,role,status) VALUES($1,$2,$3,$4,'STAFF',$5)",
        [ISSUER, `bulk-${i}`, `bulk-${String(i).padStart(3, "0")}@example.invalid`, `موظف مجمّع ${i}`, i % 10 === 0 ? "DISABLED" : "ACTIVE"],
      );
  });
  const total = (await operator((db) => db.query("SELECT count(*)::int n FROM access.staff_user"))).rows[0].n;
  assert.ok(total > 100);

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const { data }: { data: Paged<StaffItem> } = await call<Paged<StaffItem>>(
      admin,
      `staff?limit=25${cursor ? `&cursor=${cursor}` : ""}`,
    );
    assert.ok(data.items.length <= 25);
    seen.push(...data.items.map((s) => s.email));
    cursor = data.nextCursor;
    pages++;
    assert.ok(pages < 20, "pagination does not terminate");
  } while (cursor);
  assert.equal(seen.length, total, "no gap");
  assert.equal(new Set(seen).size, total, "no duplicate");
  assert.deepEqual(seen, [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "stable order");
  assert.equal(pages, Math.ceil(total / 25));

  // A full page with more behind it carries a cursor; the final page does not.
  assert.ok((await call<Paged<StaffItem>>(admin, "staff?limit=100")).data.nextCursor);

  // Filters are allowlisted and combined server-side.
  const disabled = await call<Paged<StaffItem>>(admin, "staff?status=DISABLED&q=bulk&limit=100");
  assert.equal(disabled.data.items.length, 13);
  assert.ok(disabled.data.items.every((s) => s.status === "DISABLED"));
  const byName = await call<Paged<StaffItem>>(admin, `staff?q=${encodeURIComponent("مجمّع 129")}`);
  assert.deepEqual(byName.data.items.map((s) => s.email), ["bulk-129@example.invalid"]);

  // Refused rather than ignored or clamped.
  for (const bad of ["staff?limit=101", "staff?limit=0", "staff?sort=email", "staff?role=OWNER", "staff?cursor=%%%", `staff?cursor=${encodeCursor(["x", "not-a-uuid"])}`, "staff?status=ACTIVE&status=DISABLED"])
    assert.equal(await deny(admin, bad), "VALIDATION_FAILED", bad);
  assert.equal(await failure(() => withStaff(admin, (tx) => sql`select access.staff_page('{}'::jsonb,null,null,101)`.execute(tx))), "VALIDATION_FAILED");
  assert.equal(await failure(() => withStaff(admin, (tx) => sql`select access.staff_page('{"sort":"x"}'::jsonb,null,null,10)`.execute(tx))), "VALIDATION_FAILED");
});

test("AD-2 audit: same-microsecond events paginate without gaps or duplicates; filters; ordinary staff refused", async () => {
  // 240 events share ONE timestamp, 60 more are spread out, all synthetic.
  const at = "2026-09-01T08:00:00.123456Z";
  await operator(async (db) => {
    await db.query(
      `INSERT INTO ops.audit_log(actor_id,action,target_id,field_names,occurred_at)
       SELECT $1,'ACCESS_CHANGED',gen_random_uuid(),ARRAY['role'],$2::timestamptz FROM generate_series(1,240)`,
      [ids.admin, at],
    );
    await db.query(
      `INSERT INTO ops.audit_log(actor_id,action,target_id,field_names,occurred_at,organization_id)
       SELECT $1,'DIRECTORY_CHANGED',gen_random_uuid(),ARRAY['organization'],$2::timestamptz - (g || ' seconds')::interval,$3 FROM generate_series(1,60) g`,
      [ids.staff, at, ids.orgA],
    );
  });
  const expected = (await operator((db) => db.query("SELECT id::text FROM ops.audit_log ORDER BY occurred_at DESC, id DESC"))).rows.map((r) => r.id);
  assert.ok(expected.length >= 300);

  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const { data }: { data: Paged<{ id: string; occurredAt: string }> } = await call<Paged<{ id: string; occurredAt: string }>>(
      admin,
      `audit?limit=7${cursor ? `&cursor=${cursor}` : ""}`,
    );
    seen.push(...data.items.map((e) => e.id));
    cursor = data.nextCursor;
    if (cursor) {
      const decoded = decodeCursor(cursor, cursorKinds.time)!;
      // The cursor carries full microsecond precision, not a JavaScript Date.
      assert.match(decoded[0], /\.\d{6}Z$/);
    }
  } while (cursor);
  assert.deepEqual(seen, expected, "every event once, newest first, ties broken by id");

  // Filters.
  const directory = await call<Paged<{ action: string; organizationCode: string }>>(admin, `audit?action=DIRECTORY_CHANGED&organizationId=${ids.orgA}&limit=100`);
  assert.equal(directory.data.items.length, 60);
  assert.ok(directory.data.items.every((e) => e.action === "DIRECTORY_CHANGED" && e.organizationCode === "SYNTHETIC_A"));
  const window = await call<Paged<unknown>>(admin, `audit?from=${encodeURIComponent("2026-09-01T07:59:00Z")}&to=${encodeURIComponent("2026-09-01T07:59:30Z")}&limit=100`);
  assert.equal(window.data.items.length, 30);
  const byActor = await call<Paged<{ actorId: string }>>(admin, `audit?actorId=${ids.staff}&limit=100`);
  assert.ok(byActor.data.items.length >= 60 && byActor.data.items.every((e) => e.actorId === ids.staff));
  for (const bad of ["audit?action=DROP_TABLE", "audit?from=yesterday", "audit?actorId=1", "audit?limit=500", "audit?q=x"])
    assert.equal(await deny(admin, bad), "VALIDATION_FAILED", bad);

  // Ordinary staff: refused at the route AND at the routine.
  assert.equal(await deny(staff, "audit"), "FORBIDDEN");
  assert.equal(await deny(staff, "staff"), "FORBIDDEN");
  assert.equal(await deny(staff, `staff/${ids.admin}`), "FORBIDDEN");
  assert.equal(await deny(staff, "staff/invitations"), "FORBIDDEN");
  assert.equal(await deny(staff, "staff/organizations"), "FORBIDDEN");
  assert.equal(await deny(staff, "settings/status"), "FORBIDDEN");
  assert.equal(await deny(staff, "audit/exports", { method: "POST", body: { filters: {} } }), "FORBIDDEN");
  assert.equal(await deny(staff, `staff/${ids.admin}/revoke-sessions`, { method: "POST" }), "FORBIDDEN");
  for (const query of [
    sql`select access.staff_page('{}'::jsonb,null,null,10)`,
    sql`select access.staff_record(${ids.admin}::uuid)`,
    sql`select access.invitation_page('{}'::jsonb,null,null,10)`,
    sql`select access.audit_page('{}'::jsonb,null,null,10)`,
    sql`select access.audit_export('{}'::jsonb,10)`,
    sql`select access.settings_history()`,
    sql`select access.system_status()`,
    sql`select access.revoke_sessions(${ids.admin}::uuid)`,
    sql`select access.invitation_token_matches(${ids.admin}::uuid,${digest("x")})`,
  ])
    assert.equal(await failure(() => withStaff(staff, (tx) => query.execute(tx))), "FORBIDDEN");
  // The internal selector is not reachable from the runtime role at all.
  const raw = new pg.Client({ connectionString: fixture.url("orgfit_staff") });
  await raw.connect();
  try {
    await assert.rejects(raw.query("SELECT access.audit_select('{}'::jsonb,null,null,10)"), /permission denied/);
    await assert.rejects(raw.query("SELECT * FROM ops.system_setting"), /permission denied/);
  } finally {
    await raw.end();
  }
});

test("AD-3 audit export: bounded, audited, formula-safe, and never carries a respondent invitation target", async () => {
  const respondentInvitation = randomUUID();
  await operator(async (db) => {
    await db.query("UPDATE access.staff_user SET display_name='=HYPERLINK(\"http://x\")' WHERE id=$1", [ids.staff]);
    await db.query(
      "INSERT INTO ops.audit_log(actor_id,action,target_id,field_names,organization_id) VALUES($1,'INVITATION_ISSUED',$2,ARRAY['invitation'],$3),($1,'INVITATION_REVOKED',$2,ARRAY['invitation'],$3)",
      [ids.staff, respondentInvitation, ids.orgA],
    );
  });
  const listed = await call<Paged<{ action: string; targetId: string | null; targetWithheld: boolean }>>(admin, `audit?actorId=${ids.staff}&action=INVITATION_ISSUED`);
  assert.equal(listed.data.items[0].targetId, null);
  assert.equal(listed.data.items[0].targetWithheld, true);

  const res = await route(admin, "audit/exports", { method: "POST", body: { filters: { actorId: ids.staff, organizationId: ids.orgA, from: "2026-01-01T00:00:00Z" } } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /^text\/csv/);
  assert.match(res.headers.get("content-disposition")!, /^attachment; filename="orgfit-audit-\d{8}T\d{6}Z\.csv"$/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const bytes = Buffer.from(await res.arrayBuffer());
  // A UTF-8 byte-order mark, so a spreadsheet reads Arabic names correctly.
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const csv = bytes.toString("utf8");
  assert.ok(!csv.includes(respondentInvitation), "respondent invitation id withheld");
  assert.ok(csv.includes("'=HYPERLINK"), "formula neutralized");
  assert.doesNotMatch(csv, /token|digest|password_hash|provider_subject|answer|draft/i);
  assert.equal(csv.trim().split("\r\n").length, 1 + 62);
  const exports = await operator((db) => db.query("SELECT count(*)::int n FROM ops.audit_log WHERE action='AUDIT_EXPORTED' AND actor_id=$1", [ids.admin]));
  assert.equal(exports.rows[0].n, 1);
  // Larger than the bound: refused, not silently cut.
  assert.equal(await deny(admin, "audit/exports", { method: "POST", body: { filters: {} } }), "NO_ERROR");
  await operator((db) =>
    db.query("INSERT INTO ops.audit_log(actor_id,action,target_id,field_names) SELECT $1,'LOGOUT',$1,ARRAY['authEpoch'] FROM generate_series(1,5000)", [ids.admin]),
  );
  assert.equal(await failure(async () => { await route(admin, "audit/exports", { method: "POST", body: { filters: {} } }); }), "EXPORT_TOO_LARGE");
  assert.equal(await deny(admin, "audit/exports", { method: "POST", body: { filters: { answer: "x" } } }), "VALIDATION_FAILED");

  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(auditCsv([]).split("\r\n")[0].slice(1), "occurred_at_utc,action,field_names,actor_email,actor_name,organization_code,target_id,event_id");
  await operator((db) => db.query("UPDATE access.staff_user SET display_name='موظف تجريبي staff' WHERE id=$1", [ids.staff]));
});

test("AD-4 profile sessions: own sessions only; another person's session cannot be listed or revoked", async () => {
  const mine = [await session("staff"), await session("staff"), await session("staff")];
  const theirs = await session("admin");
  const theirId = (await operator((db) => db.query("SELECT id FROM access.staff_session WHERE token_digest=$1", [digest(theirs)]))).rows[0].id;

  const list = await call<{ items: { id: string; current: boolean; authMethod: string }[] }>(mine[0], "profile/sessions");
  assert.ok(list.data.items.length >= 3);
  assert.equal(list.data.items.filter((s) => s.current).length, 1);
  assert.equal(list.data.items[0].current, true, "current session first");
  assert.ok(!list.data.items.some((s) => s.id === theirId));
  assert.doesNotMatch(JSON.stringify(list.data), /digest|token/i);

  // Someone else's session id: indistinguishable from a missing one, and untouched.
  assert.equal(await failure(async () => { await route(mine[0], `profile/sessions/${theirId}/revoke`, { method: "POST" }); }), "NOT_FOUND");
  assert.equal((await withStaff(theirs, async (_tx, p) => p)).role, "SUPER_ADMIN");
  assert.equal(await failure(async () => { await route(mine[0], `profile/sessions/${randomUUID()}/revoke`, { method: "POST" }); }), "NOT_FOUND");

  // The session in use is ended by logout, not here.
  const currentId = list.data.items.find((s) => s.current)!.id;
  assert.equal(await failure(async () => { await route(mine[0], `profile/sessions/${currentId}/revoke`, { method: "POST" }); }), "STATE_CONFLICT");

  // One other session.
  const secondId = (await operator((db) => db.query("SELECT id FROM access.staff_session WHERE token_digest=$1", [digest(mine[1])]))).rows[0].id;
  assert.equal((await route(mine[0], `profile/sessions/${secondId}/revoke`, { method: "POST" })).status, 204);
  assert.equal(await failure(() => withStaff(mine[1], async () => true)), "SESSION_REQUIRED");

  // All others: the current one survives, the admin's session is untouched.
  const others = await call<{ revoked: number }>(mine[0], "profile/sessions/revoke-others", { method: "POST" });
  assert.ok(others.data.revoked >= 1);
  assert.equal(await failure(() => withStaff(mine[2], async () => true)), "SESSION_REQUIRED");
  assert.equal(await failure(() => withStaff(staff, async () => true)), "SESSION_REQUIRED");
  assert.equal((await withStaff(mine[0], async (_tx, p) => p)).email, "staff@example.invalid");
  assert.equal((await withStaff(theirs, async (_tx, p) => p)).role, "SUPER_ADMIN");
  staff = mine[0];
  const audited = await operator((db) => db.query("SELECT count(*)::int n FROM ops.audit_log WHERE action='SESSIONS_REVOKED' AND actor_id=$1 AND 'session'=ANY(field_names)", [ids.staff]));
  assert.equal(audited.rows[0].n, 2);
});

test("AD-5 settings: floor of five, valid zone, stale revision, concurrent saves, immutable history", async () => {
  const current = await call<{ revision: number; defaultCampaignThreshold: number; defaultTimezone: string; thresholdFloor: number }>(staff, "settings");
  assert.deepEqual(
    { r: current.data.revision, t: current.data.defaultCampaignThreshold, z: current.data.defaultTimezone, f: current.data.thresholdFloor },
    { r: 1, t: 5, z: "Asia/Riyadh", f: 5 },
  );
  const patch = (token: string, revision: number, body: unknown, key = randomUUID()) =>
    route(token, "settings", { method: "PATCH", body, headers: { "if-match": `"${revision}"`, "idempotency-key": key } });
  const good = { defaultTimezone: "Asia/Dubai", defaultCampaignThreshold: 7, staffInvitationHours: 48 };

  assert.equal(await failure(async () => { await patch(staff, 1, good); }), "FORBIDDEN");
  assert.equal(await failure(async () => { await patch(admin, 1, { ...good, defaultCampaignThreshold: 4 }); }), "VALIDATION_FAILED");
  assert.equal(await failure(async () => { await patch(admin, 1, { ...good, defaultTimezone: "Mars/Olympus" }); }), "VALIDATION_FAILED");
  assert.equal(await failure(async () => { await patch(admin, 1, { ...good, secretKey: "x" }); }), "VALIDATION_FAILED");
  // The routine refuses a floor breach on its own, whatever the route let through.
  assert.equal(
    await failure(() => withStaff(admin, (tx) => sql`select access.save_settings(1,${JSON.stringify({ ...good, defaultCampaignThreshold: 3 })}::jsonb,${randomUUID()}::uuid,${digest("x")})`.execute(tx))),
    "VALIDATION_FAILED",
  );
  await assert.rejects(operator((db) => db.query("INSERT INTO ops.system_setting(revision,default_timezone,default_campaign_threshold,staff_invitation_hours,changed_by) VALUES(99,'UTC',4,1,$1)", [ids.admin])), /check constraint/);

  // Two administrators save against the same revision at the same moment:
  // exactly one wins, the other is told the record changed.
  const secondAdmin = randomUUID();
  await operator((db) => db.query("INSERT INTO access.staff_user(id,issuer,provider_subject,email,display_name,role) VALUES($1,$2,'admin-2','admin-2@example.invalid','مسؤول ثانٍ','SUPER_ADMIN')", [secondAdmin, ISSUER]));
  const admin2 = await session("admin-2");
  const outcomes = await Promise.all([
    failure(async () => { const r = await patch(admin, 1, good); if (!r.ok) throw new Error(String(r.status)); }),
    failure(async () => { const r = await patch(admin2, 1, { ...good, defaultCampaignThreshold: 9 }); if (!r.ok) throw new Error(String(r.status)); }),
  ]);
  assert.deepEqual(outcomes.sort(), ["NO_ERROR", "REVISION_CONFLICT"]);

  // An idempotent retry returns the same saved version rather than a conflict.
  const key = randomUUID();
  const saved = await (await patch(admin, 2, { ...good, staffInvitationHours: 24 }, key)).json();
  const retried = await (await patch(admin, 2, { ...good, staffInvitationHours: 24 }, key)).json();
  assert.equal(saved.data.revision, 3);
  assert.deepEqual(retried.data, saved.data);
  assert.equal(await failure(async () => { await patch(admin, 2, { ...good, staffInvitationHours: 25 }, key); }), "IDEMPOTENCY_CONFLICT");

  // History is append-only: neither the runtime nor the operator can rewrite it.
  const status = await call<{ history: { revision: number }[]; status: { retention: { approved: boolean }[]; alerts: Record<string, unknown>; localAccessEnabled: boolean }; authentication: { identityProvider: string } }>(admin, "settings/status");
  assert.deepEqual(status.data.history.map((h) => h.revision), [3, 2, 1]);
  await assert.rejects(operator((db) => db.query("UPDATE ops.system_setting SET default_campaign_threshold=6 WHERE revision=1")), /SETTINGS_IMMUTABLE/);
  await assert.rejects(operator((db) => db.query("DELETE FROM ops.system_setting WHERE revision=1")), /SETTINGS_IMMUTABLE/);
  await assert.rejects(operator((db) => db.query("TRUNCATE ops.system_setting")), /SETTINGS_IMMUTABLE|cannot truncate/);
  // Retention is reported exactly as recorded: seeded defaults are unapproved.
  assert.ok(status.data.status.retention.length >= 16);
  assert.ok(status.data.status.retention.every((p) => p.approved === false));
  assert.equal(status.data.authentication.identityProvider, ISSUER);
  assert.doesNotMatch(JSON.stringify(status.data), /synthetic-test-secret|password=|postgres(ql)?:\/\//i);
  const changed = await operator((db) => db.query("SELECT count(*)::int n FROM ops.audit_log WHERE action='SETTINGS_CHANGED'"));
  assert.equal(changed.rows[0].n, 2);
  // A launched campaign's threshold is frozen by 008 and is not a default: nothing here can reach it.
  await operator((db) => db.query("UPDATE access.staff_user SET status='DISABLED' WHERE id=$1", [secondAdmin]));
});

test("AD-6 access administration: last admin, stale revision and concurrent disabling stay intact", async () => {
  const detail = await call<{ revision: number; isSelf: boolean; otherActiveSuperAdmins: number; subject: string; authMethod: string }>(admin, `staff/${ids.admin}`);
  assert.equal(detail.data.isSelf, true);
  assert.equal(detail.data.authMethod, "OIDC");
  assert.equal(detail.data.subject, "admin");
  const body = { role: "STAFF", status: "DISABLED", capabilities: [], organizationIds: [] };
  assert.equal(
    await failure(async () => { await route(admin, `staff/${ids.admin}`, { method: "PATCH", body, headers: { "if-match": `"${detail.data.revision}"` } }); }),
    "LAST_ADMIN",
  );
  const target = await call<{ revision: number }>(admin, `staff/${ids.staff}`);
  const access = { role: "STAFF", status: "ACTIVE", capabilities: ["results.read"], organizationIds: [ids.orgA] };
  assert.equal(
    await failure(async () => { await route(admin, `staff/${ids.staff}`, { method: "PATCH", body: access, headers: { "if-match": `"${target.data.revision + 5}"` } }); }),
    "REVISION_CONFLICT",
  );
  assert.equal(await failure(async () => { await route(admin, `staff/${ids.staff}`, { method: "PATCH", body: access }); }), "PRECONDITION_REQUIRED");
  await call(admin, `staff/${ids.staff}`, { method: "PATCH", body: access, headers: { "if-match": `"${target.data.revision}"` } });
  assert.equal(await failure(() => withStaff(staff, async () => true)), "SESSION_REQUIRED", "access change revokes");

  // Two administrators disable each other at the same moment. Serialized by
  // the advisory lock: one succeeds, the other is refused as the last admin.
  const other = randomUUID();
  await operator((db) => db.query("INSERT INTO access.staff_user(id,issuer,provider_subject,email,display_name,role) VALUES($1,$2,'admin-3','admin-3@example.invalid','مسؤول ثالث','SUPER_ADMIN')", [other, ISSUER]));
  const otherToken = await session("admin-3");
  const [a, b] = await Promise.all([call<{ revision: number }>(admin, `staff/${other}`), call<{ revision: number }>(otherToken, `staff/${ids.admin}`)]);
  const outcomes = await Promise.all([
    failure(async () => { const r = await route(admin, `staff/${other}`, { method: "PATCH", body, headers: { "if-match": `"${a.data.revision}"` } }); if (!r.ok) throw new Error(String(r.status)); }),
    failure(async () => { const r = await route(otherToken, `staff/${ids.admin}`, { method: "PATCH", body, headers: { "if-match": `"${b.data.revision}"` } }); if (!r.ok) throw new Error(String(r.status)); }),
  ]);
  const active = await operator((db) => db.query("SELECT count(*)::int n FROM access.staff_user WHERE role='SUPER_ADMIN' AND status='ACTIVE'"));
  assert.ok(active.rows[0].n >= 1, `outcomes ${outcomes}`);
  assert.ok(outcomes.includes("NO_ERROR"), String(outcomes));
  assert.ok(outcomes.some((o) => o !== "NO_ERROR"), String(outcomes));
  // Whoever survived signs in again for the remaining tests.
  const survivors = await operator((db) => db.query("SELECT provider_subject FROM access.staff_user WHERE role='SUPER_ADMIN' AND status='ACTIVE' AND provider_subject IN ('admin','admin-3')"));
  admin = await session(survivors.rows[0].provider_subject);

  // Revoke sessions through the administrator route.
  const victim = await session("staff");
  assert.equal((await route(admin, `staff/${ids.staff}/revoke-sessions`, { method: "POST" })).status, 204);
  assert.equal(await failure(() => withStaff(victim, async () => true)), "SESSION_REQUIRED");
  staff = await session("staff");

  // Registering a provider identity binds the configured issuer only.
  const register = (issuer: string) => ({ method: "POST", body: { issuer, subject: `new-${randomUUID()}`, email: `new-${randomUUID().slice(0, 8)}@example.invalid`, displayName: "موظف جديد", role: "STAFF", status: "ACTIVE", capabilities: [], organizationIds: [] } });
  assert.equal(await failure(async () => { await route(admin, "staff", register("https://other.example.invalid")); }), "VALIDATION_FAILED");
  assert.equal(await failure(async () => { await route(admin, "staff", register("urn:orgfit:local-password")); }), "VALIDATION_FAILED");
  assert.equal((await call(admin, "staff", register(ISSUER))).status, 201);
  assert.equal(await failure(async () => { await route(staff, "staff", register(ISSUER)); }), "FORBIDDEN");
});

test("AD-7 invitations: > 100 paginated, states filtered, and an idempotent retry never fabricates a link", async () => {
  await operator((db) => db.query("INSERT INTO access.local_access_setting(enabled,note) VALUES(true,'administration test')"));
  const body = { email: "", role: "STAFF", capabilities: ["results.read"], organizationIds: [ids.orgA], locale: "ar", expiresInHours: 24 };
  const key = randomUUID();
  const first = await call<{ id: string; url: string | null; replayed: boolean }>(admin, "staff/invitations", { method: "POST", body: { ...body, email: "retry@example.invalid" }, headers: { "idempotency-key": key } });
  assert.equal(first.status, 201);
  assert.match(first.data.url!, /\/activate#[A-Za-z0-9_-]{43}$/);
  const retry = await call<{ id: string; url: string | null; replayed: boolean }>(admin, "staff/invitations", { method: "POST", body: { ...body, email: "retry@example.invalid" }, headers: { "idempotency-key": key } });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.id, first.data.id);
  assert.equal(retry.data.url, null, "no fabricated link");
  assert.equal(retry.data.replayed, true);

  const created = "2026-09-02T10:00:00.000001Z";
  await operator((db) =>
    db.query(
      `INSERT INTO access.staff_invitation(token_digest,email,role,expires_at,created_at,created_by,revoked_at)
       SELECT sha256(convert_to('bulk-'||g,'UTF8')),'bulk-invite-'||g||'@example.invalid','STAFF',
              CASE WHEN g%3=0 THEN clock_timestamp()-interval '1 hour' ELSE clock_timestamp()+interval '1 day' END,
              $1::timestamptz,$2,CASE WHEN g%5=0 THEN clock_timestamp() END
       FROM generate_series(1,120) g`,
      [created, ids.admin],
    ),
  );
  const all = (await operator((db) => db.query("SELECT id::text FROM access.staff_invitation ORDER BY created_at DESC, id DESC"))).rows.map((r) => r.id);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const { data }: { data: Paged<{ id: string; state: string }> } = await call<Paged<{ id: string; state: string }>>(admin, `staff/invitations?limit=11${cursor ? `&cursor=${cursor}` : ""}`);
    seen.push(...data.items.map((i) => i.id));
    cursor = data.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, all);
  const revoked = await call<Paged<{ state: string }>>(admin, "staff/invitations?state=REVOKED&q=bulk-invite&limit=100");
  assert.equal(revoked.data.items.length, 24);
  const expired = await call<Paged<{ state: string }>>(admin, "staff/invitations?state=EXPIRED&q=bulk-invite&limit=100");
  assert.equal(expired.data.items.length, 32);
  assert.ok(expired.data.items.every((i) => i.state === "EXPIRED"));

  assert.equal((await route(admin, `staff/invitations/${first.data.id}/revoke`, { method: "POST" })).status, 204);
  assert.equal(await failure(async () => { await route(admin, `staff/invitations/${first.data.id}/revoke`, { method: "POST" }); }), "STATE_CONFLICT");
  assert.equal(await deny(staff, "staff/invitations", { method: "POST", body: { ...body, email: "x@example.invalid" } }), "FORBIDDEN");
});

test("AD-8 cursors and the provider account link are validated, not trusted", () => {
  assert.equal(decodeCursor(null, cursorKinds.staff), null);
  const c = encodeCursor(["a@example.invalid", randomUUID()])!;
  assert.equal(decodeCursor(c, cursorKinds.staff)![0], "a@example.invalid");
  for (const bad of ["", "!!", Buffer.from("{}").toString("base64url"), encodeCursor(["2026-01-01T00:00:00Z", randomUUID()])!])
    assert.throws(() => decodeCursor(bad, cursorKinds.time), /VALIDATION_FAILED/);
  assert.equal(identityAccountUrl({}), null);
  assert.equal(identityAccountUrl({ OIDC_ACCOUNT_URL: "https://id.example.invalid/account" }), "https://id.example.invalid/account");
  assert.equal(identityAccountUrl({ OIDC_ACCOUNT_URL: "https://user:pw@id.example.invalid/" }), null);
  assert.equal(identityAccountUrl({ OIDC_ACCOUNT_URL: "https://id.example.invalid/?token=x" }), null);
  assert.equal(identityAccountUrl({ OIDC_ACCOUNT_URL: "http://id.example.invalid/" }), null);
  assert.equal(identityAccountUrl({ OIDC_ACCOUNT_URL: "http://127.0.0.1:4010/account", NODE_ENV: "production" }), null);
  assert.equal(identityAccountUrl({ OIDC_ACCOUNT_URL: "javascript:alert(1)" }), null);
});

test.after(async () => {
  await authDatabase().destroy();
});
