import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withStaff } from "../src/db";
import { checkMutation } from "../src/security";
import { safeError } from "../src/http";
import { instrumentRoute, saveInstrument, type Version } from "../src/instruments";
import { directoryRoute } from "../src/directory";
import { blankInstrument, tr } from "../src/instrument-input";
import { reapplyTombstones, shipTombstones } from "../src/operations";
import { scoringFixture } from "./scoring-fixtures";
import { respondentFixture, BUILTIN_QUESTIONNAIRE, type Fixture } from "./respondent-fixture";

// Deleting a questionnaire (D-187) and a company (D-188), migration 027,
// against a real PostgreSQL cluster: every refusal, a clean removal, exactly
// one audit row, earlier audit rows intact, and the restore replay.

const ORIGIN = "http://127.0.0.1:3000";
type Result = { status: number; body: Record<string, unknown> };

// A route call as the catch-all route makes it, including the error mapping,
// so a refusal shows exactly what a browser receives (code and reason).
async function call(
  token: string,
  path: string,
  method: "GET" | "POST",
  headers: Record<string, string> = {},
): Promise<Result> {
  try {
    return await withStaff(token, async (tx, profile) => {
      const body = method === "POST" ? JSON.stringify({}) : undefined;
      const req = new Request(`${ORIGIN}/api/v1/${path}`, {
        method,
        body,
        headers: { origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}), ...headers },
      });
      if (method !== "GET") checkMutation(req, ORIGIN);
      const route = path.split("?")[0];
      const res = (await instrumentRoute(req, route, tx)) ?? (await directoryRoute(req, route, tx, profile));
      if (!res) throw new Error("NO_ROUTE");
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    });
  } catch (e) {
    const res = safeError(e);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
}
const post = (token: string, path: string, revision: string | number, key = randomUUID()) =>
  call(token, path, "POST", { "idempotency-key": key, "x-orgfit-revision": `"${revision}"` });

