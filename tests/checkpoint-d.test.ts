import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "kysely";
import { withStaff } from "../src/db";
import { exchange, instrument, finalize } from "../src/respondent";
import { processCampaign } from "../src/processor";
import { releaseCampaign, releasePayload } from "../src/publication";
import { resultsRoute, readSnapshot } from "../src/results";
import { recommendationActionRoute } from "../src/recommendations";
import {
  buildReleasePlan,
  rankDimensions,
  DisclosureError,
  OVERALL_METRIC_KEY,
  type ReleasePlan,
  type SafeCell,
  type MetricDefinition,
} from "../src/disclosure";
import { evaluateRecommendations } from "../src/recommendation-engine";
import { scoreInstrument, ENGINE_VERSION } from "../src/scoring";
import { N } from "../src/score-number";
import type { Instrument, RecommendationRule } from "../src/instrument-input";
import {
  COMPANY,
  DEPT_A,
  DEPT_B,
  DIMENSION_ID,
  DIMENSION_KEY,
  CHOICE_KEY,
  CHOICE_OPTIONS,
  CHECKBOX_KEY,
  CHECKBOX_OPTIONS,
  releaseInput,
  respondent,
  t as label,
  uid,
} from "./publication-fixtures";
import { respondentFixture, failure, type Fixture } from "./respondent-fixture";

// ---------------------------------------------------------------------------
// CHECKPOINT D — blocking results and recommendation disclosure gate.
//
// This suite is adversarial and independent of the Phase 08 and Phase 09 tests.
// Where those asked "does the engine apply its rules", this one starts from the
// reader's side and tries to RECONSTRUCT a protected value: from totals, from
// contributor counts, from chart payloads, from recommendations, from statuses,
// from repeated releases and from alternate partitions.
//
// Part A attacks the arithmetic directly with datasets chosen so that every
// protected quantity is a distinct, searchable number. Part B repeats the
// attempt against the real pipeline and the real staff API.
// ---------------------------------------------------------------------------

const DIMENSION_METRIC = `dimension:${DIMENSION_KEY}`;
const CHOICE_METRIC = `question:${CHOICE_KEY}`;
const CHECKBOX_METRIC = `question:${CHECKBOX_KEY}`;
const cellFor = (plan: ReleasePlan, group: string, metric: string) =>
  plan.cells.find((c) => c.groupKey === group && c.metricKey === metric)!;
const withheldEverywhere = (cell: SafeCell) =>
  cell.status !== "AVAILABLE" &&
  cell.value === null &&
  cell.contributorCount === null &&
  cell.coverage === null &&
  cell.distribution === null &&
  cell.band === null;
const choice = (option: number) =>
  ({ type: "OPTION", optionId: CHOICE_OPTIONS[option] }) as const;
// A number as a literal pattern: an unescaped decimal point is a wildcard and
// would happily "find" 43.2 inside a UUID.
const literal = (value: string) =>
  new RegExp(value.replace(/[.]/g, String.raw`\.`));
const checkboxes = (options: number[]) =>
  ({
    type: "OPTION_SET",
    optionIds: options.map((o) => CHECKBOX_OPTIONS[o]),
  }) as const;

// ===========================================================================
// PART A — reconstruction attempts against the disclosure and rule engines
// ===========================================================================

test("D-A1 four contributors produce no release at all, not a suppressed one", () => {
  // There is nothing to suppress because there is nothing to compute: the plan
  // is refused outright, which is what stops a "withheld" shell from carrying
  // a count that itself describes four people.
  const error = (() => {
    try {
      buildReleasePlan(
        releaseInput([1, 2, 3, 4].map((v) => respondent(DEPT_A, `${60 + v}`))),
      );
      return "NO_ERROR";
    } catch (e) {
      return e instanceof DisclosureError ? e.code : (e as Error).message;
    }
  })();
  assert.equal(error, "BELOW_THRESHOLD");
});

