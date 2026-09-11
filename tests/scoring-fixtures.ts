import {
  blankInstrument,
  newIdentity,
  newQuestion,
  tr,
  type Dimension,
  type QuestionType,
} from "../src/instrument-input";
import { ENGINE_VERSION } from "../src/scoring";
export const pin = {
  engineVersion: ENGINE_VERSION,
  configVersion: "synthetic-golden-v1",
};
export function scoringFixture(
  count = 3,
  type: QuestionType = "RATING_5",
  mode: Dimension["mode"] = "AVERAGE",
) {
  const d = blankInstrument();
  d.locales = ["ar", "en"];
  d.title = tr("تجربة", "Synthetic");
  d.privacyText = tr("تجربة فقط", "Synthetic only");
  const dim: Dimension = {
    ...newIdentity(),
    name: tr("الدعم", "Support"),
    description: tr(),
    mode,
    coverage: ["SUM", "PERCENTAGE"].includes(mode) ? "1" : "0.8",
    direction: "HIGH_GOOD",
    denominator: mode === "PERCENTAGE" ? String(count) : null,
    bands: [],
  };
  d.dimensions = [dim];
  d.sections = [
    {
      ...newIdentity(),
      title: tr("قسم", "Section"),
      content: tr(),
      questions: Array.from({ length: count }, (_, i) => {
        const q = newQuestion(type);
        q.prompt = tr(`سؤال ${i + 1}`, `Question ${i + 1}`);
        q.dimensionId = dim.id;
        q.scoring.enabled = true;
        for (const o of [...q.options, ...q.rows, ...q.columns])
          o.label = tr("خيار", "Option");
        if (type === "NUMBER")
          q.validation = { min: "0", max: "4", precision: 0 };
        return q;
      }),
    },
  ];
  return d;
}
