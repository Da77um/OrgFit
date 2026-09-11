import {
  type Instrument,
  type Dimension,
  type Question,
  newIdentity,
} from "./instrument-input";
export const nodeTables = [
  "section",
  "dimension",
  "question",
  "question_option",
  "matrix_row",
  "matrix_column",
  "score_definition",
  "interpretation_band",
  "recommendation_rule",
] as const;
export type NodeRecord = {
  table: (typeof nodeTables)[number];
  position: number;
  parentId: string | null;
  payload: Record<string, unknown>;
};
export function flattenInstrument(d: Instrument): NodeRecord[] {
  const records: NodeRecord[] = [];
  const push = (
    table: NodeRecord["table"],
    payload: object,
    position: number,
    parentId: string | null = null,
  ) =>
    records.push({
      table,
      payload: payload as Record<string, unknown>,
      position,
      parentId,
    });
  d.sections.forEach((s, i) => {
    const { questions, ...section } = s;
    push("section", section, i);
    questions.forEach((q, j) => {
      const { options, rows, columns, ...question } = q;
      push("question", question, j, s.id);
      options.forEach((v, k) => push("question_option", v, k, q.id));
      rows.forEach((v, k) => push("matrix_row", v, k, q.id));
      columns.forEach((v, k) => push("matrix_column", v, k, q.id));
    });
  });
  d.dimensions.forEach((dim, i) => {
    const { bands, mode, coverage, denominator, ...data } = dim;
    push("dimension", data, i);
    // Definition IDs remain deterministic for a dimension; identity differs across
    // version copies because copied dimension IDs differ.
    const scoreId = dim.id;
    push(
      "score_definition",
      {
        id: scoreId,
        key: dim.key,
        mode,
        coverage,
        denominator,
        target: "DIMENSION",
      },
      i,
      dim.id,
    );
    bands.forEach((b, k) => push("interpretation_band", b, k, scoreId));
  });
  // OVERALL has no dimension parent and is the only root definition.
  const overallId = newIdentity();
  push(
    "score_definition",
    { ...overallId, ...d.overall, bands: undefined, target: "OVERALL" },
    0,
  );
  d.overall.bands.forEach((b, k) =>
    push("interpretation_band", b, k, overallId.id),
  );
  // Rules are root-level nodes of the version, ordered by editor position.
  // Their metric references stay declarative inside the payload.
  d.recommendations.forEach((rule, i) => push("recommendation_rule", rule, i));
  return records;
}
export function metadata(d: Instrument) {
  return {
    schemaVersion: d.schemaVersion,
    locales: d.locales,
    title: d.title,
    introduction: d.introduction,
    privacyText: d.privacyText,
  };
}
export function inflateInstrument(
  meta: ReturnType<typeof metadata>,
  nodes: NodeRecord[],
): Instrument {
  const list = (table: NodeRecord["table"], parent: string | null = null) =>
    nodes
      .filter((n) => n.table === table && n.parentId === parent)
      .sort((a, b) => a.position - b.position)
      .map((n) => n.payload);
  const overall = list("score_definition")[0];
  return {
    ...meta,
    sections: list("section").map((s) => ({
      ...s,
      questions: list("question", String(s.id)).map((q) => ({
        ...q,
        options: list("question_option", String(q.id)),
        rows: list("matrix_row", String(q.id)),
        columns: list("matrix_column", String(q.id)),
      })) as Question[],
    })) as Instrument["sections"],
    dimensions: list("dimension").map((d) => {
      const score = list("score_definition", String(d.id))[0];
      return {
        ...d,
        mode: score.mode,
        coverage: score.coverage,
        denominator: score.denominator,
        bands: list("interpretation_band", String(score.id)),
      } as Dimension;
    }),
    overall: {
      enabled: Boolean(overall.enabled),
      direction: overall.direction as Instrument["overall"]["direction"],
      inputs: overall.inputs as Instrument["overall"]["inputs"],
      bands: list(
        "interpretation_band",
        String(overall.id),
      ) as Dimension["bands"],
    },
    recommendations: list(
      "recommendation_rule",
    ) as Instrument["recommendations"],
  };
}