test("D-A2 a campaign of twenty does not license a metric with four contributors", () => {
  // Twenty people answer the choice question; only four are scorable on the
  // dimension. The campaign total is a tempting denominator and must not be
  // used as one.
  const responses = [
    ...Array.from({ length: 10 }, (_, i) =>
      respondent(DEPT_A, i < 2 ? `${70 + i}` : null, { [CHOICE_KEY]: choice(i % 2) }),
    ),
    ...Array.from({ length: 10 }, (_, i) =>
      respondent(DEPT_B, i < 2 ? `${80 + i}` : null, { [CHOICE_KEY]: choice(i % 2) }),
    ),
  ];
  const plan = buildReleasePlan(releaseInput(responses));
  assert.equal(plan.contributorCount, 20);
  for (const metric of [OVERALL_METRIC_KEY, DIMENSION_METRIC]) {
    const cell = cellFor(plan, COMPANY, metric);
    assert.equal(cell.status, "INSUFFICIENT", metric);
    assert.equal(cell.reasonCode, "BELOW_THRESHOLD", metric);
    assert.ok(withheldEverywhere(cell), `${metric} carries a value`);
  }
  // The question metric, which really does have twenty contributors, is
  // released — so the refusal above is per metric and not a blanket failure.
  const question = cellFor(plan, COMPANY, CHOICE_METRIC);
  assert.equal(question.status, "AVAILABLE");
  assert.equal(question.contributorCount, 20);
  // And no scored value for the four people appears anywhere in the plan.
  for (const value of ["70", "71", "80", "81", "75.5"])
    assert.doesNotMatch(
      JSON.stringify(plan),
      new RegExp(`"${value}(\\.|")`),
      `the plan leaks ${value}`,
    );
});

test("D-A3 ten plus two: one equation, three unknowns, and nothing else", () => {
  // Ten engineers and two operators, with department means chosen to be
  // distinct from each other and from the company mean, so any leak of either
  // department's result is a searchable string.
  const large = ["70", "72", "74", "76", "78", "80", "82", "84", "86", "88"]; // mean 79
  const small = ["30", "40"]; // mean 35
  const plan = buildReleasePlan(
    releaseInput([
      ...large.map((v) => respondent(DEPT_A, v)),
      ...small.map((v) => respondent(DEPT_B, v)),
    ]),
  );
  const company = cellFor(plan, COMPANY, DIMENSION_METRIC);
  // (10*79 + 2*35) / 12 = 860/12 = 71.666…, and the mean of department
  // means would have been 57.0 — neither of which is a department result.
  assert.equal(company.status, "AVAILABLE");
  assert.equal(company.value, "71.7");
  assert.equal(company.contributorCount, 12);
  // Both departments are withheld — including the LARGE one, which on its own
  // would have been publishable. Releasing it beside the company total is one
  // subtraction away from the two-person department.
  for (const group of [DEPT_A, DEPT_B]) {
    const cell = cellFor(plan, group, DIMENSION_METRIC);
    assert.ok(withheldEverywhere(cell), `${group} leaks`);
    assert.equal(cell.reasonCode, "COMPLEMENTARY");
  }
  // The reconstruction attempt itself: the reader holds one equation
  // (12 × 71.7 = 10a + 2b) and knows neither a nor b, and neither group size
  // was published either.
  const serialized = JSON.stringify(plan);
  for (const secret of ["79", "35", "30", "40", "88"])
    assert.doesNotMatch(
      serialized,
      new RegExp(`"${secret}(\\.\\d)?"`),
      `the plan leaks ${secret}`,
    );
  assert.doesNotMatch(serialized, /"contributorCount":(2|10)\b/);
});

test("D-A4 the company value is contributor-weighted, not a mean of department means", () => {
  // Eight people near 90 and five near 50. A mean of department means would be
  // 70.0; the contributor-weighted mean is 74.6. Both departments clear the
  // threshold, so this is checked on a released partition.
  const a = ["88", "89", "90", "91", "92", "90", "90", "90"]; // mean 90
  const b = ["48", "49", "50", "51", "52"]; // mean 50
  const plan = buildReleasePlan(
    releaseInput([
      ...a.map((v) => respondent(DEPT_A, v)),
      ...b.map((v) => respondent(DEPT_B, v)),
    ]),
  );
  const company = cellFor(plan, COMPANY, DIMENSION_METRIC);
  assert.equal(company.status, "AVAILABLE");
  // (8*90 + 5*50) / 13 = 74.6153…
  assert.equal(company.value, "74.6");
  assert.notEqual(company.value, "70.0");
  assert.equal(company.contributorCount, 13);
  assert.equal(cellFor(plan, DEPT_A, DIMENSION_METRIC).value, "90.0");
  assert.equal(cellFor(plan, DEPT_B, DIMENSION_METRIC).value, "50.0");
  // Cross-check against exact arithmetic rather than against the engine again.
  const expected = N(
    [...a, ...b].reduce((sum, v) => sum + Number(v), 0).toString(),
  ).div(N("13"));
  assert.equal(company.value, expected.format(1));
});

