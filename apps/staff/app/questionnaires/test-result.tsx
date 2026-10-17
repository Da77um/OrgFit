"use client";
import type {
  DefinitionIssue,
  Instrument,
} from "../../../../src/instrument-input";
import type { DraftScoring, Metric } from "../../../../src/scoring";
import type { TestRecommendations } from "../../../../src/test-submission";
import { Alert } from "../../../../src/ui";
import { IssueReasons } from "./issue-reasons";

// The result of submitting test answers in the preview. It is computed in
// this page from answers held in its memory and is shown only here: it is
// never sent, saved or logged, and leaving the preview or reloading drops it.
// The label is given in both languages whatever the preview language, so no
// reader of either can take it for a real result.
export function TestResult({
  document: d,
  result,
  recommendations,
  locale,
  onBack,
  onReveal,
}: {
  document: Instrument;
  result: DraftScoring;
  recommendations: TestRecommendations;
  locale: "ar" | "en";
  onBack: () => void;
  onReveal?: (issue: DefinitionIssue) => void;
}) {
  const t = (ar: string, en: string) => (locale === "ar" ? ar : en);
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 2,
  });
  const { scores, blocked } = result;
  const metric = (m: Metric) => (
    <dl>
      <dt>{t("الدرجة", "Score")}</dt>
      <dd>
        <strong>
          {m.display === null ? (
            t("بيانات غير كافية", "Insufficient data")
          ) : (
            <bdi dir="ltr">{m.display} / 100</bdi>
          )}
        </strong>
      </dd>
      <dt>{t("النطاق", "Band")}</dt>
      <dd>
        {m.band
          ? m.band.label[locale] || m.band.label[locale === "ar" ? "en" : "ar"]
          : "—"}
      </dd>
      <dt>{t("التغطية", "Coverage")}</dt>
      <dd>{percent.format(m.coverage)}</dd>
    </dl>
  );
  const name = (i: number) =>
    d.dimensions[i].name[locale] ||
    d.dimensions[i].name[locale === "ar" ? "en" : "ar"] ||
    `${t("البعد", "Dimension")} ${i + 1}`;
  return (
    <section
      className="stack"
      data-testid="test-result"
      aria-labelledby="test-result-heading"
    >
      <Alert tone="warning" role="note">
        <div className="stack" data-testid="test-result-label">
          <p lang="ar" dir="rtl">
            <strong>
              اختبار فقط: لم يُحفظ ولم يُرسل، وليس نتيجة لأي شخص أو مؤسسة.
            </strong>
          </p>
          <p lang="en" dir="ltr">
            <strong>
              TEST ONLY: not saved, not sent, and not a result for any person or
              organization.
            </strong>
          </p>
        </div>
      </Alert>
      <h3 id="test-result-heading" tabIndex={-1}>
        {t("نتيجة الإجابات التجريبية", "Test answers result")}
      </h3>
      {d.dimensions.map((dim, i) => (
        <div key={dim.id} className="stack" data-testid="test-result-dimension">
          <h4>{name(i)}</h4>
          {scores.dimensions[dim.id] ? (
            metric(scores.dimensions[dim.id])
          ) : (
            <>
              <p>
                {t(
                  "لم يُحسب هذا البعد: إعداده في المسودة لم يكتمل بعد.",
                  "This dimension was not scored: its setup in the draft is not complete yet.",
                )}
              </p>
              <IssueReasons
                document={d}
                issues={blocked.dimensions[dim.id] ?? []}
                locale={locale}
                onReveal={onReveal}
              />
            </>
          )}
        </div>
      ))}
      {d.overall.enabled && (
        <div className="stack" data-testid="test-result-overall">
          <h4>{t("الدرجة الكلية", "Overall")}</h4>
          {scores.overall ? (
            metric(scores.overall)
          ) : (
            <>
              <p>
                {t(
                  "لم تُحسب الدرجة الكلية: تحتاج كل أبعادها.",
                  "The overall score was not calculated: it needs all of its dimensions.",
                )}
              </p>
              <IssueReasons
                document={d}
                issues={blocked.overall}
                locale={locale}
                onReveal={onReveal}
              />
            </>
          )}
        </div>
      )}
      {!d.dimensions.length && (
        <p>
          {t(
            "لا توجد أبعاد مقاسة في هذه المسودة.",
            "This draft has no scored dimensions.",
          )}
        </p>
      )}
      {!!d.recommendations.length && (
        <div className="stack" data-testid="test-result-recommendations">
          <h4>
            {t("التوصيات التي كانت ستظهر", "Recommendations that would appear")}
          </h4>
          <p className="muted">
            {t(
              "تُقيَّم القواعد كأن هذه الدرجات نتيجة منشورة على مستوى الشركة، بمحرك الإصدار نفسه. في إصدار حقيقي لا يُنشر شيء ولا تظهر توصية لأي مجموعة يقل عدد مشاركيها عن ٥، فلا تُنتج إجابة تجريبية واحدة توصية حقيقية. قواعد الأقسام لا تنطبق هنا.",
              "Rules are evaluated as if these scores were a published company result, by the release's own engine. A real release publishes nothing, and shows no recommendation, for any group with fewer than 5 respondents, so one test response never produces a real recommendation. Department rules do not apply here.",
            )}
          </p>
          {recommendations.fired.length ? (
            <ol>
              {recommendations.fired.map((r) => (
                <li key={r.ruleKey} className="stack">
                  <strong>{r.text.title[locale]}</strong>
                  {r.text.body[locale] && <p>{r.text.body[locale]}</p>}
                  {r.text.action[locale] && (
                    <p>
                      {t("الإجراء المقترح", "Suggested action")}:{" "}
                      {r.text.action[locale]}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p>
              {t(
                "لم تنطبق أي قاعدة على هذه الدرجات.",
                "No rule applies to these scores.",
              )}
            </p>
          )}
          {!!recommendations.skipped.length && (
            <>
              <p>
                {t(
                  "قواعد لم تُقيَّم لأنها لم تكتمل بعد:",
                  "Rules not evaluated because they are not complete yet:",
                )}
              </p>
              <IssueReasons
                document={d}
                issues={recommendations.skipped}
                locale={locale}
                onReveal={onReveal}
              />
            </>
          )}
        </div>
      )}
      <div className="row">
        <button type="button" onClick={onBack}>
          {t("العودة إلى الإجابات", "Back to the answers")}
        </button>
      </div>
    </section>
  );
}
