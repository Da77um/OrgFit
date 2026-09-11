"use client";
import { useState } from "react";
import type { Instrument, Question } from "../../../../src/instrument-input";
import type { ScorePin } from "../../../../src/scoring";
import { ScoringSandbox } from "./scoring-sandbox";
import { syntheticBoundaryAnswers } from "../../../../src/scoring-synthetic";
export function InstrumentPreview({
  document: d,
  pin,
}: {
  document: Instrument;
  pin: ScorePin;
}) {
  const [locale, setLocale] = useState<"ar" | "en">("ar"),
    [narrow, setNarrow] = useState(false),
    [answers, setAnswers] = useState<Record<string, string | string[]>>({}),
    [checked, setChecked] = useState(false);
  const t = (ar: string, en: string) => (locale === "ar" ? ar : en);
  const set = (id: string, value: string | string[]) =>
    setAnswers((old) => ({ ...old, [id]: value }));
  const fields = d.sections
    .flatMap((s) => s.questions)
    .filter((q) => q.type !== "CONTENT");
  const completed = (q: Question) =>
    q.type === "MATRIX"
      ? q.rows.every((r) => !!answers[r.id])
      : Array.isArray(answers[q.id])
        ? (answers[q.id] as string[]).length > 0
        : !!answers[q.id];
  const choice = (
    q: Question,
    id: string,
    options: Question["options"],
    checkbox = false,
  ) => (
    <div className="stack">
      {options.map((o) => (
        <label className="choice" key={o.id}>
          <input
            type={checkbox ? "checkbox" : "radio"}
            name={id}
            value={o.id}
            checked={
              checkbox
                ? ((answers[id] as string[]) ?? []).includes(o.id)
                : answers[id] === o.id
            }
            onChange={(e) =>
              set(
                id,
                checkbox
                  ? e.target.checked
                    ? [...((answers[id] as string[]) ?? []), o.id]
                    : ((answers[id] as string[]) ?? []).filter(
                        (v) => v !== o.id,
                      )
                  : o.id,
              )
            }
          />
          {o.label[locale] || t("خيار دون نص", "Untitled option")}
        </label>
      ))}
    </div>
  );
  return (
    <section
      className="instrument-preview"
      dir={locale === "ar" ? "rtl" : "ltr"}
      lang={locale}
    >
      <div className="row">
        <label>
          {t("لغة المعاينة", "Preview language")}
          <select
            value={locale}
            onChange={(e) => setLocale(e.target.value as "ar" | "en")}
          >
            {d.locales.map((l) => (
              <option key={l} value={l}>
                {l === "ar" ? "العربية" : "English"}
              </option>
            ))}
          </select>
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={narrow}
            onChange={(e) => setNarrow(e.target.checked)}
          />
          {t("عرض الهاتف", "Mobile width")}
        </label>
        <button
          type="button"
          onClick={() => {
            setAnswers({});
            setChecked(false);
          }}
        >
          {t("مسح التجربة", "Clear preview")}
        </button>
      </div>
      <p className="muted">
        {t(
          "معاينة تجريبية فقط. الإجابات في ذاكرة هذه الصفحة ولا تُرسل أو تُحفظ. يمكنك تجربة إعدادات القياس أدناه.",
          "Synthetic preview only. Answers stay in this page's memory and are never sent or saved. Test scoring settings below.",
        )}
      </p>
      <div className="row">
        <button
          type="button"
          onClick={() => {
            setAnswers(syntheticBoundaryAnswers(d, false));
            setChecked(false);
          }}
        >
          {t("تعبئة أقل القيم التجريبية", "Fill lowest synthetic inputs")}
        </button>
        <button
          type="button"
          onClick={() => {
            setAnswers(syntheticBoundaryAnswers(d, true));
            setChecked(false);
          }}
        >
          {t("تعبئة أعلى القيم التجريبية", "Fill highest synthetic inputs")}
        </button>
      </div>
      <div className={narrow ? "preview-paper narrow" : "preview-paper"}>
        <h2>{d.title[locale]}</h2>
        <p>{d.introduction[locale]}</p>
        <p>{d.privacyText[locale]}</p>
        <p role="status">
          {t("التقدم", "Progress")}: {fields.filter(completed).length} /{" "}
          {fields.length}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setChecked(true);
          }}
        >
          {d.sections.map((s) => (
            <section key={s.id}>
              <h3>{s.title[locale]}</h3>
              <p>{s.content[locale]}</p>
              {s.questions.map((q) =>
                q.type === "CONTENT" ? (
                  <div key={q.id}>
                    <h4>{q.prompt[locale]}</h4>
                    <p>{q.help[locale]}</p>
                  </div>
                ) : (
                  <fieldset key={q.id}>
                    <legend>
                      {q.prompt[locale] ||
                        t("سؤال دون نص", "Untitled question")}
                      {q.required ? " *" : ""}
                    </legend>
                    <p className="muted">{q.help[locale]}</p>
                    {q.type === "MATRIX" ? (
                      q.rows.map((r) => (
                        <fieldset key={r.id}>
                          <legend>{r.label[locale]}</legend>
                          {choice(q, r.id, q.columns)}
                        </fieldset>
                      ))
                    ) : ["MULTIPLE_CHOICE", "CHECKBOXES", "YES_NO"].includes(
                        q.type,
                      ) ? (
                      choice(q, q.id, q.options, q.type === "CHECKBOXES")
                    ) : q.type === "DROPDOWN" ? (
                      <select
                        aria-label={q.prompt[locale]}
                        required={q.required}
                        value={(answers[q.id] as string) ?? ""}
                        onChange={(e) => set(q.id, e.target.value)}
                      >
                        <option value="">{t("اختر", "Choose")}</option>
                        {q.options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label[locale]}
                          </option>
                        ))}
                      </select>
                    ) : ["RATING_5", "RATING_10"].includes(q.type) ? (
                      <select
                        aria-label={q.prompt[locale]}
                        required={q.required}
                        value={(answers[q.id] as string) ?? ""}
                        onChange={(e) => set(q.id, e.target.value)}
                      >
                        <option value="">{t("اختر", "Choose")}</option>
                        {Array.from(
                          { length: q.type === "RATING_5" ? 5 : 10 },
                          (_, i) => (
                            <option key={i} value={String(i + 1)}>
                              {i + 1}
                            </option>
                          ),
                        )}
                      </select>
                    ) : q.type === "LONG_TEXT" ? (
                      <textarea
                        aria-label={q.prompt[locale]}
                        required={q.required}
                        maxLength={q.validation.maxLength ?? 5000}
                        value={(answers[q.id] as string) ?? ""}
                        onChange={(e) => set(q.id, e.target.value)}
                      />
                    ) : (
                      <input
                        aria-label={q.prompt[locale]}
                        type={
                          q.type === "NUMBER"
                            ? "number"
                            : q.type === "DATE"
                              ? "date"
                              : "text"
                        }
                        required={q.required}
                        maxLength={q.validation.maxLength ?? 500}
                        min={
                          q.type === "DATE"
                            ? q.validation.minDate
                            : q.validation.min
                        }
                        max={
                          q.type === "DATE"
                            ? q.validation.maxDate
                            : q.validation.max
                        }
                        step={
                          q.type === "NUMBER"
                            ? 10 ** -(q.validation.precision ?? 0)
                            : undefined
                        }
                        value={(answers[q.id] as string) ?? ""}
                        onChange={(e) => set(q.id, e.target.value)}
                      />
                    )}
                    {checked && q.required && !completed(q) && (
                      <p role="alert">
                        {t("أكمل هذا السؤال.", "Complete this question.")}
                      </p>
                    )}
                    {checked &&
                      q.type === "CHECKBOXES" &&
                      (((answers[q.id] as string[]) ?? []).length <
                        (q.validation.minSelections ?? 0) ||
                        ((answers[q.id] as string[]) ?? []).length >
                          (q.validation.maxSelections ?? q.options.length)) && (
                        <p role="alert">
                          {t(
                            "عدد الخيارات خارج النطاق المحدد.",
                            "Selection count is outside the configured range.",
                          )}
                        </p>
                      )}
                  </fieldset>
                ),
              )}
            </section>
          ))}
          <button type="submit">
            {t("التحقق من التجربة", "Check preview")}
          </button>
          {checked && (
            <p role="status">
              {t(
                "تم فحص التجربة محلياً. لم تُرسل إجابات.",
                "Preview checked locally. No answers were submitted.",
              )}
            </p>
          )}
        </form>
        <ScoringSandbox
          document={d}
          answers={answers}
          pin={pin}
          locale={locale}
        />
      </div>
    </section>
  );
}
