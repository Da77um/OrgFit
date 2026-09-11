import { z } from "zod";
import { scoringDefinitionIssues } from "./scoring-bounds";

export const questionTypes = [
  "SHORT_TEXT",
  "LONG_TEXT",
  "MULTIPLE_CHOICE",
  "CHECKBOXES",
  "DROPDOWN",
  "YES_NO",
  "RATING_5",
  "RATING_10",
  "MATRIX",
  "NUMBER",
  "DATE",
  "CONTENT",
] as const;
export type QuestionType = (typeof questionTypes)[number];
const text = z
  .string()
  .max(10000)
  .refine(
    (v) => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v),
    "PLAIN_TEXT_ONLY",
  );
export const translation = z.object({ ar: text, en: text }).strict();
export type Translation = z.infer<typeof translation>;
const identity = { id: z.uuid(), key: z.uuid() };
const decimal = z.string().regex(/^-?(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/);
const positive = decimal.refine((v) => Number(v) > 0);
const date = z.iso.date();
const option = z
  .object({ ...identity, label: translation, score: decimal.nullable() })
  .strict();
const row = z
  .object({ ...identity, label: translation, weight: positive })
  .strict();
export const questionSchema = z
  .object({
    ...identity,
    type: z.enum(questionTypes),
    prompt: translation,
    help: translation,
    required: z.boolean().default(true),
    dimensionId: z.uuid().nullable(),
    validation: z
      .object({
        maxLength: z.number().int().min(1).max(10000).optional(),
        minSelections: z.number().int().min(0).max(100).optional(),
        maxSelections: z.number().int().min(1).max(100).optional(),
        min: decimal.optional(),
        max: decimal.optional(),
        precision: z.number().int().min(0).max(6).optional(),
        minDate: date.optional(),
        maxDate: date.optional(),
      })
      .strict(),
    scoring: z
      .object({
        enabled: z.boolean(),
        reverse: z.boolean(),
        weight: positive,
        mode: z.enum(["VALUE", "OPTION_SUM", "SELECTED_PERCENTAGE"]),
      })
      .strict(),
    options: z.array(option).max(100),
    rows: z.array(row).max(200),
    columns: z.array(option).max(100),
  })
  .strict();
export type Question = z.infer<typeof questionSchema>;
const band = z
  .object({
    ...identity,
    lower: decimal,
    upper: decimal,
    label: translation,
    severity: z.enum(["NONE", "LOW", "MODERATE", "HIGH", "CRITICAL"]),
    semantic: z.enum(["HEALTH", "RISK", "NEUTRAL"]),
  })
  .strict();
const dimension = z
  .object({
    ...identity,
    name: translation,
    description: translation,
    mode: z.enum(["AVERAGE", "WEIGHTED_AVERAGE", "SUM", "PERCENTAGE"]),
    coverage: decimal,
    direction: z.enum(["HIGH_GOOD", "HIGH_RISK"]),
    denominator: positive.nullable(),
    bands: z.array(band).max(20),
  })
  .strict();
export type Dimension = z.infer<typeof dimension>;

// ---------------------------------------------------------------------------
// Deterministic recommendation rules.
//
// A rule is questionnaire configuration, exactly like a band: it belongs to the
// version, freezes when the version publishes, and travels inside the pinned
// instrument snapshot the privacy processor carries. There is no expression
// language and no model call here — a rule is a BOUNDED tree of numeric
// comparisons over metric keys the release actually publishes, and nothing it
// can say reaches beyond that.
//
// The tree is deliberately two levels rather than an arbitrary recursion: the
// editor stays reviewable, the evaluator has no depth to run away with, and a
// reviewer can read a whole rule at once.
// ---------------------------------------------------------------------------
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/);
// Metrics are addressed by what they are, not by a published key string, so a
// rule cannot be pointed at a question distribution or an invented metric.
const metricRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("OVERALL") }).strict(),
  z.object({ kind: z.literal("DIMENSION"), dimensionId: z.uuid() }).strict(),
]);
export type MetricRef = z.infer<typeof metricRef>;
const score100 = decimal.refine(
  (v) => Number(v) >= 0 && Number(v) <= 100,
  "SCORE_RANGE",
);
export const comparisonOperators = ["LT", "LTE", "GT", "GTE", "BETWEEN"] as const;
const comparison = z
  .object({
    metric: metricRef,
    operator: z.enum(comparisonOperators),
    value: score100,
    // BETWEEN is half-open: value <= score < upper, matching band semantics.
    upper: score100.nullable(),
  })
  .strict();
