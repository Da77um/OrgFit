import type { Locale } from "./i18n";

// ---------------------------------------------------------------------------
// Report wording.
//
// Everything a rendered report says that is not a released number lives here.
// Two properties matter more than style:
//
//   * A withheld result must never read as a zero, an absence of a problem or
//     a rounding. Each suppression reason has its own sentence.
//   * Automatic findings and consultant commentary have different headings and
//     different wording, in both languages, so a reader can always tell which
//     one they are looking at.
//
// The recommendation and limitation texts here are illustrative development
// wording. The instrument owner's approved text (P-006/P-007) replaces them.
// ---------------------------------------------------------------------------

const ar = {
  reportTitle: "تقرير التوافق التنظيمي",
  documentKind: "تقرير نتائج جولة تقييم",
  confidential: "وثيقة داخلية سرية — للاستخدام مع المنظمة المعنية فقط",
  organization: "المنظمة",
  series: "سلسلة التقييم",
  round: "الجولة",
  period: "فترة الجمع",
  purpose: "الغرض",
  generated: "تاريخ إصدار النتائج",
  rendered: "تاريخ إنشاء هذا الملف",
  timezone: "المنطقة الزمنية",
  reportId: "معرّف التقرير",
  snapshotId: "معرّف الإصدار",
  page: "صفحة",
  of: "من",
  contents: "المحتويات",

  executiveSummary: "الملخص التنفيذي",
  summaryOverall:
    "النتيجة العامة المنشورة لهذه الجولة هي {value} من 100 ضمن تصنيف «{band}».",
  summaryOverallWithheld:
    "لم تُنشر نتيجة عامة لهذه الجولة. {reason}",
  summaryContributors:
    "استند التقرير إلى {contributors} مساهمًا صالحًا، بحد أدنى للنشر قدره {threshold}.",
  summaryMetrics:
    "نُشر {released} مؤشرًا من أصل {total}، وحُجب {withheld} مؤشرًا حفاظًا على الخصوصية.",
  summaryRecommendations:
    "أنتجت قواعد التوصيات الحتمية {count} توصية مؤهلة لهذه الجولة.",
  summaryNoRecommendations:
    "لم تنطبق أي قاعدة توصية على النتائج المنشورة لهذه الجولة.",

  methodology: "المنهجية",
  methodologyBody:
    "تُجمع الإجابات عبر روابط فردية تُسلّم يدويًا، وتُفصل هوية المشارك عن إجاباته النهائية قبل أي حساب. تُحسب النتائج على مقياس من صفر إلى مئة وفق محرك حساب مثبّت الإصدار، ثم تمر خطة النشر بفحوص إفصاح قبل أي عرض.",
  methodologyThreshold:
    "لا يُنشر أي مؤشر إلا إذا ساهم فيه {threshold} مساهمًا صالحًا على الأقل. ويُحجب المؤشر أيضًا إذا كانت إجابات جميع المساهمين متطابقة، أو إذا كان نشره مع نتيجة الشركة يسمح باستنتاج نتيجة مجموعة أصغر.",
  methodologyDeterministic:
    "التوصيات قواعد حتمية مطبّقة على النتائج المنشورة فقط؛ لا يُستخدم أي نموذج توليدي، ولا تُنتج أي قاعدة توصية من نتيجة محجوبة.",
  methodologyScope:
    "جميع المقارنات داخل المنظمة نفسها. لا توجد مقارنة معيارية مع منظمات أخرى.",
  instrument: "الاستبانة",
  instrumentVersion: "إصدار الاستبانة",
  instrumentHash: "بصمة محتوى الاستبانة",
  engine: "إصدار محرك الحساب",
  disclosure: "إصدار سياسة الإفصاح",
  rulesVersion: "إصدار قواعد التوصيات",
  privacyVersion: "إصدار سياسة الخصوصية",
  contentHash: "بصمة محتوى الإصدار",
  reviewReference: "مرجع مراجعة الإفصاح",
  themeVersion: "إصدار قوالب العرض",

  participation: "المشاركة",
  participationNote:
    "أرقام المشاركة أعداد إجمالية فقط. لا يتضمن هذا التقرير أي اسم أو معرّف مشارك، ولا يمكن ربط أي إجابة بشخص.",
  invited: "عدد المدعوين",
  completed: "أكملوا الاستبانة",
  revoked: "دعوات ملغاة",
  outstanding: "لم تكتمل بعد",
  eligible: "الدعوات السارية",
  rate: "نسبة الإكمال",
  contributors: "المساهمون الصالحون",
  threshold: "الحد الأدنى للنشر",

  overall: "النتيجة العامة",
  dimensions: "نتائج الأبعاد",
  departments: "نتائج الأقسام",
  questions: "تحليل الأسئلة",
  strengths: "أبرز نقاط القوة",
  risks: "أبرز نقاط الاهتمام",
  recommendations: "التوصيات",
  history: "التطور عبر الجولات",
  comparison: "المقارنة بين جولتين",
  limitations: "حدود التفسير والإفصاح",
  manifest: "بيان الإصدارات",

  metric: "المؤشر",
  group: "المجموعة",
  company: "الشركة",
  value: "القيمة",
  band: "التصنيف",
  coverage: "نسبة التغطية",
  status: "الحالة",
  reason: "سبب عدم النشر",
  gap: "الفارق عن الشركة (نقاط)",
  share: "النسبة",
  count: "العدد",
  option: "الخيار",
  question: "السؤال",
  direction: "اتجاه التفسير",
  HIGH_GOOD: "الارتفاع أفضل",
  HIGH_RISK: "الارتفاع يشير إلى مخاطرة",
  scale: "المقياس من صفر إلى مئة",
  none: "لا يوجد",
  notApplicable: "غير منطبق",

  AVAILABLE: "منشورة",
  SUPPRESSED: "محجوبة",
  INSUFFICIENT: "دون الحد الأدنى",
  UNSCORED: "غير محسوبة",
  NOT_COMPARABLE: "غير قابلة للمقارنة",
  COMPARABLE: "قابلة للمقارنة",
  GAP: "غير متاحة",
  BELOW_THRESHOLD: "عدد المساهمين في هذا المؤشر أقل من الحد الأدنى.",
  COMPLEMENTARY:
    "حُجب تفصيل الأقسام لأن نشره مع نتيجة الشركة يسمح باستنتاج نتيجة قسم صغير.",
  HOMOGENEOUS:
    "أجاب جميع المساهمين بالقيمة نفسها، فنشر المتوسط يكشف إجابة كل فرد.",
  SPARSE_BIN: "أحد الخيارات اختاره عدد أقل من الحد الأدنى، فحُجب التوزيع كاملًا.",
  RAW_WITHHELD: "لا تُنشر النصوص الحرة والتواريخ الدقيقة ضمن النتائج.",
  NO_VALID_SCORE: "لا توجد إجابات كافية لحساب هذا المؤشر.",
  NOT_RELEASED: "غير مشمول بخطة النشر لهذه الحملة.",
  MEASUREMENT_CHANGED: "تغيّر تعريف القياس، فلا يمكن وصل النقطتين.",
  BOTH_WITHHELD: "القيمتان محجوبتان في الجولتين.",
  EARLIER_WITHHELD: "القيمة محجوبة في الجولة الأقدم.",
  LATER_WITHHELD: "القيمة محجوبة في الجولة الأحدث.",

  severity: "الشدة",
  priority: "الأولوية",
  NONE: "بدون",
  LOW: "منخفضة",
  MODERATE: "متوسطة",
  HIGH: "مرتفعة",
  CRITICAL: "حرجة",
  computedFinding: "نتيجة قاعدة حتمية",
  suggestedAction: "الإجراء المقترح",
  rationale: "المسوّغ",
  evidence: "الشواهد المنشورة",
  ruleReference: "مرجع القاعدة",
  consultantCommentary: "تعليق الاستشاري",
  consultantCommentaryNote:
    "ما يلي رأي بشري كتبه مستشار OrgFit، وليس نتيجة قاعدة ولا قياسًا. لا يغيّر النص المحسوب أعلاه.",
  followUpStatus: "حالة المتابعة",
  owner: "المسؤول",
  unassigned: "غير مسند",
  dueDate: "تاريخ الاستحقاق",
  consultantNotes: "ملاحظات الاستشاري",
  resolution: "الإغلاق",
  OPEN: "مفتوحة",
  IN_PROGRESS: "قيد التنفيذ",
  DONE: "منجزة",
  DISMISSED: "مستبعدة",
  noRecommendations: "لم تنطبق أي قاعدة على النتائج المنشورة لهذه الجولة.",

  trendMetric: "المؤشر",
  trendRound: "الجولة",
  trendValue: "القيمة",
  trendBreak: "انقطاع",
  historyNote:
    "تُوصل نقاط التطور فقط ما دام تعريف القياس نفسه لم يتغيّر. أي تغيّر في التعريف يظهر انقطاعًا صريحًا ولا يُستكمل تقديريًا.",
  noHistory: "لا توجد جولات سابقة قابلة للعرض في هذه السلسلة.",
  comparisonOf: "مقارنة {left} مع {right}",
  earlier: "الجولة الأقدم",
  later: "الجولة الأحدث",
  pointChange: "التغير بالنقاط",
  percentChange: "التغير النسبي",
  improved: "تحسّن",
  worsened: "تراجع",
  unchanged: "دون تغيّر",
  classification: "تصنيف القابلية للمقارنة",
  IDENTICAL: "الإصدار نفسه",
  REVIEWED_EQUIVALENT: "مكافئ بمراجعة معتمدة",
  reviewedBy: "راجع المقارنة",
  reviewedAt: "تاريخ المراجعة",
  caveats: "تحفظات على المجتمع المقارن",
  CONTRIBUTORS_CHANGED:
    "اختلف عدد المساهمين بين الجولتين؛ الفارق وصفي ولا يعني أن الأشخاص أنفسهم غيّروا رأيهم.",
  POPULATION_CHANGE_SMALL:
    "تغيّر عدد المساهمين بين الجولتين بمقدار أقل من الحد الأدنى للنشر. في هذه الحالة يكشف طرح نتيجتَي الجولتين النتيجة الفردية لمن انضم أو غادر بينهما. هذا حدّ معلن لهذه المقارنة وليس خطأً فيها، ولا تمنعه ضوابط الإفصاح داخل الجولة الواحدة.",
  GROUPS_ADDED: "توجد أقسام في الجولة الأحدث بلا مقابل في الأقدم، فلم تُقارن.",
  GROUPS_REMOVED: "توجد أقسام في الجولة الأقدم بلا مقابل في الأحدث، فلم تُقارن.",
  THRESHOLD_CHANGED: "تغيّر الحد الأدنى للنشر بين الجولتين.",
  BANDS_CHANGED: "تغيّرت نطاقات التفسير بين الجولتين.",
  VERSION_CHANGED: "تغيّر إصدار الاستبانة، والمقارنة تستند إلى مراجعة معلنة.",
  noComparison: "لم تُطلب مقارنة مع جولة أخرى في هذا التقرير.",
  notComparable:
    "قُيّمت الجولتان على أنهما غير قابلتين للمقارنة، فلا يعرض التقرير أي فارق رقمي.",

  withheldSummary: "المؤشرات المحجوبة",
  withheldNone: "لم يُحجب أي مؤشر في هذا الإصدار.",
  limitationsBody:
    "هذا التقرير عرض لنتائج مجمّعة اجتازت فحوص الإفصاح. الضوابط المطبّقة هي حد أدنى للمساهمين وحجب تكاملي وحجب التجانس، وهي ليست خصوصية تفاضلية وليست إثباتًا رياضيًا لعدم إمكانية الاستدلال أمام قارئ يمتلك معرفة خارجية عن شخص بعينه.",
  limitationsDifferencing:
    "طرح نتائج جولتين لمجتمعين متداخلين يكشف مجموع نتائج من انضم أو غادر بينهما؛ فإذا كان الفارق شخصًا واحدًا أمكن استنتاج نتيجته الفردية من الأرقام المنشورة وحدها. تُنشر هذه التقارير وهذا الحدّ معلن، وهو ليس مما تمنعه ضوابط الإفصاح داخل الجولة الواحدة.",
  limitationsDescriptive:
    "جميع الفروق وصفية. لا يتضمن التقرير دلالة إحصائية ولا علاقة سببية ولا تشخيصًا ولا مقارنة معيارية.",
  limitationsNoIndividual:
    "لا يحتوي هذا الملف على أي إجابة فردية أو اسم مشارك أو معرّف استجابة، ولا يمكن اشتقاق أي منها منه.",

  sheetSummary: "الملخص",
  sheetDimensions: "الأبعاد",
  sheetDepartments: "الأقسام",
  sheetQuestions: "الأسئلة",
  sheetRecommendations: "التوصيات",
  sheetHistory: "التطور",
  sheetMethodology: "المنهجية",
  field: "البند",
  detail: "التفصيل",

  participationExport: "قائمة المشاركة بالأسماء",
  participationExportNote:
    "ملف منفصل يحتوي أسماء وحالة الإكمال فقط، ولا يتضمن أي إجابة أو نتيجة أو معرّف استجابة.",
} as const;

