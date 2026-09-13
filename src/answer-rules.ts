import type { Question } from "./instrument-input";
import { N } from "./score-number";

// ---------------------------------------------------------------------------
// One answer, checked against its question.
//
// This is the single definition of what a present answer may look like. The
// scoring engine's validateAnswers calls it and collapses every reason to the
// one public code it has always returned, so the server's behaviour is
// unchanged; the respondent client calls the same function so it can say WHICH
// rule a value broke, beside the field, before anything is sent.
//
// Pure: no database, clock, network or locale. Safe in the respondent bundle.
// ---------------------------------------------------------------------------

/** Canonical Latin digits for a numeric answer typed on any keyboard.
 *
 * Arabic-Indic (U+0660–0669) and Extended Arabic-Indic / Persian (U+06F0–06F9)
 * digits become ASCII, the Arabic decimal separator (U+066B) becomes ".", the
 * typographic minus (U+2212) becomes "-", and the invisible direction marks a
 * mixed-direction keyboard inserts (LRM, RLM, ALM) are removed together with
 * surrounding whitespace. Nothing else is rewritten: a thousands separator is
 * still refused rather than guessed at. */
export const normalizeNumerals = (s: string) =>
  s
    .replace(/[‎‏؜]/g, "")
    .trim()
    .replace(/[٠-٩۰-۹]/g, (c) =>
      String(c.charCodeAt(0) - (c >= "۰" ? 1776 : 1632)),
    )
    .replace(/٫/g, ".")
    .replace(/−/g, "-");

export type AnswerIssue =
  | "INVALID"
  | "NUMBER_FORMAT"
  | "NUMBER_PRECISION"
  | "NUMBER_MIN"
  | "NUMBER_MAX"
  | "DATE_FORMAT"
  | "DATE_MIN"
  | "DATE_MAX"
  | "TOO_LONG"
  | "TOO_FEW"
  | "TOO_MANY";

export const isMissing = (v: string | string[] | undefined) =>
  v === undefined || (typeof v === "string" ? !v.trim() : v.length === 0);

const isoDate = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  // setUTCFullYear, not Date.UTC: the latter maps years 0–99 onto 1900–1999.
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return (
    t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
  );
};

/** Check one PRESENT answer. Returns the canonical value to keep, or the rule
 *  it broke. A missing answer is the caller's concern (required vs optional). */
export function checkAnswer(
  q: Question,
  v: string | string[],
):
  | { ok: true; value: string | string[] }
  | { ok: false; issue: AnswerIssue } {
  const no = (issue: AnswerIssue) => ({ ok: false as const, issue });
  if (q.type === "CHECKBOXES") {
    if (
      !Array.isArray(v) ||
      new Set(v).size !== v.length ||
      v.some((x) => !q.options.some((o) => o.id === x))
    )
      return no("INVALID");
    if (v.length < (q.validation.minSelections ?? 0)) return no("TOO_FEW");
    if (v.length > (q.validation.maxSelections ?? q.options.length))
      return no("TOO_MANY");
    return { ok: true, value: v };
  }
  if (typeof v !== "string") return no("INVALID");
  if (["MULTIPLE_CHOICE", "DROPDOWN", "YES_NO", "MATRIX"].includes(q.type))
    return (q.type === "MATRIX" ? q.columns : q.options).some((o) => o.id === v)
      ? { ok: true, value: v }
      : no("INVALID");
  if (["NUMBER", "RATING_5", "RATING_10"].includes(q.type)) {
    const value = normalizeNumerals(v),
      precision = q.type === "NUMBER" ? (q.validation.precision ?? 0) : 0;
    if (!/^-?\d{1,9}(?:\.\d{1,6})?$/.test(value)) return no("NUMBER_FORMAT");
    if ((value.split(".")[1]?.length ?? 0) > precision)
      return no("NUMBER_PRECISION");
    const n = N(value),
      lower = q.type === "NUMBER" ? q.validation.min : "1",
      upper =
        q.type === "NUMBER"
          ? q.validation.max
          : q.type === "RATING_5"
            ? "5"
            : "10";
    if (lower !== undefined && n.compare(N(lower)) < 0) return no("NUMBER_MIN");
    if (upper !== undefined && n.compare(N(upper)) > 0) return no("NUMBER_MAX");
    return { ok: true, value };
  }
  if (q.type === "DATE") {
    if (!isoDate(v)) return no("DATE_FORMAT");
    if (q.validation.minDate && v < q.validation.minDate) return no("DATE_MIN");
    if (q.validation.maxDate && v > q.validation.maxDate) return no("DATE_MAX");
    return { ok: true, value: v };
  }
  if (
    v.length > (q.validation.maxLength ?? (q.type === "LONG_TEXT" ? 5000 : 500))
  )
    return no("TOO_LONG");
  return { ok: true, value: v };
}
