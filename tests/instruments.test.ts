import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "kysely";
import { setupDatabase } from "./database";
import { migrate } from "../scripts/migrate";
import { seedInstruments } from "../scripts/seed-instruments";
import { ids } from "../scripts/seed";
import { withStaff } from "../src/db";
import { secret, digest } from "../src/security";
import {
  instrumentSchema,
  newQuestion,
  newIdentity,
  questionTypes,
  tr,
  definitionIssues,
  copyInstrument,
  duplicateItem,
  moveItem,
  type Instrument,
  canonicalJson,
} from "../src/instrument-input";
import { illustrativeTemplates } from "../src/instrument-templates";
import {
  flattenInstrument,
  inflateInstrument,
  metadata,
} from "../src/instrument-records";
import {
  saveInstrument,
  getVersion,
  instrumentRoute,
  type Version,
} from "../src/instruments";
export function allTypes(): Instrument {
  const d = illustrativeTemplates()[0];
  d.sections[0].questions = questionTypes.map((type) => {
    const q = newQuestion(type);
    q.prompt = tr(`سؤال ${type}`, `Question ${type}`);
    for (const o of [...q.options, ...q.rows, ...q.columns])
      o.label = tr("تسمية", "Label");
    if (type === "NUMBER")
      q.validation = { min: "-5", max: "10", precision: 2 };
    if (type === "DATE")
      q.validation = { minDate: "2026-01-01", maxDate: "2026-12-31" };
    return q;
  });
  return d;
}
test("every question type, mandatory defaults, copy lineage and relational round trips", () => {
  const d = allTypes();
  assert.equal(definitionIssues(d, true).length, 0);
  assert.deepEqual(inflateInstrument(metadata(d), flattenInstrument(d)), d);
  for (const q of d.sections[0].questions)
    assert.equal(q.required, q.type !== "CONTENT");
  const input = structuredClone(d);
  delete (
    input.sections[0].questions[0] as Partial<
      (typeof input.sections)[0]["questions"][number]
    >
  ).required;
  assert.equal(
    instrumentSchema.parse(input).sections[0].questions[0].required,
    true,
  );
  const copy = copyInstrument(d);
  assert.notEqual(copy.sections[0].id, d.sections[0].id);
  assert.equal(copy.sections[0].key, d.sections[0].key);
  assert.notEqual(
    copy.sections[0].questions[0].id,
    d.sections[0].questions[0].id,
  );
  const dup = duplicateItem(d.sections[0]);
  assert.notEqual(dup.key, d.sections[0].key);
  assert.notEqual(dup.questions[0].key, d.sections[0].questions[0].key);
  assert.deepEqual(moveItem(["a", "b"], 1, -1), ["b", "a"]);
  assert.deepEqual(moveItem(["a"], 0, -1), ["a"]);
});
test("publication rejects missing languages, unsafe markup, conditional config and invalid bounds/references/bands", () => {
  const mutate = (fn: (d: Instrument) => void, code: string) => {
    const d = allTypes();
    fn(d);
    assert(
      definitionIssues(d, true).some((i) => i.code === code),
      code,
    );
  };
  mutate((d) => {
    d.title.en = "";
  }, "TRANSLATION_REQUIRED");
  mutate((d) => {
    d.sections = [];
  }, "QUESTION_COUNT");
  mutate((d) => {
    d.sections[0].questions[2].options = [];
  }, "OPTIONS_REQUIRED");
  mutate((d) => {
    d.sections[0].questions[3].validation.minSelections = 0;
  }, "SELECTION_RANGE");
  mutate((d) => {
    d.sections[0].questions[9].validation.max = "-6";
  }, "RANGE");
  mutate((d) => {
    d.sections[0].questions[10].validation.maxDate = "2025-01-01";
  }, "RANGE");
  mutate((d) => {
    d.sections[0].questions[0].dimensionId = randomUUID();
  }, "REFERENCE");
  mutate((d) => {
    d.sections[0].questions[11].required = true;
  }, "CONTENT_UNSCORED");
  for (const payload of [
    { ...allTypes(), skipLogic: [] },
    { ...allTypes(), title: tr("<img src=x onerror=alert(1)>", "x") },
  ])
    assert.equal(instrumentSchema.safeParse(payload).success, false);
  const d = allTypes();
  Object.assign(d.sections[0].questions[0].validation, { conditional: true });
  assert.equal(instrumentSchema.safeParse(d).success, false);
  const scored = allTypes(),
    dim = {
      ...newIdentity(),
      name: tr("دعم", "Support"),
      description: tr(),
      mode: "WEIGHTED_AVERAGE" as const,
      coverage: "0.8",
      direction: "HIGH_GOOD" as const,
      denominator: null,
      bands: [
        {
          ...newIdentity(),
          lower: "0",
          upper: "100",
          label: tr("مثال", "Example"),
          severity: "NONE" as const,
          semantic: "HEALTH" as const,
        },
      ],
    };
  scored.dimensions = [dim];
  const matrix = scored.sections[0].questions[8];
  matrix.dimensionId = dim.id;
  matrix.scoring.enabled = true;
  assert.equal(definitionIssues(scored, true).length, 0);
  assert.deepEqual(
    inflateInstrument(metadata(scored), flattenInstrument(scored)),
    scored,
  );
  scored.overall = {
    enabled: true,
    direction: "HIGH_GOOD",
    inputs: [{ dimensionId: dim.id, weight: "1", invert: false }],
    bands: [],
  };
  const copied = copyInstrument(scored);
  assert.equal(copied.overall.inputs[0].dimensionId, copied.dimensions[0].id);
  assert.equal(
    copied.sections[0].questions[8].dimensionId,
    copied.dimensions[0].id,
  );
  dim.bands[0].lower = "1";
  assert(definitionIssues(scored, true).some((i) => i.code === "BANDS"));
});
test("PostgreSQL instrument scope, immutability, publication, lifecycle and concurrency", async (t) => {
  const fixture = await setupDatabase(
    undefined,
    true,
    "004_import_receipts.sql",
  );
  const upgrade = new pg.Client({
    connectionString: fixture.url("orgfit_migrator"),
  });
  await upgrade.connect();
  await upgrade.query("SET ROLE orgfit_core_owner");
  await upgrade.query(
    "insert into core.department(organization_id,code,name_ar) values($1,'UPGRADE','قسم محفوظ')",
    [ids.orgA],
  );
  await migrate(fixture.url("orgfit_migrator"));
  await seedInstruments(fixture.url("orgfit_migrator"));
  await migrate(fixture.url("orgfit_migrator"));
  assert.equal(
    (
      await upgrade.query(
        "select name_ar from core.department where code='UPGRADE'",
      )
    ).rows[0].name_ar,
    "قسم محفوظ",
  );
  await upgrade.end();
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
    operator = new pg.Client({
      connectionString: fixture.url("orgfit_migrator"),
    }),
    runtime = new pg.Client({ connectionString: fixture.url("orgfit_staff") });
  await Promise.all([auth.connect(), operator.connect(), runtime.connect()]);
  await operator.query("SET ROLE orgfit_core_owner");
  await operator.query(
    "insert into access.staff_capability(staff_user_id,capability) values($1,'instruments.manage')",
    [ids.staff],
  );
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
  const save = (
    token: string,
    args: Omit<Parameters<typeof saveInstrument>[1], "idem">,
    idem = randomUUID(),
  ) =>
    withStaff(token, (tx) =>
      saveInstrument(tx, { ...args, idem }),
    ) as Promise<Version>;
  let a: Version, b: Version;
  try {
    await t.test(
      "all types persist; global and organization access; capability and scoped FK enforcement",
      async () => {
        a = await save(staff, {
          org: ids.orgA,
          action: "CREATE",
          document: allTypes(),
        });
        b = await save(admin, {
          org: ids.orgB,
          action: "CREATE",
          document: allTypes(),
        });
        assert.deepEqual(a.document, allTypesShape(a.document));
        assert.deepEqual(
          (
            await withStaff(staff, (tx) =>
              getVersion(tx, ids.orgA, a.questionnaire_id, a.id),
            )
          ).document,
          a.document,
        );
        await assert.rejects(
          withStaff(staff, (tx) =>
            getVersion(tx, ids.orgB, b.questionnaire_id, b.id),
          ),
          /NOT_FOUND/,
        );
        await assert.rejects(
          withStaff(admin, (tx) =>
            getVersion(tx, ids.orgA, b.questionnaire_id, b.id),
          ),
          /NOT_FOUND/,
        );
        await assert.rejects(
          save(staff, {
            org: ids.orgB,
            action: "CREATE",
            document: allTypes(),
          }),
          /NOT_FOUND/,
        );
        const template = await withStaff(staff, (tx) =>
          getVersion(
            tx,
            null,
            "44000000-0000-4000-8000-000000000001",
            "44000000-0000-4000-9000-000000000001",
          ),
        );
        assert.equal(template.state, "PUBLISHED");
        await assert.rejects(
          save(admin, {
            org: null,
            qid: template.questionnaire_id,
            vid: template.id,
            revision: "1",
            action: "SAVE",
            document: template.document,
          }),
          /STATE_CONFLICT/,
        );
        await assert.rejects(
          save(admin, {
            org: ids.orgB,
            action: "CREATE",
            document: copyInstrument(a.document),
            sourceId: a.id,
          }),
          /NOT_FOUND/,
        );
        const copy = await save(staff, {
          org: ids.orgA,
          action: "CREATE",
          document: copyInstrument(template.document),
          sourceId: template.id,
        });
        assert.notEqual(
          copy.document.sections[0].id,
          template.document.sections[0].id,
        );
        for (const table of [
          "questionnaire",
          "questionnaire_version",
          "question",
          "matrix_row",
          "score_definition",
        ]) {
          await assert.rejects(
            runtime.query(`delete from instrument.${table}`),
          );
          await assert.rejects(auth.query(`select * from instrument.${table}`));
        }
        await assert.rejects(
          operator.query(
            "update instrument.question set parent_id=$1 where version_id=$2",
            [b.document.sections[0].id, a.id],
          ),
          /foreign key/,
        );
      },
    );
    await t.test(
      "optimistic saves race once, replay receipts preserve the first write and unknown config is rejected",
      async () => {
        const args = {
          org: ids.orgA,
          qid: a.questionnaire_id,
          vid: a.id,
          revision: a.revision,
          action: "SAVE",
          document: a.document,
        };
        const results = await Promise.allSettled([
          save(staff, args),
          save(staff, args),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        a = (
          results.find(
            (r) => r.status === "fulfilled",
          ) as PromiseFulfilledResult<Version>
        ).value;
        const idem = randomUUID(),
          next = { ...args, revision: a.revision };
        const first = await save(staff, next, idem);
        assert.equal((await save(staff, next, idem)).revision, first.revision);
        await assert.rejects(
          save(
            staff,
            {
              ...next,
              document: { ...a.document, title: tr("مختلف", "Different") },
            },
            idem,
          ),
          /IDEMPOTENCY_CONFLICT/,
        );
        a = first;
        const bad = { ...a.document, branch: [] };
        await assert.rejects(
          withStaff(staff, (tx) =>
            instrumentRoute(
              new Request(`http://x/questionnaires`, {
                method: "PATCH",
                headers: {
                  "Content-Type": "application/json",
                  "Idempotency-Key": randomUUID(),
                  "If-Match": `"${a.revision}"`,
                },
                body: JSON.stringify(bad),
              }),
              `organizations/${ids.orgA}/questionnaires/${a.questionnaire_id}/versions/${a.id}`,
              tx,
            ),
          ),
          /VALIDATION_FAILED/,
        );
      },
    );
    await t.test(
      "publish failures, immutable rows and translation/hash preservation through retire and new-version",
      async () => {
        const bad = structuredClone(a.document);
        bad.title.en = "";
        a = await save(staff, {
          org: ids.orgA,
          qid: a.questionnaire_id,
          vid: a.id,
          revision: a.revision,
          action: "SAVE",
          document: bad,
        });
        await assert.rejects(
          save(staff, {
            org: ids.orgA,
            qid: a.questionnaire_id,
            vid: a.id,
            revision: a.revision,
            action: "PUBLISH",
            document: bad,
          }),
          /VALIDATION_FAILED/,
        );
        bad.title.en = "All types";
        a = await save(staff, {
          org: ids.orgA,
          qid: a.questionnaire_id,
          vid: a.id,
          revision: a.revision,
          action: "SAVE",
          document: bad,
        });
        a = await save(staff, {
          org: ids.orgA,
          qid: a.questionnaire_id,
          vid: a.id,
          revision: a.revision,
          action: "PUBLISH",
          document: a.document,
        });
        const hash = a.schema_hash;
        assert.equal(a.state, "PUBLISHED");
        assert.equal(hash?.length, 64);
        assert.equal(hash, digest(canonicalJson(a.document)).toString("hex"));
        await assert.rejects(
          save(staff, {
            org: ids.orgA,
            qid: a.questionnaire_id,
            vid: a.id,
            revision: a.revision,
            action: "SAVE",
            document: a.document,
          }),
          /STATE_CONFLICT/,
        );
        await assert.rejects(
          operator.query(
            "update instrument.question set payload=jsonb_set(payload,'{prompt,ar}','\"changed\"') where version_id=$1",
            [a.id],
          ),
          /STATE_CONFLICT/,
        );
        await assert.rejects(
          operator.query(
            "update instrument.questionnaire_version set metadata='{}' where id=$1",
            [a.id],
          ),
          /STATE_CONFLICT/,
        );
        const next = await save(staff, {
          org: ids.orgA,
          qid: a.questionnaire_id,
          revision: a.revision,
          sourceId: a.id,
          action: "NEW_VERSION",
          document: copyInstrument(a.document),
        });
        assert.equal(next.version_number, 2);
        assert.notEqual(
          next.document.sections[0].id,
          a.document.sections[0].id,
        );
        assert.equal(next.document.sections[0].key, a.document.sections[0].key);
        a = await save(staff, {
          org: ids.orgA,
          qid: a.questionnaire_id,
          vid: a.id,
          revision: a.revision,
          action: "RETIRE",
          document: a.document,
        });
        assert.equal(a.schema_hash, hash);
        assert.equal(a.state, "RETIRED");
        await save(staff, {
          org: ids.orgA,
          qid: a.questionnaire_id,
          revision: "1",
          action: "ARCHIVE",
        });
        assert.equal(
          (
            await withStaff(staff, (tx) =>
              getVersion(tx, ids.orgA, a.questionnaire_id, a.id),
            )
          ).schema_hash,
          hash,
        );
      },
    );
    await t.test(
      "matrix row weights, dimensions, overall and bands persist and direct malformed publication fails",
      async () => {
        const d = allTypes(),
          dim = {
            ...newIdentity(),
            name: tr("دعم", "Support"),
            description: tr(),
            mode: "WEIGHTED_AVERAGE" as const,
            coverage: "0.8",
            direction: "HIGH_GOOD" as const,
            denominator: null,
            bands: [
              {
                ...newIdentity(),
                lower: "0",
                upper: "100",
                label: tr("مثال", "Example"),
                severity: "NONE" as const,
                semantic: "HEALTH" as const,
              },
            ],
          };
        d.dimensions = [dim];
        d.sections[0].questions[8].dimensionId = dim.id;
        d.sections[0].questions[8].scoring.enabled = true;
        d.sections[0].questions[8].rows[0].weight = "2";
        d.overall = {
          enabled: true,
          direction: "HIGH_GOOD",
          inputs: [{ dimensionId: dim.id, weight: "1", invert: false }],
          bands: [],
        };
        let v = await save(admin, {
          org: ids.orgA,
          action: "CREATE",
          document: d,
        });
        assert.deepEqual(v.document, d);
        await operator.query(
          "update instrument.question set payload=payload||'{\"conditional\":true}'::jsonb where version_id=$1",
          [v.id],
        );
        await assert.rejects(
          withStaff(admin, (tx) =>
            sql`select instrument.write_version(${ids.orgA}::uuid,${v.questionnaire_id}::uuid,${v.id}::uuid,${v.revision}::bigint,'PUBLISH','{}'::jsonb,'[]'::jsonb,${digest("synthetic")},${randomUUID()}::uuid,${digest("direct-publish")},null)`.execute(
              tx,
            ),
          ),
          /VALIDATION_FAILED/,
        );
        await operator.query(
          "update instrument.question set payload=payload-'conditional' where version_id=$1",
          [v.id],
        );
        v = await save(admin, {
          org: ids.orgA,
          qid: v.questionnaire_id,
          vid: v.id,
          revision: v.revision,
          action: "PUBLISH",
          document: v.document,
        });
        assert.equal(v.state, "PUBLISHED");
      },
    );
    await t.test(
      "capability revocation and runtime RLS remain authoritative",
      async () => {
        await operator.query(
          "delete from access.staff_capability where staff_user_id=$1 and capability='instruments.manage'",
          [ids.staff],
        );
        await assert.rejects(
          save(staff, {
            org: ids.orgA,
            action: "CREATE",
            document: allTypes(),
          }),
          /SESSION_REQUIRED/,
        );
        const renewed = secret();
        await auth.query("select access.issue_session($1,'staff',$2)", [
          process.env.OIDC_ISSUER,
          digest(renewed),
        ]);
        await assert.rejects(
          save(renewed, {
            org: ids.orgA,
            action: "CREATE",
            document: allTypes(),
          }),
          /FORBIDDEN/,
        );
        const rows = await withStaff(renewed, (tx) =>
          sql<{
            organization_id: string | null;
          }>`select organization_id from instrument.questionnaire`.execute(tx),
        );
        assert(
          rows.rows.every(
            (r) => r.organization_id === null || r.organization_id === ids.orgA,
          ),
        );
        assert.equal(
          (
            await operator.query(
              "select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='instrument' and c.relkind='r' and (not relrowsecurity or not relforcerowsecurity)",
            )
          ).rows[0].n,
          0,
        );
      },
    );
  } finally {
    await Promise.all([auth.end(), operator.end(), runtime.end()]);
  }
});
function allTypesShape(d: Instrument) {
  return instrumentSchema.parse(d);
}