test("D-A5 sparse and overlapping option bins: respondents are the denominator", () => {
  // Fifteen people, each selecting two of three options. Selections total 30,
  // respondents total 15; the released denominator must be the people.
  const overlap = [
    ...Array.from({ length: 5 }, () =>
      respondent(DEPT_A, "60", { [CHECKBOX_KEY]: checkboxes([0, 1]) }),
    ),
    ...Array.from({ length: 5 }, () =>
      respondent(DEPT_A, "61", { [CHECKBOX_KEY]: checkboxes([1, 2]) }),
    ),
    ...Array.from({ length: 5 }, () =>
      respondent(DEPT_B, "62", { [CHECKBOX_KEY]: checkboxes([0, 2]) }),
    ),
  ];
  const released = cellFor(
    buildReleasePlan(releaseInput(overlap)),
    COMPANY,
    CHECKBOX_METRIC,
  );
  assert.equal(released.status, "AVAILABLE");
  assert.equal(released.distribution!.total, 15);
  assert.equal(
    released.distribution!.bins.reduce((sum, b) => sum + b.count, 0),
    30,
    "selections must exceed respondents, proving people are counted once each",
  );
  for (const bin of released.distribution!.bins) assert.ok(bin.count >= 5);

  // Now make one option rare. The whole distribution goes, not the rare bar:
  // publishing the other two bars and the denominator would restore it.
  const sparse = [
    ...Array.from({ length: 10 }, (_, i) =>
      respondent(DEPT_A, `${60 + i}`, { [CHECKBOX_KEY]: checkboxes([0]) }),
    ),
    ...Array.from({ length: 2 }, (_, i) =>
      respondent(DEPT_B, `${70 + i}`, { [CHECKBOX_KEY]: checkboxes([1]) }),
    ),
    ...Array.from({ length: 5 }, (_, i) =>
      respondent(DEPT_B, `${80 + i}`, { [CHECKBOX_KEY]: checkboxes([2]) }),
    ),
  ];
  const plan = buildReleasePlan(releaseInput(sparse));
  const suppressed = cellFor(plan, COMPANY, CHECKBOX_METRIC);
  assert.equal(suppressed.status, "SUPPRESSED");
  assert.equal(suppressed.reasonCode, "SPARSE_BIN");
  assert.ok(withheldEverywhere(suppressed));
  // Neither the rare count nor the complementary counts survive anywhere.
  assert.doesNotMatch(JSON.stringify(plan), /"count":/);
});

test("D-A6 a homogeneous endpoint result is withheld, not published as certainty", () => {
  const plan = buildReleasePlan(
    releaseInput(
      Array.from({ length: 12 }, () =>
        respondent(DEPT_A, "100", { [CHOICE_KEY]: choice(0) }),
      ),
    ),
  );
  const company = cellFor(plan, COMPANY, DIMENSION_METRIC);
  assert.equal(company.status, "SUPPRESSED");
  assert.equal(company.reasonCode, "HOMOGENEOUS");
  assert.ok(withheldEverywhere(company));
  // The unanimous choice answer is a homogeneous disclosure too.
  const question = cellFor(plan, COMPANY, CHOICE_METRIC);
  assert.equal(question.reasonCode, "HOMOGENEOUS");
  assert.ok(withheldEverywhere(question));
  // The unanimous value appears in no cell. Band bounds elsewhere in the plan
  // are instrument configuration and describe nobody, so the search is scoped
  // to the cells rather than to the whole document.
  assert.doesNotMatch(JSON.stringify(plan.cells), /"100(\.\d)?"/);
  assert.equal(plan.summary.metricsReleased, 0);
});

