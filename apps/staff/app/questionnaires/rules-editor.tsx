"use client";
import {
  type Instrument,
  type MetricRef,
  type RecommendationRule,
  type RuleComparison,
  comparisonOperators,
  newRule,
  moveItem,
} from "../../../../src/instrument-input";
import { Translated } from "./editors";
import { normalizeNumerals as latin } from "../../../../src/answer-rules";
type T = (ar: string, en: string) => string;

// The versioned rule editor. Everything it can express is a bounded set of
// numeric comparisons over metrics this questionnaire actually publishes:
// there is no free expression field, no code, and no model. Rules freeze when
// the version publishes, so this editor is available on a draft only — the
// enclosing fieldset is disabled otherwise, exactly like the question builder.
const refValue = (ref: MetricRef) =>
  ref.kind === "OVERALL" ? "overall" : `dimension:${ref.dimensionId}`;
const parseRef = (value: string): MetricRef =>
  value === "overall"
    ? { kind: "OVERALL" }
    : { kind: "DIMENSION", dimensionId: value.slice("dimension:".length) };

function MetricSelect({
  d,
  value,
  onChange,
  label,
}: {
  d: Instrument;
  value: MetricRef;
  onChange: (v: MetricRef) => void;
  label: string;
}) {
  return (
    <label>
      {label}
      <select
        value={refValue(value)}
        onChange={(e) => onChange(parseRef(e.target.value))}
      >
        <option value="overall">النتيجة العامة / Overall score</option>
        {d.dimensions.map((dim) => (
          <option key={dim.id} value={`dimension:${dim.id}`}>
            {dim.name.ar || dim.name.en || dim.id.slice(0, 8)}
          </option>
        ))}
      </select>
    </label>
  );
}

