import test from "node:test";
import assert from "node:assert/strict";
import { buildReleasePlan, OVERALL_METRIC_KEY, type SafeCell } from "../src/disclosure";
import {
  compareSnapshots,
  equivalent,
  metricSemantics,
  proposeMapping,
  trendSeries,
  type ComparisonSide,
  type ComparisonResult,
} from "../src/comparison";
import type { Instrument } from "../src/instrument-input";
import {
  COMPANY,
  DEPT_A,
  DEPT_B,
  DIMENSION_ID,
  DIMENSION_KEY,
  groups,
  instrumentFixture,
  respondent,
  t,
} from "./publication-fixtures";

// Historical comparison, tested where the judgement lives: what counts as the
// same measurement, and what a delta may be computed from. No respondent is
// joined across rounds anywhere in this file, because nothing in the module can
// do it — both sides are released aggregates and two pinned definitions.

const DIMENSION_METRIC = `dimension:${DIMENSION_KEY}`;

// A scored instrument whose dimension key matches the release fixtures, so the
// fingerprints and the published metric keys line up.
function scored(
  patch: {
    weight?: string;
    reverse?: boolean;
    direction?: "HIGH_GOOD" | "HIGH_RISK";
    coverage?: string;
    optionScore?: string;
    translationsOnly?: boolean;
  } = {},
): Instrument {
  const d = instrumentFixture();
  const q = d.sections[0].questions[0];
  q.dimensionId = DIMENSION_ID;
  q.scoring = {
    enabled: true,
    reverse: patch.reverse ?? false,
    weight: patch.weight ?? "1",
    mode: "VALUE",
  };
  if (patch.optionScore) q.options[0].score = patch.optionScore;
  if (patch.coverage) d.dimensions[0].coverage = patch.coverage;
  if (patch.direction) {
    d.dimensions[0].direction = patch.direction;
    d.overall.direction = patch.direction;
  }
  if (patch.translationsOnly) {
    // Text in every translated field, and nothing else, is different.
    d.title = t("عنوان جديد", "New title");
    d.dimensions[0].name = t("الرضا الوظيفي", "Job satisfaction");
    d.dimensions[0].description = t("وصف محدث", "Updated description");
    q.prompt = t("صيغة جديدة للسؤال", "Reworded question");
    q.options[0].label = t("خيار محرر", "Edited option");
  }
  return d;
}

const lineage = {
  [COMPANY]: null,
  [DEPT_A]: "department-a",
  [DEPT_B]: "department-b",
};
function sideOf(
  values: { group: string; value: string }[],
  instrument: Instrument,
  overrides: Partial<ComparisonSide> = {},
): ComparisonSide {
  // The released plan is built from the SAME instrument the fingerprints are
  // taken from, so a direction or scoring change is reflected in both.
  const plan = buildReleasePlan({
    threshold: 5,
    instrument,
    groups,
    responses: values.map((v) => respondent(v.group, v.value)),
  });
  return {
    roundId: "round",
    campaignId: "campaign",
    snapshotId: "snapshot",
    label: "جولة",
    periodStart: "2026-01-01",
    periodEnd: null,
    threshold: plan.threshold,
    contributorCount: plan.contributorCount,
    instrument,
    metrics: plan.metrics,
    groups: plan.groups,
    cells: plan.cells,
    lineage,
    ...overrides,
  };
}
// Five people either side of a mean, so no metric is homogeneous.
const around = (mean: number, group = DEPT_A, count = 6) =>
  Array.from({ length: count }, (_, i) => ({
    group,
    value: String(mean - 2 + (i % 4)),
  }));
const meanOf = (values: { value: string }[]) =>
  values.reduce((sum, v) => sum + Number(v.value), 0) / values.length;
const cellOf = (result: ComparisonResult, metric: string, group = COMPANY) =>
  result.cells.find((c) => c.metricKey === metric && c.groupKey === group)!;

test("a translation-only revision is equivalent; a changed measurement is not", () => {
  const base = scored();
  assert.ok(
    equivalent(base, scored({ translationsOnly: true }), {
      leftKey: DIMENSION_METRIC,
      rightKey: DIMENSION_METRIC,
    }),
    "rewording a question must not break the measurement",
  );
  // Everything that changes the number breaks equivalence, including changes
  // that keep every stable key exactly as it was.
  for (const patch of [
    { weight: "2" },
    { reverse: true },
    { optionScore: "5" },
    { coverage: "1" },
    { direction: "HIGH_RISK" as const },
  ])
    assert.equal(
      equivalent(base, scored(patch), {
        leftKey: DIMENSION_METRIC,
        rightKey: DIMENSION_METRIC,
      }),
      false,
      `${JSON.stringify(patch)} must not be equivalent`,
    );
  // The keys are identical in every one of those cases: a stable key alone is
  // never evidence of equivalence.
  assert.equal(
    metricSemantics(base).get(DIMENSION_METRIC)!.key,
    metricSemantics(scored({ weight: "2" })).get(DIMENSION_METRIC)!.key,
  );
});