test("D-A7 a recommendation cannot restate, imply or badge a protected value", () => {
  // The 10+2 dataset again, now with rules that WANT to speak about the
  // withheld department: one scoped to departments, one whose condition reads
  // the department metric, and one that would fire on the company result.
  const large = ["70", "72", "74", "76", "78", "80", "82", "84", "86", "88"];
  const small = ["30", "40"];
  const rule = (over: Partial<RecommendationRule>): RecommendationRule => ({
    id: randomUUID(),
    key: randomUUID(),
    target: { kind: "DIMENSION", dimensionId: DIMENSION_ID },
    groupScope: "DEPARTMENT",
    condition: {
      mode: "ALL",
      clauses: [
        {
          mode: "ALL",
          comparisons: [
            {
              metric: { kind: "DIMENSION", dimensionId: DIMENSION_ID },
              operator: "LT",
              value: "50",
              upper: null,
            },
          ],
        },
      ],
    },
    priority: 100,
    dedupKey: "risk",
    exclusivityGroup: null,
    title: label("خطر", "Risk"),
    body: label("النتيجة {score}.", "The score is {score}."),
    action: label("إجراء", "Action"),
    rationale: label("{metric} — {group}", "{metric} — {group}"),
    enabled: true,
    ...over,
  });
  const rules = [
    rule({}),
    rule({ dedupKey: "company-reads-department", groupScope: "COMPANY" }),
    rule({
      dedupKey: "company-ok",
      groupScope: "COMPANY",
      target: { kind: "OVERALL" },
      condition: {
        mode: "ALL",
        clauses: [
          {
            mode: "ALL",
            comparisons: [
              { metric: { kind: "OVERALL" }, operator: "GTE", value: "0", upper: null },
            ],
          },
        ],
      },
    }),
  ];
  const input = releaseInput(
    [
      ...large.map((v) => respondent(DEPT_A, v)),
      ...small.map((v) => respondent(DEPT_B, v)),
    ],
    5,
    rules,
  );
  const plan = buildReleasePlan(input);
  const instances = evaluateRecommendations({
    instrument: input.instrument,
    groups: plan.groups,
    metrics: plan.metrics,
    cells: plan.cells,
    companyGroupKey: plan.companyGroupKey,
  });
  // The department-scoped rule is silent because every department cell is
  // withheld; the company-scoped rule reading the DEPARTMENT metric is silent
  // for the same reason even though the company cell for that metric IS
  // published — the rule is evaluated in its own group only.
  assert.deepEqual(
    instances.map((i) => i.dedupKey),
    ["company-ok"],
  );
  const only = instances[0];
  assert.equal(only.groupKey, COMPANY);
  assert.equal(only.severity, cellFor(plan, COMPANY, OVERALL_METRIC_KEY).band!.severity);
  const serialized = JSON.stringify(instances);
  for (const secret of ["79", "35", "30", "40"])
    assert.doesNotMatch(
      serialized,
      new RegExp(`"?${secret}(\\.\\d)?"?[,"\\s.]`),
      `a recommendation leaks ${secret}`,
    );
  // Every number the surviving recommendation states is a published one.
  for (const item of only.evidence.items) {
    const cell = cellFor(plan, item.groupKey, item.metricKey);
    assert.equal(cell.status, "AVAILABLE");
    assert.equal(cell.value, item.value);
  }
  assert.ok(only.text.body.ar.includes(cellFor(plan, COMPANY, OVERALL_METRIC_KEY).value!));
});

test("D-A8 the count of recommendations does not describe a withheld metric", () => {
  // Same rule set, two datasets that differ ONLY in the protected department.
  // If the number, order or severity of recommendations changed with it, the
  // list itself would be a channel.
  const build = (small: string[]) => {
    const rules: RecommendationRule[] = [
      {
        id: uid(500),
        key: uid(501),
        target: { kind: "OVERALL" },
        groupScope: "COMPANY",
        condition: {
          mode: "ALL",
          clauses: [
            {
              mode: "ALL",
              comparisons: [
                { metric: { kind: "DIMENSION", dimensionId: DIMENSION_ID }, operator: "GTE", value: "0", upper: null },
              ],
            },
          ],
        },
        priority: 10,
        dedupKey: "watch",
        exclusivityGroup: null,
        title: label("متابعة", "Watch"),
        body: label("نص", "Body"),
        action: label("إجراء", "Action"),
        rationale: label("مسوّغ", "Rationale"),
        enabled: true,
      },
    ];
    const input = releaseInput(
      [
        ...["70", "72", "74", "76", "78"].map((v) => respondent(DEPT_A, v)),
        ...small.map((v) => respondent(DEPT_B, v)),
      ],
      5,
      rules,
    );
    const plan = buildReleasePlan(input);
    return {
      plan,
      instances: evaluateRecommendations({
        instrument: input.instrument,
        groups: plan.groups,
        metrics: plan.metrics,
        cells: plan.cells,
        companyGroupKey: plan.companyGroupKey,
      }),
    };
  };
  // Two withheld two-person departments with very different values.
  const low = build(["10", "12"]),
    high = build(["90", "92"]);
  assert.equal(low.instances.length, high.instances.length);
  assert.deepEqual(
    low.instances.map((i) => [i.dedupKey, i.groupKey, i.priority, i.severity]),
    high.instances.map((i) => [i.dedupKey, i.groupKey, i.priority, i.severity]),
  );
  // The company value legitimately differs — it is published in both — but no
  // department number appears in either.
  for (const secret of ["10", "12", "90", "92", "11.0", "91.0"])
    for (const side of [low, high])
      assert.doesNotMatch(
        JSON.stringify(side.instances),
        new RegExp(`"${secret}(\\.\\d)?"`),
        `${secret} leaked`,
      );
});

