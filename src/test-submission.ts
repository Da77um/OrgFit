import {
  locateIssue,
  ruleIssues,
  type DefinitionIssue,
  type Dimension,
  type Instrument,
} from "./instrument-input";
import {
  OVERALL_LABEL,
  OVERALL_METRIC_KEY,
  type MetricDefinition,
  type SafeBand,
  type SafeCell,
} from "./disclosure";
import {
  selectRecommendations,
  type SelectedRecommendation,
} from "./recommendation-select";
import {
  scoreDraft,
  ScoringError,
  validateAnswers,
  type Answers,
  type DraftScoring,
  type Metric,
  type ScorePin,
} from "./scoring";

// The preview's "submit test answers". It is the respondent's final check
// (validateAnswers, then nothing required may be missing: respondent.ts) and
// then the sandbox's draft scoring, and nothing else: it is pure, so the
// answers and the result exist only in the caller's memory. It never stores,
// sends or logs anything, and it is never a submission for any person.
export type TestSubmission =
  | { status: "INCOMPLETE"; missingRequired: string[] }
  | { status: "REFUSED"; issues: DefinitionIssue[] }
  | {
      status: "SCORED";
      result: DraftScoring;
      recommendations: TestRecommendations;
    };
/** The rules that would fire on these scores, and the rules not evaluated
 *  because they are not complete yet (their issues, located). */
export type TestRecommendations = {
  fired: SelectedRecommendation[];
  skipped: DefinitionIssue[];
};

export function submitTestAnswers(
  d: Instrument,
  answers: Answers,
  pin: ScorePin,
): TestSubmission {
  try {
    const { missingRequired } = validateAnswers(d, answers);
    if (missingRequired.length)
      return { status: "INCOMPLETE", missingRequired };
    const result = scoreDraft(d, answers, pin);
    return {
      status: "SCORED",
      result,
      recommendations: testRecommendations(d, result),
    };
  } catch (e) {
    if (!(e instanceof ScoringError)) throw e;
    return {
      status: "REFUSED",
      issues: e.issues.map((issue) => {
        const location = locateIssue(d, issue.path);
        return location ? { ...issue, location } : issue;
      }),
    };
  }
}

// The test group is the company group of a one-group plan: the rules are
// evaluated as if these scores were a published company result. That is the
// most a test can show. A real release publishes nothing for a group with
// fewer than the threshold's contributors, so one test response would never
// produce a real recommendation, and department rules have no department here.
export const TEST_GROUP_KEY = "test";
const safeBands = (bands: Dimension["bands"]): SafeBand[] =>
  bands.map((b) => ({
    key: b.key,
    label: b.label,
    lower: b.lower,
    upper: b.upper,
    severity: b.severity,
    semantic: b.semantic,
  }));
export function testRecommendations(
  d: Instrument,
  { scores }: DraftScoring,
): TestRecommendations {
  // A rule still being written is not evaluated (a BETWEEN without its upper
  // bound cannot be compared); it is listed with its reasons instead.
  const issues = ruleIssues(d).map((issue) => {
    const location = locateIssue(d, issue.path);
    return location ? { ...issue, location } : issue;
  });
  const incomplete = new Set(
    d.recommendations
      .filter((r) =>
        issues.some((i) => i.path === r.id || i.path.startsWith(`${r.id}.`)),
      )
      .map((r) => r.id),
  );
  const metrics: MetricDefinition[] = [],
    cells: SafeCell[] = [];
  const add = (
    key: string,
    kind: "OVERALL" | "DIMENSION",
    label: MetricDefinition["label"],
    direction: MetricDefinition["direction"],
    bands: Dimension["bands"],
    m: Metric | null | undefined,
  ) => {
    metrics.push({
      key,
      kind,
      label,
      description: { ar: "", en: "" },
      direction,
      unit: "SCORE_0_100",
      order: metrics.length,
      bands: safeBands(bands),
    });
    // Only a scored value is an input, exactly as only an AVAILABLE cell is
    // one in a release: an unscored dimension leaves its rules unknown.
    if (m && m.display !== null)
      cells.push({
        groupKey: TEST_GROUP_KEY,
        metricKey: key,
        status: "AVAILABLE",
        reasonCode: null,
        contributorCount: 1,
        value: m.display,
        coverage: null,
        distribution: null,
        band: m.band ? safeBands([m.band])[0] : null,
      });
  };
  if (d.overall.enabled)
    add(
      OVERALL_METRIC_KEY,
      "OVERALL",
      OVERALL_LABEL,
      d.overall.direction,
      d.overall.bands,
      scores.overall,
    );
  for (const dim of d.dimensions)
    add(
      `dimension:${dim.key}`,
      "DIMENSION",
      dim.name,
      dim.direction,
      dim.bands,
      scores.dimensions[dim.id],
    );
  return {
    fired: selectRecommendations({
      instrument: {
        ...d,
        recommendations: d.recommendations.filter((r) => !incomplete.has(r.id)),
      },
      groups: [
        {
          key: TEST_GROUP_KEY,
          kind: "COMPANY",
          label: { ar: "الإجابات التجريبية", en: "Test answers" },
          order: 0,
        },
      ],
      metrics,
      cells,
      companyGroupKey: TEST_GROUP_KEY,
    }),
    skipped: issues.filter((i) =>
      d.recommendations.some(
        (r) =>
          incomplete.has(r.id) &&
          (i.path === r.id || i.path.startsWith(`${r.id}.`)),
      ),
    ),
  };
}
