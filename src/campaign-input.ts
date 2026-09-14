import { z } from "zod";
const uuid = z.uuid();
const optionalText = (max = 500) =>
  z.string().trim().max(max).nullable().optional();
// Explicit instants only. A local wall-clock string without an offset would be
// ambiguous exactly at the boundaries this module has to enforce.
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/)
  .refine((v) => !Number.isNaN(Date.parse(v)))
  .transform((v) => new Date(v).toISOString());
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)));
export const seriesInput = z
  .object({
    nameAr: z.string().trim().min(1).max(500),
    nameEn: optionalText(),
    purpose: z.string().trim().min(1).max(2000),
    questionnaireFamilyId: uuid,
  })
  .strict();
export const roundInput = z
  .object({
    seriesId: uuid,
    label: z.string().trim().min(1).max(200),
    periodStart: day,
    periodEnd: day.nullable().optional(),
    questionnaireVersionId: uuid,
    populationDefinition: z
      .object({
        schemaVersion: z.literal(1).default(1),
        descriptionAr: z.string().trim().max(2000).optional(),
        descriptionEn: z.string().trim().max(2000).optional(),
      })
      .strict()
      .default({ schemaVersion: 1 }),
    notes: optionalText(5000),
    compatibilityGroup: optionalText(200),
  })
  .strict()
  .refine((v) => !v.periodEnd || v.periodEnd >= v.periodStart);
// One mode per campaign, each carrying exactly its own identifiers. A payload
// that mixes modes is rejected before it can reach target resolution.
export const targetInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("SINGLE"), participantId: uuid }).strict(),
  z
    .object({
      mode: z.literal("SELECTED"),
      participantIds: z.array(uuid).min(1).max(5000),
    })
    .strict(),
  z.object({ mode: z.literal("DEPARTMENT"), departmentId: uuid }).strict(),
  // Everyone the questionnaire targets (021): the whole organization, or only
  // its targeted departments. Resolved at launch.
  z.object({ mode: z.literal("ALL") }).strict(),
]);
export const campaignInput = z
  .object({
    roundId: uuid,
    questionnaireVersionId: uuid,
    target: targetInput,
    startsAt: instant,
    endsAt: instant.nullable().optional(),
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
    locales: z
      .array(z.enum(["ar", "en"]))
      .min(1)
      .max(2)
      .refine((a) => new Set(a).size === a.length && a.includes("ar"))
      .default(["ar"]),
    privacyPolicyVersion: z.number().int().min(1).max(1000).default(1),
    threshold: z.number().int().min(5).max(1000).default(5),
  })
  .strict()
  .refine((v) => !v.endsAt || v.endsAt > v.startsAt);
export const reasonInput = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();
export const endDateInput = z
  .object({ endsAt: instant.nullable() })
  .strict();
export const issueInput = z
  .object({ expectedGeneration: z.number().int().min(0).max(1000000) })
  .strict();
export const rotateInput = issueInput.extend({
  reason: z.string().trim().min(1).max(500),
});
export const revokeInput = rotateInput;
// An export plan names every invitation and the generation the operator
// believes it is at. Any mismatch aborts the whole plan; nothing is issued.
export const linkExportInput = z
  .object({
    invitationIds: z.array(uuid).min(1).max(500),
    expectedGenerations: z.array(z.number().int().min(0).max(1000000)).min(1).max(500),
    confirmRotation: z.boolean(),
  })
  .strict()
  .refine(
    (v) =>
      v.invitationIds.length === v.expectedGenerations.length &&
      new Set(v.invitationIds).size === v.invitationIds.length,
  );
export type CampaignInput = z.infer<typeof campaignInput>;
export type TargetInput = z.infer<typeof targetInput>;
export const campaignStates = [
  "DRAFT",
  "SCHEDULED",
  "OPEN",
  "CLOSED",
  "CANCELLED",
] as const;
export type CampaignState = (typeof campaignStates)[number];
export const participationStatuses = ["READY", "COMPLETED", "REVOKED"] as const;
