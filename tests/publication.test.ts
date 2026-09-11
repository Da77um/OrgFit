import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "kysely";
import { withStaff } from "../src/db";
import { exchange, instrument, finalize } from "../src/respondent";
import { processCampaign } from "../src/processor";
import { releaseCampaign, releaseDueCampaigns } from "../src/publication";
import { resultsRoute, readSnapshot, resolveCampaign } from "../src/results";
import type { Instrument } from "../src/instrument-input";
import { RULES_VERSION } from "../src/recommendation-engine";
import { recommendationActionRoute } from "../src/recommendations";
import { respondentFixture, failure, type Fixture } from "./respondent-fixture";

// End-to-end Phase 08: a real campaign is collected through the real gateway,
// processed by the real privacy processor and released by the real publication
// job, and then read back through the staff surface only.

function answersFor(document: Instrument, seed: number) {
  const answers: Record<string, string | string[]> = {};
  for (const q of document.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    switch (q.type) {
      case "SHORT_TEXT":
      case "LONG_TEXT":
        answers[q.id] = `نص سري ${seed}`;
        break;
      case "RATING_5":
        answers[q.id] = String((seed % 5) + 1);
        break;
      case "RATING_10":
        answers[q.id] = String((seed % 10) + 1);
        break;
      case "NUMBER":
        answers[q.id] = String(seed % 10);
        break;
      case "DATE":
        answers[q.id] = "2026-06-15";
        break;
      case "CHECKBOXES":
        answers[q.id] = [q.options[seed % q.options.length].id];
        break;
      case "MATRIX":
        for (const row of q.rows)
          answers[row.id] = q.columns[seed % q.columns.length].id;
        break;
      default:
        answers[q.id] = q.options[seed % q.options.length].id;
    }
  }
  return answers;
}
async function submitAll(links: { token: string }[]) {
  for (let i = 0; i < links.length; i++) {
    const opened = await exchange(links[i].token);
    assert.ok(opened.session);
    const document = (await instrument(opened.session)).document;
    await finalize(opened.session, { answers: answersFor(document, i) });
  }
}
const get = (path: string, query = "") =>
  new Request(`http://127.0.0.1:3000/api/v1/${path}${query}`);

