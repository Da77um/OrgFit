import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReleasePlan,
  OVERALL_METRIC_KEY,
  type ReleasePlan,
} from "../src/disclosure";
import {
  definitionIssues,
  ruleIssues,
  instrumentSchema,
  type Instrument,
  type MetricRef,
  type RecommendationRule,
} from "../src/instrument-input";
import {
  evaluateRecommendations,
  ruleHash,
  RULES_VERSION,
} from "../src/recommendation-engine";
import {
  COMPANY,
  DEPT_A,
  DEPT_B,
  DIMENSION_KEY,
  DIMENSION_ID,
  instrumentFixture,
  releaseInput,
  respondent,
  t,
  uid,
} from "./publication-fixtures";

// The deterministic recommendation suite. Every case runs the real disclosure
// engine first and then the real evaluator over its approved plan, because the
// property under test is exactly the join between them: a rule may see what was
// published and nothing else.

const DIMENSION_METRIC = `dimension:${DIMENSION_KEY}`;
const overallRef: MetricRef = { kind: "OVERALL" };
const dimensionRef: MetricRef = { kind: "DIMENSION", dimensionId: DIMENSION_ID };

let ruleSeed = 0;
function rule(overrides: Partial<RecommendationRule> = {}): RecommendationRule {
  ruleSeed += 1;
  return {
    id: uid(600 + ruleSeed),
    key: uid(700 + ruleSeed),
    target: overallRef,
    groupScope: "COMPANY",
    condition: {
      mode: "ALL",
      clauses: [
        {
          mode: "ALL",
          comparisons: [
            { metric: overallRef, operator: "GTE", value: "60", upper: null },
          ],
        },
      ],
    },
    priority: 100,
    dedupKey: "review",
    exclusivityGroup: null,
    title: t("عنوان", "Title"),
    body: t("النتيجة {score} ضمن {band}.", "Score is {score}, within {band}."),
    action: t("إجراء", "Action"),
    rationale: t("{metric} لـ{group}", "{metric} for {group}"),
    enabled: true,
    ...overrides,
  };
}

// A company of ten whose dimension mean is exactly 60, split so that neither
// department can be published: the department cells are the withheld inputs the
// unknown-handling cases need.
const values = ["50", "55", "60", "65", "70", "50", "55", "60", "65", "70"];
const skewed = (rules: RecommendationRule[], counts: [number, number] = [6, 4]) =>
  releaseInput(
    [
      ...values.slice(0, counts[0]).map((v) => respondent(DEPT_A, v)),
      ...values.slice(counts[0], counts[0] + counts[1]).map((v) => respondent(DEPT_B, v)),
    ],
    5,
    rules,
  );
const evaluate = (plan: ReleasePlan, instrument: Instrument) =>
  evaluateRecommendations({
    instrument,
    groups: plan.groups,
    metrics: plan.metrics,
    cells: plan.cells,
    companyGroupKey: plan.companyGroupKey,
  });
const run = (rules: RecommendationRule[], counts: [number, number] = [6, 4]) => {
  const input = skewed(rules, counts);
  const plan = buildReleasePlan(input);
  return { plan, instances: evaluate(plan, input.instrument) };
};

test("thresholds are exact and evaluated on the published value", () => {
  const { plan } = run([]);
  const company = plan.cells.find(
    (c) => c.groupKey === COMPANY && c.metricKey === OVERALL_METRIC_KEY,
  )!;
  assert.equal(company.status, "AVAILABLE");
  assert.equal(company.value, "60.0");
  // At the boundary: >=60 fires, >60 does not, and BETWEEN is half-open.
  for (const [operator, value, upper, expected] of [
    ["GTE", "60", null, 1],
    ["GT", "60", null, 0],
    ["LTE", "60", null, 1],
    ["LT", "60", null, 0],
    ["BETWEEN", "60", "70", 1],
    ["BETWEEN", "50", "60", 0],
  ] as const) {
    const { instances } = run([
      rule({
        condition: {
          mode: "ALL",
          clauses: [
            { mode: "ALL", comparisons: [{ metric: overallRef, operator, value, upper }] },
          ],
        },
      }),
    ] as RecommendationRule[]);
    assert.equal(instances.length, expected, `${operator} ${value}`);
  }
});

test("a rule that does not match produces nothing at all", () => {
  const { instances } = run([
    rule({
      condition: {
        mode: "ALL",
        clauses: [
          {
            mode: "ALL",
            comparisons: [
              { metric: overallRef, operator: "LT", value: "10", upper: null },
            ],
          },
        ],
      },
    }),
  ]);
  assert.deepEqual(instances, []);
});

