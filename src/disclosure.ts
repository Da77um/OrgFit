import { N, total, type ScoreNumber } from "./score-number";
import type { Instrument, Question, Translation } from "./instrument-input";

// ---------------------------------------------------------------------------
// The disclosure engine.
//
// It turns a whole campaign's anonymous per-response scores and answers into
// ONE release plan, and it is the only thing that decides what a staff user may
// ever see. It is pure: no database, no clock, no randomness, no network, no
// organization authorization. Publication authorization lives in
// publication.publish_release; this file decides only what is safe to publish.
//
// The rules it implements, and why each one exists:
//
//   * Every released cell counts DISTINCT valid contributors to that metric and
//     requires at least the campaign threshold (floor five). A campaign of
//     twenty with four valid answers for one dimension does not release that
//     dimension.
//   * A metric whose contributors all hold the identical value is withheld: the
//     mean would republish every one of those people's answers exactly.
//   * The department partition is released whole or not at all, and never
//     without its company cell. One withheld sibling beside a published company
//     total is a subtraction away from being recovered.
//   * A distribution is released only when every nonempty bin also clears the
//     threshold. Checkbox bins count respondents, not selections.
//   * Free text and exact dates are never released as values.
//
// Honest limits: this is k-thresholding plus complementary and homogeneity
// controls. It is not differential privacy, it does not model an adversary with
// outside knowledge of a specific person, and a released mean always discloses
// the contributor sum. Checkpoint D is the adversarial review.
// ---------------------------------------------------------------------------

export const THRESHOLD_FLOOR = 5;
export const DISCLOSURE_VERSION = "1.0.0" as const;
// The stable definition key the processor writes for the overall score, which
// is a configured composite rather than a declared dimension.
export const OVERALL_DEFINITION_KEY = "00000000-0000-0000-0000-000000000000";
export const OVERALL_METRIC_KEY = "overall";
const OVERALL_LABEL: Translation = {
  ar: "النتيجة العامة",
  en: "Overall score",
};

export type CellStatus =
  | "AVAILABLE"
  | "SUPPRESSED"
  | "INSUFFICIENT"
  | "UNSCORED"
  | "NOT_COMPARABLE";
export type ReasonCode =
  | "BELOW_THRESHOLD"
  | "COMPLEMENTARY"
  | "HOMOGENEOUS"
  | "SPARSE_BIN"
  | "RAW_WITHHELD"
  | "NO_VALID_SCORE"
  | "NOT_RELEASED";
export type SafeBand = {
  key: string;
  label: Translation;
  lower: string;
  upper: string;
  severity: string;
  semantic: string;
};
export type SafeBin = {
  key: string;
  label: Translation;
  count: number;
  share: string;
};
export type SafeDistribution = {
  kind: "OPTION_SHARES";
  total: number;
  bins: SafeBin[];
};
export type SafeCell = {
  groupKey: string;
  metricKey: string;
  status: CellStatus;
  reasonCode: ReasonCode | null;
  contributorCount: number | null;
  value: string | null;
  coverage: string | null;
  distribution: SafeDistribution | null;
  band: SafeBand | null;
};
export type MetricDefinition = {
  key: string;
  kind: "OVERALL" | "DIMENSION" | "QUESTION";
  label: Translation;
  description: Translation;
  direction: "HIGH_GOOD" | "HIGH_RISK" | null;
  unit: "SCORE_0_100" | "PERCENT" | "NUMBER" | "SHARES";
  order: number;
  bands: SafeBand[];
};
export type GroupDefinition = {
  key: string;
  kind: "COMPANY" | "DEPARTMENT" | "OTHER";
  label: Translation;
  order: number;
};
export type TypedValue =
  | { type: "OPTION"; optionId: string }
  | { type: "OPTION_SET"; optionIds: string[] }
  | { type: "NUMBER"; value: string }
  | { type: "DATE"; value: string }
  | { type: "TEXT"; value: string };
