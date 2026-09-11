import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReleasePlan,
  validateReleasePlan,
  rankDimensions,
  DisclosureError,
  OVERALL_METRIC_KEY,
  type SafeCell,
} from "../src/disclosure";
import {
  CHECKBOX_OPTIONS,
  CHECKBOX_KEY,
  CHOICE_OPTIONS,
  CHOICE_KEY,
  COMPANY,
  DEPT_A,
  DEPT_B,
  DIMENSION_KEY,
  NUMBER_KEY,
  TEXT_KEY,
  cellOf,
  releaseInput,
  respondent,
} from "./publication-fixtures";

const DIMENSION = `dimension:${DIMENSION_KEY}`;
const CHOICE = `question:${CHOICE_KEY}`;
const CHECKBOX = `question:${CHECKBOX_KEY}`;
const NUMBER = `question:${NUMBER_KEY}`;
const TEXT = `question:${TEXT_KEY}`;
const spread = (count: number, group: string, from = 40) =>
  Array.from({ length: count }, (_, i) =>
    respondent(group, String(from + i)),
  );
const failure = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof DisclosureError ? e.code : (e as Error).message;
  }
  return "NO_ERROR";
};

test("threshold: four contributors release nothing, five release a company result", () => {
  assert.equal(
    failure(() => buildReleasePlan(releaseInput(spread(4, DEPT_A)))),
    "BELOW_THRESHOLD",
  );
  const plan = buildReleasePlan(releaseInput(spread(5, DEPT_A)));
  const company = cellOf(plan, COMPANY, DIMENSION);
  assert.equal(company.status, "AVAILABLE");
  assert.equal(company.contributorCount, 5);
  // 40..44 averages 42.
  assert.equal(company.value, "42.0");
});

test("a sparse metric inside a large campaign is withheld on its own count", () => {
  // Twenty accepted responses; only four of them produced a valid dimension
  // score. The campaign total does not qualify the metric.
  const responses = [
    ...spread(4, DEPT_A),
    ...Array.from({ length: 16 }, () => respondent(DEPT_B, null)),
  ];
  const plan = buildReleasePlan(releaseInput(responses));
  const company = cellOf(plan, COMPANY, DIMENSION);
  assert.equal(company.status, "INSUFFICIENT");
  assert.equal(company.reasonCode, "BELOW_THRESHOLD");
  assert.equal(company.value, null);
  assert.equal(company.contributorCount, null);
  assert.equal(plan.contributorCount, 20);
});

test("ten plus two: a small department forces a company-only release", () => {
  const plan = buildReleasePlan(
    releaseInput([...spread(10, DEPT_A, 40), ...spread(2, DEPT_B, 90)]),
  );
  assert.equal(cellOf(plan, COMPANY, DIMENSION).status, "AVAILABLE");
  for (const group of [DEPT_A, DEPT_B]) {
    const cell = cellOf(plan, group, DIMENSION);
    assert.equal(cell.status, "SUPPRESSED");
    assert.equal(cell.reasonCode, "COMPLEMENTARY");
    assert.equal(cell.value, null);
    assert.equal(cell.contributorCount, null);
  }
  // The department of ten is withheld too: with the company mean published, its
  // value plus the counts would recover the department of two.
  assert.equal(plan.summary.departmentPartitionsReleased, 0);
});

test("a balanced partition is released, and the company mean weights respondents", () => {
  // Ten respondents at 80 and twenty at 50. The company value is 60, the
  // contributor-weighted mean, not 65, the unweighted mean of the two groups.
  const responses = [
    ...Array.from({ length: 10 }, (_, i) =>
      respondent(DEPT_A, i === 0 ? "80.5" : "79.9444"),
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      respondent(DEPT_B, i === 0 ? "51" : "49.947368"),
    ),
  ];
  const plan = buildReleasePlan(releaseInput(responses));
  assert.equal(cellOf(plan, COMPANY, DIMENSION).value, "60.0");
  assert.equal(cellOf(plan, DEPT_A, DIMENSION).value, "80.0");
  assert.equal(cellOf(plan, DEPT_B, DIMENSION).value, "50.0");
  assert.equal(cellOf(plan, DEPT_A, DIMENSION).contributorCount, 10);
  assert.equal(plan.summary.departmentPartitionsReleased, 2);
});

test("a homogeneous metric is withheld: its mean would republish every answer", () => {
  const plan = buildReleasePlan(
    releaseInput(Array.from({ length: 8 }, () => respondent(DEPT_A, "100"))),
  );
  for (const key of [DIMENSION, OVERALL_METRIC_KEY]) {
    const cell = cellOf(plan, COMPANY, key);
    assert.equal(cell.status, "SUPPRESSED");
    assert.equal(cell.reasonCode, "HOMOGENEOUS");
    assert.equal(cell.value, null);
  }
});

