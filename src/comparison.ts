import { N } from "./score-number";
import { canonicalJson, type Instrument } from "./instrument-input";
import {
  OVERALL_METRIC_KEY,
  type GroupDefinition,
  type MetricDefinition,
  type SafeCell,
} from "./disclosure";

// ---------------------------------------------------------------------------
// Historical comparison.
//
// Two published releases of ONE organization, compared metric by metric. It is
// pure: no database, no clock, no authorization, and no respondent anywhere in
// its input. Comparison consumes released aggregate cells and the two pinned
// instrument definitions — never a roster, never an answer, and never anything
// that could join a person across rounds.
//
// What makes a comparison legitimate is measurement equivalence, and this file
// is where that is decided:
//
//   * A metric's FINGERPRINT covers everything that determines its number —
//     aggregation mode, coverage rule, direction, denominator, and every scored
//     item with its weight, reverse flag, scoring mode and option score vector.
//     It deliberately excludes all translated text, so a translation-only
//     revision keeps its fingerprint. It equally deliberately excludes the
//     dimension's own name and identity: a stable key is NOT evidence of
//     equivalence, and two dimensions that share a key but changed their items
//     do not match.
//   * A delta is computed only for a pair whose fingerprints match AT READ TIME,
//     recomputed from both pinned instruments. A stored review that claims
//     equivalence cannot manufacture one.
//   * A suppressed, insufficient, unscored or absent value on either side is a
//     GAP. Gaps never become zero, never interpolate, and never produce a
//     point change or an improvement.
// ---------------------------------------------------------------------------