export type RuleComparison = z.infer<typeof comparison>;
export const recommendationRuleSchema = z
  .object({
    ...identity,
    target: metricRef,
    groupScope: z.enum(["COMPANY", "DEPARTMENT"]),
    condition: z
      .object({
        mode: z.enum(["ALL", "ANY"]),
        clauses: z
          .array(
            z
              .object({
                mode: z.enum(["ALL", "ANY"]),
                comparisons: z.array(comparison).min(1).max(6),
              })
              .strict(),
          )
          .min(1)
          .max(4),
      })
      .strict(),
    // Lower number ranks first. Ties break on the stable rule key.
    priority: z.number().int().min(1).max(999),
    dedupKey: slug,
    exclusivityGroup: slug.nullable(),
    title: translation,
    body: translation,
    action: translation,
    rationale: translation,
    enabled: z.boolean(),
  })
  .strict();
export type RecommendationRule = z.infer<typeof recommendationRuleSchema>;
export const MAX_RULE_COMPARISONS = 12;
export const rulePlaceholders = ["score", "band", "metric", "group"] as const;

export const instrumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    locales: z
      .array(z.enum(["ar", "en"]))
      .min(1)
      .max(2)
      .refine((v) => v.includes("ar") && new Set(v).size === v.length),
    title: translation,
    introduction: translation,
    privacyText: translation,
    sections: z
      .array(
        z
          .object({
            ...identity,
            title: translation,
            content: translation,
            questions: z.array(questionSchema).max(200),
          })
          .strict(),
      )
      .max(50),
    dimensions: z.array(dimension).max(50),
    overall: z
      .object({
        enabled: z.boolean(),
        direction: z.enum(["HIGH_GOOD", "HIGH_RISK"]),
        inputs: z
          .array(
            z
              .object({
                dimensionId: z.uuid(),
                weight: positive,
                invert: z.boolean(),
              })
              .strict(),
          )
          .max(50),
        bands: z.array(band).max(20),
      })
      .strict(),
    recommendations: z.array(recommendationRuleSchema).max(50).default([]),
  })
  .strict();
