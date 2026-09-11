"use client";
import {
  type Translation,
  type Question,
  type Instrument,
  type Dimension,
  newIdentity,
  tr,
  moveItem,
  duplicateItem,
} from "../../../../src/instrument-input";
type T = (ar: string, en: string) => string;
export function Translated({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Translation;
  onChange: (v: Translation) => void;
}) {
  return (
    <div className="form-grid">
      {(["ar", "en"] as const).map((l) => (
        <label key={l}>
          {label} — {l === "ar" ? "العربية" : "English"}
          <textarea
            lang={l}
            dir={l === "ar" ? "rtl" : "ltr"}
            value={value[l]}
            maxLength={10000}
            onChange={(e) => onChange({ ...value, [l]: e.target.value })}
          />
        </label>
      ))}
    </div>
  );
}
export function Order({
  index,
  count,
  onMove,
  onCopy,
  onRemove,
  t,
}: {
  index: number;
  count: number;
  onMove: (by: number) => void;
  onCopy: () => void;
  onRemove: () => void;
  t: T;
}) {
  return (
    <div className="row">
      <button type="button" disabled={!index} onClick={() => onMove(-1)}>
        {t("نقل لأعلى", "Move up")}
      </button>
      <button
        type="button"
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        {t("نقل لأسفل", "Move down")}
      </button>
      <button type="button" onClick={onCopy}>
        {t("تكرار", "Duplicate")}
      </button>
      <button type="button" onClick={onRemove}>
        {t("إزالة", "Remove")}
      </button>
    </div>
  );
}
export function QuestionEditor({
  q,
  change,
  dimensions,
  t,
}: {
  q: Question;
  change: (q: Question) => void;
  dimensions: Dimension[];
  t: T;
}) {
  const set = (patch: Partial<Question>) => change({ ...q, ...patch });
  const config = (k: string, value: unknown) => {
    const v = { ...q.validation, [k]: value };
    if (value === "" || value === undefined)
      delete (v as Record<string, unknown>)[k];
    set({ validation: v });
  };
  const list = (kind: "options" | "rows" | "columns") => (
    <div className="stack">
      <h4>
        {kind === "rows"
          ? t("صفوف المصفوفة الثابتة", "Fixed matrix rows")
          : kind === "columns"
            ? t("أعمدة المصفوفة", "Matrix columns")
            : t("الخيارات", "Options")}
      </h4>
      {q[kind].map((o, i) => (
        <fieldset key={o.id}>
          <legend>{i + 1}</legend>
          <Translated
            label={t("النص", "Label")}
            value={o.label}
            onChange={(label) =>
              set({
                [kind]: q[kind].map((x) =>
                  x.id === o.id ? { ...x, label } : x,
                ),
              })
            }
          />
          {"weight" in o ? (
            <label>
              {t("وزن الصف", "Row weight")}
              <input
                inputMode="decimal"
                value={o.weight}
                onChange={(e) =>
                  set({
                    rows: q.rows.map((x) =>
                      x.id === o.id ? { ...x, weight: e.target.value } : x,
                    ),
                  })
                }
              />
            </label>
          ) : q.type !== "YES_NO" ? (
            <label>
              {t(
                "قيمة الخيار للقياس (فارغ لغير المقاس)",
                "Option score (blank for unscored)",
              )}
              <input
                inputMode="decimal"
                value={o.score ?? ""}
                onChange={(e) =>
                  set({
                    [kind]: (q[kind] as Question["options"]).map((x) =>
                      x.id === o.id
                        ? { ...x, score: e.target.value || null }
                        : x,
                    ),
                  })
                }
              />
            </label>
          ) : null}
          {q.type !== "YES_NO" && (
            <Order
              index={i}
              count={q[kind].length}
              t={t}
              onMove={(by) =>
                set({ [kind]: moveItem(q[kind] as Question["options"], i, by) })
              }
              onCopy={() => set({ [kind]: [...q[kind], duplicateItem(o)] })}
              onRemove={() =>
                set({ [kind]: q[kind].filter((x) => x.id !== o.id) })
              }
            />
          )}
        </fieldset>
      ))}
      {q.type !== "YES_NO" && (
        <button
          type="button"
          onClick={() =>
            set({
              [kind]: [
                ...q[kind],
                {
                  ...newIdentity(),
                  label: tr(),
                  ...(kind === "rows" ? { weight: "1" } : { score: null }),
                },
              ],
            })
          }
        >
          {t("إضافة عنصر", "Add item")}
        </button>
      )}
    </div>
  );
  return (
    <div className="stack">
      <Translated
        label={t("السؤال / المحتوى", "Prompt / content")}
        value={q.prompt}
        onChange={(prompt) => set({ prompt })}
      />
      <Translated
        label={t(
          "إرشادات (وتسميات طرفي التقييم)",
          "Help (including rating endpoints)",
        )}
        value={q.help}
        onChange={(help) => set({ help })}
      />
      {q.type !== "CONTENT" && (
        <label className="choice">
          <input
            type="checkbox"
            checked={q.required}
            onChange={(e) =>
              set({
                required: e.target.checked,
                ...(q.type === "CHECKBOXES"
                  ? {
                      validation: {
                        ...q.validation,
                        minSelections: e.target.checked
                          ? Math.max(1, q.validation.minSelections ?? 0)
                          : 0,
                      },
                    }
                  : {}),
              })
            }
          />
          {t("إجابة مطلوبة", "Required answer")}
        </label>
      )}
      {["SHORT_TEXT", "LONG_TEXT"].includes(q.type) && (
        <label>
          {t("الحد الأقصى للأحرف", "Maximum characters")}
          <input
            type="number"
            min={1}
            max={10000}
            value={q.validation.maxLength ?? ""}
            onChange={(e) =>
              config(
                "maxLength",
                e.target.value ? Number(e.target.value) : undefined,
              )
            }
          />
        </label>
      )}
      {q.type === "CHECKBOXES" && (
        <div className="form-grid">
          {["minSelections", "maxSelections"].map((k, i) => (
            <label key={k}>
              {i
                ? t("أقصى عدد اختيارات", "Maximum selections")
                : t("أقل عدد اختيارات", "Minimum selections")}
              <input
                type="number"
                min={0}
                value={q.validation[k as "minSelections"] ?? ""}
                onChange={(e) =>
                  config(k, e.target.value ? Number(e.target.value) : undefined)
                }
              />
            </label>
          ))}
        </div>
      )}
      {q.type === "NUMBER" && (
        <div className="form-grid">
          {["min", "max", "precision"].map((k, i) => (
            <label key={k}>
              {
                [
                  t("الحد الأدنى", "Minimum"),
                  t("الحد الأعلى", "Maximum"),
                  t("المنازل العشرية", "Decimal places"),
                ][i]
              }
              <input
                inputMode="decimal"
                value={q.validation[k as "min"] ?? ""}
                onChange={(e) =>
                  config(
                    k,
                    k === "precision"
                      ? e.target.value
                        ? Number(e.target.value)
                        : undefined
                      : e.target.value,
                  )
                }
              />
            </label>
          ))}
        </div>
      )}
      {q.type === "DATE" && (
        <div className="form-grid">
          {["minDate", "maxDate"].map((k, i) => (
            <label key={k}>
              {i
                ? t("آخر تاريخ", "Latest date")
                : t("أول تاريخ", "Earliest date")}
              <input
                type="date"
                value={q.validation[k as "minDate"] ?? ""}
                onChange={(e) => config(k, e.target.value)}
              />
            </label>
          ))}
        </div>
      )}
      {["MULTIPLE_CHOICE", "CHECKBOXES", "DROPDOWN", "YES_NO"].includes(
        q.type,
      ) && list("options")}
      {q.type === "MATRIX" && (
        <>
          {list("rows")}
          {list("columns")}
        </>
      )}
      {!["CONTENT", "SHORT_TEXT", "LONG_TEXT", "DATE"].includes(q.type) && (
        <fieldset>
          <legend>
            {t("إعداد القياس التصريحي", "Declarative scoring configuration")}
          </legend>
          <label className="choice">
            <input
              type="checkbox"
              checked={q.scoring.enabled}
              onChange={(e) =>
                set({
                  dimensionId: e.target.checked ? q.dimensionId : null,
                  scoring: {
                    ...q.scoring,
                    enabled: e.target.checked,
                    reverse: false,
                    mode:
                      e.target.checked && q.type === "CHECKBOXES"
                        ? "OPTION_SUM"
                        : "VALUE",
                  },
                })
              }
            />
            {t("إدراج في القياس", "Include in scoring")}
          </label>
          {q.scoring.enabled && (
            <div className="stack">
              <label>
                {t("البعد الأساسي", "Primary dimension")}
                <select
                  value={q.dimensionId ?? ""}
                  onChange={(e) => set({ dimensionId: e.target.value || null })}
                >
                  <option value="">
                    {t("اختر بعداً", "Choose dimension")}
                  </option>
                  {dimensions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name.ar ||
                        d.name.en ||
                        t("بعد دون اسم", "Untitled dimension")}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("وزن السؤال", "Question weight")}
                <input
                  inputMode="decimal"
                  value={q.scoring.weight}
                  onChange={(e) =>
                    set({ scoring: { ...q.scoring, weight: e.target.value } })
                  }
                />
              </label>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={q.scoring.reverse}
                  onChange={(e) =>
                    set({
                      scoring: { ...q.scoring, reverse: e.target.checked },
                    })
                  }
                />
                {t("عكس القياس", "Reverse scoring")}
              </label>
              {q.type === "CHECKBOXES" && (
                <label>
                  {t("طريقة قياس الاختيارات", "Checkbox scoring mode")}
                  <select
                    value={q.scoring.mode}
                    onChange={(e) =>
                      set({
                        scoring: {
                          ...q.scoring,
                          mode: e.target.value as Question["scoring"]["mode"],
                        },
                      })
                    }
                  >
                    <option value="OPTION_SUM">
                      {t("مجموع قيم الخيارات", "Option sum")}
                    </option>
                    <option value="SELECTED_PERCENTAGE">
                      {t("نسبة الخيارات المحددة", "Selected-count percentage")}
                    </option>
                  </select>
                </label>
              )}
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}
export function Bands({
  items,
  change,
  t,
}: {
  items: Dimension["bands"];
  change: (v: Dimension["bands"]) => void;
  t: T;
}) {
  return (
    <div className="stack">
      <p>
        {t(
          "النطاقات اختيارية. عند إضافتها يجب أن تغطي ٠–١٠٠ بلا فجوات أو تداخل؛ الحد الأعلى شامل في النطاق الأخير فقط.",
          "Bands are optional. If configured, cover 0–100 without gaps or overlaps; only the last upper endpoint is inclusive.",
        )}
      </p>
      {items.map((b, i) => (
        <fieldset key={b.id}>
          <legend>
            {t("نطاق", "Band")} {i + 1}
          </legend>
          <div className="form-grid">
            {(["lower", "upper"] as const).map((k) => (
              <label key={k}>
                {k === "lower"
                  ? t("من (شامل)", "From (inclusive)")
                  : t("إلى", "To")}
                <input
                  inputMode="decimal"
                  value={b[k]}
                  onChange={(e) =>
                    change(
                      items.map((x) =>
                        x.id === b.id ? { ...x, [k]: e.target.value } : x,
                      ),
                    )
                  }
                />
              </label>
            ))}
          </div>
          <Translated
            label={t("تسمية النطاق", "Band label")}
            value={b.label}
            onChange={(label) =>
              change(items.map((x) => (x.id === b.id ? { ...x, label } : x)))
            }
          />
          <div className="form-grid">
            <label>
              {t("الشدة", "Severity")}
              <select
                value={b.severity}
                onChange={(e) =>
                  change(
                    items.map((x) =>
                      x.id === b.id
                        ? {
                            ...x,
                            severity: e.target.value as typeof b.severity,
                          }
                        : x,
                    ),
                  )
                }
              >
                {["NONE", "LOW", "MODERATE", "HIGH", "CRITICAL"].map((v, j) => (
                  <option key={v} value={v}>
                    {
                      [
                        t("لا توجد", "None"),
                        t("منخفضة", "Low"),
                        t("متوسطة", "Moderate"),
                        t("عالية", "High"),
                        t("حرجة", "Critical"),
                      ][j]
                    }
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("الدلالة", "Meaning")}
              <select
                value={b.semantic}
                onChange={(e) =>
                  change(
                    items.map((x) =>
                      x.id === b.id
                        ? {
                            ...x,
                            semantic: e.target.value as typeof b.semantic,
                          }
                        : x,
                    ),
                  )
                }
              >
                {["HEALTH", "RISK", "NEUTRAL"].map((v, j) => (
                  <option key={v} value={v}>
                    {
                      [
                        t("صحة", "Health"),
                        t("مخاطر", "Risk"),
                        t("محايد", "Neutral"),
                      ][j]
                    }
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Order
            index={i}
            count={items.length}
            t={t}
            onMove={(by) => change(moveItem(items, i, by))}
            onCopy={() => change([...items, duplicateItem(b)])}
            onRemove={() => change(items.filter((x) => x.id !== b.id))}
          />
        </fieldset>
      ))}
      <button
        type="button"
        onClick={() =>
          change([
            ...items,
            {
              ...newIdentity(),
              lower: items.at(-1)?.upper ?? "0",
              upper: "100",
              label: tr(),
              severity: "NONE",
              semantic: "NEUTRAL",
            },
          ])
        }
      >
        {t("إضافة نطاق", "Add band")}
      </button>
    </div>
  );
}
export function DimensionsEditor({
  d,
  change,
  t,
}: {
  d: Instrument;
  change: (d: Instrument) => void;
  t: T;
}) {
  const update = (id: string, patch: Partial<Dimension>) =>
    change({
      ...d,
      dimensions: d.dimensions.map((x) =>
        x.id === id ? { ...x, ...patch } : x,
      ),
    });
  return (
    <div className="stack">
      <p>
        {t(
          "تُحفظ الإعدادات فقط؛ الحساب والمعاينة الرقمية في المرحلة ٥. صفوف المصفوفة عناصر قياس مستقلة بأوزانها.",
          "Configuration is stored only; computation and score preview belong to Phase 5. Matrix rows are separate weighted scoring items.",
        )}
      </p>
      {d.dimensions.map((dim, i) => (
        <fieldset key={dim.id}>
          <legend>
            {t("البعد", "Dimension")} {i + 1}
          </legend>
          <Translated
            label={t("اسم البعد", "Dimension name")}
            value={dim.name}
            onChange={(name) => update(dim.id, { name })}
          />
          <Translated
            label={t("الوصف", "Description")}
            value={dim.description}
            onChange={(description) => update(dim.id, { description })}
          />
          <div className="form-grid">
            <label>
              {t("التجميع", "Aggregation")}
              <select
                value={dim.mode}
                onChange={(e) =>
                  update(dim.id, {
                    mode: e.target.value as Dimension["mode"],
                    denominator: e.target.value === "PERCENTAGE" ? "1" : null,
                    coverage: ["SUM", "PERCENTAGE"].includes(e.target.value)
                      ? "1"
                      : dim.coverage,
                  })
                }
              >
                {["AVERAGE", "WEIGHTED_AVERAGE", "SUM", "PERCENTAGE"].map(
                  (v, j) => (
                    <option key={v} value={v}>
                      {
                        [
                          t("متوسط", "Average"),
                          t("متوسط مرجح", "Weighted average"),
                          t("مجموع", "Sum"),
                          t("نسبة نعم من عدد ثابت", "Yes-count percentage"),
                        ][j]
                      }
                    </option>
                  ),
                )}
              </select>
            </label>
            <label>
              {t("أقل تغطية (٠ إلى ١)", "Minimum coverage (0 to 1)")}
              <input
                inputMode="decimal"
                value={dim.coverage}
                onChange={(e) => update(dim.id, { coverage: e.target.value })}
              />
            </label>
            <label>
              {t("الاتجاه", "Direction")}
              <select
                value={dim.direction}
                onChange={(e) =>
                  update(dim.id, {
                    direction: e.target.value as Dimension["direction"],
                  })
                }
              >
                <option value="HIGH_GOOD">
                  {t("الأعلى أفضل", "Higher is better")}
                </option>
                <option value="HIGH_RISK">
                  {t("الأعلى أكثر خطورة", "Higher is riskier")}
                </option>
              </select>
            </label>
            {dim.mode === "PERCENTAGE" && (
              <label>
                {t(
                  "المقام الثابت (عدد أسئلة نعم/لا المطلوبة)",
                  "Fixed denominator (required yes/no item count)",
                )}
                <input
                  inputMode="decimal"
                  value={dim.denominator ?? ""}
                  onChange={(e) =>
                    update(dim.id, { denominator: e.target.value })
                  }
                />
              </label>
            )}
          </div>
          <Bands
            items={dim.bands}
            change={(bands) => update(dim.id, { bands })}
            t={t}
          />
          <button
            type="button"
            onClick={() =>
              change({
                ...d,
                dimensions: d.dimensions.filter((x) => x.id !== dim.id),
                sections: d.sections.map((s) => ({
                  ...s,
                  questions: s.questions.map((q) =>
                    q.dimensionId === dim.id
                      ? {
                          ...q,
                          dimensionId: null,
                          scoring: {
                            ...q.scoring,
                            enabled: false,
                            reverse: false,
                            mode: "VALUE",
                          },
                        }
                      : q,
                  ),
                })),
                overall: {
                  ...d.overall,
                  inputs: d.overall.inputs.filter(
                    (x) => x.dimensionId !== dim.id,
                  ),
                },
              })
            }
          >
            {t(
              "إزالة البعد وفك ارتباط الأسئلة",
              "Remove dimension and unassign questions",
            )}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        onClick={() =>
          change({
            ...d,
            dimensions: [
              ...d.dimensions,
              {
                ...newIdentity(),
                name: tr(),
                description: tr(),
                mode: "AVERAGE",
                coverage: "0.8",
                direction: "HIGH_GOOD",
                denominator: null,
                bands: [],
              },
            ],
          })
        }
      >
        {t("إضافة بعد", "Add dimension")}
      </button>
      <fieldset>
        <legend>{t("القياس الكلي", "Overall metric")}</legend>
        <label className="choice">
          <input
            type="checkbox"
            checked={d.overall.enabled}
            onChange={(e) =>
              change({
                ...d,
                overall: {
                  ...d.overall,
                  enabled: e.target.checked,
                  inputs: [],
                  bands: [],
                },
              })
            }
          />
          {t(
            "تفعيل متوسط أبعاد مرجح صريح",
            "Enable explicit weighted dimension mean",
          )}
        </label>
        {d.overall.enabled && (
          <div className="stack">
            <label>
              {t("الاتجاه الكلي", "Overall direction")}
              <select
                value={d.overall.direction}
                onChange={(e) =>
                  change({
                    ...d,
                    overall: {
                      ...d.overall,
                      direction: e.target.value as Dimension["direction"],
                    },
                  })
                }
              >
                <option value="HIGH_GOOD">
                  {t("الأعلى أفضل", "Higher is better")}
                </option>
                <option value="HIGH_RISK">
                  {t("الأعلى أكثر خطورة", "Higher is riskier")}
                </option>
              </select>
            </label>
            {d.dimensions.map((dim) => {
              const input = d.overall.inputs.find(
                (x) => x.dimensionId === dim.id,
              );
              return (
                <fieldset key={dim.id}>
                  <legend>{dim.name.ar || dim.name.en}</legend>
                  <label className="choice">
                    <input
                      type="checkbox"
                      checked={!!input}
                      onChange={(e) =>
                        change({
                          ...d,
                          overall: {
                            ...d.overall,
                            inputs: e.target.checked
                              ? [
                                  ...d.overall.inputs,
                                  {
                                    dimensionId: dim.id,
                                    weight: "1",
                                    invert:
                                      dim.direction !== d.overall.direction,
                                  },
                                ]
                              : d.overall.inputs.filter(
                                  (x) => x.dimensionId !== dim.id,
                                ),
                          },
                        })
                      }
                    />
                    {t("إدراج البعد", "Include dimension")}
                  </label>
                  {input && (
                    <>
                      <label>
                        {t("وزن البعد", "Dimension weight")}
                        <input
                          inputMode="decimal"
                          value={input.weight}
                          onChange={(e) =>
                            change({
                              ...d,
                              overall: {
                                ...d.overall,
                                inputs: d.overall.inputs.map((x) =>
                                  x.dimensionId === dim.id
                                    ? { ...x, weight: e.target.value }
                                    : x,
                                ),
                              },
                            })
                          }
                        />
                      </label>
                      <label className="choice">
                        <input
                          type="checkbox"
                          checked={input.invert}
                          onChange={(e) =>
                            change({
                              ...d,
                              overall: {
                                ...d.overall,
                                inputs: d.overall.inputs.map((x) =>
                                  x.dimensionId === dim.id
                                    ? { ...x, invert: e.target.checked }
                                    : x,
                                ),
                              },
                            })
                          }
                        />
                        {t(
                          "تحويل الاتجاه: ١٠٠ ناقص الدرجة",
                          "Invert orientation: 100 minus score",
                        )}
                      </label>
                    </>
                  )}
                </fieldset>
              );
            })}
            <Bands
              items={d.overall.bands}
              change={(bands) =>
                change({ ...d, overall: { ...d.overall, bands } })
              }
              t={t}
            />
          </div>
        )}
      </fieldset>
    </div>
  );
}
