"use client";
import { useState } from "react";
import type { Instrument } from "../../../../src/instrument-input";
import {
  scoreInstrument,
  ScoringError,
  type Answers,
  type Metric,
  type ScorePin,
} from "../../../../src/scoring";

export function ScoringSandbox({
  document: d,
  answers,
  pin,
  locale,
}: {
  document: Instrument;
  answers: Answers;
  pin: ScorePin;
  locale: "ar" | "en";
}) {
  const [show, setShow] = useState(false);
  const t = (ar: string, en: string) => (locale === "ar" ? ar : en);
  let result: ReturnType<typeof scoreInstrument> | null = null;
  let invalid = false;
  if (show)
    try {
      result = scoreInstrument(d, answers, pin);
    } catch (e) {
      if (!(e instanceof ScoringError)) throw e;
      invalid = true;
    }
  const label = (id: string) => {
    for (const q of d.sections.flatMap((s) => s.questions)) {
      if (q.id === id) return q.prompt[locale];
      const row = q.rows.find((r) => r.id === id);
      if (row) return `${q.prompt[locale]} — ${row.label[locale]}`;
    }
    return id;
  };
  const render = (name: string, m: Metric) => (
    <div key={name} className="stack">
      <h4>{name}</h4>
      <p>
        {t("الدرجة", "Score")}:{" "}
        <strong>
          {m.display === null ? (
            t("بيانات غير كافية", "Insufficient data")
          ) : (
            <bdi dir="ltr">{m.display} / 100</bdi>
          )}
        </strong>
      </p>
      <p>
        {t("التغطية", "Coverage")}:{" "}
        {new Intl.NumberFormat(locale, {
          style: "percent",
          maximumFractionDigits: 2,
        }).format(m.coverage)}{" "}
        ·{" "}
        {m.direction === "HIGH_GOOD"
          ? t("الأعلى أفضل", "Higher is better")
          : t("الأعلى أكثر خطورة", "Higher means more risk")}
      </p>
      {m.raw !== null && (
        <p>
          {t("القيمة الخام بعد العكس", "Raw value after reversal")}:{" "}
          {new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(
            m.raw,
          )}
        </p>
      )}
      {m.band && (
        <p>
          {m.band.label[locale]} ·{" "}
          <bdi dir="ltr">
            [{m.band.lower}, {m.band.upper}
            {Number(m.band.upper) === 100 ? "]" : ")"}
          </bdi>
          . {t("يُحدد النطاق قبل التقريب.", "Band assigned before rounding.")}
        </p>
      )}
      {m.normalized !== null && (
        <p className="muted">
          {t("الدرجة بتفصيل أكبر", "Score in more detail")}:{" "}
          <bdi>{m.normalized.toFixed(6)}</bdi>
        </p>
      )}
      <p className="muted">
        {m.missingPolicy === "REQUIRE_ALL"
          ? t(
              "تلزم جميع المدخلات المحددة.",
              "All configured inputs are required.",
            )
          : t(
              "تُستبعد الإجابات المفقودة بعد فحص حد التغطية.",
              "Missing inputs are omitted after checking minimum coverage.",
            )}
      </p>
    </div>
  );
  return (
    <section aria-label={t("تجربة القياس", "Scoring sandbox")}>
      <h3>{t("تجربة القياس", "Scoring sandbox")}</h3>
      <p>
        {t(
          "درجات إجابات تجريبية فقط. لا تمثل نتائج أشخاص أو مؤسسات.",
          "Synthetic answers only. These are not results for people or organizations.",
        )}
      </p>
      <button type="button" onClick={() => setShow(true)}>
        {t("حساب الدرجات التجريبية", "Calculate synthetic scores")}
      </button>
      {invalid && (
        <p role="alert">
          {t(
            "تعذر الحساب. راجع تحقق النشر ونطاقات الإجابات، ثم أعد المحاولة.",
            "Cannot calculate. Check publication validation and answer ranges, then try again.",
          )}
        </p>
      )}
      {result && (
        <div role="status" className="stack">
          {d.dimensions.map((dim) =>
            render(dim.name[locale], result!.dimensions[dim.id]),
          )}
          {result.overall ? (
            render(t("الدرجة الكلية", "Overall"), result.overall)
          ) : (
            <p>
              {t("لا توجد درجة كلية مهيأة.", "No overall score is configured.")}
            </p>
          )}
          {!!result.missingRequired.length && (
            <p>
              {t(
                "أسئلة إلزامية غير مكتملة (التجربة لا ترسل إجابات)",
                "Unanswered required items (this sandbox cannot submit answers)",
              )}
              : {result.missingRequired.map(label).join("، ")}
            </p>
          )}
          {!!result.unscored.length && (
            <p>
              {t("لا تدخل في القياس", "Unscored items")}:{" "}
              {result.unscored.map(label).join("، ")}
            </p>
          )}
          <p className="muted">
            {t("إصدار الحساب", "Engine version")}:{" "}
            <bdi>{result.engineVersion}</bdi> ·{" "}
            {t("نسخة الإعداد", "Configuration")}:{" "}
            <bdi>{result.configVersion}</bdi>
          </p>
        </div>
      )}
    </section>
  );
}
