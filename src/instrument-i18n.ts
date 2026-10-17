import type { Locale } from "./i18n";
import type { IssueLocation } from "./instrument-input";

// The questionnaire builder's validation checklist. Every entry says what to
// do, and where: the position and title the editor itself shows, the field and
// the language, never a bare identifier.
const ar = {
  // What each issue code asks the builder to do.
  issues: {
    TRANSLATION_REQUIRED: "أكمل النص في هذه اللغة.",
    DUPLICATE_KEY: "معرّف مكرر.",
    NO_QUESTIONS: "أضف سؤالاً واحداً على الأقل قبل النشر؛ أقسام المحتوى وحدها لا تكفي.",
    QUESTION_COUNT: "الحد الأقصى ٢٠٠ عنصر إجابة؛ احذف بعض الأسئلة أو صفوف المصفوفات.",
    TYPE_CONFIG: "إعداد غير متوافق مع نوع السؤال.",
    OPTIONS_REQUIRED: "أضف خيارات أو صفوفاً مكتملة.",
    SELECTION_RANGE: "راجع الحدين الأدنى والأعلى للاختيارات.",
    RANGE: "الحد الأدنى يجب أن يسبق الحد الأعلى.",
    REFERENCE: "مرجع مفقود أو بعد بلا أسئلة مقاسة.",
    SCORING_ELIGIBILITY: "نوع السؤال غير متوافق مع إعداد القياس.",
    BOUNDS_REQUIRED: "يلزم نطاق قياس معلوم وغير ثابت.",
    ATTAINABLE_BOUNDS:
      "راجع حدود الخيارات ودقة الأرقام؛ يجب أن تسمح بقيم مختلفة قابلة للإجابة.",
    WEIGHT_MODE: "استخدم المتوسط المرجح للأوزان المختلفة، أو أعد الأوزان إلى ١.",
    MIXED_SUM_SCALES:
      "يتطلب الجمع نطاقاً مشتركاً؛ استخدم متوسط القيم المعيارية للمقاييس المختلفة.",
    BANDS: "النطاقات يجب أن تغطي ٠–١٠٠ بالترتيب بلا فجوات.",
    COVERAGE: "التغطية أكبر من صفر ولا تتجاوز واحداً.",
    ALL_REQUIRED: "المجموع والنسبة يتطلبان أسئلة مطلوبة وتغطية كاملة.",
    DENOMINATOR: "المقام يساوي عدد أسئلة نعم/لا المطلوبة غير المعكوسة.",
    DIRECTION: "راجع اتجاه البعد والتحويل الكلي.",
    UNSCORED: "أزل مراجع القياس غير المفعلة.",
    CONTENT_UNSCORED: "المحتوى لا يتطلب إجابة ولا يدخل القياس.",
    YES_NO_MAPPING: "نعم/لا يتطلب قيمتي ٠ و١ الثابتتين.",
    RULE_TOO_LARGE: "قلّل عدد المقارنات في هذه القاعدة.",
    IMPOSSIBLE_CONDITION: "لا يمكن لأي درجة أن تحقق شروط هذه القاعدة معاً؛ راجع المقارنات.",
    UNKNOWN_PLACEHOLDER: "استخدم فقط {score} و{band} و{metric} و{group} في النص.",
    EXCLUSIVITY_PRIORITY: "قاعدتان في مجموعة الاستبعاد نفسها لهما الأولوية نفسها؛ غيّر إحداهما.",
    // Test scoring (scoreDraft / scoreInstrument) rather than the definition.
    INPUT_INCOMPLETE: "أكمل إعداد هذا البعد أولاً؛ الدرجة الكلية تحتاج كل أبعادها.",
    ANSWER_FORMAT: "صيغة الإجابات التجريبية غير صالحة.",
    ANSWER_RANGE: "إجابة تجريبية خارج ما يسمح به هذا السؤال؛ غيّرها ثم أعد الحساب.",
    UNKNOWN_ANSWER: "إجابة تجريبية لسؤال لم يعد موجوداً؛ امسح التجربة ثم أعد التعبئة.",
    DEFINITION_FORMAT: "بعض الحقول غير صالحة؛ تحقق من الأرقام والنصوص.",
    UNSUPPORTED_VERSION: "إصدار محرك الحساب غير مدعوم لهذه النسخة.",
  },
  otherIssue: "راجع الحقل المشار إليه.",
  // Where it is.
  section: "القسم {n}",
  question: "السؤال {n}",
  option: "الخيار {n}",
  row: "الصف {n}",
  column: "العمود {n}",
  dimension: "البعد {n}",
  band: "النطاق {n}",
  rule: "القاعدة {n}",
  overall: "القياس الكلي",
  sections: "أقسام الاستبيان",
  fields: {
    title: "العنوان",
    introduction: "المقدمة",
    privacyText: "إشعار الخصوصية",
    content: "المحتوى",
    help: "الإرشادات",
    description: "الوصف",
    body: "الشرح",
    action: "الإجراء المقترح",
    rationale: "المسوّغ",
  },
  instrumentTitle: "عنوان الاستبيان",
  languages: { ar: "العربية", en: "English" },
  goTo: "انتقل إلى الحقل",
  // The checklist while editing: what is left before publishing, and the
  // few entries that stop the draft from being saved at all.
  checklist: "قائمة التحقق",
  remaining: "تُحفظ المسودة كما هي. هذا ما بقي قبل أن يمكن نشرها.",
  blockingLead: "لا تُحفظ المسودة حتى تُصلح البنود المعلَّمة «تمنع الحفظ».",
  blocksSave: "تمنع الحفظ",
  saveBlocked: "لم تُحفظ المسودة: أصلح البنود المعلَّمة «تمنع الحفظ» في قائمة التحقق.",
  // PostgreSQL refused a publication the checklist allowed. Nothing changed.
  databaseRefused:
    "رفضت قاعدة البيانات نشر هذه النسخة رغم خلوّ قائمة التحقق. لم يُنشر شيء وما زالت المسودة محفوظة كما هي. أعد تحميل الصفحة ثم اضغط «التحقق للنشر»؛ وإن تكرر الرفض فأبلغ فريق التطوير باسم الاستبيان ورقم النسخة.",
};
const en: typeof ar = {
  issues: {
    TRANSLATION_REQUIRED: "Complete the text in this language.",
    DUPLICATE_KEY: "Duplicate identifier.",
    NO_QUESTIONS:
      "Add at least one question before publishing; content sections alone are not enough.",
    QUESTION_COUNT:
      "A questionnaire holds at most 200 answer items; remove some questions or matrix rows.",
    TYPE_CONFIG: "Configuration does not match question type.",
    OPTIONS_REQUIRED: "Complete options or matrix rows.",
    SELECTION_RANGE: "Check minimum and maximum selections.",
    RANGE: "Minimum must precede maximum.",
    REFERENCE: "Missing reference or dimension without scored items.",
    SCORING_ELIGIBILITY: "Question type is incompatible with scoring configuration.",
    BOUNDS_REQUIRED: "Scoring requires known nonconstant bounds.",
    ATTAINABLE_BOUNDS:
      "Check selection bounds and number precision; distinct attainable values are required.",
    WEIGHT_MODE: "Use weighted average for unequal weights, or reset weights to 1.",
    MIXED_SUM_SCALES:
      "Sum requires a common scale; use normalized averages for different scales.",
    BANDS: "Bands must cover 0–100 in order without gaps.",
    COVERAGE: "Coverage must be greater than zero and at most one.",
    ALL_REQUIRED: "Sum and percentage require mandatory items and full coverage.",
    DENOMINATOR: "Denominator must equal the required unreversed yes/no item count.",
    DIRECTION: "Check dimension direction and overall inversion.",
    UNSCORED: "Remove inactive scoring references.",
    CONTENT_UNSCORED: "Content cannot require answers or be scored.",
    YES_NO_MAPPING: "Yes/no requires canonical 0 and 1 mappings.",
    RULE_TOO_LARGE: "Reduce the number of comparisons in this rule.",
    IMPOSSIBLE_CONDITION: "No score can meet this rule's conditions together; review the comparisons.",
    UNKNOWN_PLACEHOLDER: "Use only {score}, {band}, {metric} and {group} in the text.",
    EXCLUSIVITY_PRIORITY:
      "Two rules in the same exclusivity group share a priority; change one of them.",
    INPUT_INCOMPLETE: "Complete this dimension first; the overall score needs all of its dimensions.",
    ANSWER_FORMAT: "The test answers are not in a valid format.",
    ANSWER_RANGE: "A test answer is outside what this question allows; change it and calculate again.",
    UNKNOWN_ANSWER: "A test answer belongs to a question that no longer exists; clear the preview and fill it again.",
    DEFINITION_FORMAT: "Some fields are invalid; check numbers and text.",
    UNSUPPORTED_VERSION: "This version's scoring engine is not supported.",
  },
  otherIssue: "Review the referenced field.",
  section: "Section {n}",
  question: "Question {n}",
  option: "Option {n}",
  row: "Row {n}",
  column: "Column {n}",
  dimension: "Dimension {n}",
  band: "Band {n}",
  rule: "Rule {n}",
  overall: "Overall metric",
  sections: "Questionnaire sections",
  fields: {
    title: "Title",
    introduction: "Introduction",
    privacyText: "Privacy notice",
    content: "Content",
    help: "Help",
    description: "Description",
    body: "Body",
    action: "Suggested action",
    rationale: "Rationale",
  },
  instrumentTitle: "Questionnaire title",
  languages: { ar: "العربية", en: "English" },
  goTo: "Go to field",
  checklist: "Validation checklist",
  remaining: "The draft saves as it is. This is what is left before it can be published.",
  blockingLead: "The draft is not saved until the items marked “Blocks saving” are fixed.",
  blocksSave: "Blocks saving",
  saveBlocked: "The draft was not saved: fix the items marked “Blocks saving” in the checklist.",
  databaseRefused:
    "The database refused to publish this version although the checklist is empty. Nothing was published and the draft is still saved as it was. Reload the page, then press “Validate for publication”; if it is refused again, report the questionnaire name and version number to the development team.",
};
export const instrumentMessages = (locale: Locale) => (locale === "en" ? en : ar);

