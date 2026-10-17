import test from "node:test";
import assert from "node:assert/strict";
import { scoringFixture, pin } from "./scoring-fixtures";
import {
  scoreInstrument,
  scoreDraft,
  respondentMean,
  ScoringError,
  type Answers,
} from "../src/scoring";
import { illustrativeTemplates } from "../src/instrument-templates";
import { submitTestAnswers } from "../src/test-submission";
import {
  instrumentFixture,
  releaseInput,
  respondent,
  DIMENSION_ID,
  DEPT_A,
} from "./publication-fixtures";
import { buildReleasePlan } from "../src/disclosure";
import { selectRecommendations } from "../src/recommendation-select";
import { scoredAuthoringSteps } from "./instrument-steps";
import { N, normalize } from "../src/score-number";
import {
  definitionIssues,
  newIdentity,
  newQuestion,
  newRule,
  tr,
  type Instrument,
} from "../src/instrument-input";
import { itemBounds } from "../src/scoring-bounds";
import { syntheticBoundaryAnswers } from "../src/scoring-synthetic";
const answers = (d: Instrument, values: (string | undefined)[]): Answers =>
  Object.fromEntries(
    d.sections[0].questions.flatMap((q, i) =>
      values[i] === undefined ? [] : [[q.id, values[i]!]],
    ),
  );
const metric = (d: Instrument, a: Answers) =>
  scoreInstrument(d, a, pin).dimensions[d.dimensions[0].id];