export type ResponseRecord = {
  groupId: string;
  scores: {
    definitionKey: string;
    normalized: string | null;
    coverage: string;
    status: string;
  }[];
  answers: { questionKey: string; typedValue: TypedValue }[];
};
export type ReleaseInput = {
  threshold: number;
  instrument: Instrument;
  groups: {
    id: string;
    kind: "COMPANY" | "DEPARTMENT" | "OTHER";
    label: Translation;
  }[];
  responses: ResponseRecord[];
};
export type ReleasePlan = {
  threshold: number;
  companyGroupKey: string;
  contributorCount: number;
  groups: GroupDefinition[];
  metrics: MetricDefinition[];
  cells: SafeCell[];
  summary: {
    disclosureVersion: string;
    partition: "COMPANY_PLUS_FLAT_DEPARTMENTS";
    metricsReleased: number;
    metricsWithheld: number;
    departmentPartitionsReleased: number;
  };
};
export class DisclosureError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const withheld = (
  groupKey: string,
  metricKey: string,
  status: CellStatus,
  reasonCode: ReasonCode,
): SafeCell => ({
  groupKey,
  metricKey,
  status,
  reasonCode,
  // Nothing else. A withheld cell is empty, not hidden: there is no companion
  // field for a chart payload, a cache or an export to serialize by accident.
  contributorCount: null,
  value: null,
  coverage: null,
  distribution: null,
  band: null,
});
const mean = (values: ScoreNumber[]) => total(values).div(N(values.length));
// Postgres returns numeric with the precision the processor stored, which comes
// from a floating-point conversion of an exact fraction. Six decimal places is
// five orders of magnitude finer than the published precision and keeps the
// exact-arithmetic parser in range.
const decimal = (value: string) => {
  const [whole, fraction = ""] = value.trim().split(".");
  return N(fraction ? `${whole}.${fraction.slice(0, 6) || "0"}` : whole);
};
const identical = (values: ScoreNumber[]) =>
  values.every((v) => v.compare(values[0]) === 0);

function bandFor(value: ScoreNumber, bands: SafeBand[]): SafeBand | null {
  return (
    bands.find(
      (b, i) =>
        value.compare(N(b.lower)) >= 0 &&
        (value.compare(N(b.upper)) < 0 ||
          (i === bands.length - 1 && value.compare(N(b.upper)) === 0)),
    ) ?? null
  );
}
const safeBands = (
  bands: { key: string; label: Translation; lower: string; upper: string; severity: string; semantic: string }[],
): SafeBand[] =>
  bands.map((b) => ({
    key: b.key,
    label: b.label,
    lower: b.lower,
    upper: b.upper,
    severity: b.severity,
    semantic: b.semantic,
  }));

// The answer-bearing items of a pinned instrument, keyed the way the anonymous
// store keys them: a matrix contributes one entry per row.
function answerItems(document: Instrument) {
  const items: {
    key: string;
    question: Question;
    label: Translation;
    bins: { key: string; label: Translation }[] | null;
  }[] = [];
  const join = (a: Translation, b: Translation): Translation => ({
    ar: `${a.ar} — ${b.ar}`,
    en: `${a.en} — ${b.en}`,
  });
  const scale = (max: number) =>
    Array.from({ length: max }, (_, i) => ({
      key: String(i + 1),
      label: { ar: String(i + 1), en: String(i + 1) },
    }));
  for (const q of document.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    const bins =
      q.type === "MULTIPLE_CHOICE" ||
      q.type === "DROPDOWN" ||
      q.type === "YES_NO" ||
      q.type === "CHECKBOXES"
        ? q.options.map((o) => ({ key: o.id, label: o.label }))
        : q.type === "MATRIX"
          ? q.columns.map((o) => ({ key: o.id, label: o.label }))
          : q.type === "RATING_5"
            ? scale(5)
            : q.type === "RATING_10"
              ? scale(10)
              : null;
    if (q.type === "MATRIX")
      for (const row of q.rows)
        items.push({
          key: row.key,
          question: q,
          label: join(q.prompt, row.label),
          bins,
        });
    else items.push({ key: q.key, question: q, label: q.prompt, bins });
  }
  return items;
}