test("D-A9 strengths and weaknesses orient by direction and skip withheld metrics", () => {
  // Built directly rather than through a fixture, so the ranking is checked
  // against a known intent: a HIGH_RISK dimension at 90 is a concern, not a
  // strength, and a withheld dimension appears in neither list.
  const metric = (key: string, direction: MetricDefinition["direction"]): MetricDefinition => ({
    key,
    kind: "DIMENSION",
    label: label(key, key),
    description: label("", ""),
    direction,
    unit: "SCORE_0_100",
    order: 0,
    bands: [],
  });
  const cell = (key: string, value: string | null): SafeCell => ({
    groupKey: COMPANY,
    metricKey: key,
    status: value ? "AVAILABLE" : "SUPPRESSED",
    reasonCode: value ? null : "COMPLEMENTARY",
    contributorCount: value ? 9 : null,
    value,
    coverage: value ? "1" : null,
    distribution: null,
    band: null,
  });
  const ranked = rankDimensions({
    companyGroupKey: COMPANY,
    metrics: [
      metric("dimension:health", "HIGH_GOOD"),
      metric("dimension:burnout", "HIGH_RISK"),
      metric("dimension:hidden", "HIGH_GOOD"),
    ],
    cells: [
      cell("dimension:health", "90.0"),
      cell("dimension:burnout", "90.0"),
      cell("dimension:hidden", null),
    ],
  });
  assert.equal(ranked.strengths[0].metricKey, "dimension:health");
  assert.equal(ranked.weaknesses[0].metricKey, "dimension:burnout");
  for (const list of [ranked.strengths, ranked.weaknesses])
    assert.ok(!list.some((r) => r.metricKey === "dimension:hidden"));
});

// ===========================================================================
// PART B — the same attempts against the real pipeline and the staff API
// ===========================================================================

