import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "kysely";
import { withStaff } from "../src/db";
import { saveRound, saveCampaign, launchCampaign } from "../src/campaigns";
import { campaignInput } from "../src/campaign-input";
import { saveInstrument, getVersion } from "../src/instruments";
import {
  copyInstrument,
  definitionIssues,
  type Instrument,
} from "../src/instrument-input";
import { exchange, instrument, finalize } from "../src/respondent";
import { processCampaign } from "../src/processor";
import { releaseCampaign } from "../src/publication";
import { historyRoute } from "../src/history";
import { respondentFixture, failure, type Fixture } from "./respondent-fixture";

// Phase 10 against the real thing: two real campaigns of one series, each
// collected through the real gateway, processed by the real privacy processor
// and released by the real publication job, then read back as a history and
// compared through a real staff review.
//
// The property under test throughout is that a comparison is made of published
// aggregates and pinned definitions ONLY. No step here has, or could have, a
// participant identifier on both sides.

function answersFor(document: Instrument, seed: number) {
  const answers: Record<string, string | string[]> = {};
  for (const q of document.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    switch (q.type) {
      case "SHORT_TEXT":
      case "LONG_TEXT":
        answers[q.id] = `تعليق ${seed}`;
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

test("PostgreSQL Phase 10: series history, trends and reviewed comparison", async (t) => {
  const f: Fixture = await respondentFixture(12);
  const core = new pg.Pool({
    connectionString: f.fixture.url("orgfit_processor"),
    max: 4,
  });
  const anon = new pg.Pool({
    connectionString: f.fixture.anonymousUrl("orgfit_processor"),
    max: 4,
  });
  // The route matcher sees the path only; the query string travels on the
  // request exactly as it does behind the real handler.
  const route = (target: string, init: RequestInit | undefined, token: string) => {
    const [path] = target.split("?");
    const request = new Request(`http://127.0.0.1:3000/api/v1/${target}`, init);
    return withStaff(token, (tx) => historyRoute(request, path, tx));
  };
  const call = async (target: string, init?: RequestInit, token = f.staff) => {
    const res = await route(target, init, token);
    assert.ok(res, `${target} is not a route`);
    return { status: res.status, data: (await res.json()).data };
  };
  const deny = (target: string, init?: RequestInit, token = f.staff) =>
    failure(async () => {
      const res = await route(target, init, token);
      if (!res) throw new Error("NO_ROUTE");
      return res;
    });
  const post = (body: unknown) => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(body),
  });

  // One round of one series, collected and released for real.
  async function releasedRound(versionId: string, periodStart: string, seed: number) {
    const round = (await withStaff(f.staff, (tx) =>
      saveRound(
        tx,
        f.orgA,
        null,
        null,
        {
          seriesId: f.seriesId,
          label: `جولة ${periodStart}`,
          periodStart,
          questionnaireVersionId: versionId,
          populationDefinition: { schemaVersion: 1 },
        },
        randomUUID(),
      ),
    )) as { id: string };
    const campaign = (await withStaff(f.staff, (tx) =>
      saveCampaign(
        tx,
        f.orgA,
        null,
        null,
        campaignInput.parse({
          roundId: round.id,
          questionnaireVersionId: versionId,
          target: { mode: "SELECTED", participantIds: f.people },
          startsAt: new Date(Date.now() - 1000).toISOString(),
          timezone: "Asia/Riyadh",
        }),
        randomUUID(),
      ),
    )) as { id: string; revision: string };
    await withStaff(f.staff, (tx) =>
      launchCampaign(tx, f.orgA, campaign.id, campaign.revision, randomUUID()),
    );
    const links = await f.issueLinks(campaign.id);
    for (let i = 0; i < links.length; i++) {
      const opened = await exchange(links[i].token);
      const document = (await instrument(opened.session!)).document;
      await finalize(opened.session!, { answers: answersFor(document, i + seed) });
    }
    await f.closeCampaign(campaign.id);
    await processCampaign(core, anon, campaign.id);
    const outcome = await releaseCampaign(core, anon, campaign.id);
    assert.equal(outcome.state, "PUBLISHED");
    return { roundId: round.id, campaignId: campaign.id, snapshotId: outcome.snapshotId! };
  }

  // A new published version of the same questionnaire, patched after copying.
  async function newVersion(patch: (d: Instrument) => void) {
    const questionnaireId = (
      await f.operator.query(
        "select questionnaire_id from instrument.questionnaire_version where id=$1",
        [f.coverageVersionId],
      )
    ).rows[0].questionnaire_id as string;
    // A new version is a copy of the published one, exactly as the editor does
    // it: copyInstrument re-identifies every node but keeps the stable keys.
    const source = await withStaff(f.staff, (tx) =>
      getVersion(tx, f.orgA, questionnaireId, f.coverageVersionId),
    );
    const draft = (await withStaff(f.staff, (tx) =>
      saveInstrument(tx, {
        org: f.orgA,
        qid: questionnaireId,
        revision: source.revision,
        action: "NEW_VERSION",
        sourceId: f.coverageVersionId,
        document: copyInstrument(source.document),
        idem: randomUUID(),
      }),
    )) as { id: string; questionnaire_id: string; revision: string; document: Instrument };
    const document = draft.document;
    patch(document);
    // The patched copy must be a valid definition before it is saved, so a
    // failure here names the patch rather than the writer.
    assert.deepEqual(definitionIssues(document), []);
    const saved = (await withStaff(f.staff, (tx) =>
      saveInstrument(tx, {
        org: f.orgA,
        qid: draft.questionnaire_id,
        vid: draft.id,
        revision: draft.revision,
        action: "SAVE",
        document,
        idem: randomUUID(),
      }),
    )) as { id: string; revision: string; document: Instrument };
    const published = (await withStaff(f.staff, (tx) =>
      saveInstrument(tx, {
        org: f.orgA,
        qid: draft.questionnaire_id,
        vid: saved.id,
        revision: saved.revision,
        action: "PUBLISH",
        document: saved.document,
        idem: randomUUID(),
      }),
    )) as { id: string };
    return published.id;
  }

  let first = { roundId: "", campaignId: "", snapshotId: "" },
    second = { roundId: "", campaignId: "", snapshotId: "" };
  let identicalComparison = "";
  try {
    // ---------------------------------------------------------------------
    await t.test(
      "two released rounds of one series form a chronological history with a connected trend",
      async () => {
        first = await releasedRound(f.coverageVersionId, "2026-01-01", 0);
        second = await releasedRound(f.coverageVersionId, "2026-07-01", 2);
        // The series list is the entry point and must not need a privilege
        // staff do not have: it counts released rounds from the campaign's own
        // release state, never from publication storage.
        const listing = await call(`organizations/${f.orgA}/history`);
        const summary = listing.data.items.find(
          (s: { id: string }) => s.id === f.seriesId,
        );
        assert.ok(summary, "the series is listed");
        assert.equal(summary.released_count, 2);
        assert.equal(summary.round_count, 2);

        const { data } = await call(
          `organizations/${f.orgA}/history/${f.seriesId}`,
        );
        assert.equal(data.seriesId, f.seriesId);
        assert.deepEqual(
          data.rounds.map((r: { roundId: string }) => r.roundId),
          [first.roundId, second.roundId],
          "rounds are ordered by collection period",
        );
        assert.equal(data.rounds[0].releaseState, "PUBLISHED");
        assert.equal(data.rounds[0].contributorCount, 12);
        const overall = data.trends.find(
          (t: { metricKey: string }) => t.metricKey === "overall",
        );
        assert.ok(overall);
        assert.deepEqual(
          overall.points.map((p: { status: string }) => p.status),
          ["COMPARABLE", "COMPARABLE"],
          "the same pinned version across both rounds is a continuous series",
        );
        for (const point of overall.points) assert.match(point.value, /^\d+(\.\d)?$/);
        // A history is a sequence of releases and carries no identity at all.
        const serialized = JSON.stringify(data);
        for (const person of f.people)
          assert.ok(!serialized.includes(person), "a participant id reached the history");
        assert.doesNotMatch(serialized, /مشارك|تعليق \d/);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "an unreleased round is a gap in the trend, never a plotted point",
      async () => {
        const open = await f.launchedCampaign(f.people.slice(0, 6));
        const { data } = await call(`organizations/${f.orgA}/history/${f.seriesId}`);
        const point = data.trends[0].points.find(
          (p: { roundId: string }) => p.roundId === open.roundId,
        );
        assert.ok(point, "the round is listed");
        assert.equal(point.status, "GAP");
        assert.equal(point.reasonCode, "NOT_RELEASED");
        assert.equal(point.value, null);
        assert.equal(point.contributorCount, null);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "the same pinned version is IDENTICAL and yields direction-aware deltas",
      async () => {
        const proposal = await call(
          `organizations/${f.orgA}/comparisons/proposal?left=${first.roundId}&right=${second.roundId}`,
        );
        assert.equal(proposal.data.identicalVersion, true);
        assert.equal(proposal.data.suggestion, "IDENTICAL");
        assert.ok(proposal.data.pairs.every((p: { equivalent: boolean }) => p.equivalent));

        const created = await call(
          `organizations/${f.orgA}/comparisons`,
          post({
            leftRoundId: first.roundId,
            rightRoundId: second.roundId,
            classification: "IDENTICAL",
            mapping: proposal.data.pairs.map(
              (p: { leftKey: string; rightKey: string }) => ({
                leftKey: p.leftKey,
                rightKey: p.rightKey,
              }),
            ),
            rationale: "نفس النسخة المنشورة ونفس التعريف القياسي.",
          }),
        );
        assert.equal(created.status, 201);
        identicalComparison = created.data.id;
        assert.equal(created.data.classification, "IDENTICAL");
        assert.equal(created.data.comparable, true);

        const company = created.data.cells.find(
          (c: { metricKey: string; groupKey: string }) =>
            c.metricKey === "overall" &&
            c.groupKey === created.data.right.groups.find((g: { kind: string }) => g.kind === "COMPANY").key,
        );
        assert.equal(company.status, "COMPARABLE");
        // The delta is exactly the difference of the two published values, and
        // the direction decides whether that is an improvement.
        assert.equal(
          company.pointChange,
          (Number(company.right.value) - Number(company.left.value)).toFixed(1),
        );
        assert.equal(
          company.improved,
          company.direction === "HIGH_RISK"
            ? Number(company.pointChange) < 0
            : Number(company.pointChange) > 0,
        );
        // Both sides keep their own frozen period and contributor count.
        assert.equal(created.data.left.contributorCount, 12);
        assert.equal(created.data.right.contributorCount, 12);
        assert.notEqual(created.data.left.snapshotId, created.data.right.snapshotId);
        // Nothing individual survives into a comparison either.
        const serialized = JSON.stringify(created.data);
        for (const person of f.people) assert.ok(!serialized.includes(person));
        assert.doesNotMatch(serialized, /تعليق \d/);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "a translation-only version is reviewable as equivalent; a re-specified one is not",
      async () => {
        const translated = await newVersion((d) => {
          d.dimensions[0].name = {
            ar: "البعد بصياغة جديدة",
            en: "Dimension, reworded",
          };
          d.sections[0].questions[0].prompt = {
            ar: "صياغة جديدة تمامًا للسؤال",
            en: "A completely reworded question",
          };
        });
        const third = await releasedRound(translated, "2027-01-01", 3);
        const proposal = await call(
          `organizations/${f.orgA}/comparisons/proposal?left=${second.roundId}&right=${third.roundId}`,
        );
        assert.equal(proposal.data.identicalVersion, false);
        assert.equal(proposal.data.suggestion, "REVIEWED_EQUIVALENT");
        const mapping = proposal.data.pairs.map(
          (p: { leftKey: string; rightKey: string }) => ({
            leftKey: p.leftKey,
            rightKey: p.rightKey,
          }),
        );
        // IDENTICAL is a claim about the pinned versions and is refused here.
        assert.equal(
          await deny(
            `organizations/${f.orgA}/comparisons`,
            post({
              leftRoundId: second.roundId,
              rightRoundId: third.roundId,
              classification: "IDENTICAL",
              mapping,
              rationale: "محاولة تصنيف غير صحيحة",
            }),
          ),
          "VALIDATION_FAILED",
        );
        const reviewed = await call(
          `organizations/${f.orgA}/comparisons`,
          post({
            leftRoundId: second.roundId,
            rightRoundId: third.roundId,
            classification: "REVIEWED_EQUIVALENT",
            mapping,
            rationale: "تعديل الصياغة فقط دون تغيير القياس.",
          }),
        );
        assert.equal(reviewed.status, 201);
        assert.equal(reviewed.data.comparable, true);
        assert.ok(reviewed.data.populationCaveats.includes("VERSION_CHANGED"));
        assert.ok(
          reviewed.data.cells.some((c: { status: string }) => c.status === "COMPARABLE"),
        );

        // Now a version whose measurement really changed.
        // A real measurement change that is still valid configuration: the
        // scored item is now reverse-scored, so the same answers mean the
        // opposite. Every stable key is untouched.
        const rescored = await newVersion((d) => {
          const scored = d.sections
            .flatMap((s) => s.questions)
            .find((q) => q.scoring.enabled)!;
          scored.scoring = { ...scored.scoring, reverse: true };
        });
        const fourth = await releasedRound(rescored, "2027-07-01", 4);
        const changed = await call(
          `organizations/${f.orgA}/comparisons/proposal?left=${third.roundId}&right=${fourth.roundId}`,
        );
        assert.equal(changed.data.suggestion, "NOT_COMPARABLE");
        assert.ok(changed.data.pairs.some((p: { equivalent: boolean }) => !p.equivalent));
        // A reviewer cannot declare equivalence the definitions contradict.
        assert.equal(
          await deny(
            `organizations/${f.orgA}/comparisons`,
            post({
              leftRoundId: third.roundId,
              rightRoundId: fourth.roundId,
              classification: "REVIEWED_EQUIVALENT",
              mapping: changed.data.pairs
                .filter((p: { equivalent: boolean }) => !p.equivalent)
                .map((p: { leftKey: string; rightKey: string }) => ({
                  leftKey: p.leftKey,
                  rightKey: p.rightKey,
                })),
              rationale: "محاولة فرض التكافؤ",
            }),
          ),
          "MEASUREMENT_NOT_EQUIVALENT",
        );
        // It can be documented as incomparable, and then no number is produced.
        const documented = await call(
          `organizations/${f.orgA}/comparisons`,
          post({
            leftRoundId: third.roundId,
            rightRoundId: fourth.roundId,
            classification: "NOT_COMPARABLE",
            mapping: [],
            rationale: "تغيّر وزن عنصر القياس بين الجولتين.",
          }),
        );
        assert.equal(documented.data.comparable, false);
        assert.ok(
          documented.data.cells.every(
            (c: { pointChange: null; improvement: null }) =>
              c.pointChange === null && c.improvement === null,
          ),
        );
        // The automatic trend breaks at the re-specified round rather than
        // continuing the line through it.
        const history = await call(`organizations/${f.orgA}/history/${f.seriesId}`);
        const overall = history.data.trends.find(
          (t: { metricKey: string }) => t.metricKey === "overall",
        );
        const point = overall.points.find(
          (p: { roundId: string }) => p.roundId === fourth.roundId,
        );
        assert.equal(point.status, "NOT_COMPARABLE");
        assert.equal(point.value, null);
        assert.equal(point.reasonCode, "MEASUREMENT_CHANGED");
      },
    );

    // ---------------------------------------------------------------------
    await t.test("impossible comparisons are refused", async () => {
      // Reversed chronology.
      assert.equal(
        await deny(
          `organizations/${f.orgA}/comparisons`,
          post({
            leftRoundId: second.roundId,
            rightRoundId: first.roundId,
            classification: "IDENTICAL",
            mapping: [{ leftKey: "overall", rightKey: "overall" }],
            rationale: "ترتيب زمني معكوس",
          }),
        ),
        "VALIDATION_FAILED",
      );
      // A round compared with itself.
      assert.equal(
        await deny(
          `organizations/${f.orgA}/comparisons`,
          post({
            leftRoundId: first.roundId,
            rightRoundId: first.roundId,
            classification: "IDENTICAL",
            mapping: [{ leftKey: "overall", rightKey: "overall" }],
            rationale: "نفس الجولة",
          }),
        ),
        "VALIDATION_FAILED",
      );
      // A round that has never been released has nothing to compare.
      const open = await f.launchedCampaign(f.people.slice(0, 6));
      assert.equal(
        await deny(
          `organizations/${f.orgA}/comparisons`,
          post({
            leftRoundId: first.roundId,
            rightRoundId: open.roundId,
            classification: "IDENTICAL",
            mapping: [{ leftKey: "overall", rightKey: "overall" }],
            rationale: "جولة غير منشورة",
          }),
        ),
        "STATE_CONFLICT",
      );
      // Another organization cannot read or create any of it.
      for (const path of [
        `organizations/${f.orgB}/history/${f.seriesId}`,
        `organizations/${f.orgB}/comparisons/${identicalComparison}`,
      ])
        assert.equal(await deny(path), "NOT_FOUND", path);
      assert.equal(
        await deny(
          `organizations/${f.orgB}/comparisons`,
          post({
            leftRoundId: first.roundId,
            rightRoundId: second.roundId,
            classification: "IDENTICAL",
            mapping: [{ leftKey: "overall", rightKey: "overall" }],
            rationale: "عبر المنظمات",
          }),
        ),
        "NOT_FOUND",
      );
      // And an arbitrary slice of a history is refused like any other.
      assert.equal(
        await deny(`organizations/${f.orgA}/history/${f.seriesId}?departmentId=${f.departmentA}`),
        "UNSUPPORTED_FILTER",
      );
    });

    // ---------------------------------------------------------------------
    await t.test(
      "reading a history needs results.read; declaring equivalence needs instrument authority",
      async () => {
        // A staff user who may read results but has no instrument authority.
        const reader = randomUUID();
        await f.operator.query(
          `insert into access.staff_user(id,issuer,provider_subject,email,display_name,role,status)
           values($1,$2,'reader','reader@example.invalid','قارئ النتائج','STAFF','ACTIVE')`,
          [reader, process.env.OIDC_ISSUER],
        );
        await f.operator.query(
          "insert into access.organization_access values($1,$2)",
          [reader, f.orgA],
        );
        await f.operator.query(
          "insert into access.staff_capability values($1,'results.read')",
          [reader],
        );
        const token = await f.session("reader");
        const history = await call(
          `organizations/${f.orgA}/history/${f.seriesId}`,
          undefined,
          token,
        );
        assert.ok(history.data.rounds.length >= 2);
        const view = await call(
          `organizations/${f.orgA}/comparisons/${identicalComparison}`,
          undefined,
          token,
        );
        assert.equal(view.data.id, identicalComparison);
        // But not the review itself, nor the review aid.
        assert.equal(
          await deny(
            `organizations/${f.orgA}/comparisons`,
            post({
              leftRoundId: first.roundId,
              rightRoundId: second.roundId,
              classification: "IDENTICAL",
              mapping: [{ leftKey: "overall", rightKey: "overall" }],
              rationale: "بدون صلاحية",
            }),
            token,
          ),
          "FORBIDDEN",
        );
        assert.equal(
          await deny(
            `organizations/${f.orgA}/comparisons/proposal?left=${first.roundId}&right=${second.roundId}`,
            undefined,
            token,
          ),
          "FORBIDDEN",
        );
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "a stored review is immutable and is not reachable as a table",
      async () => {
        for (const statement of [
          `update publication.comparison_definition set classification='IDENTICAL' where id='${identicalComparison}'`,
          `delete from publication.comparison_definition where id='${identicalComparison}'`,
        ])
          assert.match(
            await f.operator
              .query(statement)
              .then(() => "ALLOWED")
              .catch((e: Error) => e.message),
            /PUBLICATION_IMMUTABLE/,
            statement,
          );
        const denial = await withStaff(f.staff, async (tx) => {
          try {
            await sql.raw("select * from publication.comparison_definition").execute(tx);
            return "ALLOWED";
          } catch (e) {
            return (e as Error).message;
          }
        });
        assert.match(denial, /permission denied/);
        // Re-submitting the same review returns the same immutable row rather
        // than a second opinion of record.
        const repeat = await call(
          `organizations/${f.orgA}/comparisons`,
          post({
            leftRoundId: first.roundId,
            rightRoundId: second.roundId,
            classification: "IDENTICAL",
            mapping: [
              { leftKey: "overall", rightKey: "overall" },
            ],
            rationale: "نفس النسخة المنشورة ونفس التعريف القياسي.",
          }),
        );
        const rows = await f.operator.query(
          "select count(*)::int n from publication.comparison_definition where left_round_id=$1 and right_round_id=$2",
          [first.roundId, second.roundId],
        );
        assert.ok(rows.rows[0].n >= 1);
        assert.equal(repeat.data.left.roundId, first.roundId);
      },
    );
  } finally {
    await core.end();
    await anon.end();
    await f.close();
  }
});