export type Instrument = z.infer<typeof instrumentSchema>;
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, normalize(x)]),
          )
        : v;
  return JSON.stringify(normalize(value));
}
export const tr = (ar = "", en = ""): Translation => ({ ar, en });
export const newIdentity = () => ({
  id: crypto.randomUUID(),
  key: crypto.randomUUID(),
});
export function newQuestion(type: QuestionType): Question {
  return {
    ...newIdentity(),
    type,
    prompt: tr(),
    help: tr(),
    required: type !== "CONTENT",
    dimensionId: null,
    validation:
      type === "SHORT_TEXT"
        ? { maxLength: 500 }
        : type === "LONG_TEXT"
          ? { maxLength: 5000 }
          : type === "CHECKBOXES"
            ? { minSelections: 1, maxSelections: 2 }
            : type === "NUMBER"
              ? { precision: 0 }
              : {},
    scoring: { enabled: false, reverse: false, weight: "1", mode: "VALUE" },
    options: ["MULTIPLE_CHOICE", "CHECKBOXES", "DROPDOWN", "YES_NO"].includes(
      type,
    )
      ? [0, 1].map((n) => ({
          ...newIdentity(),
          label:
            type === "YES_NO" ? (n ? tr("نعم", "Yes") : tr("لا", "No")) : tr(),
          score: String(n),
        }))
      : [],
    rows:
      type === "MATRIX" ? [{ ...newIdentity(), label: tr(), weight: "1" }] : [],
    columns:
      type === "MATRIX"
        ? [0, 1].map((n) => ({
            ...newIdentity(),
            label: tr(),
            score: String(n),
          }))
        : [],
  };
}
export function blankInstrument(): Instrument {
  return {
    schemaVersion: 1,
    locales: ["ar"],
    title: tr(),
    introduction: tr(),
    privacyText: tr(),
    sections: [],
    dimensions: [],
    overall: { enabled: false, direction: "HIGH_GOOD", inputs: [], bands: [] },
    recommendations: [],
  };
}
export function newRule(target: MetricRef): RecommendationRule {
  return {
    ...newIdentity(),
    target,
    groupScope: "COMPANY",
    condition: {
      mode: "ALL",
      clauses: [
        {
          mode: "ALL",
          comparisons: [{ metric: target, operator: "LT", value: "50", upper: null }],
        },
      ],
    },
    priority: 100,
    dedupKey: "rule",
    exclusivityGroup: null,
    title: tr(),
    body: tr(),
    action: tr(),
    rationale: tr(),
    enabled: true,
  };
}
// Version copies retain measurement lineage keys. In-place duplication creates new
// keys as well as IDs; stable lineage alone never proves measurement equivalence.
export function copyInstrument(source: Instrument): Instrument {
  const copy = structuredClone(source),
    ids = new Map<string, string>();
  const assign = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if ("id" in v && typeof v.id === "string") {
      const old = v.id;
      v.id = crypto.randomUUID();
      ids.set(old, v.id as string);
    }
    for (const child of Object.values(v)) assign(child);
  };
  assign(copy);
  for (const s of copy.sections)
    for (const q of s.questions)
      if (q.dimensionId) q.dimensionId = ids.get(q.dimensionId)!;
  for (const input of copy.overall.inputs)
    input.dimensionId = ids.get(input.dimensionId)!;
  // Rules point at dimensions the same way overall inputs do, so a copied
  // version's rules must follow the copied dimension identities.
  for (const rule of copy.recommendations)
    for (const ref of [
      rule.target,
      ...rule.condition.clauses.flatMap((c) => c.comparisons.map((x) => x.metric)),
    ])
      if (ref.kind === "DIMENSION") ref.dimensionId = ids.get(ref.dimensionId)!;
  return copy;
}
export function duplicateItem<T>(source: T): T {
  const copy = structuredClone(source);
  const visit = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if ("id" in v) Object.assign(v, newIdentity());
    for (const child of Object.values(v)) visit(child);
  };
  visit(copy);
  return copy;
}
export function moveItem<T>(list: T[], from: number, by: number) {
  const next = [...list],
    to = from + by;
  if (to >= 0 && to < next.length)
    [next[from], next[to]] = [next[to], next[from]];
  return next;
}
export type DefinitionIssue = { path: string; code: string };
export function definitionIssues(
  d: Instrument,
  publish = false,
): DefinitionIssue[] {
  const errors: DefinitionIssue[] = [],
    add = (path: string, code: string) => errors.push({ path, code });
  const ids = new Set<string>(),
    keys = new Set<string>();
  const unique = (v: { id: string; key: string }, path: string) => {
    if (ids.has(v.id) || keys.has(v.key)) add(path, "DUPLICATE_KEY");
    ids.add(v.id);
    keys.add(v.key);
  };
  const translated = (v: Translation, path: string, required = true) => {
    if (publish && (required || v.ar.trim() || v.en.trim()))
      for (const l of d.locales)
        if (!v[l].trim()) add(path + "." + l, "TRANSLATION_REQUIRED");
  };
  translated(d.title, "title");
  translated(d.introduction, "introduction", false);
  translated(d.privacyText, "privacyText");
  const questions = d.sections.flatMap((s) => s.questions),
    answerItems = questions.reduce(
      (n, q) =>
        n +
        (q.type === "CONTENT" ? 0 : q.type === "MATRIX" ? q.rows.length : 1),
      0,
    );
  if (answerItems > 200 || (publish && answerItems === 0))
    add("sections", "QUESTION_COUNT");
  for (const s of d.sections) {
    unique(s, s.id);
    translated(s.title, s.id);
    translated(s.content, s.id + ".content", false);
    for (const q of s.questions) {
      unique(q, q.id);
      translated(q.prompt, q.id);
      translated(q.help, q.id + ".help", false);
      const choice = [
          "MULTIPLE_CHOICE",
          "CHECKBOXES",
          "DROPDOWN",
          "YES_NO",
        ].includes(q.type),
        matrix = q.type === "MATRIX",
        v = q.validation;
      const allowed =
        q.type === "SHORT_TEXT" || q.type === "LONG_TEXT"
          ? ["maxLength"]
          : q.type === "CHECKBOXES"
            ? ["minSelections", "maxSelections"]
            : q.type === "NUMBER"
              ? ["min", "max", "precision"]
              : q.type === "DATE"
                ? ["minDate", "maxDate"]
                : [];
      if (Object.keys(v).some((k) => !allowed.includes(k)))
        add(q.id, "TYPE_CONFIG");
      if (
        (!choice && q.options.length) ||
        (!matrix && (q.rows.length || q.columns.length))
      )
        add(q.id, "TYPE_CONFIG");
      if (
        publish &&
        ((choice && q.options.length < 2) ||
          (q.type === "YES_NO" && q.options.length !== 2) ||
          (matrix && (!q.rows.length || q.columns.length < 2)))
      )
        add(q.id, "OPTIONS_REQUIRED");
      for (const item of [...q.options, ...q.rows, ...q.columns]) {
        unique(item, item.id);
        translated(item.label, item.id);
      }
      if (
        q.type === "YES_NO" &&
        (q.options.length !== 2 ||
          q.options[0].score !== "0" ||
          q.options[1].score !== "1")
      )
        add(q.id, "YES_NO_MAPPING");
      if (
        q.type === "CHECKBOXES" &&
        ((v.minSelections ?? 0) < (q.required ? 1 : 0) ||
          (v.minSelections ?? 0) > (v.maxSelections ?? q.options.length) ||
          (v.maxSelections ?? q.options.length) > q.options.length)
      )
        add(q.id, "SELECTION_RANGE");
      if (
        v.min !== undefined &&
        v.max !== undefined &&
        Number(v.min) >= Number(v.max)
      )
        add(q.id, "RANGE");
      if (v.minDate && v.maxDate && v.minDate > v.maxDate) add(q.id, "RANGE");
      if (
        q.type === "CONTENT" &&
        (q.required || q.dimensionId || q.scoring.enabled)
      )
        add(q.id, "CONTENT_UNSCORED");
      if (q.dimensionId && !d.dimensions.some((x) => x.id === q.dimensionId))
        add(q.id, "REFERENCE");
      if (
        !q.scoring.enabled &&
        (q.dimensionId || q.scoring.reverse || q.scoring.mode !== "VALUE")
      )
        add(q.id, "UNSCORED");
      if (q.scoring.enabled) {
        if (
          ["CONTENT", "SHORT_TEXT", "LONG_TEXT", "DATE"].includes(q.type) ||
          !q.dimensionId
        )
          add(q.id, "SCORING_ELIGIBILITY");
        if (q.type !== "CHECKBOXES" && q.scoring.mode !== "VALUE")
          add(q.id, "SCORING_ELIGIBILITY");
        if (q.type === "CHECKBOXES" && q.scoring.mode === "VALUE")
          add(q.id, "SCORING_ELIGIBILITY");
        if (q.type === "NUMBER" && (v.min === undefined || v.max === undefined))
          add(q.id, "BOUNDS_REQUIRED");
        const opts = matrix ? q.columns : q.options;
        if (
          (choice || matrix) &&
          q.scoring.mode !== "SELECTED_PERCENTAGE" &&
          (opts.some((o) => o.score === null) ||
            new Set(opts.map((o) => Number(o.score))).size < 2)
        )
          add(q.id, "BOUNDS_REQUIRED");
      }
    }
  }
  const bands = (items: Dimension["bands"], path: string) => {
    for (const b of items) {
      unique(b, b.id);
      translated(b.label, b.id);
    }
    if (
      items.length &&
      (Number(items[0].lower) !== 0 ||
        Number(items.at(-1)!.upper) !== 100 ||
        items.some(
          (b, i) =>
            Number(b.upper) <= Number(b.lower) ||
            (i > 0 && Number(items[i - 1].upper) !== Number(b.lower)),
        ))
    )
      add(path, "BANDS");
  };
  for (const dim of d.dimensions) {
    unique(dim, dim.id);
    translated(dim.name, dim.id);
    translated(dim.description, dim.id + ".description", false);
    bands(dim.bands, dim.id);
    const items = questions.filter(
      (q) => q.dimensionId === dim.id && q.scoring.enabled,
    );
    if (Number(dim.coverage) <= 0 || Number(dim.coverage) > 1)
      add(dim.id, "COVERAGE");
    if (publish && !items.length) add(dim.id, "REFERENCE");
    if (
      ["SUM", "PERCENTAGE"].includes(dim.mode) &&
      (Number(dim.coverage) !== 1 || items.some((q) => !q.required))
    )
      add(dim.id, "ALL_REQUIRED");
    if (
      dim.mode === "PERCENTAGE"
        ? !dim.denominator ||
          items.some((q) => q.type !== "YES_NO" || q.scoring.reverse) ||
          Number(dim.denominator) !== items.length
        : dim.denominator !== null
    )
      add(dim.id, "DENOMINATOR");
  }
  bands(d.overall.bands, "overall");
  if (!d.overall.enabled && (d.overall.inputs.length || d.overall.bands.length))
    add("overall", "UNSCORED");
  if (
    d.overall.enabled &&
    (!d.overall.inputs.length ||
      new Set(d.overall.inputs.map((i) => i.dimensionId)).size !==
        d.overall.inputs.length)
  )
    add("overall", "REFERENCE");
  for (const i of d.overall.inputs) {
    const dim = d.dimensions.find((x) => x.id === i.dimensionId);
    if (!dim || (dim.direction !== d.overall.direction) !== i.invert)
      add("overall", "DIRECTION");
  }
  return [...errors, ...ruleIssues(d, publish), ...scoringDefinitionIssues(d)];
}

