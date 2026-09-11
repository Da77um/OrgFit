import {
  blankInstrument,
  newIdentity,
  newQuestion,
  tr,
  type Instrument,
} from "./instrument-input";
export function illustrativeTemplates(): Instrument[] {
  return ["support", "work"].map((kind) => {
    const d = blankInstrument();
    d.locales = ["ar", "en"];
    d.title =
      kind === "support"
        ? tr("مثال توضيحي: الدعم في العمل", "Illustrative: workplace support")
        : tr("مثال توضيحي: تنظيم العمل", "Illustrative: work organization");
    d.introduction = tr(
      "قالب توضيحي قابل للتعديل، غير معتمد علمياً. يجب اعتماد المحتوى والترجمة قبل الاستخدام الفعلي.",
      "Editable illustrative template, not scientifically validated. Approve content and translations before real use.",
    );
    d.privacyText = tr(
      "نص تجريبي للمعاينة فقط. يجب استبداله بإشعار الخصوصية المعتمد قبل الاستخدام.",
      "Preview notice only. Replace with the approved privacy notice before use.",
    );
    const rating = newQuestion("RATING_5"),
      text = newQuestion("LONG_TEXT");
    rating.prompt =
      kind === "support"
        ? tr(
            "أجد الدعم اللازم لإنجاز عملي.",
            "I can find the support I need to do my work.",
          )
        : tr(
            "مسؤولياتي في العمل واضحة.",
            "My work responsibilities are clear.",
          );
    rating.help = tr(
      "١ = لا أوافق إطلاقاً، ٥ = أوافق تماماً",
      "1 = strongly disagree, 5 = strongly agree",
    );
    text.prompt = tr("ما الذي يمكن تحسينه؟", "What could improve?");
    text.required = false;
    d.sections = [
      {
        ...newIdentity(),
        title: tr("بيئة العمل", "Work environment"),
        content: tr(),
        questions: [rating, text],
      },
    ];
    return d;
  });
}
