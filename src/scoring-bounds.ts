import type { Question, Instrument, DefinitionIssue } from "./instrument-input";
import { N, total, type ScoreNumber } from "./score-number";

export function itemBounds(q: Question): [ScoreNumber, ScoreNumber] {
  if (q.type === "RATING_5") return [N(1), N(5)];
  if (q.type === "RATING_10") return [N(1), N(10)];
  if (q.type === "NUMBER") {
    const b: [ScoreNumber, ScoreNumber] = [
      N(q.validation.min!),
      N(q.validation.max!),
    ];
    if (b.some((x) => x.mul(N(10 ** (q.validation.precision ?? 0))).d !== 1n))
      throw new Error("INVALID_PRECISION_BOUNDS");
    return b;
  }
  if (q.type === "CHECKBOXES") {
    const min = Math.max(1, q.validation.minSelections ?? 0),
      max = q.validation.maxSelections ?? q.options.length;
    if (q.scoring.mode === "SELECTED_PERCENTAGE")
      return [
        N(min).mul(N(100)).div(N(q.options.length)),
        N(max).mul(N(100)).div(N(q.options.length)),
      ];
    const values = q.options
      .map((o) => N(o.score!))
      .sort((a, b) => a.compare(b));
    const lows: ScoreNumber[] = [],
      highs: ScoreNumber[] = [];
    for (let k = min; k <= max; k++) {
      lows.push(total(values.slice(0, k)));
      highs.push(total(k ? values.slice(-k) : []));
    }
    return [
      lows.sort((a, b) => a.compare(b))[0],
      highs.sort((a, b) => b.compare(a))[0],
    ];
  }
  const values = (q.type === "MATRIX" ? q.columns : q.options)
    .map((o) => N(o.score!))
    .sort((a, b) => a.compare(b));
  if (!values.length) throw new Error("INVALID_BOUNDS");
  return [values[0], values.at(-1)!];
}

// Shared by the editor, server publication path and runtime compiler.
export function scoringDefinitionIssues(d: Instrument): DefinitionIssue[] {
  const errors: DefinitionIssue[] = [];
  for (const dim of d.dimensions) {
    const questions = d.sections
      .flatMap((s) => s.questions)
      .filter((q) => q.scoring.enabled && q.dimensionId === dim.id);
    const bounds: [ScoreNumber, ScoreNumber][] = [];
    for (const q of questions) {
      try {
        const b = itemBounds(q);
        if (b[1].compare(b[0]) <= 0) throw new Error("INVALID_BOUNDS");
        bounds.push(b);
      } catch {
        errors.push({ path: q.id, code: "ATTAINABLE_BOUNDS" });
      }
      if (
        dim.mode !== "WEIGHTED_AVERAGE" &&
        (N(q.scoring.weight).compare(N(1)) !== 0 ||
          q.rows.some((r) => N(r.weight).compare(N(1)) !== 0))
      )
        errors.push({ path: q.id, code: "WEIGHT_MODE" });
    }
    // A raw sum requires a common declared scale. Averages normalize each item
    // first and may mix scales; their raw value is withheld when heterogeneous.
    if (
      dim.mode === "SUM" &&
      bounds.some(
        (b) =>
          b[0].compare(bounds[0][0]) !== 0 || b[1].compare(bounds[0][1]) !== 0,
      )
    )
      errors.push({ path: dim.id, code: "MIXED_SUM_SCALES" });
  }
  return errors;
}
