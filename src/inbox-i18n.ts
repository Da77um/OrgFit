import type { Locale } from "./i18n";

// Wording for the employee-message screen (migration 025).
//
// The notes here state what the schema enforces, so a consultant does not read
// more into a message than it carries: a day and a department, never a person,
// never a time of day, never a link to a survey answer. The link panel says
// that a link is shown once, and that revoking it closes the channel for the
// whole organization.
const ar = {
  title: "رسائل الموظفين",
  lead: "رسائل كتبها موظفو المنظمة عبر رابط الرسائل الخاص بها. تحمل كل رسالة يوم الاستلام والإدارة فقط.",
  scope:
    "لا تحمل الرسالة اسم المرسل ولا وقت الإرسال ولا أي صلة بإجابات الاستبانات أو بالمشاركين. في الإدارات الصغيرة قد يدل النص نفسه على كاتبه؛ لا تحاول التعرف عليه.",
  filterDepartment: "الإدارة",
  filterAll: "كل الإدارات",
  filterOther: "أخرى / غير مدرجة",
  otherLabel: "أخرى",
  received: "يوم الاستلام",
  department: "الإدارة",
  none: "لم تصل رسائل بعد.",
  noneFiltered: "لا توجد رسائل لهذه الإدارة.",
  loadMore: "عرض المزيد",
  loading: "جارٍ التحميل…",
  countLabel: "رسالة معروضة",
  linkTitle: "رابط الرسائل",
  linkActive: "يوجد رابط فعّال لهذه المنظمة.",
  linkIssued: "صدر في {time} بواسطة {name}.",
  linkNone: "لا يوجد رابط فعّال. لا يستطيع الموظفون إرسال رسائل حتى يصدر رابط.",
  linkArchived: "المنظمة مؤرشفة؛ لا يعمل أي رابط لها.",
  linkReadOnly: "إصدار الرابط وتدويره وإلغاؤه من صلاحيات المسؤول العام.",
  linkIssue: "إصدار رابط",
  linkRotate: "تدوير الرابط",
  linkRevoke: "إلغاء الرابط",
  linkRotateNote: "يُلغي التدوير الرابط الحالي فورًا ويُصدر رابطًا جديدًا.",
  linkRevokeConfirm: "تأكيد الإلغاء",
  linkRevokeNote: "بعد الإلغاء لا يستطيع أي موظف في المنظمة إرسال رسالة حتى يصدر رابط جديد.",
  linkShownOnce:
    "انسخ هذا الرابط الآن وشاركه مع المنظمة. لا يُحفظ ولا يمكن عرضه مرة أخرى.",
  linkReplayed:
    "صدر الرابط في محاولة سابقة ولا يمكن عرضه مرة أخرى. دوّر الرابط للحصول على رابط جديد.",
  linkRevoked: "أُلغي الرابط.",
  copy: "نسخ الرابط",
  copied: "تم النسخ",
  cancel: "إلغاء",
};
const en: Record<keyof typeof ar, string> = {
  title: "Employee messages",
  lead: "Messages written by this organization's employees through its message link. Each carries only the day it was received and a department.",
  scope:
    "A message carries no sender, no time of day and no link to survey answers or participants. In a small department the text itself may point to its writer; do not try to identify them.",
  filterDepartment: "Department",
  filterAll: "All departments",
  filterOther: "Other / not listed",
  otherLabel: "Other",
  received: "Received on",
  department: "Department",
  none: "No messages have arrived yet.",
  noneFiltered: "No messages for this department.",
  loadMore: "Show more",
  loading: "Loading…",
  countLabel: "messages shown",
  linkTitle: "Message link",
  linkActive: "This organization has an active link.",
  linkIssued: "Issued {time} by {name}.",
  linkNone: "There is no active link. Employees cannot send messages until one is issued.",
  linkArchived: "The organization is archived; no link for it works.",
  linkReadOnly: "Issuing, rotating and revoking the link is a Super Admin decision.",
  linkIssue: "Issue link",
  linkRotate: "Rotate link",
  linkRevoke: "Revoke link",
  linkRotateNote: "Rotating revokes the current link immediately and issues a new one.",
  linkRevokeConfirm: "Confirm revocation",
  linkRevokeNote: "After revocation no employee of this organization can send a message until a new link is issued.",
  linkShownOnce:
    "Copy this link now and share it with the organization. It is not stored and cannot be shown again.",
  linkReplayed:
    "The link was issued by an earlier attempt and cannot be shown again. Rotate the link to get a new one.",
  linkRevoked: "The link was revoked.",
  copy: "Copy link",
  copied: "Copied",
  cancel: "Cancel",
};
export const inboxMessages = (locale: Locale) => (locale === "en" ? en : ar);
export const inboxCatalogs = { ar, en };