function answersFor(document: Instrument, seed: number) {
  const answers: Record<string, string | string[]> = {};
  for (const q of document.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    switch (q.type) {
      case "SHORT_TEXT":
      case "LONG_TEXT":
        answers[q.id] = `سر ${seed}`;
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

test("PostgreSQL Checkpoint D: reconstruction attempts against a real release", async (t) => {
  const f: Fixture = await respondentFixture(12);
  const core = new pg.Pool({
    connectionString: f.fixture.url("orgfit_processor"),
    max: 4,
  });
  const anon = new pg.Pool({
    connectionString: f.fixture.anonymousUrl("orgfit_processor"),
    max: 4,
  });
  const get = (path: string, query = "") =>
    new Request(`http://127.0.0.1:3000/api/v1/${path}${query}`);
  let roundId = "",
    campaignId = "",
    snapshotId = "";
  // The independently computed value of the protected two-person department.
  let protectedValue = "",
    companyValue = "";
  const views = ["", "/departments", "/questions", "/recommendations"];
  const read = async (suffix: string, query = "", org = f.orgA, round = roundId) => {
    const path = `organizations/${org}/assessments/${round}/results${suffix}`;
    const res = await withStaff(f.staff, (tx) =>
      resultsRoute(get(path, query), path, tx),
    );
    assert.ok(res);
    return { res, data: (await res.json()).data };
  };

  try {
    // ---------------------------------------------------------------------
    await t.test(
      "a ten-plus-two campaign releases the company only, and the small department is not solvable",
      async () => {
        // Ten people in one department and two in the other, assigned before
        // launch so the campaign roster freezes the asymmetry.
        for (const [index, person] of f.people.entries())
          await f.operator.query(
            "update core.participant set department_id=$1 where id=$2",
            [index < 10 ? f.departmentA : f.departmentB, person],
          );
        const launched = await f.launchedCampaign(f.people);
        roundId = launched.roundId;
        campaignId = launched.campaignId;
        const links = await f.issueLinks(campaignId);
        // Submission order is the participant order, so seeds 10 and 11 are
        // the two people in the small department.
        const documents: Instrument[] = [];
        for (let i = 0; i < links.length; i++) {
          const opened = await exchange(links[i].token);
          const document = (await instrument(opened.session!)).document;
          documents[i] = document;
          await finalize(opened.session!, { answers: answersFor(document, i) });
        }
        await f.closeCampaign(campaignId);
        assert.equal(
          (await processCampaign(core, anon, campaignId)).processedCount,
          12,
        );
        const outcome = await releaseCampaign(core, anon, campaignId);
        assert.equal(outcome.state, "PUBLISHED");
        snapshotId = outcome.snapshotId!;

        // Independent scoring: recompute every respondent's overall score with
        // the scoring engine directly, then form the two means the release must
        // and must not contain.
        const pin = { engineVersion: ENGINE_VERSION, configVersion: "checkpoint-d" };
        const overall = documents.map((document, i) => {
          const result = scoreInstrument(document, answersFor(document, i), pin);
          assert.equal(result.overall?.status, "VALID");
          // Six decimals is five orders finer than the published precision and
          // is what the processor itself persists.
          return N(result.overall!.normalized!.toFixed(6));
        });
        const mean = (values: typeof overall) =>
          values.reduce((a, b) => a.add(b), N("0")).div(N(String(values.length)));
        protectedValue = mean(overall.slice(10)).format(1);
        companyValue = mean(overall).format(1);
        const largeValue = mean(overall.slice(0, 10)).format(1);

        const { data } = await read("");
        const company = data.cells.find(
          (c: SafeCell) => c.metricKey === OVERALL_METRIC_KEY,
        );
        assert.equal(company.status, "AVAILABLE");
        // The published company value equals the contributor-weighted mean of
        // respondent-level scores computed by the scoring engine, not a mean of
        // department means.
        assert.equal(company.value, companyValue);
        assert.equal(company.contributorCount, 12);

        const departments = (await read("/departments")).data;
        for (const cell of departments.cells.filter(
          (c: SafeCell) => c.groupKey !== departments.companyGroupKey,
        ))
          assert.ok(
            withheldEverywhere(cell),
            `${cell.groupKey}/${cell.metricKey} is reachable`,
          );
        assert.deepEqual(departments.gaps, []);

        // The reconstruction attempt: search every staff-visible payload for
        // the protected department's value, the large department's value, and
        // the two group sizes.
        const payloads: string[] = [];
        for (const suffix of views) payloads.push(JSON.stringify((await read(suffix)).data));
        payloads.push(
          JSON.stringify(await withStaff(f.staff, (tx) => readSnapshot(tx, campaignId))),
        );
        for (const payload of payloads) {
          assert.doesNotMatch(
            payload,
            new RegExp(`"${protectedValue}"`),
            "the protected department value is reachable",
          );
          assert.doesNotMatch(
            payload,
            new RegExp(`"${largeValue}"`),
            "the complementary department value is reachable",
          );
          assert.doesNotMatch(payload, /"contributorCount":(2|10)\b/);
          // No respondent's free text survives either.
          assert.doesNotMatch(payload, /سر \d/);
        }
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "no alternate partition, slice or method is reachable through the API",
      async () => {
        const path = `organizations/${f.orgA}/assessments/${roundId}/results`;
        for (const query of [
          `?departmentId=${f.departmentB}`,
          "?groupBy=department",
          "?partition=gender",
          `?participantId=${f.people[11]}`,
          "?since=2026-01-01",
          "?threshold=2",
          "?minContributors=1",
          "?includeSuppressed=true",
          "?format=csv",
        ])
          assert.equal(
            await withStaff(f.staff, (tx) =>
              failure(() => resultsRoute(get(path, query), path, tx)),
            ),
            "UNSUPPORTED_FILTER",
            `${query} must be refused`,
          );
        // Undefined views and deeper paths are not routes at all.
        for (const suffix of [
          "/departments/questions",
          "/raw",
          "/export",
          "/candidates",
          "/recommendations/all",
        ]) {
          const target = `${path}${suffix}`;
          assert.equal(
            await withStaff(f.staff, (tx) =>
              failure(async () => {
                const res = await resultsRoute(get(target), target, tx);
                if (!res) throw new Error("NO_ROUTE");
                return res;
              }),
            ),
            suffix === "/departments/questions" || suffix === "/recommendations/all"
              ? "NO_ROUTE"
              : "NOT_FOUND",
            suffix,
          );
        }
        // The results surface is read-only: a write method is not a route.
        for (const method of ["POST", "PUT", "PATCH", "DELETE"])
          assert.equal(
            await withStaff(f.staff, (tx) =>
              failure(() =>
                resultsRoute(
                  new Request(`http://127.0.0.1:3000/api/v1/${path}`, { method }),
                  path,
                  tx,
                ),
              ),
            ),
            "NOT_FOUND",
            method,
          );
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "successive snapshots cannot be obtained for the same campaign",
      async () => {
        // A repeated run of the real job returns the same release.
        const again = await releaseCampaign(core, anon, campaignId);
        assert.equal(again.state, "REUSED");
        assert.equal(again.snapshotId, snapshotId);
        // A DIFFERENT plan for the same campaign is refused outright, so a
        // second release cannot be differenced against the first.
        const tampered = releasePayload(
          f.orgA,
          campaignId,
          randomUUID(),
          "00".repeat(32),
          {
            threshold: 5,
            companyGroupKey: COMPANY,
            contributorCount: 12,
            groups: [
              { key: COMPANY, kind: "COMPANY", label: label("الشركة", "Company"), order: 0 },
            ],
            metrics: [],
            cells: [],
            summary: {
              disclosureVersion: "1.0.0",
              partition: "COMPANY_PLUS_FLAT_DEPARTMENTS",
              metricsReleased: 0,
              metricsWithheld: 0,
              departmentPartitionsReleased: 0,
            },
          },
        );
        assert.match(
          await core
            .query("select publication.publish_release($1::jsonb)", [
              JSON.stringify(tampered),
            ])
            .then(() => "NO_ERROR")
            .catch((e: Error) => e.message),
          /RELEASE_ALREADY_PUBLISHED/,
        );
        // Only one snapshot exists, and it is the published one.
        const rows = await f.operator.query(
          "select state, count(*)::int n from publication.result_snapshot where campaign_id=$1 group by state",
          [campaignId],
        );
        assert.deepEqual(rows.rows, [{ state: "PUBLISHED", n: 1 }]);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "a candidate or revoked release is invisible, and staff cannot read publication storage",
      async () => {
        // A hand-written CANDIDATE snapshot for another campaign of the same
        // organization must never appear on the staff surface.
        const other = await f.launchedCampaign(f.people.slice(0, 6));
        await f.operator.query(
          `insert into publication.result_snapshot(organization_id,campaign_id,round_id,release_revision,state,
             instrument_version_id,scoring_version,privacy_version,threshold,batch_id,contributor_count,
             closed_period,report_manifest,content_hash,review_reference)
           select $1,$2,$3,1,'CANDIDATE',c.version_id,$4,c.privacy_policy_version,5,gen_random_uuid(),9,
             '{}'::jsonb,'{}'::jsonb,sha256('candidate'),'checkpoint d probe'
           from core.campaign c where c.id=$2`,
          [f.orgA, other.campaignId, other.roundId, ENGINE_VERSION],
        );
        const snapshot = await withStaff(f.staff, (tx) =>
          readSnapshot(tx, other.campaignId),
        );
        assert.equal(snapshot.available, false);
        assert.equal(
          await withStaff(f.staff, (tx) =>
            failure(() =>
              resultsRoute(
                get(`organizations/${f.orgA}/assessments/${other.roundId}/results`),
                `organizations/${f.orgA}/assessments/${other.roundId}/results`,
                tx,
              ),
            ),
          ),
          "RESULTS_NOT_READY",
        );
        // And no staff statement can reach the tables or the anonymous store.
        for (const statement of [
          "select * from publication.aggregate_cell",
          "select * from publication.recommendation_instance",
          "select * from publication.result_snapshot",
          "select * from core.recommendation_action",
          "select publication.publish_release('{}'::jsonb)",
          "select publication.check_recommendations('{}'::jsonb)",
        ]) {
          const denial = await withStaff(f.staff, async (tx) => {
            try {
              await sql.raw(statement).execute(tx);
              return "ALLOWED";
            } catch (e) {
              return (e as Error).message;
            }
          });
          assert.match(denial, /permission denied/, statement);
        }
        const client = new pg.Client({
          connectionString: f.fixture.anonymousUrl("orgfit_staff"),
        });
        await assert.rejects(client.connect(), /permission denied|not permitted/);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "recommendations disclose nothing the cells do not, and their actions add no channel",
      async () => {
        const { data } = await read("/recommendations");
        assert.ok(Array.isArray(data.items));
        assert.ok(protectedValue && companyValue, "the release did not produce values to search for");
        // CD-002 regression: one published number has one representation. The
        // value a recommendation froze must be the exact string the results
        // view serves for the same cell, or a reader sees "60" in one place
        // and "60.0" in another for the same disclosure.
        const overviewCells = (await read("")).data.cells as SafeCell[];
        for (const item of data.items)
          for (const e of item.evidence.items) {
            const shown = overviewCells.find(
              (c) => c.metricKey === e.metricKey && c.groupKey === e.groupKey,
            );
            if (shown)
              assert.equal(
                e.value,
                shown.value,
                `${e.metricKey} is shown as ${shown.value} and cited as ${e.value}`,
              );
          }
        for (const item of data.items) {
          // Every cited metric is an AVAILABLE cell of this snapshot and this
          // group, checked against storage rather than against the payload.
          for (const e of item.evidence.items) {
            assert.equal(e.groupKey, item.groupKey);
            const cell = await f.operator.query(
              "select status,(value=$4::numeric) matches from publication.aggregate_cell where snapshot_id=$1 and group_key=$2 and metric_key=$3",
              [snapshotId, e.groupKey, e.metricKey, e.value],
            );
            assert.equal(cell.rows[0].status, "AVAILABLE");
            assert.equal(cell.rows[0].matches, true);
          }
          assert.doesNotMatch(JSON.stringify(item), literal(protectedValue));
        }
        // A recommendation for the protected department does not exist at all.
        const departmentGroups = (await read("/departments")).data.groups.map(
          (g: { key: string }) => g.key,
        );
        assert.ok(
          !data.items.some((i: { groupKey: string }) =>
            departmentGroups.includes(i.groupKey),
          ),
          "a department recommendation exists while every department cell is withheld",
        );
        // The action record is staff workflow and cannot become a channel: it
        // carries no metric value and cannot be attached to anything else.
        if (data.items.length) {
          const target = data.items[0].id;
          const path = `organizations/${f.orgA}/recommendation-actions/${target}`;
          const patch = (body: Record<string, unknown>, org = f.orgA) => {
            const url = `organizations/${org}/recommendation-actions/${target}`;
            return withStaff(f.staff, (tx) =>
              recommendationActionRoute(
                new Request(`http://127.0.0.1:3000/api/v1/${url}`, {
                  method: "PATCH",
                  headers: {
                    "content-type": "application/json",
                    "idempotency-key": randomUUID(),
                  },
                  body: JSON.stringify(body),
                }),
                url,
                tx,
              ),
            );
          };
          assert.equal((await patch({ status: "OPEN" }))?.status, 200);
          // Another organization cannot address this instance.
          assert.equal(await failure(() => patch({ status: "OPEN" }, f.orgB)), "NOT_FOUND");
          // The stored action holds no result value.
          const stored = await f.operator.query(
            "select * from core.recommendation_action where instance_id=$1",
            [target],
          );
          assert.doesNotMatch(
            JSON.stringify(stored.rows[0]),
            literal(`${protectedValue}|${companyValue}`),
          );
          assert.ok(path.includes(target));
        }
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "the release is frozen: renaming the directory does not rewrite it",
      async () => {
        const before = (await read("/departments")).data.groups;
        await f.operator.query(
          "update core.department set name_ar=$1, revision=revision+1 where id=$2",
          ["اسم جديد بعد النشر", f.departmentA],
        );
        const after = (await read("/departments")).data.groups;
        assert.deepEqual(after, before);
        assert.ok(
          !JSON.stringify(after).includes("اسم جديد بعد النشر"),
          "a live directory rename rewrote a published label",
        );
      },
    );

    // ---------------------------------------------------------------------
    await t.test("every result response forbids caching", async () => {
      for (const suffix of views) {
        const { res } = await read(suffix);
        assert.equal(res.headers.get("cache-control"), "no-store", suffix);
      }
    });

    // ---------------------------------------------------------------------
    await t.test("another organization reaches none of it", async () => {
      for (const suffix of views) {
        const path = `organizations/${f.orgB}/assessments/${roundId}/results${suffix}`;
        assert.equal(
          await withStaff(f.staff, (tx) =>
            failure(() => resultsRoute(get(path), path, tx)),
          ),
          "NOT_FOUND",
          suffix,
        );
      }
    });
  } finally {
    await core.end();
    await anon.end();
    await f.close();
  }
});