test("the proposal reports what changed and never decides equivalence itself", () => {
  const translated = proposeMapping(scored(), scored({ translationsOnly: true }));
  assert.equal(translated.suggestion, "REVIEWED_EQUIVALENT");
  assert.ok(translated.pairs.every((p) => p.equivalent));
  assert.deepEqual([translated.added, translated.removed], [[], []]);

  const changed = proposeMapping(scored(), scored({ weight: "3" }));
  assert.equal(changed.suggestion, "NOT_COMPARABLE");
  assert.deepEqual(
    changed.pairs.filter((p) => !p.equivalent).map((p) => p.rightKey).sort(),
    [DIMENSION_METRIC, OVERALL_METRIC_KEY].sort(),
    "a changed item invalidates its dimension and the overall score above it",
  );

  // A removed dimension has no counterpart at all.
  const dropped = scored();
  dropped.dimensions = [];
  dropped.overall.enabled = false;
  const removal = proposeMapping(scored(), dropped);
  assert.deepEqual(removal.removed.sort(), [DIMENSION_METRIC, OVERALL_METRIC_KEY].sort());
  assert.deepEqual(removal.pairs, []);
});

test("a comparable pair yields a point change, a percentage and a direction-aware improvement", () => {
  const earlier = around(60),
    later = around(70);
  const result = compareSnapshots({
    classification: "IDENTICAL",
    pairs: [{ leftKey: DIMENSION_METRIC, rightKey: DIMENSION_METRIC }],
    left: sideOf(earlier, scored()),
    right: sideOf(later, scored()),
  });
  const cell = cellOf(result, DIMENSION_METRIC);
  assert.equal(cell.status, "COMPARABLE");
  assert.equal(cell.left!.value, meanOf(earlier).toFixed(1));
  assert.equal(cell.right!.value, meanOf(later).toFixed(1));
  assert.equal(cell.pointChange, "10.0");
  assert.equal(cell.improvement, "10.0");
  assert.equal(cell.improved, true);
  // The baseline is the mean of the six earlier values, not the round number
  // it was built around.
  assert.equal(cell.percentChange, ((10 / meanOf(earlier)) * 100).toFixed(1));
  assert.equal(result.comparable, true);
});

test("direction decides what improvement means", () => {
  // The same ten-point rise, on a HIGH_RISK metric, is a deterioration.
  const risk = scored({ direction: "HIGH_RISK" });
  const result = compareSnapshots({
    classification: "IDENTICAL",
    pairs: [{ leftKey: DIMENSION_METRIC, rightKey: DIMENSION_METRIC }],
    left: sideOf(around(60), risk),
    right: sideOf(around(70), risk),
  });
  const cell = cellOf(result, DIMENSION_METRIC);
  assert.equal(cell.direction, "HIGH_RISK");
  assert.equal(cell.pointChange, "10.0");
  assert.equal(cell.improvement, "-10.0");
  assert.equal(cell.improved, false);
  // And a fall on the same metric is an improvement.
  const better = compareSnapshots({
    classification: "IDENTICAL",
    pairs: [{ leftKey: DIMENSION_METRIC, rightKey: DIMENSION_METRIC }],
    left: sideOf(around(70), risk),
    right: sideOf(around(60), risk),
  });
  assert.equal(cellOf(better, DIMENSION_METRIC).improvement, "10.0");
  assert.equal(cellOf(better, DIMENSION_METRIC).improved, true);
});

test("a zero baseline has no percentage change, and no value is invented", () => {
  // Hand-built, because the disclosure engine cannot publish a company mean of
  // zero: every contributor would have to answer identically, which is a
  // homogeneous disclosure and is withheld.
  const zero: SafeCell = {
    groupKey: COMPANY,
    metricKey: DIMENSION_METRIC,
    status: "AVAILABLE",
    reasonCode: null,
    contributorCount: 8,
    value: "0.0",
    coverage: "1",
    distribution: null,
    band: null,
  };
  const left = sideOf(around(60), scored());
  const result = compareSnapshots({
    classification: "IDENTICAL",
    pairs: [{ leftKey: DIMENSION_METRIC, rightKey: DIMENSION_METRIC }],
    left: {
      ...left,
      cells: [
        zero,
        ...left.cells.filter(
          (c) => !(c.groupKey === COMPANY && c.metricKey === DIMENSION_METRIC),
        ),
      ],
    },
    right: sideOf(around(70), scored()),
  });
  const cell = cellOf(result, DIMENSION_METRIC);
  assert.equal(cell.left!.value, "0.0");
  assert.equal(cell.percentChange, null);
  assert.match(cell.pointChange!, /^\d+\.\d$/);
});