test("an empty department is an absence, not a withheld value", () => {
  const plan = buildReleasePlan(releaseInput(spread(8, DEPT_A)));
  assert.equal(cellOf(plan, DEPT_A, DIMENSION).status, "AVAILABLE");
  const empty = cellOf(plan, DEPT_B, DIMENSION);
  assert.equal(empty.status, "UNSCORED");
  assert.equal(empty.reasonCode, "NO_VALID_SCORE");
  assert.equal(empty.contributorCount, null);
});

test("a rare option bin withholds the whole distribution, not just its bar", () => {
  const choose = (option: string) => ({
    [CHOICE_KEY]: { type: "OPTION" as const, optionId: option },
  });
  const responses = [
    ...Array.from({ length: 10 }, () =>
      respondent(DEPT_A, "60", choose(CHOICE_OPTIONS[0])),
    ),
    ...Array.from({ length: 2 }, () =>
      respondent(DEPT_A, "61", choose(CHOICE_OPTIONS[1])),
    ),
  ];
  const cell = cellOf(buildReleasePlan(releaseInput(responses)), COMPANY, CHOICE);
  assert.equal(cell.status, "SUPPRESSED");
  assert.equal(cell.reasonCode, "SPARSE_BIN");
  // The complementary total goes with it: publishing "ten chose the first"
  // beside a contributor count of twelve is the same disclosure.
  assert.equal(cell.distribution, null);
  assert.equal(cell.contributorCount, null);
});

test("every contributor in one bin is a homogeneous disclosure", () => {
  const responses = Array.from({ length: 9 }, (_, i) =>
    respondent(DEPT_A, String(50 + i), {
      [CHOICE_KEY]: { type: "OPTION", optionId: CHOICE_OPTIONS[0] },
    }),
  );
  const cell = cellOf(buildReleasePlan(releaseInput(responses)), COMPANY, CHOICE);
  assert.equal(cell.status, "SUPPRESSED");
  assert.equal(cell.reasonCode, "HOMOGENEOUS");
});

test("checkbox bins count respondents, never total selections", () => {
  const pick = (a: number, b: number) => ({
    [CHECKBOX_KEY]: {
      type: "OPTION_SET" as const,
      optionIds: [CHECKBOX_OPTIONS[a], CHECKBOX_OPTIONS[b]],
    },
  });
  const responses = [
    ...Array.from({ length: 5 }, (_, i) => respondent(DEPT_A, String(50 + i), pick(0, 1))),
    ...Array.from({ length: 5 }, (_, i) => respondent(DEPT_A, String(60 + i), pick(1, 2))),
    ...Array.from({ length: 5 }, (_, i) => respondent(DEPT_A, String(70 + i), pick(0, 2))),
  ];
  const cell = cellOf(
    buildReleasePlan(releaseInput(responses)),
    COMPANY,
    CHECKBOX,
  );
  assert.equal(cell.status, "AVAILABLE");
  const distribution = cell.distribution as {
    total: number;
    bins: { count: number; share: string }[];
  };
  // Fifteen respondents made thirty selections. The denominator is people.
  assert.equal(distribution.total, 15);
  assert.deepEqual(
    distribution.bins.map((b) => b.count),
    [10, 10, 10],
  );
  assert.deepEqual(
    distribution.bins.map((b) => b.share),
    ["0.667", "0.667", "0.667"],
  );
});

test("missing answers are missing, not zero, and free text is never a value", () => {
  const responses = [
    ...Array.from({ length: 5 }, (_, i) =>
      respondent(DEPT_A, String(50 + i), {
        [NUMBER_KEY]: { type: "NUMBER", value: String(10 + i) },
        [TEXT_KEY]: { type: "TEXT", value: "أنا المدير الوحيد في القسم" },
      }),
    ),
    // Seven respondents skipped the optional number. They must not be averaged
    // in as zeros, which would drag a mean of 12 down to 5.
    ...Array.from({ length: 7 }, (_, i) => respondent(DEPT_A, String(60 + i))),
  ];
  const plan = buildReleasePlan(releaseInput(responses));
  const number = cellOf(plan, COMPANY, NUMBER);
  assert.equal(number.status, "AVAILABLE");
  assert.equal(number.contributorCount, 5);
  assert.equal(number.value, "12.00");
  assert.equal(number.coverage, "0.417");
  const text = cellOf(plan, COMPANY, TEXT);
  assert.equal(text.status, "SUPPRESSED");
  assert.equal(text.reasonCode, "RAW_WITHHELD");
  assert.doesNotMatch(JSON.stringify(plan), /المدير الوحيد/);
});

test("no withheld cell carries a value anywhere in the serialized plan", () => {
  // A department of two whose members all sit at 93.5: if any part of the
  // pipeline kept a companion value, this is where it would surface.
  const responses = [
    ...spread(10, DEPT_A, 40),
    respondent(DEPT_B, "93.5"),
    respondent(DEPT_B, "93.5"),
  ];
  const plan = buildReleasePlan(releaseInput(responses));
  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(serialized, /93\.5/);
  for (const cell of plan.cells as SafeCell[])
    if (cell.status !== "AVAILABLE")
      assert.deepEqual(
        {
          value: cell.value,
          contributorCount: cell.contributorCount,
          coverage: cell.coverage,
          distribution: cell.distribution,
          band: cell.band,
        },
        {
          value: null,
          contributorCount: null,
          coverage: null,
          distribution: null,
          band: null,
        },
        `${cell.metricKey} in ${cell.groupKey} leaks a protected field`,
      );
});

