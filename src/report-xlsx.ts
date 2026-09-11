import ExcelJS from "exceljs";
import type { ReportModel, MetricRow } from "./report-model";
import { reportMessages } from "./report-i18n";
import { reportTheme } from "./report-theme";

// ---------------------------------------------------------------------------
// The workbook.
//
// It is the same model the PDF prints, so the two cannot disagree. Four rules
// govern it, and each is asserted against the produced file rather than
// assumed:
//
//   * A released number is written as a NUMBER, so a reader can sort, filter
//     and chart it without re-parsing text.
//   * A withheld cell is written as nothing at all. Not a zero, not a dash, not
//     a hidden note, not a comment, not a cached chart point. Its status and
//     reason live in their own columns, which is where a reader learns why the
//     value column is empty.
//   * The workbook contains no chart, no pivot cache, no defined name, no
//     hidden or very-hidden sheet and no formula. There is nowhere for a value
//     to hide, because none of those parts is ever created.
//   * A string that could be re-read as a formula by a spreadsheet is
//     neutralized with a leading apostrophe, the same convention the manual
//     link export uses.
// ---------------------------------------------------------------------------

const FORMULA_START = /^[=+\-@\t\r]/;

/** User-entered and instrument-authored strings only; enum labels are ours. */
export const safeText = (value: string | null | undefined) => {
  const text = String(value ?? "");
  return FORMULA_START.test(text) ? `'${text}` : text;
};


type Cell = string | number | null;

