// ---------------------------------------------------------------------------
// The public overview page's copy.
//
// Arabic is written first and written as Arabic — not as a translation of an
// English marketing page. The English catalog is a complete parallel text, not
// a fallback.
//
// Two content rules this file is held to, and they are product rules rather
// than editorial taste:
//
//   * Nothing here may describe a capability the product does not implement.
//     Every claim below maps to a module that exists: the directory, the
//     questionnaire builder, campaigns, publication and disclosure, the
//     deterministic recommendation evaluator, the report renderer and field
//     visits.
//   * Nothing here may overclaim privacy. The implemented model separates
//     participation tracking from finalized answers and withholds a metric
//     below its contributor threshold. It is NOT unconditional anonymity, and
//     the blueprint forbids saying so. See docs/orgfit/publication.md and the
//     residual limits in docs/orgfit/checkpoint-e.md.
//
// There are no customers, logos, testimonials, adoption numbers, certifications
// or performance figures in this file, because the product has none. Every
// figure that appears on screen is synthetic and is labelled as such.
// ---------------------------------------------------------------------------

import type { Locale } from "./i18n";

export type LandingCopy = {
  navOverview: string;
  navCapabilities: string;
  navWorkflow: string;
  navFaq: string;
  navMenu: string;
  navOpenMenu: string;
  navCloseMenu: string;
  signIn: string;

  heroHeadline: string;
  heroBody: string;
  heroSecondary: string;
  heroNote: string;

  previewTitle: string;
  previewSynthetic: string;
  previewRound: string;
  previewOverall: string;
  previewParticipation: string;
  previewDimensions: string[];
  previewWithheld: string;
  previewWithheldNote: string;
  previewRecommendation: string;
  previewRecommendationBody: string;

  capabilitiesTitle: string;
  capabilitiesLead: string;
  capabilities: { title: string; body: string }[];

  workflowTitle: string;
  workflowLead: string;
  workflow: { title: string; body: string }[];

  privacyTitle: string;
  privacyLead: string;
  privacyPoints: { title: string; body: string }[];
  privacyLimit: string;

  productTitle: string;
  productLead: string;
  productPanels: { title: string; body: string; caption: string }[];

  faqTitle: string;
  faq: { q: string; a: string }[];

  ctaTitle: string;
  ctaBody: string;
  ctaNote: string;

  footerDescription: string;
  footerSections: string;
  footerInternal: string;
  footerRespondent: string;
};