test("D-187/D-188 deleting questionnaires and companies", async (t) => {
  const f: Fixture = await respondentFixture(2);
  const { operator, staff } = f;
  const admin = await f.session("admin");
  const count = async (sql: string, params: unknown[]) =>
    (await operator.query(sql, params)).rows[0].n as number;
  const create = async (token: string, org: string | null, title: string, sourceId?: string) =>
    (await withStaff(token, (tx) =>
      saveInstrument(tx, {
        org,
        action: "CREATE",
        document: { ...blankInstrument(), title: tr(title, "") },
        sourceId,
        idem: randomUUID(),
      }),
    )) as Version;
  const revisionOf = async (qid: string) =>
    String((await operator.query("select revision from instrument.questionnaire where id=$1", [qid])).rows[0].revision);
  const qpath = (org: string | null, qid: string) =>
    `${org ? `organizations/${org}/` : ""}questionnaires/${qid}`;
  const leftovers = async (qid: string, versionIds: string[]) => {
    let n = await count("select count(*)::int n from instrument.questionnaire where id=$1", [qid]);
    n += await count("select count(*)::int n from instrument.questionnaire_version where questionnaire_id=$1", [qid]);
    n += await count("select count(*)::int n from instrument.questionnaire_department where questionnaire_id=$1", [qid]);
    for (const table of ["section", "dimension", "question", "question_option", "matrix_row", "matrix_column", "score_definition", "interpretation_band", "recommendation_rule"])
      n += await count(`select count(*)::int n from instrument.${table} where version_id=any($1::uuid[])`, [versionIds]);
    return n;
  };

  try {
    await t.test("a never-used draft is deletable, leaves no child rows and one content-free audit row", async () => {
      const v = await create(staff, f.orgA, `مسودة ${randomUUID().slice(0, 6)}`);
      await operator.query(
        "insert into instrument.questionnaire_department(organization_id,questionnaire_id,department_id) values($1,$2,$3)",
        [f.orgA, v.questionnaire_id, f.departmentA],
      );
      const detail = await call(staff, qpath(f.orgA, v.questionnaire_id), "GET");
      assert.equal((detail.body.data as { deleteBlocker: unknown }).deleteBlocker, null);
      const list = await call(staff, `organizations/${f.orgA}/questionnaires?status=ALL`, "GET");
      const item = (list.body.data as { items: { id: string; deleteBlocker: unknown }[] }).items.find((i) => i.id === v.questionnaire_id);
      assert.equal(item?.deleteBlocker, null);
      const key = randomUUID();
      const done = await post(staff, `${qpath(f.orgA, v.questionnaire_id)}/delete`, await revisionOf(v.questionnaire_id), key);
      assert.equal(done.status, 200);
      assert.deepEqual(done.body.data, { id: v.questionnaire_id });
      assert.equal(await leftovers(v.questionnaire_id, [v.id]), 0);
      const audit = await operator.query("select organization_id,action,field_names from ops.audit_log where target_id=$1 and action='INSTRUMENT_DELETED'", [v.questionnaire_id]);
      assert.deepEqual(audit.rows, [{ organization_id: f.orgA, action: "INSTRUMENT_DELETED", field_names: ["instrument"] }]);
      // A replayed key answers from its receipt: same id, no second audit row.
      const replay = await post(staff, `${qpath(f.orgA, v.questionnaire_id)}/delete`, 1, key);
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.body.data, { id: v.questionnaire_id });
      assert.equal(await count("select count(*)::int n from ops.audit_log where target_id=$1 and action='INSTRUMENT_DELETED'", [v.questionnaire_id]), 1);
      // The same key for a different questionnaire is a conflict.
      const other = await create(staff, f.orgA, `أخرى ${randomUUID().slice(0, 6)}`);
      const conflict = await post(staff, `${qpath(f.orgA, other.questionnaire_id)}/delete`, await revisionOf(other.questionnaire_id), key);
      assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
    });

    await t.test("a published version never used in an assessment is deletable too (owner decision)", async () => {
      const doc = scoringFixture();
      const created = (await withStaff(staff, (tx) =>
        saveInstrument(tx, { org: f.orgA, action: "CREATE", document: doc, idem: randomUUID() }),
      )) as Version;
      const published = (await withStaff(staff, (tx) =>
        saveInstrument(tx, {
          org: f.orgA,
          qid: created.questionnaire_id,
          vid: created.id,
          revision: created.revision,
          action: "PUBLISH",
          document: created.document,
          idem: randomUUID(),
        }),
      )) as Version;
      assert.equal(published.state, "PUBLISHED");
      const done = await post(staff, `${qpath(f.orgA, created.questionnaire_id)}/delete`, await revisionOf(created.questionnaire_id));
      assert.equal(done.status, 200);
      assert.equal(await leftovers(created.questionnaire_id, [created.id]), 0);
    });

    await t.test("refusals: series on the family, used in a round/campaign, cloned-from, built-in, wrong organization, stale revision", async () => {
      const coverage = (await operator.query("select questionnaire_id from instrument.questionnaire_version where id=$1", [f.coverageVersionId])).rows[0].questionnaire_id as string;
      // The fixture's series uses the coverage questionnaire's family key.
      let r = await post(staff, `${qpath(f.orgA, coverage)}/delete`, await revisionOf(coverage));
      assert.equal(r.status, 409);
      assert.deepEqual([r.body.code, r.body.reason], ["STATE_CONFLICT", "SERIES_FAMILY"]);
      // Used by a round and its campaign (a round is checked first).
      await f.launchedCampaign(f.people);
      r = await post(staff, `${qpath(f.orgA, coverage)}/delete`, await revisionOf(coverage));
      assert.deepEqual([r.body.code, r.body.reason], ["STATE_CONFLICT", "USED_IN_ROUND"]);
      const detail = await call(staff, qpath(f.orgA, coverage), "GET");
      assert.equal((detail.body.data as { deleteBlocker: unknown }).deleteBlocker, "USED_IN_ROUND");
      // A version a campaign uses cannot be deleted even with the marker on.
      await operator.query("BEGIN");
      try {
        await operator.query("select set_config('orgfit.deleting_questionnaire',$1,true)", [coverage]);
        await assert.rejects(
          operator.query("delete from instrument.questionnaire_version where id=$1", [f.coverageVersionId]),
          /STATE_CONFLICT|foreign key/,
        );
      } finally {
        await operator.query("ROLLBACK");
      }
      // Without the marker every DELETE is refused, as before 027.
      const draft = await create(staff, f.orgA, `بدون علامة ${randomUUID().slice(0, 6)}`);
      await assert.rejects(
        operator.query("delete from instrument.questionnaire_version where id=$1", [draft.id]),
        /STATE_CONFLICT/,
      );
      // Cloned-from: lineage is refused, never rewritten.
      const source = await create(staff, f.orgA, `مصدر ${randomUUID().slice(0, 6)}`);
      const copy = await create(staff, f.orgA, `نسخة ${randomUUID().slice(0, 6)}`, source.id);
      r = await post(staff, `${qpath(f.orgA, source.questionnaire_id)}/delete`, await revisionOf(source.questionnaire_id));
      assert.deepEqual([r.body.code, r.body.reason], ["STATE_CONFLICT", "CLONED_FROM"]);
      assert.equal(await count("select count(*)::int n from instrument.questionnaire where id=$1 and source_template_id=$2", [copy.questionnaire_id, source.questionnaire_id]), 1);
      // Built-in templates.
      r = await post(admin, `${qpath(null, BUILTIN_QUESTIONNAIRE)}/delete`, await revisionOf(BUILTIN_QUESTIONNAIRE));
      assert.deepEqual([r.body.code, r.body.reason], ["STATE_CONFLICT", "BUILTIN"]);
      // Wrong organization: the questionnaire is not found beneath another one.
      const mine = await create(staff, f.orgA, `منظمتي ${randomUUID().slice(0, 6)}`);
      r = await post(admin, `${qpath(f.orgB, mine.questionnaire_id)}/delete`, await revisionOf(mine.questionnaire_id));
      assert.equal(r.body.code, "NOT_FOUND");
      // Stale revision.
      r = await post(staff, `${qpath(f.orgA, mine.questionnaire_id)}/delete`, Number(await revisionOf(mine.questionnaire_id)) + 1);
      assert.equal(r.body.code, "REVISION_CONFLICT");
      // Nothing was removed and no deletion was audited by any refusal.
      for (const q of [coverage, source.questionnaire_id, BUILTIN_QUESTIONNAIRE, mine.questionnaire_id]) {
        assert.equal(await count("select count(*)::int n from instrument.questionnaire where id=$1", [q]), 1);
        assert.equal(await count("select count(*)::int n from ops.audit_log where target_id=$1 and action='INSTRUMENT_DELETED'", [q]), 0);
      }
      // Staff hold no direct DML on the instrument tables, marker or not.
      const staffClient = new (await import("pg")).default.Client({ connectionString: f.fixture.url("orgfit_staff") });
      await staffClient.connect();
      try {
        await staffClient.query("BEGIN");
        await staffClient.query("select set_config('orgfit.deleting_questionnaire',$1,true)", [mine.questionnaire_id]);
        await assert.rejects(
          staffClient.query("delete from instrument.questionnaire_version where questionnaire_id=$1", [mine.questionnaire_id]),
          /permission denied/,
        );
        await staffClient.query("ROLLBACK");
      } finally {
        await staffClient.end();
      }
    });

    // ---------------------------------------------------------------- companies
    const newOrg = async (code: string) => {
      const id = randomUUID();
      await operator.query("insert into core.organization(id,code,name_ar) values($1,$2,$3)", [id, code, `منظمة ${code}`]);
      return id;
    };
    const orgRevision = async (org: string) =>
      String((await operator.query("select revision from core.organization where id=$1", [org])).rows[0].revision);
    const refuse = async (org: string, reason: string) => {
      const check = await call(admin, `organizations/${org}/deletion`, "GET");
      assert.deepEqual(check.body.data, { deletable: false, deleteBlocker: reason }, reason);
      const r = await post(admin, `organizations/${org}/delete`, await orgRevision(org));
      assert.deepEqual([r.status, r.body.code, r.body.reason], [409, "STATE_CONFLICT", reason], reason);
      assert.equal(await count("select count(*)::int n from core.organization where id=$1", [org]), 1, reason);
    };

    await t.test("company refusals: not Super Admin, each kind of activity, a questionnaire in use, stale revision", async () => {
      // An organization with assessment activity (series, rounds, campaigns).
      await refuse(f.orgA, "SERIES");
      const series = await newOrg(`SER${randomUUID().slice(0, 4).toUpperCase()}`);
      await operator.query(
        "insert into core.assessment_series(organization_id,name_ar,purpose,questionnaire_family_id) values($1,'سلسلة','قياس',$2)",
        [series, randomUUID()],
      );
      await refuse(series, "SERIES");
      const visits = await newOrg(`VIS${randomUUID().slice(0, 4).toUpperCase()}`);
      await operator.query(
        "insert into core.field_visit(organization_id,assigned_consultant_id,scheduled_start,timezone,purpose) values($1,(select id from access.staff_user where provider_subject='staff'),clock_timestamp(),'Asia/Riyadh','زيارة')",
        [visits],
      );
      await refuse(visits, "FIELD_VISITS");
      const links = await newOrg(`LNK${randomUUID().slice(0, 4).toUpperCase()}`);
      await operator.query("insert into core.message_link(organization_id,token_digest,key_version) values($1,$2,'v1')", [links, Buffer.alloc(32, 7)]);
      await refuse(links, "MESSAGE_LINKS");
      const messages = await newOrg(`MSG${randomUUID().slice(0, 4).toUpperCase()}`);
      await operator.query("insert into core.employee_message(organization_id,other_department,body,received_on) values($1,'أخرى','نص',current_date)", [messages]);
      await refuse(messages, "MESSAGES");
      const cloned = await newOrg(`QIU${randomUUID().slice(0, 4).toUpperCase()}`);
      const base = await create(admin, cloned, "أصل");
      await create(admin, cloned, "نسخة", base.id);
      await refuse(cloned, "QUESTIONNAIRE_IN_USE");
      // Not a Super Admin: refused by the route and by the routine itself.
      const free = await newOrg(`FRE${randomUUID().slice(0, 4).toUpperCase()}`);
      await operator.query("insert into access.organization_access values((select id from access.staff_user where provider_subject='staff'),$1)", [free]);
      const staff2 = await f.session("staff");
      const denied = await post(staff2, `organizations/${free}/delete`, await orgRevision(free));
      assert.equal(denied.body.code, "FORBIDDEN");
      assert.equal((await call(staff2, `organizations/${free}/deletion`, "GET")).body.code, "FORBIDDEN");
      await assert.rejects(
        withStaff(staff2, async (tx) => {
          const { sql } = await import("kysely");
          await sql`select core.delete_organization(${free}::uuid,1,${randomUUID()}::uuid,${Buffer.alloc(32)})`.execute(tx);
        }),
        /FORBIDDEN/,
      );
      // Stale revision.
      const stale = await post(admin, `organizations/${free}/delete`, Number(await orgRevision(free)) + 1);
      assert.equal(stale.body.code, "REVISION_CONFLICT");
    });

    await t.test("company deletion removes everything it covers, keeps every audit row, and the restore replay removes it again", async () => {
      const code = `DEL${randomUUID().slice(0, 4).toUpperCase()}`;
      const org = await newOrg(code);
      const parent = randomUUID(),
        child = randomUUID(),
        person = randomUUID();
      await operator.query("insert into core.department(id,organization_id,code,name_ar) values($1,$2,'P','أب')", [parent, org]);
      await operator.query("insert into core.department(id,organization_id,code,name_ar,parent_department_id) values($1,$2,'C','ابن',$3)", [child, org, parent]);
      await operator.query(
        "insert into core.participant(id,organization_id,private_reference,display_name,department_id) values($1,$2,'X-1','مشارك',$3)",
        [person, org, child],
      );
      for (const state of ["UPLOADED", "EXPIRED", "COMMITTED"])
        await operator.query(
          "insert into core.directory_import(id,organization_id,uploaded_by,source_digest,format,state,committed_at) values($1,$2,(select id from access.staff_user where provider_subject='admin'),$3,'CSV',$4,$5)",
          [randomUUID(), org, "a".repeat(64), state, state === "COMMITTED" ? new Date() : null],
        );
      await operator.query("insert into access.organization_access values((select id from access.staff_user where provider_subject='staff'),$1)", [org]);
      const q = await create(admin, org, "استبيان المنظمة");
      await operator.query(
        "insert into instrument.questionnaire_department(organization_id,questionnaire_id,department_id) values($1,$2,$3)",
        [org, q.questionnaire_id, child],
      );
      await operator.query(
        "insert into ops.audit_log(actor_id,organization_id,action,target_id,field_names) values((select id from access.staff_user where provider_subject='admin'),$1,'DIRECTORY_CHANGED',$1,array['organization'])",
        [org],
      );
      const before = (await operator.query("select id,action,target_id,occurred_at from ops.audit_log where organization_id=$1 order by id", [org])).rows;
      assert.ok(before.length >= 2);
      assert.deepEqual((await call(admin, `organizations/${org}/deletion`, "GET")).body.data, { deletable: true, deleteBlocker: null });

      const key = randomUUID();
      const done = await post(admin, `organizations/${org}/delete`, await orgRevision(org), key);
      assert.equal(done.status, 200);
      assert.deepEqual(done.body.data, { id: org });
      // No child rows remain.
      for (const table of ["core.department", "core.participant", "core.directory_import", "access.organization_access", "instrument.questionnaire", "instrument.questionnaire_version", "instrument.questionnaire_department", "instrument.instrument_scope"])
        assert.equal(await count(`select count(*)::int n from ${table} where organization_id=$1`, [org]), 0, table);
      assert.equal(await count("select count(*)::int n from core.organization where id=$1", [org]), 0);
      assert.equal(await leftovers(q.questionnaire_id, [q.id]), 0);
      // Exactly one ORGANIZATION_DELETED row; every earlier row unchanged.
      const after = (await operator.query("select id,action,target_id,occurred_at from ops.audit_log where organization_id=$1 order by id", [org])).rows;
      assert.equal(after.filter((a) => a.action === "ORGANIZATION_DELETED").length, 1);
      assert.deepEqual(after.filter((a) => a.action !== "ORGANIZATION_DELETED"), before);
      // The tombstone that keeps a restore from bringing the participants back.
      assert.equal(await count("select count(*)::int n from ops.deletion_tombstone where class='ORGANIZATION' and organization_id=$1 and subject_id=$1", [org]), 1);
      // Replayed key: same answer, no second audit row.
      const replay = await post(admin, `organizations/${org}/delete`, 1, key);
      assert.deepEqual([replay.status, replay.body.data], [200, { id: org }]);
      assert.equal(await count("select count(*)::int n from ops.audit_log where organization_id=$1 and action='ORGANIZATION_DELETED'", [org]), 1);

      // Restore drill: ship the ledger, bring the company back as a backup
      // restore would, and replay. Twice: the second replay changes nothing.
      const coreUrl = f.fixture.url("orgfit_migrator"),
        anonUrl = f.fixture.anonymousUrl("orgfit_anon_migrator");
      const ledger = await mkdtemp(join(tmpdir(), "orgfit-org-ledger-"));
      await shipTombstones(coreUrl, ledger);
      await operator.query("insert into core.organization(id,code,name_ar) values($1,$2,'مستعادة')", [org, code]);
      await operator.query("insert into core.department(id,organization_id,code,name_ar) values($1,$2,'P','أب')", [parent, org]);
      await operator.query(
        "insert into core.participant(id,organization_id,private_reference,display_name,department_id) values($1,$2,'X-1','مشارك',$3)",
        [person, org, parent],
      );
      const first = await reapplyTombstones(coreUrl, anonUrl, ledger, { openDespiteIncidents: true });
      assert.equal(first.applied.ORGANIZATION, 1);
      assert.equal(await count("select count(*)::int n from core.participant where id=$1", [person]), 0);
      assert.equal(await count("select count(*)::int n from core.organization where id=$1", [org]), 0);
      const second = await reapplyTombstones(coreUrl, anonUrl, ledger, { openDespiteIncidents: true });
      assert.equal(second.applied.ORGANIZATION, 0);
      assert.ok(!second.incidents.some((i) => i.organizationId === org));
      // Audit rows still point at the deleted id.
      assert.equal(await count("select count(*)::int n from ops.audit_log where organization_id=$1", [org]), after.length);
    });
  } finally {
    await f.close();
  }
});