// One scored metric across the whole partition. This is where the joint rules
// live, because a department cell can only be judged beside its siblings.
function scoredCells(
  metricKey: string,
  definitionKey: string,
  input: ReleaseInput,
  bands: SafeBand[],
  groups: GroupDefinition[],
  company: GroupDefinition,
): SafeCell[] {
  type Contribution = { value: ScoreNumber; coverage: ScoreNumber };
  const byGroup = new Map<string, Contribution[]>();
  const all: Contribution[] = [];
  for (const r of input.responses) {
    const score = r.scores.find((s) => s.definitionKey === definitionKey);
    // A dimension a respondent did not answer well enough to score is NOT a
    // zero and NOT a contributor. It simply does not enter this metric.
    if (!score || score.status !== "VALID" || score.normalized === null)
      continue;
    const item = {
      value: decimal(score.normalized),
      coverage: decimal(score.coverage),
    };
    all.push(item);
    byGroup.set(r.groupId, [...(byGroup.get(r.groupId) ?? []), item]);
  }
  const cell = (
    groupKey: string,
    items: Contribution[],
  ): SafeCell | { blocked: ReasonCode } => {
    if (!items.length) return { blocked: "NO_VALID_SCORE" };
    if (items.length < input.threshold) return { blocked: "BELOW_THRESHOLD" };
    const values = items.map((i) => i.value);
    if (identical(values)) return { blocked: "HOMOGENEOUS" };
    // The company value is the mean of respondent-level values, so a large
    // department cannot be diluted into an unweighted average of departments.
    const value = mean(values);
    return {
      groupKey,
      metricKey,
      status: "AVAILABLE",
      reasonCode: null,
      contributorCount: items.length,
      value: value.format(1),
      coverage: mean(items.map((i) => i.coverage)).format(3),
      distribution: null,
      band: bandFor(value, bands),
    };
  };
  const companyCell = cell(company.key, all);
  if ("blocked" in companyCell) {
    const status: CellStatus =
      companyCell.blocked === "NO_VALID_SCORE"
        ? "UNSCORED"
        : companyCell.blocked === "BELOW_THRESHOLD"
          ? "INSUFFICIENT"
          : "SUPPRESSED";
    return [
      withheld(company.key, metricKey, status, companyCell.blocked),
      // With no company result there is no partition to release either.
      ...groups
        .filter((g) => g.kind !== "COMPANY")
        .map((g) =>
          (byGroup.get(g.key) ?? []).length
            ? withheld(g.key, metricKey, "SUPPRESSED", "NOT_RELEASED")
            : withheld(g.key, metricKey, "UNSCORED", "NO_VALID_SCORE"),
        ),
    ];
  }
  const partition = groups.filter((g) => g.kind !== "COMPANY");
  const candidates = partition.map((g) => ({
    group: g,
    result: cell(g.key, byGroup.get(g.key) ?? []),
  }));
  // The conservative default from the blueprint: if ANY nonempty department
  // cell cannot stand on its own, the whole breakdown is withheld and only the
  // company result is released for this metric. An empty department is not a
  // withheld cell, it is an absence: it contributes nobody to reconstruct.
  const unsafe = candidates.some(
    (c) => "blocked" in c.result && c.result.blocked !== "NO_VALID_SCORE",
  );
  return [
    companyCell,
    ...candidates.map((c) =>
      "blocked" in c.result
        ? withheld(
            c.group.key,
            metricKey,
            c.result.blocked === "NO_VALID_SCORE" ? "UNSCORED" : "SUPPRESSED",
            c.result.blocked === "NO_VALID_SCORE"
              ? "NO_VALID_SCORE"
              : "COMPLEMENTARY",
          )
        : unsafe
          ? withheld(c.group.key, metricKey, "SUPPRESSED", "COMPLEMENTARY")
          : c.result,
    ),
  ];
}