test("a withheld, insufficient or missing input is UNKNOWN and never zero", () => {
  // Both departments are withheld here: 6 and 4 contributors means the
  // complementary rule removes the whole department partition.
  const { plan, instances } = run([
    rule({ groupScope: "DEPARTMENT", target: dimensionRef }),
  ]);
  for (const group of [DEPT_A, DEPT_B])
    assert.notEqual(
      plan.cells.find(
        (c) => c.groupKey === group && c.metricKey === DIMENSION_METRIC,
      )!.status,
      "AVAILABLE",
    );
  assert.deepEqual(instances, []);
  // A rule reading a metric the instrument never computed is UNKNOWN too, not
  // a zero and not an error.
  const unknownMetric = run([
    rule({
      target: { kind: "DIMENSION", dimensionId: uid(999) },
    }),
  ]);
  assert.deepEqual(unknownMetric.instances, []);
});

test("UNKNOWN is absorbing: a true branch beside an unknown one does not fire", () => {
  // ANY(overall >= 60, department dimension < 10). The first is true and
  // published; the second is withheld. Kleene logic would fire and would tell
  // the reader something about the withheld value, so this must not fire.
  const anyRule = rule({
    groupScope: "DEPARTMENT",
    target: dimensionRef,
    condition: {
      mode: "ANY",
      clauses: [
        {
          mode: "ANY",
          comparisons: [
            { metric: overallRef, operator: "GTE", value: "0", upper: null },
            { metric: dimensionRef, operator: "LT", value: "10", upper: null },
          ],
        },
      ],
    },
  });
  assert.deepEqual(run([anyRule]).instances, []);
  // With both departments publishable the same rule fires for each of them,
  // which shows the rule itself is sound and only the unknown stopped it.
  const released = run([anyRule], [5, 5]);
  assert.deepEqual(
    released.instances.map((i) => i.groupKey).sort(),
    [DEPT_A, DEPT_B].sort(),
  );
});

test("contradictory exclusive matches keep the highest priority only", () => {
  const strong = rule({
    priority: 10,
    dedupKey: "strong",
    exclusivityGroup: "overall",
    title: t("قوي", "Strong"),
  });
  const weak = rule({
    priority: 50,
    dedupKey: "weak",
    exclusivityGroup: "overall",
    title: t("ضعيف", "Weak"),
  });
  // Declared in the losing order to prove the outcome comes from priority.
  const { instances } = run([weak, strong]);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].dedupKey, "strong");
  assert.equal(instances[0].priority, 10);
});

test("duplicate findings are deduplicated per group", () => {
  const first = rule({ priority: 10, dedupKey: "same" });
  const second = rule({ priority: 20, dedupKey: "same" });
  const { instances } = run([first, second]);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].ruleKey, first.key);
  // Department scope keeps one per department rather than one overall.
  const perGroup = run(
    [
      rule({
        groupScope: "DEPARTMENT",
        target: dimensionRef,
        dedupKey: "same",
        condition: {
          mode: "ALL",
          clauses: [
            {
              mode: "ALL",
              comparisons: [
                { metric: dimensionRef, operator: "GTE", value: "0", upper: null },
              ],
            },
          ],
        },
      }),
    ],
    [5, 5],
  );
  assert.equal(perGroup.instances.length, 2);
});

test("order is deterministic and evaluation is repeatable", () => {
  const rules = [
    rule({ priority: 30, dedupKey: "c" }),
    rule({ priority: 10, dedupKey: "a" }),
    rule({ priority: 20, dedupKey: "b" }),
  ];
  const first = run(rules).instances;
  const shuffled = run([rules[2], rules[0], rules[1]]).instances;
  assert.deepEqual(
    first.map((i) => i.dedupKey),
    ["a", "b", "c"],
  );
  assert.deepEqual(first, shuffled);
});

test("evidence and severity come only from published cells of the same group", () => {
  const { plan, instances } = run(
    [
      rule({
        groupScope: "DEPARTMENT",
        target: dimensionRef,
        condition: {
          mode: "ALL",
          clauses: [
            {
              mode: "ALL",
              comparisons: [
                { metric: overallRef, operator: "GTE", value: "0", upper: null },
                { metric: dimensionRef, operator: "GTE", value: "0", upper: null },
              ],
            },
          ],
        },
      }),
    ],
    [5, 5],
  );
  assert.equal(instances.length, 2);
  for (const instance of instances) {
    for (const item of instance.evidence.items) {
      assert.equal(item.groupKey, instance.groupKey);
      const cell = plan.cells.find(
        (c) => c.groupKey === item.groupKey && c.metricKey === item.metricKey,
      )!;
      assert.equal(cell.status, "AVAILABLE");
      assert.equal(cell.value, item.value);
    }
    const target = plan.cells.find(
      (c) =>
        c.groupKey === instance.groupKey && c.metricKey === instance.metricKey,
    )!;
    assert.equal(instance.severity, target.band!.severity);
  }
});

