import { instrumentSchema, type Instrument } from "./instrument-input";
import type { Answers } from "./scoring";
import { N, total } from "./score-number";

// Fixed synthetic boundary inputs for the local sandbox, with no persistence.
export function syntheticBoundaryAnswers(
  d: Instrument,
  high: boolean,
): Answers {
  if (!instrumentSchema.safeParse(d).success) return {};
  const answers: Answers = {};
  for (const q of d.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    if (q.type === "SHORT_TEXT" || q.type === "LONG_TEXT") {
      answers[q.id] = "x";
      continue;
    }
    if (q.type === "DATE") {
      answers[q.id] =
        (high ? q.validation.maxDate : q.validation.minDate) ??
        q.validation.minDate ??
        q.validation.maxDate ??
        "2000-01-01";
      continue;
    }
    if (q.type === "RATING_5" || q.type === "RATING_10") {
      answers[q.id] = high ? (q.type === "RATING_5" ? "5" : "10") : "1";
      continue;
    }
    if (q.type === "NUMBER") {
      answers[q.id] =
        (high ? q.validation.max : q.validation.min) ??
        q.validation.min ??
        q.validation.max ??
        "0";
      continue;
    }
    const opts = [...(q.type === "MATRIX" ? q.columns : q.options)].sort(
      (a, b) => N(a.score ?? "0").compare(N(b.score ?? "0")) * (high ? -1 : 1),
    );
    if (q.type === "CHECKBOXES") {
      const min = Math.max(1, q.validation.minSelections ?? 0),
        max = q.validation.maxSelections ?? opts.length;
      const candidates = Array.from(
        { length: Math.max(0, max - min + 1) },
        (_, i) => opts.slice(0, min + i),
      );
      candidates.sort(
        (a, b) =>
          (q.scoring.mode === "OPTION_SUM"
            ? total(a.map((o) => N(o.score ?? "0"))).compare(
                total(b.map((o) => N(o.score ?? "0"))),
              )
            : a.length - b.length) * (high ? -1 : 1),
      );
      answers[q.id] = (candidates[0] ?? []).map((o) => o.id);
    } else if (opts.length) {
      if (q.type === "MATRIX")
        for (const row of q.rows) answers[row.id] = opts[0].id;
      else answers[q.id] = opts[0].id;
    }
  }
  return answers;
}