// Question analysis is company-level by design. A per-department breakdown of
// every option bin multiplies the number of small cells far faster than it adds
// consulting value, and each one is another reconstruction surface.
function questionCells(
  metricKey: string,
  key: string,
  question: Question,
  bins: { key: string; label: Translation }[] | null,
  input: ReleaseInput,
  groups: GroupDefinition[],
  company: GroupDefinition,
): SafeCell[] {
  const departments = groups
    .filter((g) => g.kind !== "COMPANY")
    .map((g) => withheld(g.key, metricKey, "SUPPRESSED", "NOT_RELEASED"));
  const answers = input.responses
    .map((r) => r.answers.find((a) => a.questionKey === key)?.typedValue)
    .filter((v): v is TypedValue => v !== undefined);
  const blocked = (status: CellStatus, reason: ReasonCode) => [
    withheld(company.key, metricKey, status, reason),
    ...departments,
  ];
  // Free text and exact dates never become a released value or a bin label.
  if (question.type === "SHORT_TEXT" || question.type === "LONG_TEXT" || question.type === "DATE")
    return blocked("SUPPRESSED", "RAW_WITHHELD");
  if (!answers.length) return blocked("UNSCORED", "NO_VALID_SCORE");
  if (answers.length < input.threshold) return blocked("INSUFFICIENT", "BELOW_THRESHOLD");
  const coverage = N(answers.length).div(N(input.responses.length)).format(3);

  if (question.type === "NUMBER") {
    // A bounded summary only. A minimum or a maximum IS one person's answer,
    // and an exact numeric value must never become a histogram label.
    const values = answers.map((a) =>
      decimal((a as { type: "NUMBER"; value: string }).value),
    );
    if (identical(values)) return blocked("SUPPRESSED", "HOMOGENEOUS");
    return [
      {
        groupKey: company.key,
        metricKey,
        status: "AVAILABLE",
        reasonCode: null,
        contributorCount: answers.length,
        value: mean(values).format(2),
        coverage,
        distribution: null,
        band: null,
      },
      ...departments,
    ];
  }
  if (!bins) return blocked("SUPPRESSED", "RAW_WITHHELD");
  // Checkboxes count RESPONDENTS per option, never total selections: the
  // privacy denominator is people.
  const counts = new Map(bins.map((b) => [b.key, 0]));
  for (const answer of answers)
    for (const chosen of answer.type === "OPTION_SET"
      ? answer.optionIds
      : answer.type === "OPTION"
        ? [answer.optionId]
        : answer.type === "NUMBER"
          ? [answer.value]
          : [])
      if (counts.has(chosen)) counts.set(chosen, counts.get(chosen)! + 1);
  const populated = [...counts.values()].filter((c) => c > 0);
  if (!populated.length) return blocked("UNSCORED", "NO_VALID_SCORE");
  // A rare bin identifies the few people in it, and its complement identifies
  // the rest, so the whole distribution goes rather than a single bar.
  if (populated.some((c) => c < input.threshold))
    return blocked("SUPPRESSED", "SPARSE_BIN");
  // Everyone in one bin means the chart republishes every contributor's answer.
  if (populated.some((c) => c === answers.length))
    return blocked("SUPPRESSED", "HOMOGENEOUS");
  return [
    {
      groupKey: company.key,
      metricKey,
      status: "AVAILABLE",
      reasonCode: null,
      contributorCount: answers.length,
      value: null,
      coverage,
      distribution: {
        kind: "OPTION_SHARES",
        total: answers.length,
        bins: bins.map((b) => ({
          key: b.key,
          label: b.label,
          count: counts.get(b.key)!,
          share: N(counts.get(b.key)!).div(N(answers.length)).format(3),
        })),
      },
      band: null,
    },
    ...departments,
  ];
}