test("localized text is frozen with substituted published values only", () => {
  const { instances } = run([rule()]);
  const [instance] = instances;
  assert.equal(instance.text.body.ar, "النتيجة 60.0 ضمن مرتفع.");
  assert.equal(instance.text.body.en, "Score is 60.0, within High.");
  assert.equal(instance.text.rationale.en, "Overall score for Company");
  // Every substituted number is a published cell value.
  assert.ok(
    instance.evidence.items.some((i) => i.value === "60.0"),
    "substituted score is published evidence",
  );
});

test("rule identity is versioned: text or thresholds change the hash", () => {
  const base = rule();
  assert.equal(ruleHash(base), ruleHash({ ...base }));
  assert.notEqual(ruleHash(base), ruleHash({ ...base, priority: 11 }));
  assert.notEqual(
    ruleHash(base),
    ruleHash({ ...base, title: t("مختلف", "Different") }),
  );
  const { instances } = run([base]);
  assert.equal(instances[0].ruleHash, ruleHash(base));
  assert.equal(RULES_VERSION, "1.0.0");
});

test("a disabled rule is configuration only", () => {
  assert.deepEqual(run([rule({ enabled: false })]).instances, []);
});

test("the editor rejects unusable rule configuration", () => {
  const issues = (r: Partial<RecommendationRule>, publish = false) =>
    ruleIssues(instrumentFixture([rule(r)]), publish).map((i) => i.code);
  assert.deepEqual(issues({}), []);
  assert.ok(
    issues({ target: { kind: "DIMENSION", dimensionId: uid(999) } }).includes(
      "REFERENCE",
    ),
  );
  assert.ok(
    issues({
      condition: {
        mode: "ALL",
        clauses: [
          {
            mode: "ALL",
            comparisons: [
              { metric: overallRef, operator: "GTE", value: "70", upper: null },
              { metric: overallRef, operator: "LT", value: "40", upper: null },
            ],
          },
        ],
      },
    }).includes("IMPOSSIBLE_CONDITION"),
  );
  // A boundary pair that IS satisfiable must not be reported as impossible.
  assert.deepEqual(
    issues({
      condition: {
        mode: "ALL",
        clauses: [
          {
            mode: "ALL",
            comparisons: [
              { metric: overallRef, operator: "GTE", value: "60", upper: null },
              { metric: overallRef, operator: "LTE", value: "60", upper: null },
            ],
          },
        ],
      },
    }),
    [],
  );
  assert.ok(
    issues({
      condition: {
        mode: "ALL",
        clauses: [
          {
            mode: "ALL",
            comparisons: [
              { metric: overallRef, operator: "BETWEEN", value: "70", upper: "40" },
            ],
          },
        ],
      },
    }).includes("RANGE"),
  );
  assert.ok(issues({ body: t("{scoree}", "{scoree}") }).includes("UNKNOWN_PLACEHOLDER"));
  assert.ok(issues({ title: t("", "") }, true).includes("TRANSLATION_REQUIRED"));
  const clash = ruleIssues(
    instrumentFixture([
      rule({ priority: 10, exclusivityGroup: "x", dedupKey: "a" }),
      rule({ priority: 10, exclusivityGroup: "x", dedupKey: "b" }),
    ]),
  ).map((i) => i.code);
  assert.ok(clash.includes("EXCLUSIVITY_PRIORITY"));
  // Rule issues travel with the ordinary definition validation the editor and
  // the publish guard already run.
  assert.ok(
    definitionIssues(
      instrumentFixture([rule({ target: { kind: "DIMENSION", dimensionId: uid(999) } })]),
    ).some((i) => i.code === "REFERENCE"),
  );
});

test("the document schema bounds the rule tree and rejects free expressions", () => {
  const parsed = instrumentSchema.safeParse({
    ...instrumentFixture(),
    recommendations: [
      { ...rule(), condition: { mode: "ALL", clauses: [], } },
    ],
  });
  assert.equal(parsed.success, false);
  const tooMany = instrumentSchema.safeParse({
    ...instrumentFixture(),
    recommendations: [
      {
        ...rule(),
        condition: {
          mode: "ALL",
          clauses: Array.from({ length: 5 }, () => ({
            mode: "ALL",
            comparisons: [
              { metric: overallRef, operator: "GTE", value: "1", upper: null },
            ],
          })),
        },
      },
    ],
  });
  assert.equal(tooMany.success, false);
  const injected = instrumentSchema.safeParse({
    ...instrumentFixture(),
    recommendations: [{ ...rule(), expression: "score > 5" }],
  });
  assert.equal(injected.success, false);
});
