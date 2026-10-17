import {
  blankInstrument,
  newIdentity,
  newQuestion,
  newRule,
  tr,
  type Instrument,
} from "../src/instrument-input";

// A scored questionnaire built the way a builder builds it in the editor, one
// action at a time, with the editor's own defaults: a new option has no score
// (editors.tsx), ticking "Include in scoring" leaves the dimension unchosen,
// a new band runs from the last band's upper bound to 100, and a new rule has
// no text. Every snapshot is a state a draft passes through and must be able
// to save; only the last one is complete enough to publish.
export function scoredAuthoringSteps(): { step: string; doc: Instrument }[] {
  const steps: { step: string; doc: Instrument }[] = [];
  const d = blankInstrument();
  const snap = (step: string) => steps.push({ step, doc: structuredClone(d) });
  d.locales = ["ar", "en"];
  d.title = tr("استبيان مقاس", "Scored questionnaire");
  d.privacyText = tr("إشعار تجريبي فقط.", "Synthetic notice only.");
  const q = newQuestion("MULTIPLE_CHOICE");
  q.prompt = tr("كيف تقيّم الدعم؟", "How do you rate support?");
  q.options[0].label = tr("ضعيف", "Poor");
  q.options[1].label = tr("مقبول", "Fair");
  d.sections = [
    { ...newIdentity(), title: tr("القسم", "Section"), content: tr(), questions: [q] },
  ];
  // The unscored starting point is already publishable, so it is not a step.
  // From here the dimension stays unnamed until the end, which keeps every
  // intermediate state unpublishable by PostgreSQL's own checks as well.
  d.dimensions.push({
    ...newIdentity(),
    name: tr(),
    description: tr(),
    mode: "AVERAGE",
    coverage: "0.8",
    direction: "HIGH_GOOD",
    denominator: null,
    bands: [],
  });
  const dim = d.dimensions[0];
  snap("add a dimension (no name, no scored question)");
  q.options.push({ ...newIdentity(), label: tr(), score: null });
  snap("add an option (no label, no score)");
  q.scoring = { ...q.scoring, enabled: true, reverse: false, mode: "VALUE" };
  snap("tick scored (no dimension chosen)");
  q.dimensionId = dim.id;
  snap("choose the dimension (option score still empty)");
  q.options[2].score = "2";
  snap("score the new option (label still empty)");
  dim.bands.push({
    ...newIdentity(),
    lower: "0",
    upper: "100",
    label: tr(),
    severity: "NONE",
    semantic: "NEUTRAL",
  });
  snap("add the first band (no label)");
  dim.bands.push({
    ...newIdentity(),
    lower: dim.bands[0].upper,
    upper: "100",
    label: tr(),
    severity: "NONE",
    semantic: "NEUTRAL",
  });
  snap("add a second band (100–100, overlapping)");
  dim.bands[0].upper = "50";
  snap("lower the first band (gap 50–100)");
  dim.bands[1].lower = "50";
  dim.bands[0].label = tr("منخفض", "Low");
  dim.bands[1].label = tr("مرتفع", "High");
  snap("close the gap and label both bands");
  d.overall = { enabled: true, direction: "HIGH_GOOD", inputs: [], bands: [] };
  snap("enable the overall metric (no inputs)");
  d.overall.inputs.push({ dimensionId: dim.id, weight: "1", invert: false });
  snap("add the dimension to the overall metric");
  const rule = newRule({ kind: "DIMENSION", dimensionId: dim.id });
  d.recommendations.push(rule);
  snap("add a rule (no text)");
  rule.condition.clauses[0].comparisons[0] = {
    metric: { kind: "DIMENSION", dimensionId: dim.id },
    operator: "BETWEEN",
    value: "20",
    upper: null,
  };
  rule.title = tr("دعم منخفض {score", "Low support {scor}");
  snap("half-written rule: BETWEEN without upper, unfinished placeholder");
  rule.condition.clauses[0].comparisons[0].upper = "50";
  rule.title = tr("دعم منخفض", "Low support");
  rule.body = tr("الدرجة {score}.", "Score {score}.");
  rule.action = tr("راجع الدعم.", "Review support.");
  rule.dedupKey = "low-support";
  snap("finish the rule");
  dim.name = tr("الدعم", "Support");
  q.options[2].label = tr("ممتاز", "Good");
  snap("complete: name the dimension and label the option");
  return steps;
}

// The complete document broken in exactly one scoring respect at a time, with
// every text filled in, so that a refusal can only come from the scoring
// configuration. Each must save as a draft and be refused for publication by
// TypeScript and by PostgreSQL alone.
export function scoringIncompleteVariants(): { variant: string; doc: Instrument }[] {
  const complete = scoredAuthoringSteps().at(-1)!.doc;
  const variant = (name: string, fn: (d: Instrument) => void) => {
    const d = structuredClone(complete);
    fn(d);
    return { variant: name, doc: d };
  };
  return [
    variant("an option without a score", (d) => {
      d.sections[0].questions[0].options[2].score = null;
    }),
    variant("a scored question without a dimension", (d) => {
      d.sections[0].questions[0].dimensionId = null;
    }),
    variant("bands leaving a gap", (d) => {
      d.dimensions[0].bands[0].upper = "40";
    }),
    variant("overlapping bands", (d) => {
      d.dimensions[0].bands[1].lower = d.dimensions[0].bands[1].upper;
    }),
    variant("bands not reaching 100", (d) => {
      d.dimensions[0].bands[1].upper = "90";
    }),
    variant("an overall metric without inputs", (d) => {
      d.overall.inputs = [];
    }),
  ];
}