test("a withheld or missing point stays a gap on either side", () => {
  // Ten and two: the department partition is withheld, so no department delta
  // can exist even though both company results are published.
  const skewed = [...around(60, DEPT_A, 10), ...around(30, DEPT_B, 2)];
  const result = compareSnapshots({
    classification: "IDENTICAL",
    pairs: [{ leftKey: DIMENSION_METRIC, rightKey: DIMENSION_METRIC }],
    left: sideOf(skewed, scored()),
    right: sideOf([...around(65, DEPT_A, 10), ...around(35, DEPT_B, 2)], scored()),
  });
  for (const group of [DEPT_A, DEPT_B]) {
    const cell = cellOf(result, DIMENSION_METRIC, group);
    assert.equal(cell.status, "GAP");
    assert.equal(cell.reasonCode, "BOTH_WITHHELD");
    assert.deepEqual(
      [cell.pointChange, cell.percentChange, cell.improvement, cell.improved],
      [null, null, null, null],
    );
  }
  assert.equal(cellOf(result, DIMENSION_METRIC).status, "COMPARABLE");
  // A one-sided gap is reported as one-sided, not silently dropped.
  const oneSided = compareSnapshots({
    classification: "IDENTICAL",
    pairs: [{ leftKey: DIMENSION_METRIC, rightKey: DIMENSION_METRIC }],
    left: sideOf([...around(60, DEPT_A, 6), ...around(50, DEPT_B, 6)], scored()),
    right: sideOf(skewed, scored()),
  });
  assert.equal(cellOf(oneSided, DIMENSION_METRIC, DEPT_A).reasonCode, "LATER_WITHHELD");
});

test("a stored review cannot manufacture a delta the definitions do not support", () => {
  // The review says REVIEWED_EQUIVALENT, but the item weight changed. The read
  // path re-verifies from the pinned instruments and refuses the number.
  const result = compareSnapshots({
    classification: "REVIEWED_EQUIVALENT",
    pairs: [{ leftKey: DIMENSION_METRIC, rightKey: DIMENSION_METRIC }],
    left: sideOf(around(60), scored()),
    right: sideOf(around(70), scored({ weight: "4" })),
  });
  const cell = cellOf(result, DIMENSION_METRIC);
  assert.equal(cell.status, "NOT_COMPARABLE");
  assert.equal(cell.reasonCode, "MEASUREMENT_CHANGED");
  assert.equal(cell.pointChange, null);
  assert.equal(result.comparable, false);
  // Both released values are still shown side by side; only the delta is refused.
  assert.ok(cell.left!.value && cell.right!.value);
});

test("a NOT_COMPARABLE review documents the rounds and computes nothing", () => {
  const result = compareSnapshots({
    classification: "NOT_COMPARABLE",
    pairs: [{ leftKey: DIMENSION_METRIC, rightKey: DIMENSION_METRIC }],
    left: sideOf(around(60), scored()),
    right: sideOf(around(70), scored({ weight: "2" })),
  });
  assert.equal(result.comparable, false);
  assert.ok(result.cells.every((c) => c.status === "NOT_COMPARABLE"));
  assert.ok(result.cells.every((c) => c.pointChange === null && c.improvement === null));
});

test("departments pair by lineage: a rename keeps the pairing and its historic labels", () => {
  const left = sideOf([...around(60, DEPT_A, 6), ...around(50, DEPT_B, 6)], scored());
  const right = sideOf([...around(70, DEPT_A, 6), ...around(55, DEPT_B, 6)], scored());
  // The later round renamed the department; the lineage is the department, not
  // the label, and each snapshot keeps the name it froze.
  right.groups = right.groups.map((g) =>
    g.key === DEPT_A ? { ...g, label: t("الهندسة والتشغيل", "Engineering and operations") } : g,
  );
  const result = compareSnapshots({
    classification: "IDENTICAL",
    pairs: [{ leftKey: DIMENSION_METRIC, rightKey: DIMENSION_METRIC }],
    left,
    right,
  });
  const pairing = result.groupMappings.find((g) => g.rightGroupKey === DEPT_A)!;
  assert.equal(pairing.leftGroupKey, DEPT_A);
  assert.equal(cellOf(result, DIMENSION_METRIC, DEPT_A).status, "COMPARABLE");
  assert.equal(
    left.groups.find((g) => g.key === DEPT_A)!.label.ar,
    "الهندسة",
    "the earlier round keeps the name it was published with",
  );
  assert.equal(pairing.label.ar, "الهندسة والتشغيل");
});

