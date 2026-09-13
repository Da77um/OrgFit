import type { Locale } from "./i18n";

// Respondent-facing text. Arabic is the default and is complete; English is a
// complete parallel catalog, because a respondent must never be shown a partial
// interface. No branding, palette or logo is invented here.
export const respondentAr = {
  appTitle: "استبانة OrgFit",
  loading: "جارٍ التحميل…",
  welcome: "مرحبًا بك",
  welcomeBody:
    "هذه الاستبانة مشتركة معك عبر رابط خاص. لا يوجد حساب ولا تسجيل دخول.",
  privacyTitle: "كيف تُعالَج إجاباتك",
  privacyDefault:
    "تُفصل إجاباتك عن هويتك قبل أي تحليل. يرى فريق OrgFit من أكمل الاستبانة ومن لم يكملها، ولا يستطيع أي موظف الاطلاع على إجابات شخص بعينه. لا تُنشر النتائج إلا بعد إغلاق الحملة ووجود خمسة مشاركين على الأقل.",
  // The heading is rendered separately by the welcome screen, so the sentence
  // no longer restates it.
  privacyLimits:
    "من يملك رابطك يستطيع فتح الاستبانة نيابة عنك، ولا يمكن للنظام إثبات من استخدم الرابط. تجنّب كتابة ما يدل على هويتك في الحقول النصية. هذه الحماية إدارية وتقنية، وليست ضمانًا رياضيًا ضد من يملك صلاحيات البنية التحتية.",
  begin: "ابدأ الاستبانة",
  resumeExisting: "استئناف إجاباتي المحفوظة",
  section: "القسم",
  of: "من",
  next: "التالي",
  previous: "السابق",
  saveDraft: "حفظ ومتابعة لاحقًا",
  saving: "جارٍ الحفظ…",
  saved: "تم الحفظ",
  saveFailed: "لم يُحفظ. حاول مرة أخرى.",
  notSaved: "لم تُحفظ التغييرات بعد",
  reviewTitle: "مراجعة الإجابات",
  reviewBody: "راجع إجاباتك قبل الإرسال النهائي. لا يمكن تعديلها بعد الإرسال.",
  submit: "إرسال نهائي",
  submitting: "جارٍ الإرسال…",
  confirmTitle: "تأكيد الإرسال النهائي",
  confirmBody:
    "بعد التأكيد تصبح إجاباتك نهائية ولا يمكن تعديلها أو استرجاعها أو حذفها.",
  confirm: "تأكيد وإرسال",
  cancel: "إلغاء",
  acceptedTitle: "تم استلام إجاباتك",
  acceptedBody:
    "سُجِّل إكمالك للاستبانة. لا يمكن فتح إجاباتك أو تعديلها من هذا الرابط.",
  requiredMissing: "أسئلة مطلوبة لم تُجب:",
  required: "مطلوب",
  optional: "اختياري",
  answered: "تمت الإجابة",
  progress: "التقدّم",
  mustAnswer: "هذا السؤال مطلوب.",
  goToQuestion: "الانتقال إلى السؤال",
  privacyLimitsTitle: "حدود مهمة",
  resumeCodeTitle: "رمز الاستئناف الخاص",
  resumeCodeBody:
    "احتفظ بهذا الرمز لمتابعة الاستبانة من جهاز آخر. هو المفتاح الوحيد لفك تشفير إجاباتك المحفوظة، ولا يملك فريق OrgFit نسخة منه.",
  resumeCodeCopy: "نسخ الرمز",
  resumeCodeCopied: "تم النسخ",
  resumeCodeLost:
    "إذا فقدت الرمز فلا يمكن استرجاع المسودة. يمكنك البدء من جديد فقط.",
  sharedDevice:
    "على جهاز مشترك: يستطيع من يستخدم المتصفح نفسه الوصول إلى المسودة المحفوظة محليًا.",
  resumeTitle: "استئناف من جهاز آخر",
  resumeBody: "الصق رمز الاستئناف الخاص بك.",
  resumeAction: "استئناف",
  resumeFailed: "تعذر فتح المسودة بهذا الرمز.",
  startOver: "البدء من جديد",
  startOverTitle: "حذف المسودة والبدء من جديد",
  startOverBody:
    "سيُحذف ما حفظته سابقًا نهائيًا ولن يمكن استرجاعه. لم تُرسل أي إجابة بعد.",
  conflictTitle: "تعارض في الحفظ",
  conflictBody:
    "حُفظت نسخة أحدث من هذه المسودة، غالبًا من نافذة أو جهاز آخر. حمّل النسخة الأحدث أو ابدأ من جديد.",
  reload: "تحميل النسخة الأحدث",
  notYetOpen: "لم تُفتح هذه الاستبانة بعد.",
  closed: "أُغلقت هذه الاستبانة ولم تعد تقبل إجابات.",
  unavailable: "هذا الرابط غير صالح أو لم يعد متاحًا.",
  sessionExpired: "انتهت الجلسة. افتح الرابط الأصلي مرة أخرى.",
  serviceUnavailable: "الخدمة غير متاحة حاليًا. حاول مرة أخرى بعد قليل.",
  invalidAnswers: "تحقق من الإجابات المحددة.",
  retry: "إعادة المحاولة",
  yes: "نعم",
  no: "لا",
  choose: "اختر",
  language: "English",
  skip: "الانتقال إلى المحتوى",
  // ---- Phase 13: truthful journey states and per-field rules ------------
  // Every sentence below states what actually happened, including what did
  // NOT: an unsaved change is never called saved, and an unconfirmed
  // submission is never called received or failed.
  offline:
    "أنت غير متصل بالإنترنت. إجاباتك باقية في هذه الصفحة فقط، ولن تُحفظ حتى يعود الاتصال.",
  saveFailedOffline: "لم يُحفظ لأن الاتصال مقطوع.",
  sessionEndedTitle: "انتهت الجلسة",
  sessionEndedBody:
    "لم يعد بالإمكان الحفظ أو الإرسال من هذه الصفحة. ما لم تحفظه لم يُرسل إلى أي مكان. افتح الرابط الأصلي مرة أخرى، ثم استأنف إجاباتك المحفوظة.",
  closedWhileEditing:
    "أُغلقت هذه الاستبانة أثناء تعبئتك لها، ولم تعد تقبل إجابات. لم تُرسل إجاباتك.",
  draftExistsBody:
    "توجد مسودة محفوظة لهذا الرابط، غالبًا من نافذة أو جهاز آخر، ولم تُستبدل. حمّلها أو استخدم رمز الاستئناف أو ابدأ من جديد.",
  submitUncertain:
    "تعذر التأكد من وصول إجاباتك بسبب الاتصال. تحقق من الاتصال ثم أرسل مرة أخرى؛ إعادة الإرسال لا تُنشئ إرسالًا ثانيًا أبدًا.",
  resumeCodeCopyFailed:
    "تعذر النسخ تلقائيًا. الرمز محدد الآن؛ انسخه يدويًا.",
  leaveUnsaved: "لديك تغييرات غير محفوظة.",
  numberHint: "يمكن الكتابة بالأرقام العربية أو اللاتينية.",
  numberRange: "القيمة بين {min} و{max}.",
  numberMinOnly: "أصغر قيمة مسموحة {min}.",
  numberMaxOnly: "أكبر قيمة مسموحة {max}.",
  wholeNumber: "عدد صحيح بلا كسور.",
  decimals: "حتى {n} منازل عشرية.",
  selectionsRange: "اختر من {min} إلى {max}.",
  dateRange: "تاريخ بين {min} و{max}.",
  issueInvalid: "هذه الإجابة ليست من الخيارات المتاحة.",
  issueNumberFormat: "اكتب رقمًا فقط، دون فواصل للآلاف أو رموز.",
  issueNumberPrecision: "عدد المنازل العشرية أكثر من المسموح.",
  issueNumberMin: "القيمة أصغر من الحد الأدنى {min}.",
  issueNumberMax: "القيمة أكبر من الحد الأعلى {max}.",
  issueDateFormat: "أدخل تاريخًا كاملًا.",
  issueDateMin: "التاريخ قبل أقرب تاريخ مسموح {min}.",
  issueDateMax: "التاريخ بعد آخر تاريخ مسموح {max}.",
  issueTooLong: "الإجابة أطول من {max} حرف.",
  issueTooFew: "اختر {min} على الأقل.",
  issueTooMany: "اختر {max} على الأكثر.",
  invalidSummary: "إجابات تحتاج إلى تصحيح:",
  rateLimited:
    "محاولات كثيرة خلال وقت قصير. انتظر دقيقة ثم أعد المحاولة؛ لم يتغير شيء في رابطك أو إجاباتك.",
} as const;
export type RespondentKey = keyof typeof respondentAr;
export const respondentEn: Record<RespondentKey, string> = {
  appTitle: "OrgFit questionnaire",
  loading: "Loading…",
  welcome: "Welcome",
  welcomeBody:
    "This questionnaire was shared with you through a private link. There is no account and no sign-in.",
  privacyTitle: "How your answers are handled",
  privacyDefault:
    "Your answers are separated from your identity before any analysis. OrgFit staff can see who has and has not completed the questionnaire, and no staff member can view an individual person's answers. Results are published only after the campaign closes and at least five people have contributed.",
  privacyLimits:
    "Anyone holding your link can open this questionnaire, and the service cannot prove who used it. Avoid writing anything that identifies you in free-text fields. These protections are organizational and technical; they are not a mathematical guarantee against someone with infrastructure privileges.",
  begin: "Start the questionnaire",
  resumeExisting: "Resume my saved answers",
  section: "Section",
  of: "of",
  next: "Next",
  previous: "Back",
  saveDraft: "Save and continue later",
  saving: "Saving…",
  saved: "Saved",
  saveFailed: "Not saved. Try again.",
  notSaved: "Changes are not saved yet",
  reviewTitle: "Review your answers",
  reviewBody:
    "Review your answers before the final submission. They cannot be changed afterwards.",
  submit: "Submit final answers",
  submitting: "Submitting…",
  confirmTitle: "Confirm final submission",
  confirmBody:
    "After you confirm, your answers become final and cannot be changed, retrieved or deleted.",
  confirm: "Confirm and submit",
  cancel: "Cancel",
  acceptedTitle: "Your answers were received",
  acceptedBody:
    "Your completion is recorded. Your answers cannot be opened or changed from this link.",
  requiredMissing: "Required questions still unanswered:",
  required: "Required",
  optional: "Optional",
  answered: "Answered",
  progress: "Progress",
  mustAnswer: "This question is required.",
  goToQuestion: "Go to this question",
  privacyLimitsTitle: "Important limits",
  resumeCodeTitle: "Private resume code",
  resumeCodeBody:
    "Keep this code to continue on another device. It is the only key that decrypts your saved answers, and OrgFit staff do not hold a copy.",
  resumeCodeCopy: "Copy code",
  resumeCodeCopied: "Copied",
  resumeCodeLost:
    "If you lose the code the saved draft cannot be recovered. You can only start over.",
  sharedDevice:
    "On a shared device: anyone using the same browser can reach the locally saved draft.",
  resumeTitle: "Resume on another device",
  resumeBody: "Paste your private resume code.",
  resumeAction: "Resume",
  resumeFailed: "That code could not open the saved draft.",
  startOver: "Start over",
  startOverTitle: "Delete the draft and start over",
  startOverBody:
    "What you saved earlier will be deleted permanently and cannot be recovered. Nothing has been submitted yet.",
  conflictTitle: "Save conflict",
  conflictBody:
    "A newer version of this draft was saved, most likely from another tab or device. Load the newer version or start over.",
  reload: "Load the newer version",
  notYetOpen: "This questionnaire has not opened yet.",
  closed: "This questionnaire is closed and no longer accepts answers.",
  unavailable: "This link is not valid or is no longer available.",
  sessionExpired: "The session ended. Open the original link again.",
  serviceUnavailable: "The service is unavailable. Please try again shortly.",
  invalidAnswers: "Check the highlighted answers.",
  retry: "Try again",
  yes: "Yes",
  no: "No",
  choose: "Choose",
  language: "العربية",
  skip: "Skip to content",
  offline:
    "You are offline. Your answers stay on this page only and are not saved until the connection returns.",
  saveFailedOffline: "Not saved: the connection is down.",
  sessionEndedTitle: "The session ended",
  sessionEndedBody:
    "This page can no longer save or submit. Anything you had not saved was not sent anywhere. Open your original link again, then resume your saved answers.",
  closedWhileEditing:
    "This questionnaire closed while you were answering and no longer accepts answers. Your answers were not submitted.",
  draftExistsBody:
    "A saved draft already exists for this link, most likely from another tab or device, and it was not replaced. Load it, use your resume code, or start over.",
  submitUncertain:
    "We could not confirm that your answers arrived because of the connection. Check the connection and submit again; submitting again never creates a second submission.",
  resumeCodeCopyFailed:
    "Copying was not possible. The code is now selected; copy it manually.",
  leaveUnsaved: "You have unsaved changes.",
  numberHint: "Arabic or Latin digits are accepted.",
  numberRange: "A value from {min} to {max}.",
  numberMinOnly: "The smallest allowed value is {min}.",
  numberMaxOnly: "The largest allowed value is {max}.",
  wholeNumber: "A whole number.",
  decimals: "Up to {n} decimal places.",
  selectionsRange: "Choose from {min} to {max}.",
  dateRange: "A date from {min} to {max}.",
  issueInvalid: "This answer is not one of the available choices.",
  issueNumberFormat: "Enter digits only, without thousands separators or symbols.",
  issueNumberPrecision: "This has more decimal places than allowed.",
  issueNumberMin: "The value is below the minimum of {min}.",
  issueNumberMax: "The value is above the maximum of {max}.",
  issueDateFormat: "Enter a complete date.",
  issueDateMin: "The date is before the earliest allowed date, {min}.",
  issueDateMax: "The date is after the latest allowed date, {max}.",
  issueTooLong: "The answer is longer than {max} characters.",
  issueTooFew: "Choose at least {min}.",
  issueTooMany: "Choose no more than {max}.",
  invalidSummary: "Answers that need correcting:",
  rateLimited:
    "Too many attempts in a short time. Wait a minute and try again; nothing about your link or your answers has changed.",
};
/** Fill {name} placeholders. Values are inserted as text, never as markup. */
export const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
export const respondentMessages = (locale: Locale) =>
  locale === "en" ? respondentEn : respondentAr;