export function buildReleasePlan(input: ReleaseInput): ReleasePlan {
  const threshold = Math.max(input.threshold, THRESHOLD_FLOOR);
  const plan: ReleaseInput = { ...input, threshold };
  const companySource = input.groups.find((g) => g.kind === "COMPANY");
  if (!companySource) throw new DisclosureError("NO_COMPANY_GROUP");
  if (input.responses.length < threshold)
    throw new DisclosureError("BELOW_THRESHOLD");
  const groups: GroupDefinition[] = [
    { ...companySource, key: companySource.id, order: 0 },
    ...input.groups
      .filter((g) => g.kind !== "COMPANY")
      .sort((a, b) => (a.label.ar < b.label.ar ? -1 : a.label.ar > b.label.ar ? 1 : a.id < b.id ? -1 : 1))
      .map((g, i) => ({ ...g, key: g.id, order: i + 1 })),
  ];
  const company = groups[0];
  if (input.responses.some((r) => r.groupId === company.key))
    throw new DisclosureError("COMPANY_GROUP_ASSIGNED");
  const known = new Set(groups.map((g) => g.key));
  if (input.responses.some((r) => !known.has(r.groupId)))
    throw new DisclosureError("UNKNOWN_GROUP");

  const metrics: MetricDefinition[] = [];
  const cells: SafeCell[] = [];
  let order = 0;
  const document = input.instrument;
  if (document.overall.enabled) {
    const bands = safeBands(document.overall.bands);
    metrics.push({
      key: OVERALL_METRIC_KEY,
      kind: "OVERALL",
      label: OVERALL_LABEL,
      description: { ar: "", en: "" },
      direction: document.overall.direction,
      unit: "SCORE_0_100",
      order: order++,
      bands,
    });
    cells.push(
      ...scoredCells(OVERALL_METRIC_KEY, OVERALL_DEFINITION_KEY, plan, bands, groups, company),
    );
  }
  for (const dimension of document.dimensions) {
    const key = `dimension:${dimension.key}`,
      bands = safeBands(dimension.bands);
    metrics.push({
      key,
      kind: "DIMENSION",
      label: dimension.name,
      description: dimension.description,
      direction: dimension.direction,
      unit: "SCORE_0_100",
      order: order++,
      bands,
    });
    cells.push(...scoredCells(key, dimension.key, plan, bands, groups, company));
  }
  for (const item of answerItems(document)) {
    const key = `question:${item.key}`;
    metrics.push({
      key,
      kind: "QUESTION",
      label: item.label,
      description: item.question.help,
      direction: null,
      unit: item.question.type === "NUMBER" ? "NUMBER" : "SHARES",
      order: order++,
      bands: [],
    });
    cells.push(
      ...questionCells(key, item.key, item.question, item.bins, plan, groups, company),
    );
  }
  const released = new Set(
    cells.filter((c) => c.status === "AVAILABLE").map((c) => c.metricKey),
  );
  const result: ReleasePlan = {
    threshold,
    companyGroupKey: company.key,
    contributorCount: input.responses.length,
    groups,
    metrics,
    cells,
    summary: {
      disclosureVersion: DISCLOSURE_VERSION,
      partition: "COMPANY_PLUS_FLAT_DEPARTMENTS",
      metricsReleased: released.size,
      metricsWithheld: metrics.length - released.size,
      departmentPartitionsReleased: new Set(
        cells
          .filter((c) => c.status === "AVAILABLE" && c.groupKey !== company.key)
          .map((c) => c.metricKey),
      ).size,
    },
  };
  validateReleasePlan(result);
  return result;
}

