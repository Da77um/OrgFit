import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { setupDatabase } from "./database";
import { migrate } from "../scripts/migrate";
import { ids } from "../scripts/seed";
import { withStaff } from "../src/db";
import { secret, digest } from "../src/security";
import { safeError } from "../src/http";
import { saveDirectory } from "../src/directory";
import { instrumentRoute, saveInstrument } from "../src/instruments";
import { blankInstrument } from "../src/instrument-input";

// Questionnaire -> organization -> department targeting (020), against a real
// database through the real routines: the organization stays the owner, and a
// department of another organization can never be attached.
test("questionnaire department targeting stays inside the owning organization", async (t) => {
  const fixture = await setupDatabase(undefined, true, "019_administration.sql");
  Object.assign(process.env, {
    NODE_ENV: "test",
    STAFF_ORIGIN: "http://127.0.0.1:3000",
    RESPONDENT_ORIGIN: "http://localhost:3001",
    DATABASE_URL: fixture.url("orgfit_staff"),
    AUTH_DATABASE_URL: fixture.url("orgfit_auth"),
    OIDC_ISSUER: "http://127.0.0.1:4010",
    OIDC_CLIENT_ID: "test",
    OIDC_CLIENT_SECRET: "synthetic-test-secret",
    OIDC_MFA_ACR: "urn:test:mfa",
  });
  delete process.env.MIGRATION_DATABASE_URL;
  const auth = new pg.Client({ connectionString: fixture.url("orgfit_auth") }),
    operator = new pg.Client({ connectionString: fixture.url("orgfit_migrator") });
  await Promise.all([auth.connect(), operator.connect()]);
  await operator.query("SET ROLE orgfit_core_owner");
  const admin = secret(),
    staff = secret();
  for (const [token, sub] of [
    [admin, "admin"],
    [staff, "staff"],
  ])
    await auth.query("select access.issue_session($1,$2,$3)", [
      process.env.OIDC_ISSUER,
      sub,
      digest(token),
    ]);
  type Body = { data?: Record<string, unknown> & { items?: Record<string, unknown>[] }; code?: string };
  const call = async (
    token: string,
    route: string,
    method = "GET",
    body?: unknown,
    revision?: string,
    key = randomUUID(),
  ): Promise<{ status: number; body: Body }> => {
    try {
      const r = await withStaff(token, async (tx) => {
        const req = new Request("http://127.0.0.1:3000/api/v1/" + route, {
          method,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            ...(revision ? { "If-Match": `"${revision}"` } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const res = await instrumentRoute(req, route.split("?")[0], tx);
        assert(res);
        return res;
      });
      return { status: r.status, body: await r.json() };
    } catch (e) {
      const r = safeError(e);
      return { status: r.status, body: await r.json() };
    }
  };
  const department = async (org: string, code: string) =>
    (
      await withStaff(admin, (tx) =>
        saveDirectory(tx, "department", org, null, null, { code, nameAr: `قسم ${code}`, nameEn: code }, randomUUID()),
      )
    ).id;
  const detail = async (org: string, qid: string) =>
    (await call(admin, `organizations/${org}/questionnaires/${qid}`)).body.data!;
  try {
    // An organization questionnaire that exists before the upgrade.
    const legacy = await withStaff(admin, (tx) =>
      saveInstrument(tx, { org: ids.orgA, action: "CREATE", document: blankInstrument(), idem: randomUUID() }),
    );
    const legacyId = (legacy as { questionnaire_id: string }).questionnaire_id;
    await migrate(fixture.url("orgfit_migrator"));
    await migrate(fixture.url("orgfit_migrator"));

    const hrA = await department(ids.orgA, "HR"),
      techA = await department(ids.orgA, "TECH"),
      opsA = await department(ids.orgA, "OPS"),
      hrB = await department(ids.orgB, "HR");

    await t.test("existing questionnaires keep targeting the entire organization", async () => {
      const d = await detail(ids.orgA, legacyId);
      assert.equal(d.target_mode, "ORGANIZATION");
      assert.deepEqual(d.departments, []);
      assert.equal(
        (await operator.query("select count(*)::int n from instrument.questionnaire_department")).rows[0].n,
        0,
      );
    });

    let targeted = "";
    await t.test("create with departments of the selected organization, in one transaction", async () => {
      const r = await call(admin, `organizations/${ids.orgA}/questionnaires`, "POST", {
        title: { ar: "بيئة العمل", en: "Work environment" },
        target: { mode: "DEPARTMENTS", departmentIds: [hrA, techA, hrA] },
      });
      assert.equal(r.status, 201);
      targeted = String(r.body.data!.questionnaire_id);
      const d = await detail(ids.orgA, targeted);
      assert.equal(d.organization_id, ids.orgA);
      assert.equal(d.target_mode, "DEPARTMENTS");
      assert.deepEqual(
        (d.departments as { id: string }[]).map((x) => x.id).sort(),
        [hrA, techA].sort(),
      );
    });

    await t.test("a department of another organization rejects the whole request", async () => {
      const before = (await operator.query("select count(*)::int n from instrument.questionnaire")).rows[0].n;
      const created = await call(admin, `organizations/${ids.orgA}/questionnaires`, "POST", {
        title: { ar: "مرفوض", en: "Refused" },
        target: { mode: "DEPARTMENTS", departmentIds: [hrA, hrB] },
      });
      assert.equal(created.status, 422);
      assert.equal((await operator.query("select count(*)::int n from instrument.questionnaire")).rows[0].n, before);

      const d = await detail(ids.orgA, targeted);
      const changed = await call(
        admin,
        `organizations/${ids.orgA}/questionnaires/${targeted}/target`,
        "POST",
        { mode: "DEPARTMENTS", departmentIds: [hrB] },
        String(d.revision),
      );
      assert.equal(changed.status, 422);
      const after = await detail(ids.orgA, targeted);
      assert.equal(after.revision, d.revision);
      assert.deepEqual(
        (after.departments as { id: string }[]).map((x) => x.id).sort(),
        [hrA, techA].sort(),
      );
      // Even a direct insert that bypasses the routine is refused by the
      // composite (organization, id) foreign keys.
      await assert.rejects(
        operator.query(
          "insert into instrument.questionnaire_department(organization_id,questionnaire_id,department_id) values($1,$2,$3)",
          [ids.orgA, targeted, hrB],
        ),
        /foreign key/,
      );
      await assert.rejects(
        operator.query(
          "insert into instrument.questionnaire_department(organization_id,questionnaire_id,department_id) values($1,$2,$3)",
          [ids.orgB, targeted, hrB],
        ),
        /foreign key/,
      );
    });

    await t.test("malformed, empty, global and stale targets are refused", async () => {
      const rev = String((await detail(ids.orgA, targeted)).revision);
      const url = `organizations/${ids.orgA}/questionnaires/${targeted}/target`;
      assert.equal((await call(admin, url, "POST", { mode: "DEPARTMENTS", departmentIds: [] }, rev)).status, 422);
      assert.equal((await call(admin, url, "POST", { mode: "ORGANIZATION", departmentIds: [hrA] }, rev)).status, 422);
      assert.equal((await call(admin, url, "POST", { mode: "DEPARTMENTS", departmentIds: [randomUUID()] }, rev)).status, 422);
      assert.equal((await call(admin, url, "POST", { mode: "ORGANIZATION" }, "999")).status, 409);
      assert.equal((await call(admin, url, "POST", { mode: "ORGANIZATION" })).status, 400);
      assert.equal(
        (
          await call(admin, "questionnaires", "POST", {
            title: { ar: "عام", en: "Global" },
            target: { mode: "DEPARTMENTS", departmentIds: [hrA] },
          })
        ).status,
        422,
      );
      // A questionnaire in another organization cannot be reached through this one.
      assert.equal((await call(admin, `organizations/${ids.orgB}/questionnaires/${targeted}/target`, "POST", { mode: "ORGANIZATION" }, rev)).status, 404);
    });

    await t.test("changes are keyed, audited and replace the previous selection", async () => {
      const d = await detail(ids.orgA, targeted);
      const url = `organizations/${ids.orgA}/questionnaires/${targeted}/target`,
        key = randomUUID();
      const first = await call(admin, url, "POST", { mode: "DEPARTMENTS", departmentIds: [opsA] }, String(d.revision), key);
      assert.equal(first.status, 200);
      assert.deepEqual((first.body.data!.departments as { id: string }[]).map((x) => x.id), [opsA]);
      const replay = await call(admin, url, "POST", { mode: "DEPARTMENTS", departmentIds: [opsA] }, String(d.revision), key);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.data!.revision, first.body.data!.revision);
      assert.equal(
        (await call(admin, url, "POST", { mode: "DEPARTMENTS", departmentIds: [hrA] }, String(d.revision), key)).status,
        409,
      );
      const audit = await operator.query(
        "select field_names from ops.audit_log where target_id=$1 and action='INSTRUMENT_CHANGED' and 'department'=any(field_names)",
        [targeted],
      );
      assert(audit.rowCount! >= 2);
    });

    await t.test("department filter lists only questionnaires that reach that department", async () => {
      const list = async (dept: string) =>
        call(admin, `organizations/${ids.orgA}/questionnaires?departmentId=${dept}`);
      const ops = (await list(opsA)).body.data!.items!.map((i) => i.id);
      const hr = (await list(hrA)).body.data!.items!.map((i) => i.id);
      assert(ops.includes(targeted) && ops.includes(legacyId));
      assert(!hr.includes(targeted) && hr.includes(legacyId));
      const all = (await call(admin, `organizations/${ids.orgA}/questionnaires`)).body.data!.items!;
      const row = all.find((i) => i.id === targeted)!;
      assert.equal(row.target_mode, "DEPARTMENTS");
      assert.deepEqual((row.departments as { id: string }[]).map((x) => x.id), [opsA]);
      assert.equal((await list(hrB)).status, 422);
      assert.equal((await call(admin, `questionnaires?departmentId=${hrA}`)).status, 422);
    });

    await t.test("a targeted department cannot be archived; archived departments cannot be targeted", async () => {
      const revision = async (id: string) =>
        String((await operator.query("select revision from core.department where id=$1", [id])).rows[0].revision);
      await assert.rejects(
        withStaff(admin, async (tx) =>
          saveDirectory(tx, "department", ids.orgA, opsA, await revision(opsA), { reason: "closing" }, randomUUID(), true),
        ),
        /DEPARTMENT_IN_USE/,
      );
      await withStaff(admin, async (tx) =>
        saveDirectory(tx, "department", ids.orgA, techA, await revision(techA), { reason: "merged" }, randomUUID(), true),
      );
      const d = await detail(ids.orgA, targeted);
      assert.equal(
        (
          await call(admin, `organizations/${ids.orgA}/questionnaires/${targeted}/target`, "POST", { mode: "DEPARTMENTS", departmentIds: [techA] }, String(d.revision))
        ).status,
        422,
      );
      const back = await call(admin, `organizations/${ids.orgA}/questionnaires/${targeted}/target`, "POST", { mode: "ORGANIZATION" }, String(d.revision));
      assert.equal(back.status, 200);
      assert.equal(back.body.data!.target_mode, "ORGANIZATION");
      assert.deepEqual(back.body.data!.departments, []);
    });

    await t.test("department options are organization scoped and targeting needs instruments.manage", async () => {
      const options = await call(staff, `organizations/${ids.orgA}/questionnaire-departments`);
      assert.equal(options.status, 200);
      assert.deepEqual(
        options.body.data!.items!.map((i) => i.id).sort(),
        [hrA, techA, opsA].sort(),
      );
      assert.equal((await call(staff, `organizations/${ids.orgB}/questionnaire-departments`)).status, 404);
      const d = await detail(ids.orgA, targeted);
      assert.equal(
        (await call(staff, `organizations/${ids.orgA}/questionnaires/${targeted}/target`, "POST", { mode: "DEPARTMENTS", departmentIds: [hrA] }, String(d.revision))).status,
        403,
      );
    });
  } finally {
    await Promise.all([auth.end(), operator.end()]);
  }
});