const ar: LandingCopy = {
  navOverview: "نظرة عامة",
  navCapabilities: "قدرات المنصة",
  navWorkflow: "مسار العمل",
  navFaq: "أسئلة متكررة",
  navMenu: "قائمة التنقل",
  navOpenMenu: "فتح قائمة التنقل",
  navCloseMenu: "إغلاق قائمة التنقل",
  signIn: "تسجيل الدخول",

  heroHeadline: "رؤية أوضح للمؤسسات، وقرارات تستند إلى البيانات",
  heroBody:
    "مساحة عمل داخلية واحدة يستخدمها فريق OrgFit لبناء أدوات التقييم، وإطلاق الاستبانات، ومتابعة المشاركة، وتحليل النتائج على مستوى المؤسسة، واشتقاق التوصيات، وإصدار التقارير، وتوثيق الزيارات الميدانية — دون تنقّل بين أدوات متفرقة.",
  heroSecondary: "استكشف المنصة",
  heroNote:
    "منصة داخلية لفريق OrgFit. لا تُنشأ الحسابات ذاتيًا، ولا يحتاج المشاركون في الاستبانات إلى حساب.",

  previewTitle: "جولة تقييم — عرض توضيحي",
  previewSynthetic: "بيانات توضيحية",
  previewRound: "الجولة السنوية ٢٠٢٦",
  previewOverall: "المؤشر العام",
  previewParticipation: "نسبة المشاركة",
  previewDimensions: [
    "القيادة والتوجيه",
    "التواصل الداخلي",
    "بيئة العمل",
    "التطوير المهني",
    "العمليات والإجراءات",
  ],
  previewWithheld: "محجوب",
  previewWithheldNote:
    "خلية محجوبة لأن عدد المساهمين فيها أقل من الحد الأدنى. لا تحمل قيمة في أي مكان.",
  previewRecommendation: "توصية مشتقّة بقاعدة",
  previewRecommendationBody:
    "انخفاض مؤشر التواصل الداخلي عن حد المراجعة يستدعي جلسة عمل مع قيادات الأقسام.",

  capabilitiesTitle: "ما الذي تفعله المنصة",
  capabilitiesLead:
    "ست قدرات مترابطة تغطي دورة التقييم كاملة، من وصف المؤسسة حتى المتابعة الميدانية.",
  capabilities: [
    {
      title: "المؤسسات والأقسام",
      body: "مساحة عمل لكل مؤسسة مصرَّح بها، بهيكل أقسام متعدد المستويات وسجل مشاركين خاص، مع استيراد مُراجَع من ملفات CSV وXLSX. لا تتجاوز بيانات أي مؤسسة حدودها.",
    },
    {
      title: "بناء الاستبانات والقوالب",
      body: "محرّر لبناء الاستبانات بأبعادها وأوزانها وأنواع أسئلتها، مع قوالب قابلة لإعادة الاستخدام. النسخة المنشورة تُجمَّد: أي تعديل يتطلب إصدارًا جديدًا، فلا تتغير قراءة أُخذت بالفعل.",
    },
    {
      title: "الحملات ومتابعة المشاركة",
      body: "حملة لكل جولة تقييم، بروابط دعوة تُولَّد يدويًا وتُستخدم مرة واحدة. تتابع لوحة المشاركة من أكمل ومن لم يكمل، دون أن تفتح إجابات أحد.",
    },
    {
      title: "التحليل التجميعي والمقارنة التاريخية",
      body: "نتائج على مستوى المؤسسة والأبعاد والأقسام، وسلسلة زمنية تقارن الجولات المنشورة فقط. المقارنة بين جولتين تتطلب مراجعة موثَّقة تُقرّ أن القياسين يقيسان الشيء نفسه.",
    },
    {
      title: "توصيات قائمة على قواعد",
      body: "قواعد رقمية صريحة يكتبها الفريق على مسوّدة الاستبانة وتُجمَّد مع نشرها. النتيجة حتمية وقابلة للتفسير: لا نموذج لغوي، ولا قاعدة تُفعَّل بمدخل محجوب.",
    },
    {
      title: "التقارير والزيارات الميدانية",
      body: "تقارير PDF وXLSX بالعربية أو الإنجليزية تُبنى من النتائج المنشورة وحدها، وسجلّ للزيارات الاستشارية بإجراءات متابعة ومرفقات خاصة تمرّ بفحص قبل إتاحتها.",
    },
  ],

  workflowTitle: "كيف يجري العمل",
  workflowLead: "أربع مراحل، ولكل مرحلة منها شاشتها داخل مساحة العمل.",
  workflow: [
    {
      title: "إعداد المؤسسة والمشاركين",
      body: "تُنشأ مساحة المؤسسة، وتُبنى شجرة الأقسام، ويُستورد سجل المشاركين أو يُضاف يدويًا بعد مراجعة.",
    },
    {
      title: "إنشاء التقييم وإطلاق الاستبيان",
      body: "تُبنى الاستبانة أو يُعاد استخدام قالب، ثم تُنشر نسخة مجمَّدة وتُطلق حملة تولّد رابط دعوة خاصًا لكل مشارك.",
    },
    {
      title: "متابعة المشاركة وتحليل النتائج",
      body: "تُتابع نسبة الإكمال أثناء فتح الحملة. بعد الإغلاق وفحوص الخصوصية تُنشر النتائج التجميعية دفعة واحدة غير قابلة للتعديل.",
    },
    {
      title: "تحويل النتائج إلى توصيات ومتابعة ميدانية",
      body: "تُشتق التوصيات من القواعد المجمَّدة، ويتولى الفريق متابعتها بمالك وتاريخ استحقاق، ثم تُوثَّق الزيارة الميدانية وإجراءاتها.",
    },
  ],

  privacyTitle: "كيف تُعامل بيانات المشاركين",
  privacyLead:
    "الفصل بين «من شارك» و«ماذا أُجيب» مبني في بنية النظام، لا في سياسة استخدام.",
  privacyPoints: [
    {
      title: "متابعة المشاركة منفصلة عن الإجابات",
      body: "تعرف الحملة أن فلانًا أكمل الاستبانة، ولا يوجد في المنصة مسار يربط شخصًا بإجاباته: لا عارض إجابات فردية، ولا بطاقة نتيجة شخصية، ولا تصدير على مستوى الفرد.",
    },
    {
      title: "النتائج تُقرأ مجمَّعة فقط",
      body: "تُنشر القيم على مستوى المؤسسة والأبعاد والأقسام. لا تُعرض إجابة فرد في أي شاشة أو تقرير أو ملف.",
    },
    {
      title: "حدّ أدنى لحجم المجموعة",
      body: "لا يُفرج عن مؤشر ما لم يساهم فيه خمسة مشاركين صالحين على الأقل، وتُضاف ضوابط تكميلية لمنع استنتاج قيمة محجوبة من القيم المجاورة. الخلية المحجوبة لا تحمل قيمة في التخزين ولا في الواجهة.",
    },
  ],
  privacyLimit:
    "هذا نموذج فصل وحدّ أدنى للإفصاح، وليس ضمان إخفاء هوية مطلقًا. يظل أثر المقارنة بين جولتين منشورتين قابلًا للاستنتاج في حالات معيّنة، وهو أمر موثَّق صراحةً في وثائق المنصة وتحت مراجعة خصوصية مستقلة قبل أي جمع بيانات حقيقي.",

  productTitle: "لمحة من داخل مساحة العمل",
  productLead:
    "الشاشات أدناه تعكس قدرات منفَّذة فعلًا، وكل رقم فيها مُركَّب لأغراض العرض.",
  productPanels: [
    {
      title: "لوحة النتائج",
      body: "مؤشر عام وأبعاد وتوزيع إجابات ومقارنة بين الأقسام، مع بيان صريح لكل خلية محجوبة وسبب حجبها.",
      caption: "أرقام توضيحية",
    },
    {
      title: "متابعة الحملة",
      body: "عدد المدعوين ومن أكمل ومن لم يبدأ بعد، محدَّثة أثناء فتح الحملة ومنفصلة تمامًا عن محتوى الإجابات.",
      caption: "أرقام توضيحية",
    },
    {
      title: "التوصيات والزيارات",
      body: "توصيات مشتقّة بقواعد مجمَّدة، وإلى جانبها سجلّ متابعة الفريق: المالك والحالة وتاريخ الاستحقاق ومحضر الزيارة.",
      caption: "محتوى توضيحي",
    },
  ],

  faqTitle: "أسئلة متكررة",
  faq: [
    {
      q: "من يستطيع الوصول إلى المنصة؟",
      a: "موظفو OrgFit المصرَّح لهم فقط. يُنشأ الحساب بدعوة من إدارة OrgFit، ويحدد المسؤول الدور والصلاحيات والمؤسسات المسندة قبل إرسال الدعوة. لا يوجد تسجيل ذاتي ولا حسابات للجهات العميلة.",
    },
    {
      q: "هل يحتاج المشاركون في الاستبانة إلى حساب؟",
      a: "لا. يصل المشارك عبر رابط خاص يُشارَك معه مباشرة، ويستطيع حفظ إجاباته ومتابعتها لاحقًا، ثم يرسلها مرة واحدة نهائية. لا يُنشئ حسابًا ولا يسجّل دخولًا.",
    },
    {
      q: "كيف تُعامل خصوصية المشاركين؟",
      a: "متابعة الإكمال منفصلة عن الإجابات المُسلَّمة، والنتائج تُقرأ مجمَّعة فقط، ولا يُفرج عن مؤشر يقل عدد مساهميه عن الحد الأدنى. هذا فصل وحدّ أدنى للإفصاح، وليس ادعاء إخفاء هوية مطلق.",
    },
    {
      q: "هل تدعم المنصة العربية والإنجليزية؟",
      a: "العربية هي اللغة الافتراضية بتخطيط من اليمين إلى اليسار، والإنجليزية متاحة بتخطيط من اليسار إلى اليمين. يشمل ذلك شاشات الفريق وتقارير PDF وملفات XLSX.",
    },
    {
      q: "هل يمكن إكمال الاستبانة على الهاتف؟",
      a: "نعم. صُممت شاشة المشارك للهاتف أولًا: أهداف لمس مريحة، وحفظ واستئناف، ومراجعة قبل الإرسال النهائي.",
    },
  ],

  ctaTitle: "ادخل إلى مساحة العمل",
  ctaBody:
    "سجّل الدخول بحسابك المؤسسي لمتابعة التقييمات والنتائج والزيارات المسندة إليك.",
  ctaNote: "لا تملك حسابًا؟ تُنشأ حسابات الموظفين بدعوة من إدارة OrgFit.",

  footerDescription:
    "منصة OrgFit الداخلية للتقييم التنظيمي والاستشارات: بناء التقييمات، وجمع الاستجابات، وتحليل النتائج مجمَّعة، ومتابعة التوصيات والزيارات الميدانية.",
  footerSections: "أقسام الصفحة",
  footerInternal: "استخدام داخلي لفريق OrgFit.",
  footerRespondent:
    "يصل المشاركون في الاستبانات عبر الرابط الخاص الذي تسلّموه، لا من هذه الصفحة.",
};