function Comparisons({
  d,
  items,
  change,
  t,
}: {
  d: Instrument;
  items: RuleComparison[];
  change: (v: RuleComparison[]) => void;
  t: T;
}) {
  const update = (index: number, patch: Partial<RuleComparison>) =>
    change(items.map((x, i) => (i === index ? { ...x, ...patch } : x)));
  return (
    <div className="stack">
      {items.map((c, i) => (
        <div className="form-grid" key={i}>
          <MetricSelect
            d={d}
            value={c.metric}
            label={t("المؤشر", "Metric")}
            onChange={(metric) => update(i, { metric })}
          />
          <label>
            {t("المقارنة", "Comparison")}
            <select
              value={c.operator}
              onChange={(e) =>
                update(i, {
                  operator: e.target.value as RuleComparison["operator"],
                  upper: e.target.value === "BETWEEN" ? (c.upper ?? "100") : null,
                })
              }
            >
              {comparisonOperators.map((op, j) => (
                <option key={op} value={op}>
                  {
                    [
                      t("أقل من", "Less than"),
                      t("أقل من أو يساوي", "At most"),
                      t("أكبر من", "Greater than"),
                      t("أكبر من أو يساوي", "At least"),
                      t("ضمن نطاق", "Within range"),
                    ][j]
                  }
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("القيمة (٠ إلى ١٠٠)", "Value (0 to 100)")}
            <input
              inputMode="decimal"
              value={c.value}
              onChange={(e) => update(i, { value: latin(e.target.value) })}
            />
          </label>
          {c.operator === "BETWEEN" && (
            <label>
              {t("إلى (غير شامل)", "Up to (exclusive)")}
              <input
                inputMode="decimal"
                value={c.upper ?? ""}
                onChange={(e) => update(i, { upper: latin(e.target.value) })}
              />
            </label>
          )}
          {items.length > 1 && (
            <button
              type="button"
              onClick={() => change(items.filter((_, j) => j !== i))}
            >
              {t("حذف الشرط", "Remove comparison")}
            </button>
          )}
        </div>
      ))}
      {items.length < 6 && (
        <button
          type="button"
          onClick={() =>
            change([
              ...items,
              { metric: items[0].metric, operator: "LT", value: "50", upper: null },
            ])
          }
        >
          {t("إضافة شرط", "Add comparison")}
        </button>
      )}
    </div>
  );
}

export function RulesEditor({
  d,
  change,
  t,
}: {
  d: Instrument;
  change: (d: Instrument) => void;
  t: T;
}) {
  const rules = d.recommendations;
  const update = (id: string, patch: Partial<RecommendationRule>) =>
    change({
      ...d,
      recommendations: rules.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    });
  return (
    <div className="stack">
      <p>
        {t(
          "التوصيات قواعد حتمية على النتائج المجمّعة المعتمدة فقط. لا تعتمد على ذكاء اصطناعي، ولا تُقيَّم على نتيجة محجوبة: أي مدخل غير منشور يُعامل «غير معروف» فلا تظهر القاعدة إطلاقًا.",
          "Recommendations are deterministic rules over approved aggregate results only. They use no AI and never evaluate a withheld result: an unpublished input is UNKNOWN, and the rule then does not appear at all.",
        )}
      </p>
      <p>
        {t(
          "تُجمَّد القواعد ونصوصها مع نشر النسخة؛ أي تعديل يحتاج نسخة مسودة جديدة. قواعد المقارنة التاريخية غير متاحة حتى تُنفَّذ المقارنة المتوافقة.",
          "Rules and their text freeze when the version publishes; a change requires a new draft version. Historical-change rules are unavailable until compatible comparison support exists.",
        )}
      </p>
      {rules.map((rule, index) => (
        <fieldset key={rule.id}>
          <legend>
            {t("قاعدة", "Rule")} {index + 1}
          </legend>
          <div className="form-grid">
            <MetricSelect
              d={d}
              value={rule.target}
              label={t("المؤشر المستهدف", "Target metric")}
              onChange={(target) => update(rule.id, { target })}
            />
            <label>
              {t("نطاق المجموعة", "Group scope")}
              <select
                value={rule.groupScope}
                onChange={(e) =>
                  update(rule.id, {
                    groupScope: e.target.value as RecommendationRule["groupScope"],
                  })
                }
              >
                <option value="COMPANY">{t("الشركة", "Company")}</option>
                <option value="DEPARTMENT">
                  {t("كل قسم منشور", "Each published department")}
                </option>
              </select>
            </label>
            <label>
              {t("الأولوية (الأصغر أولًا)", "Priority (lower first)")}
              <input
                inputMode="numeric"
                value={rule.priority}
                onChange={(e) =>
                  update(rule.id, { priority: Number(latin(e.target.value)) || 0 })
                }
              />
            </label>
            <label>
              {t("مفتاح منع التكرار", "Deduplication key")}
              <input
                value={rule.dedupKey}
                onChange={(e) => update(rule.id, { dedupKey: e.target.value })}
              />
            </label>
            <label>
              {t("مجموعة التعارض (اختياري)", "Exclusivity group (optional)")}
              <input
                value={rule.exclusivityGroup ?? ""}
                onChange={(e) =>
                  update(rule.id, {
                    exclusivityGroup: e.target.value.trim() || null,
                  })
                }
              />
            </label>
          </div>
          <label className="choice">
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => update(rule.id, { enabled: e.target.checked })}
            />
            {t("مفعّلة", "Enabled")}
          </label>
          <fieldset>
            <legend>{t("الشروط", "Conditions")}</legend>
            <label>
              {t("الربط بين المجموعات", "Between condition groups")}
              <select
                value={rule.condition.mode}
                onChange={(e) =>
                  update(rule.id, {
                    condition: {
                      ...rule.condition,
                      mode: e.target.value as "ALL" | "ANY",
                    },
                  })
                }
              >
                <option value="ALL">{t("كل المجموعات", "All groups")}</option>
                <option value="ANY">{t("أي مجموعة", "Any group")}</option>
              </select>
            </label>
            {rule.condition.clauses.map((clause, ci) => (
              <fieldset key={ci}>
                <legend>
                  {t("مجموعة شروط", "Condition group")} {ci + 1}
                </legend>
                <label>
                  {t("الربط داخل المجموعة", "Within this group")}
                  <select
                    value={clause.mode}
                    onChange={(e) =>
                      update(rule.id, {
                        condition: {
                          ...rule.condition,
                          clauses: rule.condition.clauses.map((x, i) =>
                            i === ci
                              ? { ...x, mode: e.target.value as "ALL" | "ANY" }
                              : x,
                          ),
                        },
                      })
                    }
                  >
                    <option value="ALL">{t("كل الشروط", "All")}</option>
                    <option value="ANY">{t("أي شرط", "Any")}</option>
                  </select>
                </label>
                <Comparisons
                  d={d}
                  items={clause.comparisons}
                  t={t}
                  change={(comparisons) =>
                    update(rule.id, {
                      condition: {
                        ...rule.condition,
                        clauses: rule.condition.clauses.map((x, i) =>
                          i === ci ? { ...x, comparisons } : x,
                        ),
                      },
                    })
                  }
                />
                {rule.condition.clauses.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      update(rule.id, {
                        condition: {
                          ...rule.condition,
                          clauses: rule.condition.clauses.filter(
                            (_, i) => i !== ci,
                          ),
                        },
                      })
                    }
                  >
                    {t("حذف المجموعة", "Remove group")}
                  </button>
                )}
              </fieldset>
            ))}
            {rule.condition.clauses.length < 4 && (
              <button
                type="button"
                onClick={() =>
                  update(rule.id, {
                    condition: {
                      ...rule.condition,
                      clauses: [
                        ...rule.condition.clauses,
                        {
                          mode: "ALL",
                          comparisons: [
                            {
                              metric: rule.target,
                              operator: "LT",
                              value: "50",
                              upper: null,
                            },
                          ],
                        },
                      ],
                    },
                  })
                }
              >
                {t("إضافة مجموعة شروط", "Add condition group")}
              </button>
            )}
          </fieldset>
          <Translated
            label={t("العنوان", "Title")}
            value={rule.title}
            onChange={(title) => update(rule.id, { title })}
          />
          <Translated
            label={t("الشرح", "Body")}
            value={rule.body}
            onChange={(body) => update(rule.id, { body })}
          />
          <Translated
            label={t("الإجراء المقترح", "Suggested action")}
            value={rule.action}
            onChange={(action) => update(rule.id, { action })}
          />
          <Translated
            label={t(
              "المسوّغ — يقبل {score} و{band} و{metric} و{group}",
              "Rationale — accepts {score}, {band}, {metric} and {group}",
            )}
            value={rule.rationale}
            onChange={(rationale) => update(rule.id, { rationale })}
          />
          <div className="row">
            {[-1, 1].map((by) => (
              <button
                type="button"
                key={by}
                onClick={() =>
                  change({
                    ...d,
                    recommendations: moveItem(rules, index, by),
                  })
                }
              >
                {by < 0 ? t("تقديم", "Move up") : t("تأخير", "Move down")}
              </button>
            ))}
            <button
              type="button"
              onClick={() =>
                change({
                  ...d,
                  recommendations: rules.filter((x) => x.id !== rule.id),
                })
              }
            >
              {t("حذف القاعدة", "Delete rule")}
            </button>
          </div>
        </fieldset>
      ))}
      {rules.length < 50 && (
        <button
          type="button"
          onClick={() =>
            change({
              ...d,
              recommendations: [
                ...rules,
                newRule(
                  d.dimensions.length
                    ? { kind: "DIMENSION", dimensionId: d.dimensions[0].id }
                    : { kind: "OVERALL" },
                ),
              ],
            })
          }
        >
          {t("إضافة قاعدة", "Add rule")}
        </button>
      )}
    </div>
  );
}