test("malformed SUM checkbox ranges return validation issues without crashing", () => {
  for (const validation of [
    { minSelections: 3, maxSelections: 2 },
    { minSelections: 0, maxSelections: 1 },
  ]) {
    const d = scoringFixture(1, "CHECKBOXES", "SUM"),
      q = d.sections[0].questions[0];
    q.scoring.mode = "OPTION_SUM";
    q.validation = validation;
    if (validation.minSelections === 0) q.options = [];
    assert(
      definitionIssues(d, true).some(
        (i) => i.code === "ATTAINABLE_BOUNDS" || i.code === "SELECTION_RANGE",
      ),
    );
    assert.throws(
      () => scoreInstrument(d, {}, pin),
      (e: unknown) => e instanceof ScoringError,
    );
  }
});
test("golden reverse, equal mean 83.333333 and weighted 81.25", () => {
  const d = scoringFixture(),
    q = d.sections[0].questions;
  q[1].scoring.reverse = true;
  const a = answers(d, ["4", "2", "5"]),
    m = metric(d, a);
  assert.equal(m.normalized, 250 / 3);
  assert.equal(m.display, "83.3");
  assert.equal(m.raw, 13 / 3);
  assert.equal(m.engineVersion, "1.0.0");
  assert.equal(m.configVersion, pin.configVersion);
  d.dimensions[0].mode = "WEIGHTED_AVERAGE";
  q[0].scoring.weight = "2";
  assert.equal(metric(d, a).normalized, 81.25);
  assert.equal(metric(d, a).display, "81.3");
});
test("80% vs 60%, weighted coverage, optional missing never zero, collection distinct from scoring", () => {
  const d = scoringFixture(5);
  d.sections[0].questions.forEach((q) => (q.required = false));
  const a = answers(d, ["4", "3", "5", "4"]);
  assert.equal(metric(d, a).normalized, 75);
  assert.equal(metric(d, a).coverage, 0.8);
  const low = metric(d, answers(d, ["4", "3", "5"]));
  assert.equal(low.status, "INSUFFICIENT");
  assert.equal(low.normalized, null);
  assert.equal(low.raw, null);
  assert.equal(low.coverage, 0.6);
  d.dimensions[0].mode = "WEIGHTED_AVERAGE";
  d.sections[0].questions[4].scoring.weight = "10";
  assert.equal(metric(d, a).status, "INSUFFICIENT");
  d.sections[0].questions[4].scoring.weight = "1";
  const text = newQuestion("SHORT_TEXT");
  text.prompt = tr("نص", "Text");
  d.sections[0].questions.push(text);
  const result = scoreInstrument(d, a, pin);
  assert.equal(result.dimensions[d.dimensions[0].id].normalized, 75);
  assert.deepEqual(result.missingRequired, [text.id]);
  assert.deepEqual(result.unscored, [text.id]);
});
test("bounded sum 9/12, nonzero minima, fixed yes count 8/10 and all-input requirement", () => {
  const d = scoringFixture(3, "NUMBER", "SUM"),
    a = answers(d, ["2", "3", "4"]);
  assert.equal(metric(d, a).raw, 9);
  d.dimensions[0].coverage = "1.0";
  assert.equal(metric(d, a).normalized, 75);
  assert.equal(metric(d, answers(d, ["2", "3"])).normalized, null);
  const r = scoringFixture(3, "RATING_5", "SUM");
  assert.equal(metric(r, answers(r, ["3", "4", "5"])).normalized, 75);
  const y = scoringFixture(10, "YES_NO", "PERCENTAGE");
  const ya = Object.fromEntries(
    y.sections[0].questions.map((q, i) => [q.id, q.options[i < 8 ? 1 : 0].id]),
  );
  assert.equal(metric(y, ya).normalized, 80);
  assert.equal(metric(y, ya).raw, 8);
  delete ya[y.sections[0].questions[0].id];
  assert.equal(metric(y, ya).status, "INSUFFICIENT");
  y.dimensions[0].denominator = "0";
  assert.throws(() => metric(y, ya), /SCORING_VALIDATION_FAILED/);
});
test("overall 78, explicit orientation and missing configured dimensions", () => {
  const d = scoringFixture(1, "NUMBER"),
    second = scoringFixture(1, "NUMBER");
  for (const doc of [d, second])
    doc.sections[0].questions[0].validation = {
      min: "0",
      max: "100",
      precision: 2,
    };
  d.dimensions.push(second.dimensions[0]);
  d.sections[0].questions.push(second.sections[0].questions[0]);
  d.overall = {
    enabled: true,
    direction: "HIGH_GOOD",
    inputs: d.dimensions.map((dim, i) => ({
      dimensionId: dim.id,
      weight: i ? "0.4" : "0.6",
      invert: false,
    })),
    bands: [],
  };
  assert.equal(
    scoreInstrument(d, answers(d, ["70", "90"]), pin).overall?.normalized,
    78,
  );
  assert.equal(
    scoreInstrument(d, answers(d, ["70"]), pin).overall?.status,
    "INSUFFICIENT",
  );
  d.dimensions[1].direction = "HIGH_RISK";
  assert.throws(() => scoreInstrument(d, answers(d, ["70", "10"]), pin));
  d.overall.inputs[1].invert = true;
  assert.equal(
    scoreInstrument(d, answers(d, ["70", "10"]), pin).overall?.normalized,
    78,
  );
});
test("respondent-weighted company 60, eligible contributors and empty data", () => {
  assert.deepEqual(
    respondentMean([...Array(10).fill(80), ...Array(20).fill(50), null]),
    { value: 60, contributors: 30 },
  );
  assert.deepEqual(respondentMean([null]), { value: null, contributors: 0 });
  assert.throws(() => respondentMean([NaN]));
  assert.throws(() => respondentMean([101]));
});
test("continuous exact bands, final endpoint and decimal half-up before/after rounding", () => {
  const d = scoringFixture(1, "NUMBER"),
    dim = d.dimensions[0];
  d.sections[0].questions[0].validation = {
    min: "0",
    max: "100",
    precision: 6,
  };
  dim.bands = [0, 25, 50, 75].map((n, i) => ({
    ...newIdentity(),
    lower: String(n),
    upper: String(n + 25),
    label: tr(`نطاق ${i}`, `Band ${i}`),
    severity: "NONE",
    semantic: "HEALTH",
  }));
  for (const [value, index] of [
    ["0", 0],
    ["24.999999", 0],
    ["25", 1],
    ["50", 2],
    ["74.96", 2],
    ["75", 3],
    ["100", 3],
  ] as const)
    assert.equal(metric(d, answers(d, [value])).band?.id, dim.bands[index].id);
  assert.equal(metric(d, answers(d, ["74.96"])).display, "75.0");
  assert.equal(N("1.25").format(), "1.3");
  assert.equal(N("-1.25").format(), "-1.3");
  dim.bands[1].lower = "25.1";
  assert.throws(() => metric(d, answers(d, ["25"])));
});
test("matrix item times row weights and weighted missing coverage", () => {
  const d = scoringFixture(1, "MATRIX", "WEIGHTED_AVERAGE"),
    q = d.sections[0].questions[0];
  q.required = false;
  q.rows.push({ ...newIdentity(), label: tr("صف", "Row"), weight: "3" });
  q.scoring.weight = "2";
  const a = {
    [q.rows[0].id]: q.columns[0].id,
    [q.rows[1].id]: q.columns[1].id,
  };
  assert.equal(metric(d, a).normalized, 75);
  delete a[q.rows[0].id];
  assert.equal(metric(d, a).coverage, 0.75);
  assert.equal(metric(d, a).status, "INSUFFICIENT");
  d.dimensions[0].coverage = "0.75";
  assert.equal(metric(d, a).normalized, 100);
  d.dimensions[0].mode = "AVERAGE";
  assert.throws(() => metric(d, a));
});
test("checkbox attainable signed subset bounds, selected-count percentage and degenerate rejection", () => {
  const d = scoringFixture(1, "CHECKBOXES"),
    q = d.sections[0].questions[0];
  q.scoring.mode = "OPTION_SUM";
  q.options = [-5, -2, 4].map((score) => ({
    ...newIdentity(),
    label: tr("خيار", "Option"),
    score: String(score),
  }));
  q.validation = { minSelections: 1, maxSelections: 2 };
  assert.deepEqual(
    itemBounds(q).map((x) => x.number()),
    [-7, 4],
  );
  assert.equal(
    metric(d, { [q.id]: q.options.slice(0, 2).map((o) => o.id) }).normalized,
    0,
  );
  assert.equal(metric(d, { [q.id]: [q.options[2].id] }).normalized, 100);
  q.scoring.mode = "SELECTED_PERCENTAGE";
  assert.equal(metric(d, { [q.id]: [q.options[0].id] }).normalized, 0);
  assert.equal(
    metric(d, { [q.id]: q.options.slice(0, 2).map((o) => o.id) }).normalized,
    100,
  );
  q.validation.minSelections = 2;
  assert(definitionIssues(d, true).some((x) => x.code === "ATTAINABLE_BOUNDS"));
  q.scoring.mode = "OPTION_SUM";
  q.validation = { minSelections: 3, maxSelections: 3 };
  assert.throws(() => metric(d, { [q.id]: q.options.map((o) => o.id) }));
});
test("mixed scales normalize before averaging; raw sum mixed scales rejected", () => {
  const d = scoringFixture(2),
    q = d.sections[0].questions;
  q[1].type = "RATING_10";
  const m = metric(d, answers(d, ["5", "10"]));
  assert.equal(m.normalized, 100);
  assert.equal(m.raw, null);
  d.dimensions[0].mode = "SUM";
  d.dimensions[0].coverage = "1";
  assert.throws(() => metric(d, answers(d, ["5", "10"])));
});
test("runtime validates all types, unknown IDs, numerals, precision and rejects formulas and engine substitution", () => {
  const d = scoringFixture(1, "NUMBER"),
    q = d.sections[0].questions[0];
  q.validation = { min: "0", max: "100", precision: 2 };
  assert.equal(metric(d, { [q.id]: "٧٤٫٩٦" }).normalized, 74.96);
  for (const value of ["NaN", "1e2", "101", "-1", "1.001", "eval(1)", ["1"]])
    assert.throws(() => metric(d, { [q.id]: value }));
  assert.throws(() => metric(d, { bad: "5" }));
  assert.throws(() =>
    scoreInstrument(d, {}, { ...pin, engineVersion: "2.0.0" }),
  );
  const extraPin = { ...pin, formula: "1+1" };
  assert.throws(() => scoreInstrument(d, {}, extraPin));
  for (const type of [
    "MULTIPLE_CHOICE",
    "DROPDOWN",
    "YES_NO",
    "CHECKBOXES",
  ] as const) {
    const c = scoringFixture(1, type),
      cq = c.sections[0].questions[0];
    if (type === "CHECKBOXES") cq.scoring.mode = "OPTION_SUM";
    const input = type === "CHECKBOXES" ? [cq.options[0].id] : cq.options[0].id;
    assert.equal(metric(c, { [cq.id]: input }).status, "VALID");
    assert.throws(() =>
      metric(c, {
        [cq.id]:
          type === "CHECKBOXES"
            ? [cq.options[0].id, cq.options[0].id]
            : "unknown",
      }),
    );
  }
  for (const type of ["SHORT_TEXT", "LONG_TEXT", "DATE", "CONTENT"] as const) {
    const u = newQuestion(type);
    u.prompt = tr("تجربة", "Example");
    d.sections[0].questions.push(u);
    if (type === "CONTENT") assert.throws(() => metric(d, { [u.id]: "text" }));
    else {
      const value = type === "DATE" ? "2026-09-09" : "synthetic";
      assert.equal(metric(d, { [q.id]: "50", [u.id]: value }).normalized, 50);
      if (type === "DATE")
        assert.throws(() => metric(d, { [u.id]: "2026-02-30" }));
    }
  }
  q.scoring.weight = "0";
  assert.throws(() => metric(d, {}));
  q.scoring.weight = "-1";
  assert.throws(() => metric(d, {}));
});
test("normalization endpoints, reverse involution, weight scaling and deterministic nonmutation properties", () => {
  for (let lower = -10; lower <= 10; lower++)
    for (let width = 1; width <= 10; width++) {
      const l = N(lower),
        u = N(lower + width);
      assert.equal(normalize(l, l, u).number(), 0);
      assert.equal(normalize(u, l, u).number(), 100);
      for (let offset = 0; offset <= width; offset++) {
        const x = N(lower + offset);
        assert.equal(l.add(u).sub(l.add(u).sub(x)).compare(x), 0);
        assert.equal(
          normalize(x, l, u, true)
            .add(normalize(x, l, u))
            .number(),
          100,
        );
      }
    }
  const d = scoringFixture(3, "RATING_5", "WEIGHTED_AVERAGE"),
    a = answers(d, ["4", "2", "5"]);
  d.sections[0].questions.forEach((q, i) => (q.scoring.weight = String(i + 1)));
  const before = JSON.stringify({ d, a }),
    expected = scoreInstrument(d, a, pin);
  for (let i = 0; i < 25; i++)
    assert.deepEqual(scoreInstrument(d, a, pin), expected);
  assert.equal(JSON.stringify({ d, a }), before);
  d.sections[0].questions.forEach(
    (q, i) => (q.scoring.weight = String((i + 1) * 17)),
  );
  assert.equal(
    metric(d, a).normalized,
    expected.dimensions[d.dimensions[0].id].normalized,
  );
});
test("unscored instrument never invents an overall", () => {
  const d = scoringFixture();
  d.dimensions = [];
  for (const q of d.sections[0].questions) {
    q.scoring.enabled = false;
    q.dimensionId = null;
  }
  assert.deepEqual(scoreInstrument(d, {}, pin).dimensions, {});
  assert.equal(scoreInstrument(d, {}, pin).overall, null);
});
test("200 heterogeneous bounded items retain finite output with very large exact fractions", () => {
  const d = scoringFixture(200, "NUMBER");
  d.sections[0].questions.forEach((q, i) => {
    q.validation.max = String(100000019 + 2 * i);
  });
  const m = metric(d, answers(d, Array(200).fill("1")));
  assert(m.exact!.denominator.length > 308);
  assert(Number.isFinite(m.normalized));
  assert(m.normalized! > 0);
  assert.equal(m.raw, null);
});
test("boundary fixtures stay local and valid; optional empty checkboxes are missing and number bounds attainable", () => {
  for (const type of [
    "RATING_5",
    "RATING_10",
    "NUMBER",
    "YES_NO",
    "MULTIPLE_CHOICE",
    "DROPDOWN",
    "MATRIX",
    "CHECKBOXES",
  ] as const) {
    const d = scoringFixture(1, type);
    if (type === "CHECKBOXES")
      d.sections[0].questions[0].scoring.mode = "OPTION_SUM";
    for (const high of [false, true])
      assert.equal(
        metric(d, syntheticBoundaryAnswers(d, high)).normalized,
        high ? 100 : 0,
      );
  }
  const c = scoringFixture(1, "CHECKBOXES");
  c.sections[0].questions[0].scoring.mode = "OPTION_SUM";
  c.sections[0].questions[0].required = false;
  assert.equal(
    metric(c, { [c.sections[0].questions[0].id]: [] }).normalized,
    null,
  );
  const d = scoringFixture(1, "NUMBER");
  d.sections[0].questions[0].validation.min = "0.1";
  assert.throws(() => metric(d, {}));
});