/** What an issue code asks for, in the reader's language. */
export function issueMessage(code: string, locale: Locale) {
  const m = instrumentMessages(locale);
  return (m.issues as Record<string, string>)[code] ?? m.otherIssue;
}

/**
 * Where an issue is, as the editor shows it: "Section 2 «Workload» ·
 * Question 3 «How often…» · Option 1 — العربية". A title is quoted in the
 * reader's language when it has one, else in the other language, and long
 * text is shortened.
 */
export function describeLocation(loc: IssueLocation, locale: Locale) {
  const m = instrumentMessages(locale);
  const n = (template: string, value: number) => template.replace("{n}", String(value));
  const quote = (text: { ar: string; en: string }) => {
    const value = (text[locale].trim() || text[locale === "ar" ? "en" : "ar"].trim()).replace(/\s+/g, " ");
    return value ? `«${value.length > 60 ? `${value.slice(0, 59)}…` : value}»` : "";
  };
  const named = (template: string, value: number, text?: { ar: string; en: string }) =>
    [n(template, value), text ? quote(text) : ""].filter(Boolean).join(" ");
  const parts: string[] = [];
  if (loc.kind === "instrument")
    parts.push(loc.field === "title" ? m.instrumentTitle : m.fields[loc.field as keyof typeof m.fields] ?? "");
  if (loc.kind === "sections") parts.push(m.sections);
  if (loc.kind === "overall") parts.push(m.overall);
  if (loc.section) parts.push(named(m.section, loc.section.n, loc.section.title));
  if (loc.question) parts.push(named(m.question, loc.question.n, loc.question.prompt));
  if (loc.dimension) parts.push(named(m.dimension, loc.dimension.n, loc.dimension.name));
  if (loc.kind === "band" && !loc.dimension) parts.push(m.overall);
  if (loc.rule) parts.push(named(m.rule, loc.rule.n, loc.rule.title));
  if (loc.item !== undefined)
    parts.push(
      n(
        loc.kind === "row" ? m.row : loc.kind === "column" ? m.column : loc.kind === "band" ? m.band : m.option,
        loc.item,
      ),
    );
  if (loc.field && loc.kind !== "instrument")
    parts.push(m.fields[loc.field as keyof typeof m.fields] ?? loc.field);
  const where = parts.filter(Boolean).join(" · ");
  return loc.locale ? `${where} — ${m.languages[loc.locale]}` : where;
}
