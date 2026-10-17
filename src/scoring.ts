import { z } from "zod";
import {
  instrumentSchema,
  definitionIssues,
  saveIssues,
  locateIssue,
  type DefinitionIssue,
  type Instrument,
  type Dimension,
  type Question,
} from "./instrument-input";
import { itemBounds } from "./scoring-bounds";
import { checkAnswer, isMissing, normalizeNumerals } from "./answer-rules";
import { N, total, normalize, ScoreNumber } from "./score-number";

export const ENGINE_VERSION = "1.0.0" as const;
export type Answers = Record<string, string | string[]>;
export type ScorePin = { engineVersion: string; configVersion: string };
type Band = Dimension["bands"][number];
export type Metric = {
  status: "VALID" | "INSUFFICIENT";
  raw: number | null;
  normalized: number | null;
  exact: ReturnType<ScoreNumber["exact"]> | null;
  display: string | null;
  coverage: number;
  direction: Dimension["direction"];
  band: Band | null;
  engineVersion: typeof ENGINE_VERSION;
  configVersion: string;
  missingPolicy: "OMIT_WITH_COVERAGE" | "REQUIRE_ALL";
};
export type ScoringResult = {
  engineVersion: typeof ENGINE_VERSION;
  configVersion: string;
  dimensions: Record<string, Metric>;
  overall: Metric | null;
  unscored: string[];
  missingRequired: string[];
};
export class ScoringError extends Error {
  constructor(readonly issues: { path: string; code: string }[]) {
    super("SCORING_VALIDATION_FAILED");
  }
}
const fail = (path: string, code: string): never => {
  throw new ScoringError([{ path, code }]);
};
const missing = isMissing;
export { normalizeNumerals };

export function validateAnswers(
  d: Instrument,
  input: unknown,
): { answers: Answers; missingRequired: string[] } {
  const parsed = z
    .record(
      z.string().max(100),
      z.union([z.string().max(10000), z.array(z.string().max(100)).max(100)]),
    )
    .safeParse(input);
  if (!parsed.success) return fail("answers", "ANSWER_FORMAT");
  const answers = parsed.data,
    known = new Set<string>(),
    required: string[] = [];
  const validate = (q: Question, id: string) => {
    known.add(id);
    const v = answers[id];
    if (missing(v)) {
      if (q.required) required.push(id);
      return;
    }
    // Every broken rule is reported as the one public code this function has
    // always used; the detailed reason exists for the respondent's screen.
    const checked = checkAnswer(q, v);
    if (!checked.ok) return fail(id, "ANSWER_RANGE");
    // Numeric answers are kept in canonical Latin digits whatever was typed.
    if (["NUMBER", "RATING_5", "RATING_10"].includes(q.type))
      answers[id] = checked.value;
  };
  for (const q of d.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    if (q.type === "MATRIX") for (const r of q.rows) validate(q, r.id);
    else validate(q, q.id);
  }
  for (const id of Object.keys(answers))
    if (!known.has(id)) fail(id, "UNKNOWN_ANSWER");
  return { answers, missingRequired: required };
}
const mapped = (
  q: Question,
  id: string,
  answers: Answers,
): ScoreNumber | null => {
  const value = answers[id];
  if (missing(value)) return null;
  if (["NUMBER", "RATING_5", "RATING_10"].includes(q.type))
    return N(value as string);
  if (q.type === "CHECKBOXES")
    return q.scoring.mode === "SELECTED_PERCENTAGE"
      ? N(value.length).mul(N(100)).div(N(q.options.length))
      : total(
          (value as string[]).map((v) =>
            N(q.options.find((o) => o.id === v)!.score!),
          ),
        );
  return N(
    (q.type === "MATRIX" ? q.columns : q.options).find((o) => o.id === value)!
      .score!,
  );
};
const mean = (values: ScoreNumber[], weights: ScoreNumber[]) =>
  total(values.map((v, i) => v.mul(weights[i]))).div(total(weights));
const classify = (value: ScoreNumber, bands: Band[]) =>
  bands.find(
    (b, i) =>
      value.compare(N(b.lower)) >= 0 &&
      (value.compare(N(b.upper)) < 0 ||
        (i === bands.length - 1 && value.compare(N(b.upper)) === 0)),
  ) ?? null;