// ---------------------------------------------------------------------------
// Draft scoring (questionnaire pipeline repair, Phase 2). The staff sandbox
// scores a draft without requiring it to be publishable: translations, the
// introduction and privacy text and recommendation copy are not needed to
// compute a score. It reuses the strict engine's core, so on any document the
// strict engine accepts the two must agree exactly.
// ---------------------------------------------------------------------------
function equivalenceFixtures(): { name: string; doc: Instrument }[] {
  const withBands = (d: Instrument) => {
    for (const dim of d.dimensions)
      dim.bands = [
        {
          ...newIdentity(),
          lower: "0",
          upper: "50",
          label: tr("منخفض", "Low"),
          severity: "HIGH",
          semantic: "RISK",
        },
        {
          ...newIdentity(),
          lower: "50",
          upper: "100",
          label: tr("مرتفع", "High"),
          severity: "NONE",
          semantic: "HEALTH",
        },
      ];
    d.overall = {
      enabled: true,
      direction: "HIGH_GOOD",
      inputs: d.dimensions.map((x) => ({
        dimensionId: x.id,
        weight: "1",
        invert: x.direction !== "HIGH_GOOD",
      })),
      bands: d.dimensions[0].bands.map((b) => ({ ...b, ...newIdentity() })),
    };
    return d;
  };
  const reversed = scoringFixture(3);
  reversed.sections[0].questions[1].scoring.reverse = true;
  const weighted = scoringFixture(3, "RATING_10", "WEIGHTED_AVERAGE");
  weighted.sections[0].questions[0].scoring.weight = "2.5";
  const checkboxes = scoringFixture(3, "CHECKBOXES", "AVERAGE");
  for (const q of checkboxes.sections[0].questions)
    q.scoring.mode = "OPTION_SUM";
  const percentage = scoringFixture(3, "CHECKBOXES", "AVERAGE");
  for (const q of percentage.sections[0].questions) {
    q.scoring.mode = "SELECTED_PERCENTAGE";
    q.options.push({
      ...newIdentity(),
      label: tr("خيار", "Option"),
      score: null,
    });
  }
  const risk = scoringFixture(2, "MATRIX", "AVERAGE");
  risk.dimensions[0].direction = "HIGH_RISK";
  const publication = instrumentFixture();
  publication.sections[0].questions[1].validation = {
    minSelections: 1,
    maxSelections: 2,
  };
  publication.sections[0].questions[0].scoring.enabled = true;
  publication.sections[0].questions[0].dimensionId =
    publication.dimensions[0].id;
  return [
    { name: "rating 5 average, reversed", doc: withBands(reversed) },
    { name: "rating 10 weighted", doc: withBands(weighted) },
    {
      name: "yes/no percentage",
      doc: withBands(scoringFixture(4, "YES_NO", "PERCENTAGE")),
    },
    { name: "number sum", doc: withBands(scoringFixture(3, "NUMBER", "SUM")) },
    { name: "matrix, high risk", doc: withBands(risk) },
    { name: "checkboxes option sum", doc: withBands(checkboxes) },
    { name: "checkboxes selected percentage", doc: withBands(percentage) },
    { name: "disclosure fixture", doc: publication },
    ...illustrativeTemplates().map((doc, i) => ({
      name: `illustrative template ${i + 1}`,
      doc,
    })),
    { name: "built step by step", doc: scoredAuthoringSteps().at(-1)!.doc },
  ];
}
function answerSets(d: Instrument): { name: string; answers: Answers }[] {
  const high = syntheticBoundaryAnswers(d, true),
    low = syntheticBoundaryAnswers(d, false),
    keys = Object.keys(high);
  return [
    { name: "lowest", answers: low },
    { name: "highest", answers: high },
    { name: "none", answers: {} },
    {
      name: "first half",
      answers: Object.fromEntries(
        keys.slice(0, Math.ceil(keys.length / 2)).map((k) => [k, high[k]]),
      ),
    },
    {
      name: "alternating",
      answers: Object.fromEntries(
        keys.map((k, i) => [k, i % 2 ? high[k] : low[k]]),
      ),
    },
  ];
}
test("draft scoring is byte-identical to the strict engine on every publishable fixture", () => {
  let compared = 0;
  for (const { name, doc } of equivalenceFixtures()) {
    assert.deepEqual(definitionIssues(doc, true), [], `${name} is publishable`);
    for (const set of answerSets(doc)) {
      const strict = scoreInstrument(doc, set.answers, pin),
        draft = scoreDraft(doc, set.answers, pin);
      assert.equal(
        JSON.stringify(draft.scores),
        JSON.stringify(strict),
        `${name}, ${set.name}`,
      );
      assert.deepEqual(
        draft.blocked,
        { dimensions: {}, overall: [], unassigned: [] },
        `${name}, ${set.name}`,
      );
      compared++;
    }
  }
  assert.ok(compared >= 55, `${compared} comparisons`);
});
test("draft scoring scores each complete dimension and says exactly why the others cannot be", () => {
  const d = scoringFixture(2);
  const complete = d.dimensions[0];
  // Copy that a score does not need is missing, and so is a rule's text.
  d.title.en = "";
  d.privacyText = tr();
  d.recommendations = [
    newRule({ kind: "DIMENSION", dimensionId: complete.id }),
  ];
  // A second dimension mid-build: its scored question has a new option
  // without a score, and its bands stop short of 100.
  const pending = {
    ...structuredClone(complete),
    ...newIdentity(),
    name: tr(),
    bands: [
      {
        ...newIdentity(),
        lower: "0",
        upper: "60",
        label: tr(),
        severity: "NONE" as const,
        semantic: "NEUTRAL" as const,
      },
    ],
  };
  d.dimensions.push(pending);
  const choice = newQuestion("MULTIPLE_CHOICE");
  choice.scoring.enabled = true;
  choice.dimensionId = pending.id;
  choice.options.push({ ...newIdentity(), label: tr(), score: null });
  // A scored question no dimension has been chosen for yet.
  const orphan = newQuestion("RATING_5");
  orphan.scoring.enabled = true;
  d.sections[0].questions.push(choice, orphan);
  d.overall = {
    enabled: true,
    direction: "HIGH_GOOD",
    inputs: [complete.id, pending.id].map((dimensionId) => ({
      dimensionId,
      weight: "1",
      invert: false,
    })),
    bands: [],
  };
  // The strict engine is unchanged: it refuses the whole draft.
  assert.throws(
    () => scoreInstrument(d, {}, pin),
    (e: unknown) =>
      e instanceof ScoringError &&
      e.issues.some((i) => i.code === "TRANSLATION_REQUIRED"),
  );
  const a: Answers = {
    [d.sections[0].questions[0].id]: "4",
    [d.sections[0].questions[1].id]: "2",
    [choice.id]: choice.options[1].id,
  };
  const draft = scoreDraft(d, a, pin);
  // The complete dimension is scored exactly as it would be on its own.
  const alone = structuredClone(d);
  alone.dimensions = [complete];
  alone.sections[0].questions = alone.sections[0].questions.slice(0, 2);
  alone.overall = {
    enabled: false,
    direction: "HIGH_GOOD",
    inputs: [],
    bands: [],
  };
  alone.recommendations = [];
  alone.title.en = "Synthetic";
  alone.privacyText = tr("تجربة", "Synthetic");
  assert.deepEqual(
    draft.scores.dimensions[complete.id],
    scoreInstrument(
      alone,
      Object.fromEntries(Object.entries(a).filter(([id]) => id !== choice.id)),
      pin,
    ).dimensions[complete.id],
  );
  assert.equal(draft.scores.dimensions[complete.id].normalized, 50);
  // The pending one is not scored, and the reasons are located.
  assert.equal(draft.scores.dimensions[pending.id], undefined);
  const reasons = draft.blocked.dimensions[pending.id];
  assert.deepEqual(reasons.map((i) => i.code).sort(), [
    "ATTAINABLE_BOUNDS",
    "BANDS",
    "BOUNDS_REQUIRED",
  ]);
  assert.deepEqual(
    reasons.find((i) => i.code === "BOUNDS_REQUIRED")?.location,
    {
      kind: "question",
      id: choice.id,
      section: { n: 1, title: d.sections[0].title },
      question: { n: 3, prompt: choice.prompt },
    },
  );
  assert.equal(
    reasons.find((i) => i.code === "BANDS")?.location?.kind,
    "dimension",
  );
  // Overall waits for every input, and names the one that is not ready.
  assert.equal(draft.scores.overall, null);
  assert.deepEqual(
    draft.blocked.overall.map((i) => [i.code, i.path]),
    [["INPUT_INCOMPLETE", pending.id]],
  );
  assert.equal(draft.blocked.overall[0].location?.kind, "dimension");
  // The scored question without a dimension is not counted anywhere, and says so.
  assert.deepEqual(
    draft.blocked.unassigned.map((i) => [i.code, i.path]),
    [["SCORING_ELIGIBILITY", orphan.id]],
  );
  // Nothing about copy, translations or rules is reported as a scoring reason.
  const all = [
    ...Object.values(draft.blocked.dimensions).flat(),
    ...draft.blocked.overall,
    ...draft.blocked.unassigned,
  ];
  assert.ok(
    all.every(
      (i) => i.code !== "TRANSLATION_REQUIRED" && i.location?.kind !== "rule",
    ),
  );
  // Required answers are still checked as a respondent's would be.
  assert.deepEqual(draft.scores.missingRequired, [orphan.id]);
});
// Phase 3: the preview's "submit test answers". The respondent's own final
// check (validateAnswers, then nothing required may be missing), then draft
// scoring. It is a pure function: no request, storage or log.
test("a test submission checks required answers like a respondent's and scores like the sandbox", () => {
  const d = scoringFixture(3);
  d.sections[0].questions[2].required = false;
  d.dimensions[0].coverage = "0.6";
  const [q1, q2] = d.sections[0].questions;
  const offline = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("a test submission must not make a request");
  };
  try {
    const incomplete = submitTestAnswers(d, { [q1.id]: "4" }, pin);
    assert.deepEqual(incomplete, {
      status: "INCOMPLETE",
      missingRequired: [q2.id],
    });
    const range = submitTestAnswers(d, { [q1.id]: "4", [q2.id]: "9" }, pin);
    assert.equal(range.status, "REFUSED");
    assert.deepEqual(
      range.status === "REFUSED" &&
        range.issues.map((i) => [i.code, i.path, i.location?.kind]),
      [["ANSWER_RANGE", q2.id, "question"]],
    );
    const answers = { [q1.id]: "4", [q2.id]: "2" };
    const scored = submitTestAnswers(d, answers, pin);
    assert.equal(scored.status, "SCORED");
    assert.deepEqual(
      scored.status === "SCORED" && scored.result,
      scoreDraft(d, answers, pin),
    );
    // The optional third question is missing, not a refusal, and not zero.
    assert.equal(
      scored.status === "SCORED" &&
        scored.result.scores.dimensions[d.dimensions[0].id].normalized,
      50,
    );
    assert.deepEqual(
      answers,
      { [q1.id]: "4", [q2.id]: "2" },
      "answers are not mutated",
    );
  } finally {
    globalThis.fetch = offline;
  }
});
// Option A (D-179): the test screen lists the rules that would fire, using
// the release's own evaluator (recommendation-select.ts) on the test scores
// as if they were a published company result.
test("test recommendations are the release's own, evaluated on the test scores as a company result", () => {
  const d = instrumentFixture();
  const choice = d.sections[0].questions[0];
  choice.scoring.enabled = true;
  choice.dimensionId = DIMENSION_ID;
  d.sections[0].questions[1].validation = {
    minSelections: 1,
    maxSelections: 2,
  };
  const dimension = { kind: "DIMENSION" as const, dimensionId: DIMENSION_ID };
  const compare = (operator: "LT" | "GTE", value: string) => ({
    mode: "ALL" as const,
    clauses: [
      {
        mode: "ALL" as const,
        comparisons: [{ metric: dimension, operator, value, upper: null }],
      },
    ],
  });
  const low = {
    ...newRule(dimension),
    priority: 10,
    dedupKey: "low",
    condition: compare("LT", "60"),
  };
  low.title = tr("دعم منخفض: {score}", "Low support: {score}");
  low.body = tr("ضمن {band} في {metric}.", "Within {band} for {metric}.");
  low.action = tr("راجع الدعم.", "Review support.");
  const high = {
    ...newRule(dimension),
    priority: 20,
    dedupKey: "high",
    condition: compare("GTE", "60"),
  };
  high.title = tr("دعم جيد", "Good support");
  high.action = tr("حافظ عليه.", "Keep it.");
  const department = {
    ...structuredClone(low),
    ...newIdentity(),
    groupScope: "DEPARTMENT" as const,
    dedupKey: "dept",
  };
  const unfinished = { ...newRule(dimension), dedupKey: "draft" };
  unfinished.condition.clauses[0].comparisons[0] = {
    metric: dimension,
    operator: "BETWEEN",
    value: "10",
    upper: null,
  };
  d.recommendations = [low, high, department, unfinished];
  const [, checkbox, text, number] = d.sections[0].questions;
  const answers = {
    [choice.id]: choice.options[1].id,
    [checkbox.id]: [checkbox.options[0].id],
    [text.id]: "x",
    [number.id]: "10",
  };
  const outcome = submitTestAnswers(d, answers, pin);
  assert.equal(outcome.status, "SCORED");
  if (outcome.status !== "SCORED") return;
  assert.equal(outcome.result.scores.dimensions[DIMENSION_ID].display, "50.0");
  const tested = outcome.recommendations;
  assert.deepEqual(
    tested.fired.map((r) => r.ruleKey),
    [low.key],
  );
  assert.deepEqual(
    tested.fired[0].text.title,
    tr("دعم منخفض: 50.0", "Low support: 50.0"),
  );
  assert.deepEqual(
    tested.fired[0].text.body,
    tr("ضمن مرتفع في الرضا.", "Within High for Satisfaction."),
  );
  // The unfinished rule is not evaluated, and says why, where.
  assert.deepEqual([...new Set(tested.skipped.map((i) => i.code))].sort(), [
    "IMPOSSIBLE_CONDITION",
    "RANGE",
  ]);
  assert.ok(
    tested.skipped.every(
      (i) => i.path === unfinished.id && i.location?.kind === "rule",
    ),
  );
  // The same rules over a real release of five people whose company score is
  // the test score: what fires for the company is what the test screen shows.
  const release = buildReleasePlan(
    releaseInput(
      // Five different scores averaging 50: identical ones would be
      // suppressed as homogeneous, since they would reveal every person.
      ["40", "45", "50", "55", "60"].map((v) => respondent(DEPT_A, v)),
      5,
      d.recommendations.filter((r) => r.id !== unfinished.id),
    ),
  );
  const published = selectRecommendations({
    instrument: {
      ...d,
      recommendations: d.recommendations.filter((r) => r.id !== unfinished.id),
    },
    groups: release.groups,
    metrics: release.metrics,
    cells: release.cells,
    companyGroupKey: release.companyGroupKey,
  }).filter((r) => r.groupKey === release.companyGroupKey);
  const comparable = (r: {
    ruleKey: string;
    metricKey: string;
    severity: string;
    text: { title: unknown; body: unknown; action: unknown };
  }) => [
    r.ruleKey,
    r.metricKey,
    r.severity,
    r.text.title,
    r.text.body,
    r.text.action,
  ];
  assert.deepEqual(tested.fired.map(comparable), published.map(comparable));
  // One real respondent would publish nothing at all: below the threshold.
  assert.throws(
    () => buildReleasePlan(releaseInput([respondent(DEPT_A, "50")], 5, [low])),
    /BELOW_THRESHOLD/,
  );
});
test("draft scoring still refuses unsafe documents, foreign answers and a substituted engine", () => {
  const d = scoringFixture(2);
  d.sections[0].questions.push(structuredClone(d.sections[0].questions[0]));
  assert.throws(
    () => scoreDraft(d, {}, pin),
    (e: unknown) =>
      e instanceof ScoringError &&
      e.issues.some((i) => i.code === "DUPLICATE_KEY"),
  );
  const ok = scoringFixture(2);
  assert.throws(
    () => scoreDraft(ok, { [newIdentity().id]: "3" }, pin),
    (e: unknown) =>
      e instanceof ScoringError && e.issues[0].code === "UNKNOWN_ANSWER",
  );
  assert.throws(
    () => scoreDraft(ok, {}, { ...pin, engineVersion: "9.9.9" }),
    (e: unknown) =>
      e instanceof ScoringError && e.issues[0].code === "UNSUPPORTED_VERSION",
  );
  assert.throws(
    () => scoreDraft({ ...ok, branch: [] }, {}, pin),
    (e: unknown) =>
      e instanceof ScoringError && e.issues[0].code === "DEFINITION_FORMAT",
  );
});
