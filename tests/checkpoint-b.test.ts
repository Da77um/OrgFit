import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { setupDatabase } from "./database";
import { scoringFixture } from "./scoring-fixtures";
import {
  newIdentity,
  newQuestion,
  questionTypes,
  tr,
  definitionIssues,
  instrumentSchema,
  copyInstrument,
  canonicalJson,
  type Instrument,
} from "../src/instrument-input";
import { scoreInstrument, ENGINE_VERSION, type Answers } from "../src/scoring";
import { syntheticBoundaryAnswers } from "../src/scoring-synthetic";
import { nodeTables } from "../src/instrument-records";
import { withStaff } from "../src/db";
import { saveInstrument, getVersion, type Version } from "../src/instruments";
import { secret, digest } from "../src/security";
import { ids } from "../scripts/seed";

function allTypesScored() {
  const d = scoringFixture(1, "RATING_5", "WEIGHTED_AVERAGE"),
    dim = d.dimensions[0];
  dim.bands = [
    {
      ...newIdentity(),
      lower: "0",
      upper: "100",
      label: tr("تجريبي", "Synthetic"),
      severity: "NONE",
      semantic: "HEALTH",
    },
  ];
  d.sections[0].questions = questionTypes.map((type) => {
    const q = newQuestion(type);
    q.prompt = tr(`سؤال ${type}`, `Question ${type}`);
    for (const o of [...q.options, ...q.rows, ...q.columns])
      o.label = tr("تسمية", "Label");
    if (type === "NUMBER")
      q.validation = { min: "0", max: "100", precision: 2 };
    if (!["SHORT_TEXT", "LONG_TEXT", "DATE", "CONTENT"].includes(type)) {
      q.scoring.enabled = true;
      q.dimensionId = dim.id;
    }
    if (type === "CHECKBOXES") q.scoring.mode = "OPTION_SUM";
    if (type === "MATRIX") {
      q.required = false;
      q.rows.push({
        ...newIdentity(),
        label: tr("صف ثان", "Second row"),
        weight: "2",
      });
    }
    if (type === "RATING_5") q.required = false;
    return q;
  });
  d.overall = {
    enabled: true,
    direction: "HIGH_GOOD",
    inputs: [{ dimensionId: dim.id, weight: "1", invert: false }],
    bands: [],
  };
  // One recommendation rule, so the persistence, round-trip and published-node
  // protection below cover every node table this version can hold.
  d.recommendations = [
    {
      ...newIdentity(),
      target: { kind: "DIMENSION", dimensionId: dim.id },
      groupScope: "COMPANY",
      condition: {
        mode: "ALL",
        clauses: [
          {
            mode: "ALL",
            comparisons: [
              {
                metric: { kind: "DIMENSION", dimensionId: dim.id },
                operator: "LT",
                value: "40",
                upper: null,
              },
            ],
          },
        ],
      },
      priority: 100,
      dedupKey: "checkpoint-b",
      exclusivityGroup: null,
      title: tr("عنوان", "Title"),
      body: tr("النص", "Body"),
      action: tr("إجراء", "Action"),
      rationale: tr("مسوّغ", "Rationale"),
      enabled: true,
    },
  ];
  return d;
}
const inputs = (d: Instrument, values: string[]): Answers =>
  Object.fromEntries(d.sections[0].questions.map((q, i) => [q.id, values[i]]));

