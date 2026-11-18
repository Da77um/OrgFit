import { importFields } from "./directory-input";

// Suggested column mapping for an uploaded participant file (D-192). A real
// file has headings such as «الرقم المرجعي» or "Employee name", not the
// internal field keys, so the reviewer used to start with every column set to
// "ignore" and a validation error. The suggestion is only a starting point:
// the reviewer still sees and can change every column before validating.
type Field = (typeof importFields)[number];

const NAMES: Record<Field, string[]> = {
  privateReference: [
    "privateReference", "private reference", "reference", "ref", "employee id", "employee number", "staff id", "id",
    "المرجع الخاص", "المرجع", "الرقم المرجعي", "رقم مرجعي", "الرقم الوظيفي", "رقم الموظف", "الرقم",
  ],
  displayName: [
    "displayName", "display name", "name", "full name", "employee name",
    "الاسم", "اسم الموظف", "الاسم الكامل", "اسم المشارك",
  ],
  departmentCode: [
    "departmentCode", "department code", "department", "dept", "dept code",
    "رمز القسم", "القسم", "الإدارة", "الادارة",
  ],
  position: ["position", "job title", "title", "role", "المسمى الوظيفي", "المسمى", "الوظيفة"],
  jobLevel: ["jobLevel", "job level", "level", "grade", "المستوى الوظيفي", "المستوى", "المرتبة", "الدرجة"],
  gender: ["gender", "sex", "الجنس", "النوع"],
  ageGroup: ["ageGroup", "age group", "age", "الفئة العمرية", "العمر"],
  yearsOfService: ["yearsOfService", "years of service", "service", "tenure", "سنوات الخدمة", "مدة الخدمة"],
  email: ["email", "e-mail", "email address", "البريد الإلكتروني", "البريد", "الإيميل", "الايميل"],
  phone: ["phone", "mobile", "phone number", "telephone", "الهاتف", "الجوال", "رقم الجوال", "رقم الهاتف"],
};

// Case, spacing, punctuation, Arabic diacritics and the common letter
// variants (أ/إ/آ → ا, ة → ه, ى → ي) do not decide a match.
export function normalizeHeading(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\(.*?\)/g, "")
    .replace(/[\s_\-.:/]+/g, "");
}

const LOOKUP = new Map<string, Field>();
for (const field of importFields)
  for (const name of NAMES[field]) {
    const key = normalizeHeading(name);
    if (!LOOKUP.has(key)) LOOKUP.set(key, field);
  }

/** headers → { header: field } for every heading that clearly names a field;
 * each field is suggested at most once (the first matching column wins). */
export function suggestMapping(headers: readonly string[]): Record<string, Field> {
  const used = new Set<Field>();
  const out: Record<string, Field> = {};
  for (const header of headers) {
    const field = LOOKUP.get(normalizeHeading(header));
    if (field && !used.has(field)) {
      used.add(field);
      out[header] = field;
    }
  }
  return out;
}