const en: LandingCopy = {
  navOverview: "Overview",
  navCapabilities: "Capabilities",
  navWorkflow: "How it works",
  navFaq: "FAQ",
  navMenu: "Navigation",
  navOpenMenu: "Open navigation",
  navCloseMenu: "Close navigation",
  signIn: "Sign in",

  heroHeadline: "A clearer view of the organization, and decisions grounded in its data",
  heroBody:
    "One internal workspace where the OrgFit team builds assessment instruments, launches surveys, tracks participation, analyses results at organization level, derives recommendations, issues reports and records consulting visits — without moving between separate tools.",
  heroSecondary: "Explore the platform",
  heroNote:
    "An internal platform for OrgFit staff. Accounts are not self-created, and survey respondents need no account.",

  previewTitle: "Assessment round — illustrative view",
  previewSynthetic: "Synthetic data",
  previewRound: "Annual round 2026",
  previewOverall: "Overall index",
  previewParticipation: "Participation",
  previewDimensions: [
    "Leadership and direction",
    "Internal communication",
    "Working environment",
    "Professional development",
    "Processes and procedures",
  ],
  previewWithheld: "Withheld",
  previewWithheldNote:
    "A cell withheld because fewer than the minimum number of people contributed to it. It carries no value anywhere.",
  previewRecommendation: "Rule-derived recommendation",
  previewRecommendationBody:
    "Internal communication falling below the review threshold calls for a working session with department leads.",

  capabilitiesTitle: "What the platform does",
  capabilitiesLead:
    "Six connected capabilities covering the whole assessment cycle, from describing the organization to following up in the field.",
  capabilities: [
    {
      title: "Organizations and departments",
      body: "A workspace for each authorized organization, with a multi-level department tree and a private participant register, plus reviewed CSV and XLSX imports. No organization's data leaves its own boundary.",
    },
    {
      title: "Questionnaire building and templates",
      body: "An editor for dimensions, weights and question types, with reusable templates. A published version is frozen: a change needs a new version, so a reading already taken never shifts underneath it.",
    },
    {
      title: "Campaigns and participation tracking",
      body: "A campaign per assessment round, with invitation links generated by hand and usable once. The participation board shows who finished and who has not, without opening anybody's answers.",
    },
    {
      title: "Aggregate analytics and historical comparison",
      body: "Results at organization, dimension and department level, and a time series drawn only from published rounds. Comparing two rounds requires a recorded review declaring that the two versions measure the same thing.",
    },
    {
      title: "Rule-based recommendations",
      body: "Explicit numeric rules written on a questionnaire draft and frozen when it publishes. The outcome is deterministic and explainable: no language model, and no rule fires on a withheld input.",
    },
    {
      title: "Reports and field visits",
      body: "Arabic or English PDF and XLSX reports built only from published results, and a record of consulting visits with follow-up actions and private attachments that are checked before they can be opened.",
    },
  ],

  workflowTitle: "How the work runs",
  workflowLead: "Four stages, each with its own screen inside the workspace.",
  workflow: [
    {
      title: "Set up the organization and its participants",
      body: "The organization workspace is created, the department tree is built, and the participant register is imported or entered after review.",
    },
    {
      title: "Build the assessment and launch the survey",
      body: "A questionnaire is built or a template reused, a frozen version is published, and a campaign generates a private invitation link for each participant.",
    },
    {
      title: "Track participation and analyse the results",
      body: "Completion is followed while the campaign is open. After it closes and the privacy checks run, aggregate results are published in one immutable release.",
    },
    {
      title: "Turn results into recommendations and field follow-up",
      body: "Recommendations are derived from the frozen rules, the team tracks each one with an owner and a due date, and the field visit and its actions are recorded.",
    },
  ],

  privacyTitle: "How participant data is handled",
  privacyLead:
    "The separation between who took part and what was answered is built into the system's structure, not stated in a usage policy.",
  privacyPoints: [
    {
      title: "Participation tracking is separate from answers",
      body: "A campaign knows that a given person finished. There is no path in the platform from a person to their answers: no individual response browser, no personal scorecard, no per-respondent export.",
    },
    {
      title: "Results are read in aggregate only",
      body: "Values are published at organization, dimension and department level. No individual answer appears on any screen, in any report, or in any file.",
    },
    {
      title: "A minimum group size",
      body: "A metric is not released unless at least five valid participants contributed to it, and complementary controls prevent a withheld value being read back off its neighbours. A withheld cell carries no value in storage or in the interface.",
    },
  ],
  privacyLimit:
    "This is a separation model with a disclosure threshold, not a guarantee of anonymity. Comparing two published rounds can still permit inference in specific cases; that is documented explicitly in the platform's own records and is under independent privacy review before any real data collection.",

  productTitle: "A look inside the workspace",
  productLead:
    "The screens below reflect capabilities that are actually implemented. Every figure in them is constructed for illustration.",
  productPanels: [
    {
      title: "Results board",
      body: "Overall index, dimensions, answer distribution and a department comparison, with every withheld cell named together with the reason it is withheld.",
      caption: "Illustrative figures",
    },
    {
      title: "Campaign tracking",
      body: "Invited, completed and not yet started, updated while the campaign is open and entirely separate from the content of any answer.",
      caption: "Illustrative figures",
    },
    {
      title: "Recommendations and visits",
      body: "Recommendations derived from frozen rules, beside the team's own follow-up record: owner, status, due date and the visit report.",
      caption: "Illustrative content",
    },
  ],

  faqTitle: "Frequently asked",
  faq: [
    {
      q: "Who can access the platform?",
      a: "Authorized OrgFit staff only. An account is created by invitation from OrgFit administration, and the administrator sets the role, the capabilities and the assigned organizations before the invitation is issued. There is no self-registration and no client-facing accounts.",
    },
    {
      q: "Do survey respondents need accounts?",
      a: "No. A respondent opens a private link shared with them directly, can save and resume, and then submits once, finally. They create no account and never sign in.",
    },
    {
      q: "How is participant privacy handled?",
      a: "Completion tracking is separate from submitted answers, results are read in aggregate only, and a metric with fewer contributors than the minimum is not released. That is a separation model with a disclosure threshold, not a claim of absolute anonymity.",
    },
    {
      q: "Does the platform support Arabic and English?",
      a: "Arabic is the default, laid out right to left; English is available left to right. That covers the team's screens as well as PDF reports and XLSX workbooks.",
    },
    {
      q: "Can questionnaires be completed on mobile?",
      a: "Yes. The respondent screen is designed for the phone first: comfortable touch targets, save and resume, and a review step before the final submission.",
    },
  ],

  ctaTitle: "Enter the workspace",
  ctaBody:
    "Sign in with your staff account to continue with the assessments, results and visits assigned to you.",
  ctaNote:
    "No account? Staff accounts are created by invitation from OrgFit administration.",

  footerDescription:
    "The internal OrgFit platform for organizational assessment and consulting: building assessments, collecting responses, analysing results in aggregate, and following up recommendations and field visits.",
  footerSections: "Page sections",
  footerInternal: "Internal use by the OrgFit team.",
  footerRespondent:
    "Survey respondents use the private link they received, not this page.",
};

export const landing = (locale: Locale) => (locale === "en" ? en : ar);