test("Checkpoint B independent SQL arithmetic and persisted all-type scoring", async (t) => {
  const fixture = await setupDatabase();
  const operator = new pg.Client({
      connectionString: fixture.url("orgfit_migrator"),
    }),
    auth = new pg.Client({ connectionString: fixture.url("orgfit_auth") });
  await operator.connect();
  await auth.connect();
  await operator.query("SET ROLE orgfit_core_owner");
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
  const admin = secret(),
    staff = secret();
  for (const [token, subject] of [
    [admin, "admin"],
    [staff, "staff"],
  ])
    await auth.query("select access.issue_session($1,$2,$3)", [
      process.env.OIDC_ISSUER,
      subject,
      digest(token),
    ]);
  const save = (args: Omit<Parameters<typeof saveInstrument>[1], "idem">) =>
    withStaff(admin, (tx) =>
      saveInstrument(tx, { ...args, idem: randomUUID() }),
    ) as Promise<Version>;
  const pin = {
    engineVersion: ENGINE_VERSION,
    configVersion: "checkpoint-b-independent",
  };
  try {
    await t.test(
      "all blueprint golden examples independently recalculated by PostgreSQL numeric",
      async () => {
        const {
          rows: [r],
        } = await operator.query(`select
        ((100::numeric*(4-1)/4)+(100::numeric*((1+5-2)-1)/4)+(100::numeric*(5-1)/4))/3 equal_mean,
        (2*(100::numeric*(4-1)/4)+(100::numeric*((1+5-2)-1)/4)+(100::numeric*(5-1)/4))/4 weighted,
        4::numeric/5 coverage80, 3::numeric/5 coverage60,
        (75::numeric+50+100+75)/4 missing_mean,
        2+3+4 raw_sum,100::numeric*((2+3+4)-(0+0+0))/((4+4+4)-(0+0+0)) sum_normalized,
        100::numeric*8/10 yes_percentage,70::numeric*0.6+90::numeric*0.4 overall,
        (10::numeric*80+20::numeric*50)/(10+20) company`);
        const equal = scoringFixture();
        equal.sections[0].questions[1].scoring.reverse = true;
        const calc = (d: Instrument, a: Answers) =>
          scoreInstrument(d, a, pin).dimensions[d.dimensions[0].id];
        const close = (actual: number | null, expected: unknown) =>
          assert(
            Math.abs(actual! - Number(expected)) < 1e-12,
            `${actual} vs ${expected}`,
          );
        close(
          calc(equal, inputs(equal, ["4", "2", "5"])).normalized,
          r.equal_mean,
        );
        equal.dimensions[0].mode = "WEIGHTED_AVERAGE";
        equal.sections[0].questions[0].scoring.weight = "2";
        close(
          calc(equal, inputs(equal, ["4", "2", "5"])).normalized,
          r.weighted,
        );
        const optional = scoringFixture(5);
        optional.sections[0].questions.forEach((q) => (q.required = false));
        const a = Object.fromEntries(
          optional.sections[0].questions
            .slice(0, 4)
            .map((q, i) => [q.id, ["4", "3", "5", "4"][i]]),
        );
        close(calc(optional, a).coverage, r.coverage80);
        close(calc(optional, a).normalized, r.missing_mean);
        delete a[optional.sections[0].questions[3].id];
        close(calc(optional, a).coverage, r.coverage60);
        assert.equal(calc(optional, a).normalized, null);
        const sum = scoringFixture(3, "NUMBER", "SUM"),
          sm = calc(sum, inputs(sum, ["2", "3", "4"]));
        close(sm.raw, r.raw_sum);
        close(sm.normalized, r.sum_normalized);
        const yes = scoringFixture(10, "YES_NO", "PERCENTAGE");
        close(
          calc(
            yes,
            Object.fromEntries(
              yes.sections[0].questions.map((q, i) => [
                q.id,
                q.options[i < 8 ? 1 : 0].id,
              ]),
            ),
          ).normalized,
          r.yes_percentage,
        );
        const overall = scoringFixture(1, "NUMBER"),
          second = scoringFixture(1, "NUMBER");
        for (const doc of [overall, second])
          doc.sections[0].questions[0].validation.max = "100";
        overall.sections[0].questions.push(second.sections[0].questions[0]);
        overall.dimensions.push(second.dimensions[0]);
        overall.overall = {
          enabled: true,
          direction: "HIGH_GOOD",
          inputs: overall.dimensions.map((dim, i) => ({
            dimensionId: dim.id,
            weight: i ? "0.4" : "0.6",
            invert: false,
          })),
          bands: [],
        };
        close(
          scoreInstrument(overall, inputs(overall, ["70", "90"]), pin).overall!
            .normalized,
          r.overall,
        );
        const { respondentMean } = await import("../src/scoring");
        close(
          respondentMean([...Array(10).fill(80), ...Array(20).fill(50)]).value,
          r.company,
        );
        assert.equal(Number(r.company), 60);
      },
    );
    await t.test(
      "all 12 types persist, validate, score, retain lineage and protect every published node",
      async () => {
        const d = allTypesScored();
        assert.deepEqual(definitionIssues(instrumentSchema.parse(d), true), []);
        let v = await save({ org: ids.orgA, action: "CREATE", document: d });
        v = await save({
          org: ids.orgA,
          qid: v.questionnaire_id,
          vid: v.id,
          revision: v.revision,
          action: "PUBLISH",
          document: v.document,
        });
        const loaded = await withStaff(staff, (tx) =>
          getVersion(tx, ids.orgA, v.questionnaire_id, v.id),
        );
        assert.deepEqual(loaded.document, d);
        assert.equal(
          loaded.schema_hash,
          digest(canonicalJson(d)).toString("hex"),
        );
        const p = {
          engineVersion: loaded.engine_version,
          configVersion: loaded.id,
        };
        for (const high of [false, true]) {
          const a = syntheticBoundaryAnswers(loaded.document, high),
            before = JSON.stringify({ d: loaded.document, a });
          const result = scoreInstrument(loaded.document, a, p);
          assert.equal(result.overall?.normalized, high ? 100 : 0);
          assert.equal(result.missingRequired.length, 0);
          assert.equal(result.unscored.length, 3);
          assert.deepEqual(scoreInstrument(loaded.document, a, p), result);
          assert.equal(JSON.stringify({ d: loaded.document, a }), before);
        }
        const a = syntheticBoundaryAnswers(d, true),
          matrix = d.sections[0].questions.find((q) => q.type === "MATRIX")!;
        delete a[matrix.rows[1].id];
        const text = d.sections[0].questions.find(
          (q) => q.type === "SHORT_TEXT",
        )!;
        delete a[text.id];
        let result = scoreInstrument(d, a, p);
        assert.equal(result.dimensions[d.dimensions[0].id].coverage, 0.8);
        assert.equal(result.overall?.normalized, 100);
        assert.deepEqual(result.missingRequired, [text.id]);
        delete a[
          d.sections[0].questions.find((q) => q.type === "RATING_5")!.id
        ];
        result = scoreInstrument(d, a, p);
        assert.equal(result.dimensions[d.dimensions[0].id].coverage, 0.7);
        assert.equal(result.overall?.normalized, null);
        for (const table of nodeTables)
          await assert.rejects(
            operator.query(
              `update instrument.${table} set payload=jsonb_set(payload,'{checkpointB}','true') where version_id=$1`,
              [v.id],
            ),
            /STATE_CONFLICT/,
          );
        await assert.rejects(
          operator.query(
            "update instrument.questionnaire_version set metadata=jsonb_set(metadata,'{title,en}','\"Changed\"') where id=$1",
            [v.id],
          ),
          /STATE_CONFLICT/,
        );
        const copied = copyInstrument(d);
        const next = await save({
          org: ids.orgA,
          qid: v.questionnaire_id,
          revision: v.revision,
          action: "NEW_VERSION",
          sourceId: v.id,
          document: copied,
        });
        const collect = (value: unknown): { id: string; key: string }[] =>
          !value || typeof value !== "object"
            ? []
            : [
                ...("id" in value && "key" in value
                  ? [value as { id: string; key: string }]
                  : []),
                ...Object.values(value).flatMap(collect),
              ];
        const oldItems = collect(d),
          newItems = collect(next.document);
        assert.equal(oldItems.length, newItems.length);
        for (const item of oldItems) {
          const match = newItems.find((x) => x.key === item.key);
          assert(match);
          assert.notEqual(match.id, item.id);
        }
        next.document.title.en = "Edited new draft";
        await save({
          org: ids.orgA,
          qid: next.questionnaire_id,
          vid: next.id,
          revision: next.revision,
          action: "SAVE",
          document: next.document,
        });
        const original = await withStaff(admin, (tx) =>
          getVersion(tx, ids.orgA, v.questionnaire_id, v.id),
        );
        assert.deepEqual(original.document, d);
        assert.equal(original.schema_hash, loaded.schema_hash);
        await assert.rejects(
          withStaff(staff, (tx) =>
            getVersion(tx, ids.orgB, v.questionnaire_id, v.id),
          ),
          /NOT_FOUND/,
        );
        const b = await save({
          org: ids.orgB,
          action: "CREATE",
          document: copyInstrument(d),
        });
        await assert.rejects(
          withStaff(staff, (tx) =>
            getVersion(tx, ids.orgB, b.questionnaire_id, b.id),
          ),
          /NOT_FOUND/,
        );
        for (const field of ["skipLogic", "recommendationRules", "expressions"])
          assert.equal(
            instrumentSchema.safeParse({ ...d, [field]: [] }).success,
            false,
          );
      },
    );
  } finally {
    await operator.end();
    await auth.end();
  }
});