// Rule validation. A rule that cannot fire, cannot be read, or cannot be ranked
// deterministically is a defect at edit time, not a surprise months later when
// a release is generated and nothing appears.
export function ruleIssues(d: Instrument, publish = false): DefinitionIssue[] {
  const errors: DefinitionIssue[] = [],
    add = (path: string, code: string) => errors.push({ path, code });
  const seen = new Set<string>();
  const known = (ref: MetricRef) =>
    ref.kind === "OVERALL"
      ? d.overall.enabled
      : d.dimensions.some((x) => x.id === ref.dimensionId);
  const refKey = (ref: MetricRef) =>
    ref.kind === "OVERALL" ? "overall" : `dimension:${ref.dimensionId}`;
  // Half-open interval of the scores a comparison admits, used only to prove a
  // conjunction is unsatisfiable. It is never used to evaluate a release.
  // Configured thresholds carry at most six decimals, so a 1e-9 step is a
  // faithful stand-in for "just above" without colliding with a real value.
  const step = 1e-9;
  const span = (c: RuleComparison): [number, number] =>
    c.operator === "LT"
      ? [0, Number(c.value)]
      : c.operator === "LTE"
        ? [0, Number(c.value) + step]
        : c.operator === "GT"
          ? [Number(c.value) + step, 101]
          : c.operator === "GTE"
            ? [Number(c.value), 101]
            : [Number(c.value), Number(c.upper ?? c.value)];
  for (const rule of d.recommendations) {
    if (seen.has(rule.id) || seen.has(rule.key)) add(rule.id, "DUPLICATE_KEY");
    seen.add(rule.id);
    seen.add(rule.key);
    if (!known(rule.target)) add(rule.id, "REFERENCE");
    const comparisons = rule.condition.clauses.flatMap((c) => c.comparisons);
    if (comparisons.length > MAX_RULE_COMPARISONS) add(rule.id, "RULE_TOO_LARGE");
    for (const c of comparisons) {
      if (!known(c.metric)) add(rule.id, "REFERENCE");
      if (c.operator === "BETWEEN") {
        if (c.upper === null || Number(c.upper) <= Number(c.value))
          add(rule.id, "RANGE");
      } else if (c.upper !== null) add(rule.id, "RANGE");
    }
    // Contradiction check inside every conjunction: two comparisons on one
    // metric that no score can satisfy make the rule dead configuration.
    const conjunctions = [
      ...rule.condition.clauses
        .filter((c) => c.mode === "ALL" || c.comparisons.length === 1)
        .map((c) => c.comparisons),
      ...(rule.condition.mode === "ALL"
        ? [
            rule.condition.clauses
              .filter((c) => c.mode === "ALL" || c.comparisons.length === 1)
              .flatMap((c) => c.comparisons),
          ]
        : []),
    ];
    for (const group of conjunctions) {
      const spans = new Map<string, [number, number]>();
      for (const c of group) {
        const key = refKey(c.metric),
          [lo, hi] = span(c),
          current = spans.get(key) ?? [0, 101];
        spans.set(key, [Math.max(current[0], lo), Math.min(current[1], hi)]);
      }
      if ([...spans.values()].some(([lo, hi]) => lo >= hi))
        add(rule.id, "IMPOSSIBLE_CONDITION");
    }
    for (const [field, value] of [
      ["title", rule.title],
      ["body", rule.body],
      ["action", rule.action],
      ["rationale", rule.rationale],
    ] as const) {
      if (publish && field !== "rationale")
        for (const l of d.locales)
          if (!value[l].trim())
            add(`${rule.id}.${field}.${l}`, "TRANSLATION_REQUIRED");
      for (const l of d.locales)
        for (const token of value[l].matchAll(/\{([a-zA-Z]+)\}/g))
          if (!(rulePlaceholders as readonly string[]).includes(token[1]))
            add(`${rule.id}.${field}`, "UNKNOWN_PLACEHOLDER");
    }
  }
  // Two enabled rules that exclude each other must be rankable without a
  // tie-break on an opaque identifier, so their priorities must differ.
  const exclusive = new Map<string, number[]>();
  for (const rule of d.recommendations.filter(
    (r) => r.enabled && r.exclusivityGroup,
  )) {
    const key = `${rule.groupScope}/${rule.exclusivityGroup}`;
    const list = exclusive.get(key) ?? [];
    if (list.includes(rule.priority)) add(rule.id, "EXCLUSIVITY_PRIORITY");
    exclusive.set(key, [...list, rule.priority]);
  }
  return errors;
}