export async function renderReportWorkbook(model: ReportModel): Promise<Buffer> {
  const m = reportMessages(model.locale),
    t = (key: string) => (m as Record<string, string>)[key] ?? key;
  const theme = reportTheme();
  const rtl = model.direction === "rtl";
  const book = new ExcelJS.Workbook();
  // No staff name, no machine name and no local path enters the file.
  book.creator = "OrgFit";
  book.lastModifiedBy = "OrgFit";
  book.created = new Date(0);
  book.modified = new Date(0);
  book.calcProperties.fullCalcOnLoad = false;

  const headerFill = theme["accent-soft"].replace("#", "").padStart(6, "0");
  const sheet = (name: string, columns: { header: string; width: number }[]) => {
    const ws = book.addWorksheet(name.slice(0, 31), {
      views: [{ rightToLeft: rtl, state: "frozen", ySplit: 1 }],
    });
    ws.columns = columns.map((c) => ({ header: c.header, width: c.width }));
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: `FF${headerFill.toUpperCase()}` },
      };
      cell.alignment = { horizontal: rtl ? "right" : "left", readingOrder: rtl ? "rtl" : "ltr" };
    });
    return ws;
  };
  const push = (ws: ExcelJS.Worksheet, values: Cell[]) => {
    const row = ws.addRow(values.map((v) => (v === null ? undefined : v)));
    row.alignment = {
      vertical: "top",
      wrapText: true,
      horizontal: rtl ? "right" : "left",
      readingOrder: rtl ? "rtl" : "ltr",
    };
    return row;
  };

  // --- Summary -------------------------------------------------------------
  const summary = sheet(t("sheetSummary"), [
    { header: t("field"), width: 34 },
    { header: t("detail"), width: 70 },
  ]);
  for (const item of model.identity) push(summary, [safeText(item.label), safeText(item.value)]);
  push(summary, [null, null]);
  for (const line of model.summary) push(summary, [t("executiveSummary"), safeText(line)]);
  push(summary, [null, null]);
  push(summary, [t("participationNote"), safeText(model.participationNote)]);
  for (const item of model.participation)
    push(summary, [safeText(item.label), safeText(item.value)]);

  // --- Dimensions ----------------------------------------------------------
  const dimensions = sheet(t("sheetDimensions"), [
    { header: t("metric"), width: 40 },
    { header: t("value"), width: 10 },
    { header: t("band"), width: 18 },
    { header: t("coverage"), width: 12 },
    { header: t("contributors"), width: 14 },
    { header: t("direction"), width: 20 },
    { header: t("status"), width: 16 },
    { header: t("reason"), width: 60 },
  ]);
  const metricRow = (row: MetricRow): Cell[] => [
    safeText(row.label),
    row.numeric,
    safeText(row.band),
    row.coverageNumeric,
    row.contributorCount,
    row.direction ? t(row.direction) : null,
    row.statusLabel,
    safeText(row.reasonText),
  ];
  for (const row of [...(model.overall ? [model.overall] : []), ...model.dimensions]) {
    const added = push(dimensions, metricRow(row));
    added.getCell(4).numFmt = "0%";
  }

  // --- Departments ---------------------------------------------------------
  const departments = sheet(t("sheetDepartments"), [
    { header: t("group"), width: 30 },
    { header: t("metric"), width: 36 },
    { header: t("value"), width: 10 },
    { header: t("gap"), width: 16 },
    { header: t("band"), width: 18 },
    { header: t("contributors"), width: 14 },
    { header: t("status"), width: 16 },
    { header: t("reason"), width: 60 },
  ]);
  for (const row of model.departments.rows)
    push(departments, [
      safeText(row.groupLabel),
      safeText(row.label),
      row.numeric,
      row.gapNumeric,
      safeText(row.band),
      row.contributorCount,
      row.statusLabel,
      safeText(row.reasonText),
    ]);

  // --- Questions -----------------------------------------------------------
  const questions = sheet(t("sheetQuestions"), [
    { header: t("question"), width: 46 },
    { header: t("option"), width: 30 },
    { header: t("value"), width: 10 },
    { header: t("count"), width: 10 },
    { header: t("share"), width: 10 },
    { header: t("status"), width: 16 },
    { header: t("reason"), width: 60 },
  ]);
  for (const question of model.questions) {
    push(questions, [
      safeText(question.label),
      null,
      question.numeric,
      question.contributorCount,
      null,
      question.statusLabel,
      safeText(question.reasonText),
    ]);
    for (const bin of question.bins) {
      const added = push(questions, [
        safeText(question.label),
        safeText(bin.label),
        null,
        bin.count,
        bin.shareNumeric,
        question.statusLabel,
        null,
      ]);
      added.getCell(5).numFmt = "0.0%";
    }
  }

  // --- Recommendations -----------------------------------------------------
  const recommendations = sheet(t("sheetRecommendations"), [
    { header: t("priority"), width: 10 },
    { header: t("severity"), width: 14 },
    { header: t("group"), width: 26 },
    { header: t("metric"), width: 30 },
    { header: t("computedFinding"), width: 40 },
    { header: t("suggestedAction"), width: 50 },
    { header: t("rationale"), width: 50 },
    { header: t("evidence"), width: 44 },
    { header: t("ruleReference"), width: 34 },
    { header: t("rulesVersion"), width: 14 },
    { header: `${t("consultantCommentary")} — ${t("followUpStatus")}`, width: 20 },
    { header: `${t("consultantCommentary")} — ${t("owner")}`, width: 22 },
    { header: `${t("consultantCommentary")} — ${t("dueDate")}`, width: 14 },
    { header: `${t("consultantCommentary")} — ${t("consultantNotes")}`, width: 50 },
    { header: `${t("consultantCommentary")} — ${t("resolution")}`, width: 50 },
  ]);
  // The commentary columns carry the disclaimer in their own first row so that
  // a reader who only opens the workbook still sees that they are opinion.
  push(recommendations, [
    null, null, null, null,
    safeText(t("methodologyDeterministic")),
    null, null, null, null, null,
    safeText(t("consultantCommentaryNote")),
    null, null, null, null,
  ]);
  for (const item of model.recommendations)
    push(recommendations, [
      item.priority,
      item.severityLabel,
      safeText(item.groupLabel),
      safeText(item.metricLabel),
      safeText(`${item.title}\n${item.body}`),
      safeText(item.action),
      safeText(item.rationale),
      safeText(
        item.evidence
          .map((e) => `${e.label} · ${e.groupLabel} · ${e.value}`)
          .join("\n"),
      ),
      safeText(item.ruleReference),
      item.rulesVersion,
      item.commentary ? item.commentary.statusLabel : null,
      item.commentary ? safeText(item.commentary.owner) : null,
      item.commentary?.dueDate ?? null,
      item.commentary ? safeText(item.commentary.notes) : null,
      item.commentary ? safeText(item.commentary.resolution) : null,
    ]);

  // --- History (trend, then the reviewed comparison when one was requested) --
  const history = sheet(t("sheetHistory"), [
    { header: t("metric"), width: 34 },
    { header: t("trendRound"), width: 26 },
    { header: t("period"), width: 14 },
    { header: t("trendValue"), width: 10 },
    { header: t("contributors"), width: 14 },
    { header: t("status"), width: 18 },
    { header: t("reason"), width: 60 },
  ]);
  push(history, [safeText(model.historyNote), null, null, null, null, null, null]);
  for (const trend of model.history)
    for (const point of trend.points)
      push(history, [
        safeText(trend.label),
        safeText(point.roundLabel),
        point.periodStart,
        point.numeric,
        point.contributorCount,
        point.statusLabel,
        safeText(point.reasonText),
      ]);
  if (model.comparison) {
    push(history, [null, null, null, null, null, null, null]);
    push(history, [
      safeText(model.comparison.heading),
      safeText(model.comparison.classificationLabel),
      null,
      null,
      null,
      null,
      safeText(model.comparison.rationale),
    ]);
    for (const caveat of model.comparison.caveats)
      push(history, [t("caveats"), null, null, null, null, null, safeText(caveat)]);
    push(history, [
      t("metric"),
      t("group"),
      t("earlier"),
      t("later"),
      t("pointChange"),
      t("status"),
      t("reason"),
    ]);
    for (const row of model.comparison.rows)
      push(history, [
        safeText(row.label),
        safeText(row.groupLabel),
        row.earlierNumeric,
        row.laterNumeric,
        row.pointNumeric,
        row.statusLabel,
        safeText(row.reasonText),
      ]);
  }

  // --- Methodology, limits and the version manifest -------------------------
  const methodology = sheet(t("sheetMethodology"), [
    { header: t("field"), width: 34 },
    { header: t("detail"), width: 96 },
  ]);
  for (const paragraph of model.methodologyParagraphs)
    push(methodology, [t("methodology"), safeText(paragraph)]);
  for (const item of model.methodology)
    push(methodology, [safeText(item.label), safeText(item.value)]);
  push(methodology, [null, null]);
  for (const line of model.limitations)
    push(methodology, [t("limitations"), safeText(line)]);
  push(methodology, [null, null]);
  if (model.withheld.length)
    for (const row of model.withheld)
      push(methodology, [
        `${t("withheldSummary")}: ${row.groupLabel} · ${row.label}`,
        `${row.statusLabel} — ${safeText(row.reasonText)}`,
      ]);
  else push(methodology, [t("withheldSummary"), t("withheldNone")]);
  push(methodology, [null, null]);
  for (const item of model.manifest)
    push(methodology, [safeText(item.label), safeText(item.value)]);

  return Buffer.from(await book.xlsx.writeBuffer());
}