test("plan generation is deterministic and repeatable", () => {
  const responses = [...spread(10, DEPT_A, 40), ...spread(10, DEPT_B, 30)];
  assert.deepEqual(
    buildReleasePlan(releaseInput(responses)),
    buildReleasePlan(releaseInput([...responses].reverse())),
  );
});

test("bands are classified from the released value and never from a hidden one", () => {
  const plan = buildReleasePlan(releaseInput(spread(6, DEPT_A, 70)));
  const cell = cellOf(plan, COMPANY, DIMENSION);
  assert.equal((cell.band as { severity: string }).severity, "NONE");
  const low = buildReleasePlan(releaseInput(spread(6, DEPT_A, 10)));
  assert.equal(
    (cellOf(low, COMPANY, DIMENSION).band as { semantic: string }).semantic,
    "RISK",
  );
  assert.equal(cellOf(low, COMPANY, TEXT).band, null);
});

test("whole-plan validation rejects tampered cells and partial partitions", () => {
  const base = buildReleasePlan(
    releaseInput([...spread(10, DEPT_A, 40), ...spread(10, DEPT_B, 30)]),
  );
  const mutate = (fn: (cells: SafeCell[]) => void) => {
    const copy = structuredClone(base);
    fn(copy.cells);
    return failure(() => validateReleasePlan(copy));
  };
  assert.equal(
    mutate((cells) => {
      const cell = cells.find(
        (c) => c.metricKey === TEXT && c.groupKey === COMPANY,
      )!;
      cell.value = "77.0";
    }),
    "PLAN_WITHHELD_CELL_CARRIES_VALUE",
  );
  assert.equal(
    mutate((cells) => {
      const cell = cells.find(
        (c) => c.metricKey === DIMENSION && c.groupKey === DEPT_B,
      )!;
      Object.assign(cell, {
        status: "SUPPRESSED",
        reasonCode: "COMPLEMENTARY",
        value: null,
        contributorCount: null,
        coverage: null,
        band: null,
      });
    }),
    "PLAN_PARTIAL_PARTITION",
  );
  assert.equal(
    mutate((cells) => {
      const cell = cells.find(
        (c) => c.metricKey === DIMENSION && c.groupKey === COMPANY,
      )!;
      Object.assign(cell, {
        status: "SUPPRESSED",
        reasonCode: "HOMOGENEOUS",
        value: null,
        contributorCount: null,
        coverage: null,
        band: null,
      });
    }),
    "PLAN_PARTITION_WITHOUT_COMPANY",
  );
  assert.equal(
    mutate((cells) => {
      cells.find((c) => c.status === "AVAILABLE")!.contributorCount = 4;
    }),
    "PLAN_BELOW_THRESHOLD",
  );
  assert.equal(
    mutate((cells) => {
      const cell = cells.find(
        (c) => c.metricKey === DIMENSION && c.groupKey === COMPANY,
      )!;
      cell.reasonCode = "COMPLEMENTARY";
    }),
    "PLAN_REASON_ON_AVAILABLE",
  );
});

test("a configured threshold above five is honoured, and five is a floor", () => {
  // Nine accepted, seven of them scored: enough for a threshold of five and not
  // for a configured eight.
  const responses = [
    ...spread(7, DEPT_A),
    respondent(DEPT_A, null),
    respondent(DEPT_A, null),
  ];
  assert.equal(
    cellOf(buildReleasePlan(releaseInput(responses, 5)), COMPANY, DIMENSION)
      .status,
    "AVAILABLE",
  );
  const strict = cellOf(
    buildReleasePlan(releaseInput(responses, 8)),
    COMPANY,
    DIMENSION,
  );
  assert.equal(strict.status, "INSUFFICIENT");
  assert.equal(strict.value, null);
  // A campaign whose accepted total is under the configured threshold produces
  // no plan at all rather than a plan of withheld cells.
  assert.equal(
    failure(() => buildReleasePlan(releaseInput(spread(7, DEPT_A), 8))),
    "BELOW_THRESHOLD",
  );
  // A configuration attempting a weaker threshold is raised to the floor.
  assert.equal(buildReleasePlan(releaseInput(responses, 2)).threshold, 5);
});

test("ranking uses released cells only and orients by direction", () => {
  const plan = buildReleasePlan(releaseInput(spread(6, DEPT_A, 70)));
  const { strengths, weaknesses } = rankDimensions(plan);
  assert.deepEqual(
    strengths.map((s) => s.metricKey),
    [DIMENSION],
  );
  // One released dimension is a strength and nothing else.
  assert.equal(weaknesses.length, 0);
  const hidden = buildReleasePlan(
    releaseInput(Array.from({ length: 6 }, () => respondent(DEPT_A, "100"))),
  );
  assert.deepEqual(rankDimensions(hidden), { strengths: [], weaknesses: [] });
});
