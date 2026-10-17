"use client";
import { useState } from "react";
import type {
  DefinitionIssue,
  Instrument,
} from "../../../../src/instrument-input";
import {
  scoreDraft,
  ScoringError,
  type Answers,
  type DraftScoring,
  type Metric,
  type ScorePin,
} from "../../../../src/scoring";
import { IssueReasons } from "./issue-reasons";

// Test scoring of the page's copy of the draft. Each dimension whose own
// configuration is complete is scored; any other says exactly why not, with
// the checklist's location and a way to the field. Nothing leaves the page.
export function ScoringSandbox({
  document: d,
  answers,
  pin,
  locale,
  onReveal,
}: {
  document: Instrument;
  answers: Answers;
  pin: ScorePin;
  locale: "ar" | "en";
  /** Go to the field an issue names (the workspace's checklist link). */
  onReveal?: (issue: DefinitionIssue) => void;
}) {
  const [show, setShow] = useState(false);
  const t = (ar: string, en: string) => (locale === "ar" ? ar : en);
  let outcome: DraftScoring | null = null;
  let refused: DefinitionIssue[] = [];
  if (show)
    try {
      outcome = scoreDraft(d, answers, pin);
    } catch (e) {
      if (!(e instanceof ScoringError)) throw e;
      refused = e.issues;
    }
  const result = outcome?.scores ?? null;
  const reasons = (issues: DefinitionIssue[]) => (
    <IssueReasons
      document={d}
      issues={issues}
      locale={locale}
      onReveal={onReveal}
    />
  );
  const dimensionName = (i: number) =>
    d.dimensions[i].name[locale] ||
    d.dimensions[i].name[locale === "ar" ? "en" : "ar"] ||
    `${t("البعد", "Dimension")} ${i + 1}`;
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
      {!!refused.length && (
        <div role="alert" className="stack" data-testid="sandbox-refused">
          <h4>{t("تعذر الحساب", "Cannot calculate")}</h4>
          {reasons(refused)}
        </div>
      )}
      {outcome && result && (
        <div role="status" className="stack">
          {d.dimensions.map((dim, i) =>
            result.dimensions[dim.id] ? (
              render(dimensionName(i), result.dimensions[dim.id])
            ) : (
              <div
                key={dim.id}
                className="stack"
                data-testid="sandbox-unscored"
              >
                <h4>{dimensionName(i)}</h4>
                <p>
                  {t(
                    "لم يُحسب هذا البعد بعد. ما ينقصه:",
                    "This dimension is not scored yet. What it still needs:",
                  )}
                </p>
                {reasons(outcome!.blocked.dimensions[dim.id] ?? [])}
              </div>
            ),
          )}
          {result.overall ? (
            render(t("الدرجة الكلية", "Overall"), result.overall)
          ) : d.overall.enabled ? (
            <div className="stack" data-testid="sandbox-overall-unscored">
              <h4>{t("الدرجة الكلية", "Overall")}</h4>
              <p>
                {t(
                  "لم تُحسب الدرجة الكلية بعد. ما ينقصها:",
                  "The overall score is not calculated yet. What it still needs:",
                )}
              </p>
              {reasons(outcome.blocked.overall)}
            </div>
          ) : (
            <p>
              {t("لا توجد درجة كلية مهيأة.", "No overall score is configured.")}
            </p>
          )}
          {!!outcome.blocked.unassigned.length && (
            <div className="stack">
              <p>
                {t(
                  "أسئلة مقاسة لا يحسبها أي بعد بعد:",
                  "Scored questions that no dimension counts yet:",
                )}
              </p>
              {reasons(outcome.blocked.unassigned)}
            </div>
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
