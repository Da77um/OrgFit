import test from "node:test";
import assert from "node:assert/strict";
import { scoringFixture, pin } from "./scoring-fixtures";
import {
  scoreInstrument,
  respondentMean,
  ScoringError,
  type Answers,
} from "../src/scoring";
import { N, normalize } from "../src/score-number";
import {
  definitionIssues,
  newIdentity,
  newQuestion,
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