test("a structural department change blocks its comparison and is declared", () => {
  const left = sideOf([...around(60, DEPT_A, 6), ...around(50, DEPT_B, 6)], scored());
  // The later round has a department the earlier one does not: a split, a
  // merger or simply a new department. The company series continues; that
  // department is not compared to anything.
  const right = sideOf([...around(70, DEPT_A, 6), ...around(55, DEPT_B, 6)], scored(), {
    lineage: { [COMPANY]: null, [DEPT_A]: "department-a", [DEPT_B]: "department-new" },
  });
  const result = compareSnapshots({
    classification: "IDENTICAL",
    pairs: [{ leftKey: DIMENSION_METRIC, rightKey: DIMENSION_METRIC }],
    left,
    right,
  });
  assert.ok(result.populationCaveats.includes("GROUPS_ADDED"));
  assert.ok(result.populationCaveats.includes("GROUPS_REMOVED"));
  assert.ok(!result.groupMappings.some((g) => g.rightGroupKey === DEPT_B));
  assert.ok(!result.cells.some((c) => c.groupKey === DEPT_B));
  assert.equal(cellOf(result, DIMENSION_METRIC, DEPT_A).status, "COMPARABLE");
  assert.equal(cellOf(result, DIMENSION_METRIC).status, "COMPARABLE");
});

test("a changed population is declared rather than assumed away", () => {
  // People moved between departments, or joined, or left. The comparison
  // cannot and does not track individuals; it says the population differs.
  const result = compareSnapshots({
    classification: "IDENTICAL",
    pairs: [{ leftKey: DIMENSION_METRIC, rightKey: DIMENSION_METRIC }],
    left: sideOf([...around(60, DEPT_A, 6), ...around(50, DEPT_B, 6)], scored()),
    right: sideOf([...around(70, DEPT_A, 8), ...around(55, DEPT_B, 6)], scored()),
  });
  assert.ok(result.populationCaveats.includes("CONTRIBUTORS_CHANGED"));
  assert.equal(cellOf(result, DIMENSION_METRIC).status, "COMPARABLE");
  assert.doesNotMatch(JSON.stringify(result), /participant|invitation|respondent/i);
});

test("a reviewed-equivalent comparison declares that the version changed", () => {
  const result = compareSnapshots({
    classification: "REVIEWED_EQUIVALENT",
    pairs: [{ leftKey: DIMENSION_METRIC, rightKey: DIMENSION_METRIC }],
    left: sideOf(around(60), scored()),
    right: sideOf(around(70), scored({ translationsOnly: true })),
  });
  assert.ok(result.populationCaveats.includes("VERSION_CHANGED"));
  assert.equal(cellOf(result, DIMENSION_METRIC).status, "COMPARABLE");
});

test("the automatic trend breaks rather than drawing through a change or a gap", () => {
  const released = (mean: number, instrument: Instrument, roundId: string) => {
    const side = sideOf(around(mean), instrument);
    return {
      roundId,
      label: roundId,
      periodStart: "2026-01-01",
      releaseState: "PUBLISHED",
      contributorCount: side.contributorCount,
      instrument,
      metrics: side.metrics,
      cells: side.cells,
      companyGroupKey: COMPANY,
    };
  };
  const trends = trendSeries([
    released(60, scored(), "r1"),
    released(70, scored({ translationsOnly: true }), "r2"),
    released(80, scored({ weight: "9" }), "r3"),
    {
      roundId: "r4",
      label: "r4",
      periodStart: "2026-10-01",
      releaseState: "QUEUED",
      contributorCount: null,
      instrument: null,
      metrics: [],
      cells: [],
      companyGroupKey: null,
    },
  ]);
  const dimension = trends.find((t) => t.metricKey === DIMENSION_METRIC)!;
  assert.deepEqual(
    dimension.points.map((p) => p.status),
    ["COMPARABLE", "COMPARABLE", "NOT_COMPARABLE", "GAP"],
  );
  // A break and an unreleased round carry no value at all: nothing is drawn
  // through them and nothing reads as zero.
  assert.equal(dimension.points[2].value, null);
  assert.equal(dimension.points[2].reasonCode, "MEASUREMENT_CHANGED");
  assert.equal(dimension.points[3].value, null);
  assert.equal(dimension.points[3].reasonCode, "NOT_RELEASED");
  assert.match(dimension.points[0].value!, /^\d+\.\d$/);
});
