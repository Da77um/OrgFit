import type { Instrument, Question, Translation } from "../src/instrument-input";
import {
  OVERALL_DEFINITION_KEY,
  type ReleaseInput,
  type ResponseRecord,
  type TypedValue,
} from "../src/disclosure";

// Synthetic instrument and response fixtures for the disclosure suite. They are
// deliberately hand-built rather than driven through the survey: the adversarial
// cases below need exact contributor counts and exact value multisets, which a
// generated questionnaire run cannot pin down.

export const t = (ar: string, en = ar): Translation => ({ ar, en });
export const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const DIMENSION_ID = uid(1),
  DIMENSION_KEY = uid(2),
  CHOICE_KEY = uid(11),
  CHECKBOX_KEY = uid(21),
  TEXT_KEY = uid(31),
  NUMBER_KEY = uid(41),
  COMPANY = uid(90),
  DEPT_A = uid(91),
  DEPT_B = uid(92);
export const CHOICE_OPTIONS = [uid(12), uid(14), uid(16)];
export const CHECKBOX_OPTIONS = [uid(22), uid(24), uid(26)];

const bands = (offset: number) => [
  {
    id: uid(offset),
    key: uid(offset + 1),
    lower: "0",
    upper: "50",
    label: t("منخفض", "Low"),
    severity: "HIGH" as const,
    semantic: "RISK" as const,
  },
  {
    id: uid(offset + 2),
    key: uid(offset + 3),
    lower: "50",
    upper: "100",
    label: t("مرتفع", "High"),
    severity: "NONE" as const,
    semantic: "HEALTH" as const,
  },
];
const question = (
  id: number,
  key: number,
  type: Question["type"],
  extra: Partial<Question> = {},
): Question =>
  ({
    id: uid(id),
    key: uid(key),
    type,
    prompt: t(`سؤال ${id}`, `Question ${id}`),
    help: t("مساعدة", "Help"),
    required: true,
    dimensionId: null,
    validation: {},
    scoring: {
      enabled: false,
      reverse: false,
      weight: "1",
      mode: "VALUE" as const,
    },
    options: [],
    rows: [],
    columns: [],
    ...extra,
  }) as Question;
const options = (ids: string[], start: number) =>
  ids.map((id, i) => ({
    id,
    key: uid(start + i),
    label: t(`خيار ${i + 1}`, `Option ${i + 1}`),
    score: String(i + 1),
  }));

export function instrumentFixture(
  recommendations: Instrument["recommendations"] = [],
): Instrument {
  return {
    recommendations,
    schemaVersion: 1,
    locales: ["ar", "en"],
    title: t("استبانة", "Questionnaire"),
    introduction: t("مقدمة", "Introduction"),
    privacyText: t("إشعار", "Notice"),
    dimensions: [
      {
        id: DIMENSION_ID,
        key: DIMENSION_KEY,
        name: t("الرضا", "Satisfaction"),
        description: t("وصف", "Description"),
        mode: "AVERAGE",
        coverage: "0.5",
        direction: "HIGH_GOOD",
        denominator: null,
        bands: bands(100),
      },
    ],
    overall: {
      enabled: true,
      direction: "HIGH_GOOD",
      inputs: [{ dimensionId: DIMENSION_ID, weight: "1", invert: false }],
      bands: bands(110),
    },
    sections: [
      {
        id: uid(5),
        key: uid(6),
        title: t("القسم", "Section"),
        content: t("", ""),
        questions: [
          question(10, 11, "MULTIPLE_CHOICE", {
            options: options(CHOICE_OPTIONS, 200),
          }),
          question(20, 21, "CHECKBOXES", {
            options: options(CHECKBOX_OPTIONS, 210),
          }),
          question(30, 31, "SHORT_TEXT"),
          question(40, 41, "NUMBER", {
            validation: { min: "0", max: "100", precision: 0 },
          }),
        ],
      },
    ],
  };
}

export const groups: ReleaseInput["groups"] = [
  { id: COMPANY, kind: "COMPANY", label: t("الشركة", "Company") },
  { id: DEPT_A, kind: "DEPARTMENT", label: t("الهندسة", "Engineering") },
  { id: DEPT_B, kind: "DEPARTMENT", label: t("العمليات", "Operations") },
];

// One synthetic respondent. `dimension` null means the respondent did not answer
// enough of it to be scored — which is an absence, never a zero.
export function respondent(
  groupId: string,
  dimension: string | null,
  answers: Record<string, TypedValue> = {},
): ResponseRecord {
  const score = (definitionKey: string) =>
    dimension === null
      ? {
          definitionKey,
          normalized: null,
          coverage: "0",
          status: "INSUFFICIENT",
        }
      : {
          definitionKey,
          normalized: dimension,
          coverage: "1",
          status: "VALID",
        };
  return {
    groupId,
    scores: [score(DIMENSION_KEY), score(OVERALL_DEFINITION_KEY)],
    answers: Object.entries(answers).map(([questionKey, typedValue]) => ({
      questionKey,
      typedValue,
    })),
  };
}

export const releaseInput = (
  responses: ResponseRecord[],
  threshold = 5,
  recommendations: Instrument["recommendations"] = [],
): ReleaseInput => ({
  threshold,
  instrument: instrumentFixture(recommendations),
  groups,
  responses,
});
export const cellOf = (
  plan: { cells: { groupKey: string; metricKey: string }[] },
  groupKey: string,
  metricKey: string,
) =>
  plan.cells.find(
    (c) => c.groupKey === groupKey && c.metricKey === metricKey,
  ) as (typeof plan.cells)[number] & Record<string, unknown>;