export type ReportMessageKey = keyof typeof ar;

const en: Record<ReportMessageKey, string> = {
  reportTitle: "Organizational fit report",
  documentKind: "Assessment round results report",
  confidential: "Confidential internal document — for use with this organization only",
  organization: "Organization",
  series: "Assessment series",
  round: "Round",
  period: "Collection period",
  purpose: "Purpose",
  generated: "Results released",
  rendered: "File generated",
  timezone: "Time zone",
  reportId: "Report identifier",
  snapshotId: "Release identifier",
  page: "Page",
  of: "of",
  contents: "Contents",

  executiveSummary: "Executive summary",
  summaryOverall:
    "The published overall score for this round is {value} out of 100, in the “{band}” band.",
  summaryOverallWithheld: "No overall score was published for this round. {reason}",
  summaryContributors:
    "The report rests on {contributors} valid contributors, with a publication threshold of {threshold}.",
  summaryMetrics:
    "{released} of {total} metrics were published; {withheld} were withheld to protect privacy.",
  summaryRecommendations:
    "The deterministic recommendation rules produced {count} eligible recommendations for this round.",
  summaryNoRecommendations:
    "No recommendation rule applied to the published results of this round.",

  methodology: "Methodology",
  methodologyBody:
    "Answers are collected through individual links delivered manually, and a participant's identity is separated from their final answers before any calculation. Scores are computed on a zero to one hundred scale by a version-pinned engine, and the release plan passes disclosure checks before anything is shown.",
  methodologyThreshold:
    "A metric is published only where at least {threshold} valid contributors answered it. It is also withheld where every contributor gave the identical value, or where publishing it beside the company result would allow a smaller group's result to be inferred.",
  methodologyDeterministic:
    "Recommendations are deterministic rules applied to published results only. No generative model is used, and no rule produces a recommendation from a withheld result.",
  methodologyScope:
    "All comparisons are within this organization. There is no benchmarking against other organizations.",
  instrument: "Questionnaire",
  instrumentVersion: "Questionnaire version",
  instrumentHash: "Questionnaire content hash",
  engine: "Scoring engine version",
  disclosure: "Disclosure policy version",
  rulesVersion: "Recommendation rules version",
  privacyVersion: "Privacy policy version",
  contentHash: "Release content hash",
  reviewReference: "Disclosure review reference",
  themeVersion: "Report template version",

  participation: "Participation",
  participationNote:
    "Participation figures are totals only. This report contains no participant name or identifier, and no answer can be linked to a person.",
  invited: "Invited",
  completed: "Completed",
  revoked: "Revoked invitations",
  outstanding: "Outstanding",
  eligible: "Active invitations",
  rate: "Completion rate",
  contributors: "Valid contributors",
  threshold: "Publication threshold",

  overall: "Overall score",
  dimensions: "Dimension results",
  departments: "Department results",
  questions: "Question analysis",
  strengths: "Leading strengths",
  risks: "Areas to review",
  recommendations: "Recommendations",
  history: "Change across rounds",
  comparison: "Two-round comparison",
  limitations: "Interpretation and disclosure limits",
  manifest: "Version manifest",

  metric: "Metric",
  group: "Group",
  company: "Company",
  value: "Value",
  band: "Band",
  coverage: "Coverage",
  status: "Status",
  reason: "Reason not published",
  gap: "Gap to company (points)",
  share: "Share",
  count: "Count",
  option: "Option",
  question: "Question",
  direction: "Interpretation direction",
  HIGH_GOOD: "Higher is better",
  HIGH_RISK: "Higher indicates risk",
  scale: "Zero to one hundred scale",
  none: "None",
  notApplicable: "Not applicable",

  AVAILABLE: "Published",
  SUPPRESSED: "Withheld",
  INSUFFICIENT: "Below threshold",
  UNSCORED: "Not scored",
  NOT_COMPARABLE: "Not comparable",
  COMPARABLE: "Comparable",
  GAP: "Unavailable",
  BELOW_THRESHOLD: "Fewer contributors than the publication threshold for this metric.",
  COMPLEMENTARY:
    "The department breakdown was withheld because publishing it beside the company result would allow a small department's result to be inferred.",
  HOMOGENEOUS:
    "Every contributor gave the identical value, so publishing the mean would republish each individual answer.",
  SPARSE_BIN:
    "One option was chosen by fewer contributors than the threshold, so the whole distribution was withheld.",
  RAW_WITHHELD: "Free text and exact dates are never published in results.",
  NO_VALID_SCORE: "Not enough answers to compute this metric.",
  NOT_RELEASED: "Not part of the release plan for this campaign.",
  MEASUREMENT_CHANGED: "The measurement definition changed, so the points are not connected.",
  BOTH_WITHHELD: "Both rounds withheld this value.",
  EARLIER_WITHHELD: "The earlier round withheld this value.",
  LATER_WITHHELD: "The later round withheld this value.",

  severity: "Severity",
  priority: "Priority",
  NONE: "None",
  LOW: "Low",
  MODERATE: "Moderate",
  HIGH: "High",
  CRITICAL: "Critical",
  computedFinding: "Deterministic rule finding",
  suggestedAction: "Suggested action",
  rationale: "Rationale",
  evidence: "Published evidence",
  ruleReference: "Rule reference",
  consultantCommentary: "Consultant commentary",
  consultantCommentaryNote:
    "The following is a human opinion written by an OrgFit consultant. It is not a rule outcome and not a measurement, and it does not change the computed text above.",
  followUpStatus: "Follow-up status",
  owner: "Owner",
  unassigned: "Unassigned",
  dueDate: "Due date",
  consultantNotes: "Consultant notes",
  resolution: "Resolution",
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  DONE: "Done",
  DISMISSED: "Dismissed",
  noRecommendations: "No rule applied to the published results of this round.",

  trendMetric: "Metric",
  trendRound: "Round",
  trendValue: "Value",
  trendBreak: "Break",
  historyNote:
    "Trend points are connected only while the measurement definition is unchanged. A changed definition is shown as an explicit break and is never interpolated.",
  noHistory: "This series has no earlier rounds to show.",
  comparisonOf: "Comparison of {left} with {right}",
  earlier: "Earlier round",
  later: "Later round",
  pointChange: "Point change",
  percentChange: "Relative change",
  improved: "Improved",
  worsened: "Declined",
  unchanged: "Unchanged",
  classification: "Comparability classification",
  IDENTICAL: "Same version",
  REVIEWED_EQUIVALENT: "Reviewed as equivalent",
  reviewedBy: "Reviewed by",
  reviewedAt: "Reviewed on",
  caveats: "Population caveats",
  CONTRIBUTORS_CHANGED:
    "The number of contributors differs between the rounds. The difference is descriptive and does not mean the same people changed their minds.",
  POPULATION_CHANGE_SMALL:
    "The number of contributors changed by fewer than the publication threshold. Subtracting the two rounds' results then reveals the individual result of whoever joined or left between them. This is a declared limit of this comparison, not a fault in it, and it is not something the within-round disclosure controls prevent.",
  GROUPS_ADDED:
    "The later round has departments with no counterpart in the earlier one, so they were not compared.",
  GROUPS_REMOVED:
    "The earlier round has departments with no counterpart in the later one, so they were not compared.",
  THRESHOLD_CHANGED: "The publication threshold changed between the rounds.",
  BANDS_CHANGED: "The interpretation bands changed between the rounds.",
  VERSION_CHANGED:
    "The questionnaire version changed; the comparison rests on a declared review.",
  noComparison: "No comparison with another round was requested for this report.",
  notComparable:
    "The two rounds were judged not comparable, so this report shows no numeric difference between them.",

  withheldSummary: "Withheld metrics",
  withheldNone: "No metric was withheld in this release.",
  limitationsBody:
    "This report presents aggregate results that passed disclosure checks. The controls applied are a minimum contributor threshold plus complementary and homogeneity suppression. They are not differential privacy and are not a mathematical proof against inference by a reader who holds outside knowledge about a specific person.",
  limitationsDifferencing:
    "Subtracting two rounds of overlapping populations reveals the combined result of whoever joined or left between them; where that is one person, their individual result can be derived from the published figures alone. These reports are published with that limit declared, and it is not something the within-round disclosure controls prevent.",
  limitationsDescriptive:
    "All differences are descriptive. This report implies no statistical significance, causation, diagnosis or benchmark.",
  limitationsNoIndividual:
    "This file contains no individual answer, participant name or response identifier, and none can be derived from it.",

  sheetSummary: "Summary",
  sheetDimensions: "Dimensions",
  sheetDepartments: "Departments",
  sheetQuestions: "Questions",
  sheetRecommendations: "Recommendations",
  // Excel reserves the sheet name "History" for its own change-tracking sheet,
  // so the workbook cannot use it however natural it reads.
  sheetHistory: "Round history",
  sheetMethodology: "Methodology",
  field: "Field",
  detail: "Detail",

  participationExport: "Named participation list",
  participationExportNote:
    "A separate file containing names and completion status only. It contains no answer, score or response identifier.",
};

export const reportMessages = (locale: Locale) => (locale === "en" ? en : ar);

export const localeText = (
  value: { ar?: string | null; en?: string | null } | null | undefined,
  locale: Locale,
) => (!value ? "" : ((locale === "en" ? value.en || value.ar : value.ar) ?? ""));

// Placeholder substitution for the summary sentences. Only the named keys are
// replaced; an unknown placeholder is left as written rather than blanked, so a
// wording mistake is visible instead of silently producing a truncated claim.
export function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  );
}