function metric(
  value: ScoreNumber | null,
  raw: ScoreNumber | null,
  coverage: ScoreNumber,
  direction: Dimension["direction"],
  bands: Band[],
  pin: ScorePin,
  all: boolean,
): Metric {
  return {
    status: value === null ? "INSUFFICIENT" : "VALID",
    raw: raw?.number() ?? null,
    normalized: value?.number() ?? null,
    exact: value?.exact() ?? null,
    display: value?.format() ?? null,
    coverage: coverage.number(),
    direction,
    band: value ? classify(value, bands) : null,
    engineVersion: ENGINE_VERSION,
    configVersion: pin.configVersion,
    missingPolicy: all ? "REQUIRE_ALL" : "OMIT_WITH_COVERAGE",
  };
}

const pinned = (pin: ScorePin) => {
  if (
    !z
      .object({
        engineVersion: z.literal(ENGINE_VERSION),
        configVersion: z.string().min(1).max(200),
      })
      .strict()
      .safeParse(pin).success
  )
    fail("version", "UNSUPPORTED_VERSION");
};
const definition = (input: unknown): Instrument => {
  const parsed = instrumentSchema.safeParse(input);
  return parsed.success ? parsed.data : fail("definition", "DEFINITION_FORMAT");
};

// This function has no storage, staff identity, network, clock, randomness or
// publication side effects. Later processing must supply its immutable pin.
// It is the engine the privacy processor runs on real answers: the whole
// definition must be publishable, or nothing is scored.
export function scoreInstrument(
  input: unknown,
  answerInput: unknown,
  pin: ScorePin,
): ScoringResult {
  pinned(pin);
  const d = definition(input),
    issues = definitionIssues(d, true);
  if (issues.length) throw new ScoringError(issues);
  const { answers, missingRequired } = validateAnswers(d, answerInput);
  return scoreCore(d, answers, missingRequired, pin, () => true, true);
}

export type DraftBlocks = {
  /** Per dimension id, what stops that dimension from being scored. */
  dimensions: Record<string, DefinitionIssue[]>;
  /** What stops the overall score; an input not ready is INPUT_INCOMPLETE. */
  overall: DefinitionIssue[];
  /** Scored questions that no dimension counts yet. */
  unassigned: DefinitionIssue[];
};
export type DraftScoring = { scores: ScoringResult; blocked: DraftBlocks };
// Publication requires these, a score does not.
const notForScoring = new Set(["TRANSLATION_REQUIRED", "NO_QUESTIONS"]);

// Staff-only test scoring of a draft, never run on real answers. It checks
// only what a score depends on: no translation, introduction, privacy text or
// recommendation rule is needed. Each dimension is scored on its own when its
// own configuration is complete; otherwise it is left out and its reasons are
// returned, located as the publication checklist locates them. The overall
// score needs every input dimension, as in the strict engine. The arithmetic
// is the strict engine's own (scoreCore), so on a publishable definition the
// result is identical to scoreInstrument's.
export function scoreDraft(
  input: unknown,
  answerInput: unknown,
  pin: ScorePin,
): DraftScoring {
  pinned(pin);
  const d = definition(input);
  // An unsafe or unrepresentable document is not scored at all.
  const unsafe = saveIssues(d);
  if (unsafe.length) throw new ScoringError(unsafe);
  const blocked: DraftBlocks = { dimensions: {}, overall: [], unassigned: [] },
    against = (id: string, issue: DefinitionIssue) =>
      (blocked.dimensions[id] ??= []).push(issue);
  for (const issue of definitionIssues(d, true)) {
    const at = issue.location;
    if (notForScoring.has(issue.code) || !at || at.kind === "rule") continue;
    if (at.kind === "overall" || (at.kind === "band" && !at.dimension))
      blocked.overall.push(issue);
    else if (at.kind === "dimension" || at.kind === "band")
      against(d.dimensions[at.dimension!.n - 1].id, issue);
    else if (at.section && at.question) {
      const q = d.sections[at.section.n - 1].questions[at.question.n - 1];
      // An unscored question's configuration does not touch any score.
      if (!q.scoring.enabled) continue;
      if (q.dimensionId) against(q.dimensionId, issue);
      else blocked.unassigned.push(issue);
    }
  }
  const ready = (id: string) => !blocked.dimensions[id];
  if (d.overall.enabled)
    for (const input of d.overall.inputs)
      if (
        d.dimensions.some((x) => x.id === input.dimensionId) &&
        !ready(input.dimensionId)
      )
        blocked.overall.push({
          path: input.dimensionId,
          code: "INPUT_INCOMPLETE",
          location: locateIssue(d, input.dimensionId),
        });
  const { answers, missingRequired } = validateAnswers(d, answerInput);
  return {
    scores: scoreCore(
      d,
      answers,
      missingRequired,
      pin,
      ready,
      !blocked.overall.length,
    ),
    blocked,
  };
}