// The whole-plan check. It runs on every generated plan before the plan is
// offered for publication, and publication.publish_release repeats the same
// reasoning independently in SQL: neither one trusts the other.
export function validateReleasePlan(plan: ReleasePlan) {
  const fail = (code: string) => {
    throw new DisclosureError(code);
  };
  if (plan.threshold < THRESHOLD_FLOOR) fail("PLAN_THRESHOLD_TOO_LOW");
  const groups = new Map(plan.groups.map((g) => [g.key, g]));
  const metrics = new Map(plan.metrics.map((m) => [m.key, m]));
  if (plan.groups.filter((g) => g.kind === "COMPANY").length !== 1)
    fail("PLAN_NO_COMPANY_GROUP");
  const seen = new Set<string>();
  for (const cell of plan.cells) {
    if (!groups.has(cell.groupKey) || !metrics.has(cell.metricKey))
      fail("PLAN_UNKNOWN_REFERENCE");
    const id = `${cell.metricKey} ${cell.groupKey}`;
    if (seen.has(id)) fail("PLAN_DUPLICATE_CELL");
    seen.add(id);
    if (cell.status === "AVAILABLE") {
      if (cell.reasonCode !== null) fail("PLAN_REASON_ON_AVAILABLE");
      if ((cell.contributorCount ?? 0) < plan.threshold)
        fail("PLAN_BELOW_THRESHOLD");
      if (cell.value === null && cell.distribution === null)
        fail("PLAN_EMPTY_AVAILABLE");
      for (const bin of cell.distribution?.bins ?? [])
        if (bin.count !== 0 && bin.count < plan.threshold) fail("PLAN_SPARSE_BIN");
    } else if (
      cell.reasonCode === null ||
      cell.contributorCount !== null ||
      cell.value !== null ||
      cell.coverage !== null ||
      cell.distribution !== null ||
      cell.band !== null
    )
      fail("PLAN_WITHHELD_CELL_CARRIES_VALUE");
  }
  for (const metric of plan.metrics) {
    const partition = plan.cells.filter(
      (c) => c.metricKey === metric.key && c.groupKey !== plan.companyGroupKey,
    );
    const shown = partition.filter((c) => c.status === "AVAILABLE");
    // An UNSCORED/NO_VALID_SCORE cell is an absence, not a withheld value: that
    // group contributed nobody to this metric, so it cannot be reconstructed.
    const hidden = partition.filter(
      (c) =>
        c.status !== "AVAILABLE" &&
        !(c.status === "UNSCORED" && c.reasonCode === "NO_VALID_SCORE"),
    );
    if (shown.length && hidden.length) fail("PLAN_PARTIAL_PARTITION");
    if (
      shown.length &&
      !plan.cells.some(
        (c) =>
          c.metricKey === metric.key &&
          c.groupKey === plan.companyGroupKey &&
          c.status === "AVAILABLE",
      )
    )
      fail("PLAN_PARTITION_WITHOUT_COMPANY");
  }
  return plan;
}

// Strengths and weaknesses are derived from released cells only, so a withheld
// dimension cannot leak its position through a ranking. Ties are broken by
// metric key, never by an unpublished value.
export function rankDimensions(
  plan: Pick<ReleasePlan, "cells" | "metrics" | "companyGroupKey">,
) {
  const entries = plan.metrics
    .filter((m) => m.kind === "DIMENSION")
    .flatMap((metric) => {
      const cell = plan.cells.find(
        (c) =>
          c.metricKey === metric.key &&
          c.groupKey === plan.companyGroupKey &&
          c.status === "AVAILABLE" &&
          c.value !== null,
      );
      if (!cell) return [];
      // Orientation first: on a HIGH_RISK dimension a high number is a concern,
      // not a strength.
      const oriented = N(cell.value!);
      return [
        {
          metricKey: metric.key,
          label: metric.label,
          value: cell.value!,
          band: cell.band,
          favourable:
            metric.direction === "HIGH_RISK"
              ? N(100).sub(oriented)
              : oriented,
        },
      ];
    })
    .sort(
      (a, b) =>
        b.favourable.compare(a.favourable) ||
        (a.metricKey < b.metricKey ? -1 : 1),
    );
  // The list is split at its midpoint, at most three a side. Taking the top
  // three unconditionally would present the WORST dimension of a three- or
  // four-dimension instrument as a strength — including a critical HIGH_RISK
  // one — because "areas to review" only began at the fourth entry. The two
  // lists still never overlap, and a single released dimension is a strength
  // and nothing else rather than appearing as both the best and the worst.
  const weak = Math.min(3, Math.floor(entries.length / 2));
  const strong = Math.min(3, entries.length - weak);
  return {
    strengths: entries.slice(0, strong).map(({ favourable: _f, ...rest }) => rest),
    weaknesses: entries
      .slice(entries.length - weak)
      .reverse()
      .map(({ favourable: _f, ...rest }) => rest),
  };
}