test("PostgreSQL publication: release, disclosure storage and staff analytics", async (t) => {
  const f: Fixture = await respondentFixture(12);
  const core = new pg.Pool({
    connectionString: f.fixture.url("orgfit_processor"),
    max: 4,
  });
  const anon = new pg.Pool({
    connectionString: f.fixture.anonymousUrl("orgfit_processor"),
    max: 4,
  });
  let roundId = "",
    campaignId = "",
    snapshotId = "";
  try {
    // ---------------------------------------------------------------------
    await t.test(
      "an open campaign produces no assessment metrics and no release",
      async () => {
        const open = await f.launchedCampaign(f.people.slice(0, 6));
        const outcome = await releaseCampaign(core, anon, open.campaignId);
        assert.equal(outcome.state, "NOT_READY");
        assert.equal(outcome.snapshotId, null);
        const denial = await withStaff(f.staff, (tx) =>
          failure(() =>
            resultsRoute(get(`organizations/${f.orgA}/assessments/${open.roundId}/results`), `organizations/${f.orgA}/assessments/${open.roundId}/results`, tx),
          ),
        );
        assert.equal(denial, "RESULTS_NOT_READY");
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "a campaign below the threshold records an outcome and creates no snapshot",
      async () => {
        const small = await f.launchedCampaign(f.people.slice(0, 4));
        await submitAll(await f.issueLinks(small.campaignId));
        await f.closeCampaign(small.campaignId);
        await processCampaign(core, anon, small.campaignId);
        const outcome = await releaseCampaign(core, anon, small.campaignId);
        assert.equal(outcome.state, "INSUFFICIENT_DATA");
        const state = await f.operator.query(
          "select release_state from core.campaign where id=$1",
          [small.campaignId],
        );
        assert.equal(state.rows[0].release_state, "INSUFFICIENT_DATA");
        const rows = await f.operator.query(
          "select count(*)::int n from publication.result_snapshot where campaign_id=$1",
          [small.campaignId],
        );
        assert.equal(rows.rows[0].n, 0);
        const denial = await withStaff(f.staff, (tx) =>
          failure(() => readSnapshot(tx, small.campaignId)),
        );
        assert.equal(denial, "NO_ERROR");
        const snapshot = await withStaff(f.staff, (tx) =>
          readSnapshot(tx, small.campaignId),
        );
        assert.equal(snapshot.available, false);
      },
    );

    // ---------------------------------------------------------------------
    await t.test("a closed campaign is processed and released once", async () => {
      const launched = await f.launchedCampaign(f.people);
      roundId = launched.roundId;
      campaignId = launched.campaignId;
      await submitAll(await f.issueLinks(campaignId));
      await f.closeCampaign(campaignId);
      const processed = await processCampaign(core, anon, campaignId);
      assert.equal(processed.processedCount, 12);
      const outcome = await releaseCampaign(core, anon, campaignId);
      assert.equal(outcome.state, "PUBLISHED");
      assert.equal(outcome.contributorCount, 12);
      assert.ok(outcome.snapshotId);
      snapshotId = outcome.snapshotId!;
      // Repeating the whole job is idempotent: the same plan returns the same
      // snapshot rather than a second release.
      const again = await releaseCampaign(core, anon, campaignId);
      assert.equal(again.state, "REUSED");
      assert.equal(again.snapshotId, snapshotId);
      const repeated = await releaseDueCampaigns(core, anon);
      assert.ok(
        repeated.every((r) => r.state !== "PUBLISHED"),
        "an already released campaign must not be published again",
      );
      const count = await f.operator.query(
        "select count(*)::int n from publication.result_snapshot where campaign_id=$1",
        [campaignId],
      );
      assert.equal(count.rows[0].n, 1);
    });

    // ---------------------------------------------------------------------
    await t.test(
      "staff read published cells only, through one routine, in three fixed views",
      async () => {
        const read = async (suffix: string, query = "") => {
          const path = `organizations/${f.orgA}/assessments/${roundId}/results${suffix}`;
          const res = await withStaff(f.staff, (tx) =>
            resultsRoute(get(path, query), path, tx),
          );
          assert.ok(res);
          return (await res.json()).data;
        };
        const overview = await read("");
        assert.equal(overview.view, "overview");
        assert.equal(overview.contributorCount, 12);
        assert.equal(overview.threshold, 5);
        assert.equal(overview.snapshotId, snapshotId);
        assert.ok(overview.metrics.length >= 2);
        const available = overview.cells.filter(
          (c: { status: string }) => c.status === "AVAILABLE",
        );
        assert.ok(
          available.length >= 1,
          "twelve contributors must release at least one scored metric",
        );
        for (const cell of available) {
          assert.ok(cell.contributorCount >= 5);
          assert.match(cell.value, /^\d+(\.\d)?$/);
        }
        for (const cell of overview.cells)
          if (cell.status !== "AVAILABLE")
            assert.equal(cell.value, null, `${cell.metricKey} leaks a value`);
        assert.ok(overview.strengths.length >= 1);
        const departments = await read("/departments");
        assert.equal(departments.view, "departments");
        assert.equal(departments.groups.length, 2);
        // Six contributors in each department clears the threshold, so the flat
        // partition is released with its gaps against the company mean.
        assert.ok(
          departments.gaps.length >= 2,
          "a balanced two-department partition must be released",
        );
        for (const gap of departments.gaps)
          assert.match(String(gap.points), /^-?\d+\.\d$/);
        const questions = await read("/questions");
        assert.equal(questions.view, "questions");
        assert.ok(
          questions.cells.every(
            (c: { status: string; distribution: unknown }) =>
              c.status === "AVAILABLE" || c.distribution === null,
          ),
        );
        // No free-text answer reaches any view.
        for (const view of [overview, departments, questions])
          assert.doesNotMatch(JSON.stringify(view), /نص سري/);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "unsupported slices are refused rather than silently ignored",
      async () => {
        const path = `organizations/${f.orgA}/assessments/${roundId}/results`;
        for (const query of [
          "?departmentId=" + f.departmentA,
          "?since=2026-01-01",
          "?participantId=" + f.people[0],
          "?groupBy=gender",
        ]) {
          const denial = await withStaff(f.staff, (tx) =>
            failure(() => resultsRoute(get(path, query), path, tx)),
          );
          assert.equal(denial, "UNSUPPORTED_FILTER", `${query} must be refused`);
        }
        // Locale is presentation and stays allowed.
        const ok = await withStaff(f.staff, (tx) =>
          resultsRoute(get(path, "?locale=en"), path, tx),
        );
        assert.equal(ok?.status, 200);
        // An undefined view is not a route.
        const missing = `${path}/timeline`;
        assert.equal(
          await withStaff(f.staff, (tx) =>
            failure(() => resultsRoute(get(missing), missing, tx)),
          ),
          "NOT_FOUND",
        );
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "the staff credential cannot reach raw answers, scores or unpublished storage",
      async () => {
        for (const statement of [
          "select * from publication.result_snapshot",
          "select * from publication.aggregate_cell",
          "select * from publication.snapshot_metric",
          "select publication.publish_release('{}'::jsonb)",
          "select publication.mark_release_state(null,null,'FAILED')",
          "select publication.due_campaigns('RELEASE',5)",
        ]) {
          const denial = await withStaff(f.staff, async (tx) => {
            try {
              await sql.raw(statement).execute(tx);
              return "ALLOWED";
            } catch (e) {
              return (e as Error).message;
            }
          });
          assert.match(
            denial,
            /permission denied/,
            `orgfit_staff must be denied: ${statement} (got ${denial})`,
          );
        }
        // And no staff credential may connect to the anonymous answer database.
        const client = new pg.Client({
          connectionString: f.fixture.anonymousUrl("orgfit_staff"),
        });
        await assert.rejects(client.connect(), /permission denied|not permitted/);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "published content is immutable and no suppressed value is stored",
      async () => {
        const owner = f.operator;
        for (const statement of [
          `update publication.aggregate_cell set value=1 where snapshot_id='${snapshotId}'`,
          `delete from publication.aggregate_cell where snapshot_id='${snapshotId}'`,
          `update publication.snapshot_metric set unit='PERCENT' where snapshot_id='${snapshotId}'`,
          `delete from publication.result_snapshot where id='${snapshotId}'`,
          `update publication.result_snapshot set threshold=5,contributor_count=99 where id='${snapshotId}'`,
        ]) {
          const denial = await owner
            .query(statement)
            .then(() => "ALLOWED")
            .catch((e: Error) => e.message);
          assert.match(denial, /PUBLICATION_IMMUTABLE/, statement);
        }
        // The storage-level invariant, checked against the actual rows.
        const rows = await owner.query(
          `select status, contributor_count, value, coverage, distribution, band
             from publication.aggregate_cell where snapshot_id=$1`,
          [snapshotId],
        );
        assert.ok(rows.rowCount && rows.rowCount > 0);
        for (const row of rows.rows)
          if (row.status !== "AVAILABLE")
            assert.deepEqual(
              [row.contributor_count, row.value, row.coverage, row.distribution, row.band],
              [null, null, null, null, null],
            );
          else assert.ok(row.contributor_count >= 5);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "the database repeats the joint disclosure check independently",
      async () => {
        const COMPANY = "00000000-0000-4000-8000-000000000090",
          A = "00000000-0000-4000-8000-000000000091",
          B = "00000000-0000-4000-8000-000000000092";
        const cell = (
          groupKey: string,
          status: string,
          extra: Record<string, unknown> = {},
        ) => ({
          groupKey,
          metricKey: "overall",
          status,
          reasonCode: status === "AVAILABLE" ? null : "COMPLEMENTARY",
          contributorCount: null,
          value: null,
          coverage: null,
          distribution: null,
          band: null,
          ...extra,
        });
        const available = (groupKey: string, count = 6) =>
          cell(groupKey, "AVAILABLE", {
            reasonCode: null,
            contributorCount: count,
            value: "60.0",
          });
        const plan = (cells: unknown[], groups = [COMPANY, A, B]) => ({
          groups: groups.map((key, i) => ({
            key,
            kind: i === 0 ? "COMPANY" : "DEPARTMENT",
            label: { ar: "مجموعة", en: "Group" },
            order: i,
          })),
          metrics: [],
          cells,
        });
        const check = (payload: unknown, threshold = 5) =>
          f.operator
            .query("select publication.check_plan($1::jsonb,$2)", [
              JSON.stringify(payload),
              threshold,
            ])
            .then(() => "NO_ERROR")
            .catch((e: Error) => e.message);

        assert.equal(
          await check(plan([available(COMPANY, 12), available(A), available(B)])),
          "NO_ERROR",
        );
        assert.equal(
          await check(plan([available(COMPANY, 4)])),
          "PLAN_BELOW_THRESHOLD",
        );
        assert.equal(
          await check(
            plan([cell(COMPANY, "SUPPRESSED", { value: "60.0" })]),
          ),
          "PLAN_WITHHELD_CELL_CARRIES_VALUE",
        );
        assert.equal(
          await check(
            plan([available(COMPANY, 12), available(A), cell(B, "SUPPRESSED")]),
          ),
          "PLAN_PARTIAL_PARTITION",
        );
        assert.equal(
          await check(
            plan([cell(COMPANY, "SUPPRESSED"), available(A), available(B)]),
          ),
          "PLAN_PARTITION_WITHOUT_COMPANY",
        );
        assert.equal(
          await check(
            plan([
              {
                ...available(COMPANY, 12),
                value: null,
                distribution: {
                  kind: "OPTION_SHARES",
                  total: 12,
                  bins: [
                    { key: "a", count: 10 },
                    { key: "b", count: 2 },
                  ],
                },
              },
            ]),
          ),
          "PLAN_SPARSE_BIN",
        );
        assert.equal(
          await check({
            ...plan([available(COMPANY, 12)]),
            groups: [
              {
                key: A,
                kind: "DEPARTMENT",
                label: { ar: "قسم", en: "Department" },
                order: 0,
              },
            ],
          }),
          "PLAN_NO_COMPANY_GROUP",
        );
        // A campaign that is still collecting cannot be released at all, even
        // by the credential that owns the routine.
        const open = await f.launchedCampaign(f.people.slice(0, 6));
        assert.match(
          await f.operator
            .query("select publication.publish_release($1::jsonb)", [
              JSON.stringify({
                organizationId: f.orgA,
                campaignId: open.campaignId,
                ...plan([available(COMPANY, 12)]),
              }),
            ])
            .then(() => "NO_ERROR")
            .catch((e: Error) => e.message),
          /CAMPAIGN_NOT_CLOSED/,
        );
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "recommendations are released with the snapshot, deduplicated and frozen",
      async () => {
        const path = `organizations/${f.orgA}/assessments/${roundId}/results/recommendations`;
        const res = await withStaff(f.staff, (tx) =>
          resultsRoute(get(path), path, tx),
        );
        assert.ok(res);
        const data = (await res.json()).data;
        assert.equal(data.view, "recommendations");
        assert.equal(data.rulesVersion, RULES_VERSION);
        assert.ok(data.items.length >= 1);
        const keys = data.items.map((i: { dedupKey: string }) => i.dedupKey);
        // The fixture's rule set: one company rule wins its exclusivity group,
        // the weaker sibling never appears, and the disabled rule never runs.
        assert.ok(keys.includes("overall-review"));
        assert.ok(!keys.includes("overall-alternate"));
        assert.ok(!keys.includes("disabled-rule"));
        for (const item of data.items) {
          assert.match(item.ruleHash, /^[0-9a-f]{64}$/);
          assert.ok(item.evidence.items.length >= 1);
          for (const e of item.evidence.items) {
            assert.equal(e.groupKey, item.groupKey);
            // Every cited value is a cell the release actually published.
            const cell = await f.operator.query(
              "select status,(value=$4::numeric) matches from publication.aggregate_cell where snapshot_id=$1 and group_key=$2 and metric_key=$3",
              [snapshotId, e.groupKey, e.metricKey, e.value],
            );
            assert.equal(cell.rows[0].status, "AVAILABLE");
            assert.equal(cell.rows[0].matches, true);
          }
          // The substituted score is a published number, never a raw one.
          assert.doesNotMatch(JSON.stringify(item.text), /نص سري/);
        }
        // The release job is repeatable: a second run publishes nothing new and
        // leaves exactly the instances already stored.
        const again = await releaseCampaign(core, anon, campaignId);
        assert.equal(again.state, "REUSED");
        const stored = await f.operator.query(
          "select count(*)::int n from publication.recommendation_instance where snapshot_id=$1",
          [snapshotId],
        );
        assert.equal(stored.rows[0].n, data.items.length);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "a computed recommendation cannot cite or exist on a withheld metric",
      async () => {
        const instance = (
          await f.operator.query(
            "select id,group_key,metric_key,evidence from publication.recommendation_instance where snapshot_id=$1 limit 1",
            [snapshotId],
          )
        ).rows[0];
        // A withheld cell of the same snapshot, used as a forged target and as
        // forged evidence. Both are refused by the database itself.
        const withheld = (
          await f.operator.query(
            "select group_key,metric_key from publication.aggregate_cell where snapshot_id=$1 and status<>'AVAILABLE' limit 1",
            [snapshotId],
          )
        ).rows[0];
        assert.ok(withheld, "the release must contain at least one withheld cell");
        const insert = (groupKey: string, metricKey: string, evidence: unknown) =>
          f.operator
            .query(
              `insert into publication.recommendation_instance(organization_id,snapshot_id,group_key,metric_key,
                 rules_version,rule_key,rule_hash,priority,dedup_key,severity,text,evidence)
               values($1,$2,$3,$4,'1.0.0',gen_random_uuid(),sha256('x'),50,'forged','NONE','{}'::jsonb,$5::jsonb)`,
              [f.orgA, snapshotId, groupKey, metricKey, JSON.stringify(evidence)],
            )
            .then(() => "ALLOWED")
            .catch((e: Error) => e.message);
        assert.match(
          await insert(withheld.group_key, withheld.metric_key, {
            schemaVersion: 1,
            items: [
              {
                metricKey: withheld.metric_key,
                groupKey: withheld.group_key,
                value: "60.0",
                unit: "SCORE_0_100",
                band: null,
              },
            ],
          }),
          /RECOMMENDATION_ON_WITHHELD_METRIC|violates foreign key/,
        );
        assert.match(
          await insert(instance.group_key, instance.metric_key, {
            schemaVersion: 1,
            items: [
              {
                metricKey: withheld.metric_key,
                groupKey: withheld.group_key,
                value: "60.0",
                unit: "SCORE_0_100",
                band: null,
              },
            ],
          }),
          /RECOMMENDATION_CROSS_GROUP_EVIDENCE|RECOMMENDATION_ON_WITHHELD_METRIC/,
        );
        // A value that does not match the published cell is refused as well, so
        // a rendered number cannot drift from its evidence.
        assert.match(
          await insert(instance.group_key, instance.metric_key, {
            schemaVersion: 1,
            items: [
              {
                metricKey: instance.metric_key,
                groupKey: instance.group_key,
                value: "99.9",
                unit: "SCORE_0_100",
                band: null,
              },
            ],
          }),
          /RECOMMENDATION_ON_WITHHELD_METRIC/,
        );
        // And the computed row is immutable even for the owning role.
        for (const statement of [
          `update publication.recommendation_instance set priority=1 where id='${instance.id}'`,
          `delete from publication.recommendation_instance where id='${instance.id}'`,
        ])
          assert.match(
            await f.operator
              .query(statement)
              .then(() => "ALLOWED")
              .catch((e: Error) => e.message),
            /PUBLICATION_IMMUTABLE/,
            statement,
          );
        // The staff credential holds no privilege on the table at all.
        const denial = await withStaff(f.staff, async (tx) => {
          try {
            await sql.raw(
              "select * from publication.recommendation_instance",
            ).execute(tx);
            return "ALLOWED";
          } catch (e) {
            return (e as Error).message;
          }
        });
        assert.match(denial, /permission denied/);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "staff track an action beside the frozen finding, never inside it",
      async () => {
        const read = async () => {
          const path = `organizations/${f.orgA}/assessments/${roundId}/results/recommendations`;
          const res = await withStaff(f.staff, (tx) =>
            resultsRoute(get(path), path, tx),
          );
          return (await res!.json()).data.items as {
            id: string;
            text: Record<string, unknown>;
            action: { revision: number; status: string; staffNotes: string } | null;
          }[];
        };
        const before = await read();
        const target = before[0];
        assert.equal(target.action, null);
        const patch = (
          body: Record<string, unknown>,
          revision?: number,
          instanceId = target.id,
        ) => {
          const path = `organizations/${f.orgA}/recommendation-actions/${instanceId}`;
          const request = new Request(`http://127.0.0.1:3000/api/v1/${path}`, {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "idempotency-key": randomUUID(),
              ...(revision ? { "if-match": `"${revision}"` } : {}),
            },
            body: JSON.stringify(body),
          });
          return withStaff(f.staff, (tx) =>
            recommendationActionRoute(request, path, tx),
          );
        };
        const created = await patch({
          status: "IN_PROGRESS",
          staffNotes: "ملاحظة استشارية",
        });
        assert.equal(created?.status, 200);
        const afterCreate = await read();
        const withAction = afterCreate.find((i) => i.id === target.id)!;
        assert.equal(withAction.action?.status, "IN_PROGRESS");
        assert.equal(withAction.action?.staffNotes, "ملاحظة استشارية");
        // The computed half is untouched by the staff write.
        assert.deepEqual(withAction.text, target.text);
        // A stale revision loses, and closing requires a resolution.
        assert.equal(
          await failure(() => patch({ status: "DONE", resolution: "تم" }, 99)),
          "REVISION_CONFLICT",
        );
        assert.equal(
          await failure(() =>
            patch({ status: "DONE" }, withAction.action!.revision),
          ),
          "VALIDATION_FAILED",
        );
        const closed = await patch(
          { status: "DONE", resolution: "عولجت مع الإدارة" },
          withAction.action!.revision,
        );
        assert.equal(closed?.status, 200);
        // The same instance addressed through another organization is not
        // reachable, and neither is an instance identifier that does not exist.
        const foreign = `organizations/${f.orgB}/recommendation-actions/${target.id}`;
        const request = (path: string) =>
          withStaff(f.staff, (tx) =>
            recommendationActionRoute(
              new Request(`http://127.0.0.1:3000/api/v1/${path}`, {
                method: "PATCH",
                headers: {
                  "content-type": "application/json",
                  "idempotency-key": randomUUID(),
                },
                body: JSON.stringify({ status: "OPEN" }),
              }),
              path,
              tx,
            ),
          );
        assert.equal(await failure(() => request(foreign)), "NOT_FOUND");
        assert.equal(
          await failure(() =>
            request(
              `organizations/${f.orgA}/recommendation-actions/${randomUUID()}`,
            ),
          ),
          "NOT_FOUND",
        );
      },
    );

    // ---------------------------------------------------------------------
    await t.test("another organization sees nothing of this release", async () => {
      const denial = await withStaff(f.staff, (tx) =>
        failure(() => resolveCampaign(tx, f.orgB, roundId)),
      );
      assert.equal(denial, "NOT_FOUND");
      const path = `organizations/${f.orgB}/assessments/${roundId}/results`;
      assert.equal(
        await withStaff(f.staff, (tx) =>
          failure(() => resultsRoute(get(path), path, tx)),
        ),
        "NOT_FOUND",
      );
    });
  } finally {
    await core.end();
    await anon.end();
    await f.close();
  }
});