// The arithmetic both entry points share. `scorable` and `overallReady` are
// always true for the strict engine; a draft passes only the dimensions whose
// configuration is complete.
function scoreCore(
  d: Instrument,
  answers: Answers,
  missingRequired: string[],
  pin: ScorePin,
  scorable: (dimensionId: string) => boolean,
  overallReady: boolean,
): ScoringResult {
  const dimensions: Record<string, Metric> = {},
    exact = new Map<string, ScoreNumber>();
  for (const dim of d.dimensions.filter((x) => scorable(x.id))) {
    const items = d.sections
      .flatMap((s) => s.questions)
      .filter((q) => q.scoring.enabled && q.dimensionId === dim.id)
      .flatMap((q) => {
        const [lower, upper] = itemBounds(q);
        return (q.type === "MATRIX" ? q.rows : [{ id: q.id, weight: "1" }]).map(
          (row) => {
            const x = mapped(q, row.id, answers),
              raw =
                x === null
                  ? null
                  : q.scoring.reverse
                    ? lower.add(upper).sub(x)
                    : x;
            return {
              lower,
              upper,
              raw,
              normalized:
                x === null
                  ? null
                  : normalize(x, lower, upper, q.scoring.reverse),
              weight:
                dim.mode === "WEIGHTED_AVERAGE"
                  ? N(q.scoring.weight).mul(N(row.weight))
                  : N(1),
            };
          },
        );
      });
    const answered = items.filter((x) => x.raw !== null),
      weights = answered.map((x) => x.weight),
      all = dim.mode === "SUM" || dim.mode === "PERCENTAGE";
    const coverage = total(weights).div(total(items.map((x) => x.weight)));
    let value: ScoreNumber | null = null,
      raw: ScoreNumber | null = null;
    if (answered.length && coverage.compare(N(all ? "1" : dim.coverage)) >= 0) {
      const raws = answered.map((x) => x.raw!),
        normalized = answered.map((x) => x.normalized!);
      if (dim.mode === "SUM") {
        raw = total(raws);
        value = normalize(
          raw,
          total(items.map((x) => x.lower)),
          total(items.map((x) => x.upper)),
        );
      } else if (dim.mode === "PERCENTAGE") {
        raw = total(raws);
        value = raw.mul(N(100)).div(N(dim.denominator!));
      } else {
        value = mean(normalized, weights);
        if (
          items.every(
            (x) =>
              x.lower.compare(items[0].lower) === 0 &&
              x.upper.compare(items[0].upper) === 0,
          )
        )
          raw = mean(raws, weights);
      }
      exact.set(dim.id, value);
    }
    dimensions[dim.id] = metric(
      value,
      raw,
      coverage,
      dim.direction,
      dim.bands,
      pin,
      all,
    );
  }
  let overall: Metric | null = null;
  if (d.overall.enabled && overallReady) {
    const available = d.overall.inputs.filter((i) => exact.has(i.dimensionId));
    const value =
      available.length === d.overall.inputs.length
        ? mean(
            available.map((i) =>
              i.invert
                ? N(100).sub(exact.get(i.dimensionId)!)
                : exact.get(i.dimensionId)!,
            ),
            available.map((i) => N(i.weight)),
          )
        : null;
    overall = metric(
      value,
      null,
      N(available.length).div(N(d.overall.inputs.length)),
      d.overall.direction,
      d.overall.bands,
      pin,
      true,
    );
  }
  return {
    engineVersion: ENGINE_VERSION,
    configVersion: pin.configVersion,
    dimensions,
    overall,
    unscored: d.sections
      .flatMap((s) => s.questions)
      .filter((q) => !q.scoring.enabled && q.type !== "CONTENT")
      .flatMap((q) => (q.type === "MATRIX" ? q.rows.map((r) => r.id) : [q.id])),
    missingRequired,
  };
}

// Internal math primitive only, never a release API. Disclosure and organization
// authorization belong to the future publication boundary.
export function respondentMean(values: readonly (number | null)[]): {
  value: number | null;
  contributors: number;
} {
  const valid = values.filter((x): x is number => x !== null);
  if (valid.some((x) => !Number.isFinite(x) || x < 0 || x > 100))
    throw new Error("INVALID_SCORE");
  return {
    value: valid.length
      ? valid.reduce((a, b) => a + b, 0) / valid.length
      : null,
    contributors: valid.length,
  };
}
