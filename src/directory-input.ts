import { z } from "zod";
const uuid = z.uuid();
const optionalText = (max = 500) =>
  z.string().trim().max(max).nullable().optional();
const code = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform((v) => v.normalize("NFC").toUpperCase());
const contact = z
  .object({
    schemaVersion: z.literal(1).default(1),
    email: z.email().max(320).optional(),
    phone: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
export const organizationInput = z
  .object({
    code,
    nameAr: z.string().trim().min(1).max(500),
    nameEn: optionalText(),
    industry: optionalText(),
    timezone: z
      .string()
      .max(100)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      })
      .default("Asia/Riyadh"),
    notes: optionalText(5000),
    contact: contact.extend({ contactName: optionalText() }).optional(),
  })
  .strict();
export const departmentInput = z
  .object({
    code,
    nameAr: z.string().trim().min(1).max(500),
    nameEn: optionalText(),
    parentDepartmentId: uuid.nullable().optional(),
  })
  .strict();
export const participantInput = z
  .object({
    privateReference: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .transform((v) => v.normalize("NFC")),
    displayName: z.string().trim().min(1).max(500),
    departmentId: uuid.nullable().optional(),
    position: optionalText(),
    jobLevel: optionalText(),
    gender: optionalText(80),
    ageGroup: optionalText(80),
    yearsOfService: z
      .string()
      .regex(/^(?:0|[1-9]\d?)(?:\.\d{1,2})?$|^100(?:\.00?)?$/)
      .nullable()
      .optional(),
    contact: contact.optional(),
  })
  .strict();
export const archiveInput = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();
export type ParticipantInput = z.infer<typeof participantInput>;
export const importFields = [
  "privateReference",
  "displayName",
  "departmentCode",
  "position",
  "jobLevel",
  "gender",
  "ageGroup",
  "yearsOfService",
  "email",
  "phone",
] as const;
export const mappingInput = z
  .record(z.string().min(1).max(100), z.enum(importFields))
  .refine(
    (m) =>
      Object.keys(m).length <= 10 &&
      new Set(Object.values(m)).size === Object.values(m).length &&
      Object.values(m).includes("privateReference") &&
      Object.values(m).includes("displayName"),
  );
export type DirectoryKind = "organization" | "department" | "participant";
export const schemas = {
  organization: organizationInput,
  department: departmentInput,
  participant: participantInput,
};