export const CLASSIFICATIONS = [
  "IDENTICAL",
  "REVIEWED_EQUIVALENT",
  "NOT_COMPARABLE",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export type MetricPair = { leftKey: string; rightKey: string };
export type MetricSemantics = {
  key: string;
  kind: "OVERALL" | "DIMENSION";
  direction: "HIGH_GOOD" | "HIGH_RISK";
  fingerprint: string;
};

// The measurement identity of every scored metric a version publishes.
export function metricSemantics(d: Instrument): Map<string, MetricSemantics> {
  const questions = d.sections.flatMap((s) => s.questions);
  // One scored item, described by what it contributes numerically. Option
  // labels and prompts are excluded; option SCORES are not.
  const item = (dimensionId: string) =>
    questions
      .filter((q) => q.dimensionId === dimensionId && q.scoring.enabled)
      .map((q) =>
        canonicalJson({
          key: q.key,
          type: q.type,
          required: q.required,
          scoring: q.scoring,
          validation: q.validation,
          options: q.options.map((o) => ({ key: o.key, score: o.score })),
          rows: q.rows.map((r) => ({ key: r.key, weight: r.weight })),
          columns: q.columns.map((c) => ({ key: c.key, score: c.score })),
        }),
      )
      .sort();
  const result = new Map<string, MetricSemantics>();
  for (const dimension of d.dimensions)
    result.set(`dimension:${dimension.key}`, {
      key: `dimension:${dimension.key}`,
      kind: "DIMENSION",
      direction: dimension.direction,
      fingerprint: canonicalJson({
        mode: dimension.mode,
        coverage: dimension.coverage,
        denominator: dimension.denominator,
        direction: dimension.direction,
        items: item(dimension.id),
      }),
    });
  if (d.overall.enabled)
    result.set(OVERALL_METRIC_KEY, {
      key: OVERALL_METRIC_KEY,
      kind: "OVERALL",
      direction: d.overall.direction,
      fingerprint: canonicalJson({
        direction: d.overall.direction,
        // Overall inputs are identified by the fingerprint of the dimension
        // they weight, not by its identifier, so a renumbered copy still
        // matches while a re-specified dimension does not.
        inputs: d.overall.inputs
          .map((i) => {
            const dimension = d.dimensions.find((x) => x.id === i.dimensionId);
            return canonicalJson({
              weight: i.weight,
              invert: i.invert,
              dimension: dimension
                ? result.get(`dimension:${dimension.key}`)?.fingerprint
                : null,
            });
          })
          .sort(),
      }),
    });
  return result;
}

export const equivalent = (
  left: Instrument,
  right: Instrument,
  pair: MetricPair,
) => {
  const a = metricSemantics(left).get(pair.leftKey),
    b = metricSemantics(right).get(pair.rightKey);
  return Boolean(a && b && a.kind === b.kind && a.fingerprint === b.fingerprint);
};

// What a reviewer is offered before they decide. Pairing by key is a
// SUGGESTION only: every suggested pair still has to pass the fingerprint test,
// and the ones that do not are reported so the review is made with the
// difference in view rather than around it.
export function proposeMapping(left: Instrument, right: Instrument) {
  const a = metricSemantics(left),
    b = metricSemantics(right);
  const pairs: (MetricPair & { equivalent: boolean })[] = [];
  for (const [key, metric] of a) {
    const counterpart = b.get(key);
    if (!counterpart) continue;
    pairs.push({
      leftKey: key,
      rightKey: key,
      equivalent:
        metric.kind === counterpart.kind &&
        metric.fingerprint === counterpart.fingerprint,
    });
  }
  return {
    pairs,
    // Metrics with no counterpart at all: added or removed between rounds.
    removed: [...a.keys()].filter((k) => !b.has(k)),
    added: [...b.keys()].filter((k) => !a.has(k)),
    // A version whose every shared metric matches is a candidate for review as
    // equivalent; it is never automatically equivalent.
    suggestion: (pairs.length && pairs.every((p) => p.equivalent)
      ? "REVIEWED_EQUIVALENT"
      : "NOT_COMPARABLE") as Classification,
  };
}

export type ComparisonSide = {
  roundId: string;
  campaignId: string;
  snapshotId: string;
  label: string;
  periodStart: string;
  periodEnd: string | null;
  threshold: number;
  contributorCount: number;
  instrument: Instrument;
  metrics: MetricDefinition[];
  groups: GroupDefinition[];
  cells: SafeCell[];
  // group key → the department it froze, or null for the company and for the
  // unknown-department group. This is department lineage, never a participant.
  lineage: Record<string, string | null>;
};
export type ComparisonCell = {
  metricKey: string;
  leftMetricKey: string;
  groupKey: string;
  leftGroupKey: string;
  label: MetricDefinition["label"];
  groupLabel: GroupDefinition["label"];
  direction: MetricDefinition["direction"];
  status: "COMPARABLE" | "GAP" | "NOT_COMPARABLE";
  reasonCode: string | null;
  left: SafeCell | null;
  right: SafeCell | null;
  pointChange: string | null;
  percentChange: string | null;
  improvement: string | null;
  improved: boolean | null;
};
export type ComparisonResult = {
  classification: Classification;
  comparable: boolean;
  metricMappings: (MetricPair & { equivalent: boolean })[];
  groupMappings: {
    leftGroupKey: string;
    rightGroupKey: string;
    kind: GroupDefinition["kind"];
    label: GroupDefinition["label"];
  }[];
  populationCaveats: string[];
  cells: ComparisonCell[];
};

const available = (cell: SafeCell | undefined | null) =>
  cell && cell.status === "AVAILABLE" && cell.value !== null ? cell : null;

export function compareSnapshots(input: {
  classification: Classification;
  pairs: MetricPair[];
  left: ComparisonSide;
  right: ComparisonSide;
}): ComparisonResult {
  const { left, right } = input;
  // Every mapped pair is re-verified here against the pinned instruments. A
  // stored review cannot assert equivalence the definitions do not support.
  const metricMappings = input.pairs.map((pair) => ({
    ...pair,
    equivalent:
      input.classification !== "NOT_COMPARABLE" &&
      equivalent(left.instrument, right.instrument, pair),
  }));
  const comparable =
    input.classification !== "NOT_COMPARABLE" &&
    metricMappings.some((m) => m.equivalent);

  // Groups pair by department lineage, so a renamed department still lines up
  // and each side keeps its own frozen label. A department present on one side
  // only — a merger, a split, or simply a new department — has no counterpart
  // and is not compared.
  const leftByDepartment = new Map(
    left.groups.map((g) => [left.lineage[g.key] ?? `kind:${g.kind}`, g]),
  );
  const groupMappings: ComparisonResult["groupMappings"] = [];
  const unmatched: string[] = [];
  for (const group of right.groups) {
    const counterpart = leftByDepartment.get(
      right.lineage[group.key] ?? `kind:${group.kind}`,
    );
    if (counterpart && counterpart.kind === group.kind)
      groupMappings.push({
        leftGroupKey: counterpart.key,
        rightGroupKey: group.key,
        kind: group.kind,
        label: group.label,
      });
    else if (group.kind !== "COMPANY") unmatched.push(group.key);
  }
  const caveats = new Set<string>();
  if (unmatched.length) caveats.add("GROUPS_ADDED");
  if (
    left.groups.filter((g) => g.kind !== "COMPANY").length >
    groupMappings.filter((g) => g.kind !== "COMPANY").length
  )
    caveats.add("GROUPS_REMOVED");
  if (left.contributorCount !== right.contributorCount)
    caveats.add("CONTRIBUTORS_CHANGED");
  // THE declared longitudinal limit (CE-001, P-009). Subtracting two releases
  // returns the combined result of whoever joined or left between them; where
  // that is fewer people than the publication threshold, it isolates them, and
  // where it is one person it is that person's own score. The owner accepted
  // this rather than restricting what a round may publish, so the obligation
  // that remains is to say so — and to say it HERE, where the reader is looking
  // at the two rounds, not only in a standing limitations paragraph.
  const changed = Math.abs(left.contributorCount - right.contributorCount);
  if (changed > 0 && changed < Math.max(left.threshold, right.threshold))
    caveats.add("POPULATION_CHANGE_SMALL");
  if (left.threshold !== right.threshold) caveats.add("THRESHOLD_CHANGED");
  if (left.instrument !== right.instrument) {
    if (input.classification === "REVIEWED_EQUIVALENT")
      caveats.add("VERSION_CHANGED");
    const bands = (side: ComparisonSide) =>
      canonicalJson(side.metrics.map((m) => m.bands));
    if (bands(left) !== bands(right)) caveats.add("BANDS_CHANGED");
  }

  const cellOf = (side: ComparisonSide, groupKey: string, metricKey: string) =>
    side.cells.find(
      (c) => c.groupKey === groupKey && c.metricKey === metricKey,
    ) ?? null;
  const cells: ComparisonCell[] = [];
  for (const mapping of groupMappings)
    for (const pair of metricMappings) {
      const metric = right.metrics.find((m) => m.key === pair.rightKey);
      if (!metric || metric.kind === "QUESTION") continue;
      const before = cellOf(left, mapping.leftGroupKey, pair.leftKey),
        after = cellOf(right, mapping.rightGroupKey, pair.rightKey);
      const base = {
        metricKey: pair.rightKey,
        leftMetricKey: pair.leftKey,
        groupKey: mapping.rightGroupKey,
        leftGroupKey: mapping.leftGroupKey,
        label: metric.label,
        groupLabel: mapping.label,
        direction: metric.direction,
        left: before,
        right: after,
      };
      if (!pair.equivalent) {
        cells.push({
          ...base,
          status: "NOT_COMPARABLE",
          reasonCode: "MEASUREMENT_CHANGED",
          pointChange: null,
          percentChange: null,
          improvement: null,
          improved: null,
        });
        continue;
      }
      const a = available(before),
        b = available(after);
      if (!a || !b) {
        // A missing point stays missing. It is not zero, it is not carried
        // forward, and nothing is drawn through it.
        cells.push({
          ...base,
          status: "GAP",
          reasonCode: !a && !b ? "BOTH_WITHHELD" : !a ? "EARLIER_WITHHELD" : "LATER_WITHHELD",
          pointChange: null,
          percentChange: null,
          improvement: null,
          improved: null,
        });
        continue;
      }
      const earlier = N(a.value!),
        later = N(b.value!);
      const change = later.sub(earlier);
      // Direction decides what "better" means: a fall in a HIGH_RISK metric is
      // an improvement, a fall in a HIGH_GOOD one is not.
      const improvement =
        metric.direction === "HIGH_RISK" ? N("0").sub(change) : change;
      cells.push({
        ...base,
        status: "COMPARABLE",
        reasonCode: null,
        pointChange: change.format(1),
        // Percentage change is undefined from a zero baseline and is never
        // invented; the point change is the primary number.
        percentChange:
          earlier.compare(N("0")) === 0
            ? null
            : change.mul(N("100")).div(earlier).format(1),
        improvement: improvement.format(1),
        improved:
          improvement.compare(N("0")) === 0
            ? null
            : improvement.compare(N("0")) > 0,
      });
    }
  return {
    classification: input.classification,
    comparable,
    metricMappings,
    groupMappings,
    populationCaveats: [...caveats].sort(),
    cells,
  };
}

// The automatic trend: a series of released rounds, connected only where the
// measurement did not change. A round whose fingerprint differs from the
// baseline is returned as an explicit break, never as a plotted point.
export function trendSeries(
  rounds: {
    roundId: string;
    label: string;
    periodStart: string;
    releaseState: string;
    contributorCount: number | null;
    instrument: Instrument | null;
    metrics: MetricDefinition[];
    cells: SafeCell[];
    companyGroupKey: string | null;
  }[],
) {
  const released = rounds.filter((r) => r.instrument && r.companyGroupKey);
  const baseline = released[0];
  const baseSemantics = baseline ? metricSemantics(baseline.instrument!) : null;
  const keys = [...(baseSemantics?.keys() ?? [])];
  return keys.map((key) => ({
    metricKey: key,
    label:
      baseline?.metrics.find((m) => m.key === key)?.label ??
      { ar: key, en: key },
    direction: baseline?.metrics.find((m) => m.key === key)?.direction ?? null,
    points: rounds.map((round) => {
      const semantics = round.instrument
        ? metricSemantics(round.instrument).get(key)
        : undefined;
      const comparable =
        Boolean(semantics) &&
        semantics!.fingerprint === baseSemantics!.get(key)!.fingerprint;
      const cell = round.companyGroupKey
        ? (round.cells.find(
            (c) => c.metricKey === key && c.groupKey === round.companyGroupKey,
          ) ?? null)
        : null;
      const value = comparable ? available(cell) : null;
      return {
        roundId: round.roundId,
        label: round.label,
        periodStart: round.periodStart,
        releaseState: round.releaseState,
        value: value?.value ?? null,
        contributorCount: value?.contributorCount ?? null,
        band: value?.band ?? null,
        status: value
          ? ("COMPARABLE" as const)
          : !comparable && round.instrument
            ? ("NOT_COMPARABLE" as const)
            : ("GAP" as const),
        reasonCode: value
          ? null
          : !round.instrument
            ? "NOT_RELEASED"
            : !comparable
              ? "MEASUREMENT_CHANGED"
              : (cell?.reasonCode ?? "NOT_RELEASED"),
      };
    }),
  }));
}
