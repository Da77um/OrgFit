import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { setupDatabase } from "./database";
import { migrate } from "../scripts/migrate";
import { withStaff } from "../src/db";
import { secret, digest } from "../src/security";
import { saveInstrument, getVersion, type Version } from "../src/instruments";
import { scoreInstrument, ENGINE_VERSION } from "../src/scoring";
import { scoringFixture } from "./scoring-fixtures";
import { ids } from "../scripts/seed";

test("007 populated upgrade preserves published content, pins engine and enforces SQL scoring checks", async (t) => {
  const fixture = await setupDatabase(
    undefined,
    true,
    "006_instrument_validation.sql",
  );
  const operator = new pg.Client({
      connectionString: fixture.url("orgfit_migrator"),
    }),
    auth = new pg.Client({ connectionString: fixture.url("orgfit_auth") });
  await operator.connect();
  await auth.connect();
  await operator.query("SET ROLE orgfit_core_owner");
  const snapshot = () =>
    operator.query(
      "select id,metadata,encode(schema_hash,'hex') hash,state from instrument.questionnaire_version where state='PUBLISHED' order by id",
    );
  const before = (await snapshot()).rows;
  try {
    await migrate(fixture.url("orgfit_migrator"));
    await migrate(fixture.url("orgfit_migrator"));
    assert.deepEqual((await snapshot()).rows, before);
    assert.equal(
      (
        await operator.query(
          "select distinct engine_version from instrument.questionnaire_version",
        )
      ).rows[0].engine_version,
      ENGINE_VERSION,
    );
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
    const token = secret();
    await auth.query("select access.issue_session($1,'admin',$2)", [
      process.env.OIDC_ISSUER,
      digest(token),
    ]);
    const save = (args: Omit<Parameters<typeof saveInstrument>[1], "idem">) =>
      withStaff(token, (tx) =>
        saveInstrument(tx, { ...args, idem: randomUUID() }),
      ) as Promise<Version>;
    const create = async (d: ReturnType<typeof scoringFixture>) =>
      save({ org: ids.orgA, action: "CREATE", document: d });
    const directPublish = (v: Version) =>
      withStaff(token, (tx) =>
        sql`select instrument.write_version(${ids.orgA}::uuid,${v.questionnaire_id}::uuid,${v.id}::uuid,${v.revision}::bigint,'PUBLISH','{}'::jsonb,'[]'::jsonb,${digest("synthetic")},${randomUUID()}::uuid,${digest(randomUUID())},null)`.execute(
          tx,
        ),
      );
    await t.test(
      "persisted version calculates golden score and engine/content remain immutable",
      async () => {
        const d = scoringFixture();
        d.sections[0].questions[1].scoring.reverse = true;
        let v = await create(d);
        v = await save({
          org: ids.orgA,
          qid: v.questionnaire_id,
          vid: v.id,
          revision: v.revision,
          action: "PUBLISH",
          document: v.document,
        });
        const loaded = await withStaff(token, (tx) =>
          getVersion(tx, ids.orgA, v.questionnaire_id, v.id),
        );
        const values = ["4", "2", "5"],
          answers = Object.fromEntries(
            loaded.document.sections[0].questions.map((q, i) => [
              q.id,
              values[i],
            ]),
          );
        assert.equal(
          scoreInstrument(loaded.document, answers, {
            engineVersion: loaded.engine_version,
            configVersion: loaded.id,
          }).dimensions[d.dimensions[0].id].normalized,
          250 / 3,
        );
        await assert.rejects(
          operator.query(
            "update instrument.questionnaire_version set engine_version='2.0.0' where id=$1",
            [v.id],
          ),
        );
        await assert.rejects(
          operator.query(
            "update instrument.question set payload=jsonb_set(payload,'{scoring,weight}','\"9\"') where version_id=$1",
            [v.id],
          ),
          /STATE_CONFLICT/,
        );
        const retired = await save({
          org: ids.orgA,
          qid: v.questionnaire_id,
          vid: v.id,
          revision: v.revision,
          action: "RETIRE",
          document: v.document,
        });
        assert.equal(retired.schema_hash, v.schema_hash);
        assert.equal(retired.engine_version, ENGINE_VERSION);
      },
    );
    await t.test(
      "direct SQL publication rejects constant checkbox bounds, ignored weights and mixed sums",
      async () => {
        const d = scoringFixture(1, "CHECKBOXES");
        d.sections[0].questions[0].scoring.mode = "OPTION_SUM";
        const v = await create(d);
        await operator.query(
          "update instrument.question set payload=jsonb_set(payload,'{validation,minSelections}','2'::jsonb) where version_id=$1",
          [v.id],
        );
        await assert.rejects(directPublish(v), /VALIDATION_FAILED/);
        const w = await create(scoringFixture());
        await operator.query(
          "update instrument.question set payload=jsonb_set(payload,'{scoring,weight}','\"2\"'::jsonb) where version_id=$1",
          [w.id],
        );
        await assert.rejects(directPublish(w), /VALIDATION_FAILED/);
        const s = await create(scoringFixture(2, "RATING_5", "SUM"));
        await operator.query(
          "update instrument.question set payload=jsonb_set(payload,'{type}','\"RATING_10\"'::jsonb) where id=$1",
          [s.document.sections[0].questions[0].id],
        );
        await assert.rejects(directPublish(s), /VALIDATION_FAILED/);
      },
    );
    await t.test(
      "SQL rejects nondecimal numbers, precision-incompatible bounds and zero denominators",
      async () => {
        const d = await create(scoringFixture(1, "NUMBER"));
        await operator.query(
          "update instrument.question set payload=jsonb_set(payload,'{validation,min}','\"0.1\"'::jsonb) where version_id=$1",
          [d.id],
        );
        await assert.rejects(directPublish(d), /VALIDATION_FAILED/);
        await operator.query(
          "update instrument.question set payload=jsonb_set(payload,'{validation,min}','\"NaN\"'::jsonb) where version_id=$1",
          [d.id],
        );
        await assert.rejects(directPublish(d), /VALIDATION_FAILED/);
        const p = await create(scoringFixture(2, "YES_NO", "PERCENTAGE"));
        await operator.query(
          "update instrument.score_definition set payload=jsonb_set(payload,'{denominator}','\"0\"'::jsonb) where version_id=$1 and parent_id is not null",
          [p.id],
        );
        await assert.rejects(directPublish(p), /VALIDATION_FAILED/);
      },
    );
    await t.test(
      "SQL and pure checkbox bounds agree for signed options and selection constraints",
      async () => {
        const d = scoringFixture(1, "CHECKBOXES");
        d.sections[0].questions[0].scoring.mode = "OPTION_SUM";
        d.sections[0].questions[0].options[0].score = "-5";
        d.sections[0].questions[0].options[1].score = "4";
        let v = await create(d);
        const b = await operator.query(
          "select instrument.scoring_bounds($1,$2) b",
          [d.sections[0].questions[0].id, v.id],
        );
        assert.deepEqual(b.rows[0].b, [-5, 4]);
        v = await save({
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
  } finally {
    await auth.end();
    await operator.end();
  }
});
