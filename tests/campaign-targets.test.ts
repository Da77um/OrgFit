import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { setupDatabase } from "./database";
import { ids } from "../scripts/seed";
import { withStaff } from "../src/db";
import { secret, digest, AppError } from "../src/security";
import { instrumentRoute } from "../src/instruments";
import {
  saveSeries,
  saveRound,
  saveCampaign,
  launchCampaign,
  launchReview,
} from "../src/campaigns";
import { campaignInput } from "../src/campaign-input";
import { generateCustodianKeypair } from "../src/key-custody";

// A campaign's audience is bounded by its questionnaire's target (021): the
// whole organization when no department is selected, otherwise only the
// targeted departments. Enforced at save, at review and again at launch.
const BUILTIN_VERSION = "44000000-0000-4000-9000-000000000001";
const BUILTIN_QUESTIONNAIRE = "44000000-0000-4000-8000-000000000001";
const failure = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (e) {
    return e instanceof AppError ? e.code : (e as Error).message;
  }
  return "NO_ERROR";
};
type Review = {
  invited: number;
  targetProblem: string | null;
  questionnaireTarget: { mode: string; departments: { id: string }[] };
};

test("campaign launch honours the questionnaire target", async (t) => {
  const fixture = await setupDatabase();
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
    INVITATION_DIGEST_KEY: "a".repeat(64),
    INVITATION_DIGEST_KEY_VERSION: "test-v1",
    CAMPAIGN_KEY_CUSTODY_DIRECTORY: `work/key-custody-${randomUUID()}`,
    CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY: (await generateCustodianKeypair()).publicKey,
  });
  delete process.env.MIGRATION_DATABASE_URL;
  const auth = new pg.Client({ connectionString: fixture.url("orgfit_auth") }),
    operator = new pg.Client({ connectionString: fixture.url("orgfit_migrator") });
  await Promise.all([auth.connect(), operator.connect()]);
  await operator.query("SET ROLE orgfit_core_owner");
  const admin = secret();
  await auth.query("select access.issue_session($1,$2,$3)", [process.env.OIDC_ISSUER, "admin", digest(admin)]);

  // Directory: HR (2 people), TECH (1), EMPTY (none), one person without a
  // department, one archived HR person, one person of the other organization.
  const dept = { hr: randomUUID(), tech: randomUUID(), empty: randomUUID() };
  const people = { h1: randomUUID(), h2: randomUUID(), t1: randomUUID(), n1: randomUUID(), gone: randomUUID(), foreign: randomUUID() };
  for (const [id, code] of [
    [dept.hr, "HR"],
    [dept.tech, "TECH"],
    [dept.empty, "EMPTY"],
  ])
    await operator.query("insert into core.department(id,organization_id,code,name_ar) values($1,$2,$3,$4)", [id, ids.orgA, code, `قسم ${code}`]);
  for (const [id, org, ref, department, status] of [
    [people.h1, ids.orgA, "H1", dept.hr, "ACTIVE"],
    [people.h2, ids.orgA, "H2", dept.hr, "ACTIVE"],
    [people.t1, ids.orgA, "T1", dept.tech, "ACTIVE"],
    [people.n1, ids.orgA, "N1", null, "ACTIVE"],
    [people.gone, ids.orgA, "G1", dept.hr, "ARCHIVED"],
    [people.foreign, ids.orgB, "F1", null, "ACTIVE"],
  ] as const)
    await operator.query(
      "insert into core.participant(id,organization_id,private_reference,display_name,department_id,status) values($1,$2,$3,$4,$5,$6)",
      [id, org, ref, `مشارك ${ref}`, department, status],
    );

  const route = async (path: string, method = "GET", body?: unknown, revision?: string) =>
    withStaff(admin, async (tx) => {
      const req = new Request("http://127.0.0.1:3000/api/v1/" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
          ...(revision ? { "If-Match": `"${revision}"` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const res = await instrumentRoute(req, path, tx);
      assert(res);
      const json = await res.json();
      assert(res.ok, JSON.stringify(json));
      return json.data;
    });
  // An organization copy of the illustrative template, published, with a target.
  const questionnaire = async (target: unknown) => {
    const base = `organizations/${ids.orgA}/questionnaires`;
    const draft = await route(base, "POST", {
      title: { ar: "استبيان مستهدف", en: "Targeted" },
      source: { organizationId: null, questionnaireId: BUILTIN_QUESTIONNAIRE, versionId: BUILTIN_VERSION },
      target,
    });
    const published = await route(`${base}/${draft.questionnaire_id}/versions/${draft.id}/publish`, "POST", {}, draft.revision);
    return { id: draft.questionnaire_id as string, version: published.id as string };
  };
  const setTarget = async (qid: string, target: unknown) => {
    const base = `organizations/${ids.orgA}/questionnaires/${qid}`;
    const current = await route(base);
    return route(`${base}/target`, "POST", target, current.revision);
  };
  let n = 0;
  const round = async (version: string, family: string) => {
    const series = await withStaff(admin, (tx) =>
      saveSeries(tx, ids.orgA, null, null, { nameAr: `سلسلة ${++n}`, purpose: "اختبار", questionnaireFamilyId: family }, randomUUID()),
    );
    const r = await withStaff(admin, (tx) =>
      saveRound(
        tx,
        ids.orgA,
        null,
        null,
        { seriesId: series.id, label: `جولة ${n}`, periodStart: "2026-01-01", questionnaireVersionId: version, populationDefinition: { schemaVersion: 1 } },
        randomUUID(),
      ),
    );
    return r.id as string;
  };
  const family = async (qid: string) =>
    (await operator.query("select family_key from instrument.questionnaire where id=$1", [qid])).rows[0].family_key as string;
  const draft = async (version: string, qid: string, target: unknown) => {
    const roundId = await round(version, await family(qid));
    return withStaff(admin, (tx) =>
      saveCampaign(
        tx,
        ids.orgA,
        null,
        null,
        campaignInput.parse({
          roundId,
          questionnaireVersionId: version,
          target,
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          timezone: "Asia/Riyadh",
        }),
        randomUUID(),
      ),
    );
  };
  const review = (id: string) => withStaff(admin, (tx) => launchReview(tx, ids.orgA, id)) as Promise<Review>;
  const launch = (id: string, revision: string) => withStaff(admin, (tx) => launchCampaign(tx, ids.orgA, id, revision, randomUUID()));
  const roster = async (id: string) =>
    (
      await operator.query("select participant_id from core.invitation where campaign_id=$1 order by participant_id", [id])
    ).rows.map((r) => r.participant_id as string);

  try {
    const whole = await questionnaire({ mode: "ORGANIZATION" });
    const hrOnly = await questionnaire({ mode: "DEPARTMENTS", departmentIds: [dept.hr] });

    await t.test("no department selected: everyone active in the organization", async () => {
      const c = await draft(whole.version, whole.id, { mode: "ALL" });
      const r = await review(c.id);
      assert.equal(r.questionnaireTarget.mode, "ORGANIZATION");
      assert.equal(r.invited, 4);
      assert.equal(r.targetProblem, null);
      const launched = await launch(c.id, c.revision);
      assert.equal(launched.frozen_invited_count, 4);
      assert.deepEqual(await roster(c.id), [people.h1, people.h2, people.t1, people.n1].sort());
    });

    await t.test("the global template also means the entire organization", async () => {
      const roundId = await round(
        BUILTIN_VERSION,
        (await operator.query("select family_key from instrument.questionnaire where id=$1", [BUILTIN_QUESTIONNAIRE])).rows[0].family_key,
      );
      const c = await withStaff(admin, (tx) =>
        saveCampaign(
          tx,
          ids.orgA,
          null,
          null,
          campaignInput.parse({ roundId, questionnaireVersionId: BUILTIN_VERSION, target: { mode: "ALL" }, startsAt: new Date().toISOString(), timezone: "Asia/Riyadh" }),
          randomUUID(),
        ),
      );
      assert.equal((await review(c.id)).invited, 4);
    });

    await t.test("departments selected: only people in those departments", async () => {
      const c = await draft(hrOnly.version, hrOnly.id, { mode: "ALL" });
      const r = await review(c.id);
      assert.equal(r.questionnaireTarget.mode, "DEPARTMENTS");
      assert.deepEqual(r.questionnaireTarget.departments.map((d) => d.id), [dept.hr]);
      assert.equal(r.invited, 2);
      await launch(c.id, c.revision);
      assert.deepEqual(await roster(c.id), [people.h1, people.h2].sort());
    });

    await t.test("single, selected and department campaigns cannot leave the target", async () => {
      assert.equal(await failure(() => draft(hrOnly.version, hrOnly.id, { mode: "DEPARTMENT", departmentId: dept.tech })), "OUTSIDE_QUESTIONNAIRE_TARGET");
      assert.equal(await failure(() => draft(hrOnly.version, hrOnly.id, { mode: "SELECTED", participantIds: [people.h1, people.t1] })), "OUTSIDE_QUESTIONNAIRE_TARGET");
      assert.equal(await failure(() => draft(hrOnly.version, hrOnly.id, { mode: "SINGLE", participantId: people.n1 })), "OUTSIDE_QUESTIONNAIRE_TARGET");
      assert.equal(await failure(() => draft(hrOnly.version, hrOnly.id, { mode: "SELECTED", participantIds: [people.foreign] })), "VALIDATION_FAILED");
      const dep = await draft(hrOnly.version, hrOnly.id, { mode: "DEPARTMENT", departmentId: dept.hr });
      await launch(dep.id, dep.revision);
      assert.deepEqual(await roster(dep.id), [people.h1, people.h2].sort());
      const one = await draft(hrOnly.version, hrOnly.id, { mode: "SINGLE", participantId: people.h2 });
      await launch(one.id, one.revision);
      assert.deepEqual(await roster(one.id), [people.h2]);
      // An entire-organization questionnaire keeps every existing mode unchanged.
      const any = await draft(whole.version, whole.id, { mode: "SELECTED", participantIds: [people.t1, people.n1] });
      assert.equal((await review(any.id)).invited, 2);
    });

    await t.test("a target narrowed after the draft is enforced at review and launch", async () => {
      const narrowing = await questionnaire({ mode: "ORGANIZATION" });
      const c = await draft(narrowing.version, narrowing.id, { mode: "SELECTED", participantIds: [people.t1] });
      await setTarget(narrowing.id, { mode: "DEPARTMENTS", departmentIds: [dept.hr] });
      const r = await review(c.id);
      assert.equal(r.targetProblem, "OUTSIDE_QUESTIONNAIRE_TARGET");
      assert.equal(r.invited, 0);
      assert.equal(await failure(() => launch(c.id, c.revision)), "OUTSIDE_QUESTIONNAIRE_TARGET");
      assert.equal((await operator.query("select state from core.campaign where id=$1", [c.id])).rows[0].state, "DRAFT");
      assert.deepEqual(await roster(c.id), []);
      // Widening it again lets the same draft launch.
      await setTarget(narrowing.id, { mode: "ORGANIZATION" });
      await launch(c.id, c.revision);
      assert.deepEqual(await roster(c.id), [people.t1]);
      // A launched roster is frozen: a later target change does not touch it.
      await setTarget(narrowing.id, { mode: "DEPARTMENTS", departmentIds: [dept.hr] });
      assert.deepEqual(await roster(c.id), [people.t1]);
    });

    await t.test("an empty audience and malformed ALL payloads are refused", async () => {
      const empty = await questionnaire({ mode: "DEPARTMENTS", departmentIds: [dept.empty] });
      assert.equal(await failure(() => draft(empty.version, empty.id, { mode: "ALL" })), "NO_ELIGIBLE_PARTICIPANTS");
      assert.throws(() => campaignInput.shape.target.parse({ mode: "ALL", departmentId: dept.hr }));
    });
  } finally {
    await Promise.all([auth.end(), operator.end()]);
  }
});
