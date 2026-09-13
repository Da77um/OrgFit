import type { ReportModel, MetricRow } from "./report-model";
import { reportMessages } from "./report-i18n";
import { reportTheme, themeVariables, REPORT_THEME_VERSION, type ReportTheme } from "./report-theme";
import { fontStack } from "./report-fonts";

// ---------------------------------------------------------------------------
// The printable document.
//
// Deterministic HTML for a paged renderer. Three properties are load-bearing:
//
//   * Every value printed comes from the model, which already decided what may
//     be shown. This file never inspects a cell, and a withheld metric is
//     printed as its status sentence — never as a zero, a dash in a numeric
//     column, or a zero-length bar that reads as "none".
//   * Every string is escaped. The only markup here is what this file writes;
//     an organization name, a consultant note or a band label cannot introduce
//     an element, a style or a resource reference.
//   * Every visual value is a theme token. There is no literal colour or size
//     below, so replacing the theme replaces the design.
//
// Long tables repeat their header on each page through <thead>, and rows avoid
// splitting across a page break. Page numbers come from the renderer's footer
// template, which is generated here so it carries the same fonts and tokens.
// ---------------------------------------------------------------------------

const escape = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

type Column<T> = {
  head: string;
  cell: (row: T) => string;
  numeric?: boolean;
  wide?: boolean;
};

function table<T>(columns: Column<T>[], rows: T[]) {
  if (!rows.length) return "";
  return `<table><thead><tr>${columns
    .map(
      (c) =>
        `<th${c.numeric ? ' class="num"' : c.wide ? ' class="wide"' : ""}>${escape(c.head)}</th>`,
    )
    .join("")}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${columns
          .map((c) => `<td${c.numeric ? ' class="num"' : ""}>${c.cell(row)}</td>`)
          .join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
}

// A withheld cell prints its status, never an empty numeric slot that a reader
// could mistake for a zero or a missing import.
const valueCell = (row: { value: string | null; statusLabel: string }) =>
  row.value === null
    ? `<span class="withheld">${escape(row.statusLabel)}</span>`
    : escape(row.value);

const percentCell = (value: string | null) =>
  value === null ? "" : escape(`${(Number(value) * 100).toFixed(0)}%`);

// A labelled horizontal bar chart. Withheld metrics keep their row and their
// label but have no bar at all: a bar of length zero is a claim about a number.
//
// Two things about the labels are load-bearing rather than cosmetic, and both
// were found by looking at a rendered Arabic page:
//
//   * The <svg> carries direction="ltr" even in an Arabic report. Inside an RTL
//     container, `text-anchor="end"` anchors the LOGICAL end, which is the
//     visual LEFT — so a label placed at the right edge grew rightwards, off the
//     viewBox, and only its tail survived. The anchors here are geometric, so
//     the drawing context must be too. Each label is still shaped and ordered
//     right to left by its own bidi run.
//   * A label longer than the space reserved for it is truncated visibly. The
//     track is an opaque rectangle painted after the label, so an untruncated
//     long label was silently painted over and read as a short one — a label
//     that lies about which metric a bar belongs to.
const CHART_LABEL_MAX = 26;
const chartLabel = (value: string) =>
  value.length > CHART_LABEL_MAX ? `${value.slice(0, CHART_LABEL_MAX - 1)}…` : value;

function barChart(rows: MetricRow[], model: ReportModel, title: string) {
  if (!rows.length) return "";
  const rtl = model.direction === "rtl";
  const rowHeight = 26,
    height = rows.length * rowHeight + 26,
    width = 640,
    labelWidth = 210,
    trackWidth = width - labelWidth - 60;
  const trackX = rtl ? 60 : labelWidth;
  const bars = rows
    .map((row, index) => {
      const y = index * rowHeight + 20;
      const labelX = rtl ? width - 4 : 4;
      const label = `<text x="${labelX}" y="${y + 12}" text-anchor="${rtl ? "end" : "start"}" class="c-label">${escape(chartLabel(row.label))}</text>`;
      const track = `<rect x="${trackX}" y="${y + 3}" width="${trackWidth}" height="12" class="c-track"/>`;
      if (row.numeric === null)
        return `${label}${track}<text x="${rtl ? trackX + trackWidth - 4 : trackX + 4}" y="${y + 12}" text-anchor="${rtl ? "end" : "start"}" class="c-withheld">${escape(row.statusLabel)}</text>`;
      const length = Math.max(1, (Math.min(100, Math.max(0, row.numeric)) / 100) * trackWidth);
      const barX = rtl ? trackX + trackWidth - length : trackX;
      const valueX = rtl ? trackX - 6 : trackX + trackWidth + 6;
      return `${label}${track}<rect x="${barX}" y="${y + 3}" width="${length}" height="12" class="c-bar"/><text x="${valueX}" y="${y + 12}" text-anchor="${rtl ? "end" : "start"}" class="c-value">${escape(row.value)}</text>`;
    })
    .join("");
  return `<figure class="chart"><figcaption>${escape(title)}</figcaption>
<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" direction="ltr" role="img" aria-label="${escape(title)}" xmlns="http://www.w3.org/2000/svg">${bars}</svg></figure>`;
}

const section = (id: string, heading: string, body: string) =>
  `<section id="${escape(id)}"><h2>${escape(heading)}</h2>${body}</section>`;

const definitionList = (items: { label: string; value: string }[]) =>
  `<dl>${items
    .map(
      (item) =>
        `<dt>${escape(item.label)}</dt><dd>${escape(item.value)}</dd>`,
    )
    .join("")}</dl>`;

export function reportStyles(model: ReportModel, theme: ReportTheme) {
  return `:root{
  ${themeVariables(theme)}
}
@page{size:A4;margin:var(--report-page-margin-top) var(--report-page-margin-side) var(--report-page-margin-bottom);}
html,body{margin:0;padding:0;background:var(--report-surface);color:var(--report-ink);}
body{font-family:${fontStack(model.locale)};font-size:var(--report-font-size-base);line-height:var(--report-line-height);}
h1{font-size:var(--report-font-size-h1);margin:0 0 4pt;color:var(--report-accent);}
h2{font-size:var(--report-font-size-h2);margin:16pt 0 6pt;color:var(--report-accent);border-bottom:1pt solid var(--report-rule);padding-bottom:3pt;break-after:avoid;}
h3{font-size:var(--report-font-size-h3);margin:9pt 0 3pt;break-after:avoid;}
p{margin:0 0 6pt;}
section{break-inside:auto;}
.cover{border:1pt solid var(--report-rule-strong);padding:10pt;margin-bottom:10pt;background:var(--report-surface-alt);border-radius:var(--report-radius);}
.kind{color:var(--report-ink-muted);margin:0 0 6pt;}
.confidential{display:inline-block;background:var(--report-accent);color:var(--report-ink-inverse);padding:2pt 6pt;border-radius:var(--report-radius);font-size:var(--report-font-size-small);}
dl{display:grid;grid-template-columns:auto 1fr;gap:2pt 10pt;margin:6pt 0;}
dt{color:var(--report-ink-muted);font-size:var(--report-font-size-small);}
dd{margin:0;word-break:break-word;}
table{border-collapse:collapse;width:100%;margin:6pt 0;font-size:var(--report-font-size-small);}
th,td{border:0.5pt solid var(--report-rule);padding:3pt 5pt;text-align:${model.direction === "rtl" ? "right" : "left"};vertical-align:top;}
thead th{background:var(--report-accent-soft);color:var(--report-ink);font-weight:700;}
thead{display:table-header-group;}
tbody tr{break-inside:avoid;}
td.num,th.num{text-align:${model.direction === "rtl" ? "left" : "right"};font-variant-numeric:tabular-nums;}
td.num{direction:ltr;unicode-bidi:isolate;}
th.wide{width:40%;}
.withheld{color:var(--report-withheld);font-style:italic;}
.note{background:var(--report-surface-alt);border-${model.direction === "rtl" ? "right" : "left"}:2pt solid var(--report-rule-strong);padding:5pt 7pt;margin:6pt 0;font-size:var(--report-font-size-small);}
.chart{margin:8pt 0;break-inside:avoid;}
.chart figcaption{font-size:var(--report-font-size-small);color:var(--report-ink-muted);margin-bottom:3pt;}
.c-label{font-size:8px;fill:var(--report-ink);}
.c-value{font-size:8px;fill:var(--report-ink);font-weight:700;}
.c-withheld{font-size:8px;fill:var(--report-withheld);font-style:italic;}
.c-track{fill:var(--report-surface-alt);stroke:var(--report-rule);stroke-width:0.5;}
.c-bar{fill:var(--report-accent);}
.finding{border:0.5pt solid var(--report-rule);border-radius:var(--report-radius);padding:7pt;margin:7pt 0;break-inside:avoid;}
.finding h3{margin-top:0;}
.badge{display:inline-block;font-size:var(--report-font-size-small);padding:1pt 5pt;border-radius:var(--report-radius);background:var(--report-accent-soft);color:var(--report-ink);margin-${model.direction === "rtl" ? "left" : "right"}:4pt;}
.badge.sev-HIGH,.badge.sev-CRITICAL{background:var(--report-negative);color:var(--report-ink-inverse);}
.badge.sev-MODERATE{background:var(--report-caution);color:var(--report-ink-inverse);}
.badge.sev-LOW,.badge.sev-NONE{background:var(--report-positive);color:var(--report-ink-inverse);}
.commentary{margin-top:6pt;border-top:0.5pt dashed var(--report-rule-strong);padding-top:5pt;background:var(--report-surface-alt);padding:5pt;}
.commentary h4{margin:0 0 3pt;font-size:var(--report-font-size-small);color:var(--report-caution);}
.commentary .disclaimer{font-size:var(--report-font-size-small);color:var(--report-ink-muted);margin-bottom:4pt;}
.limits li{margin-bottom:4pt;}
.page-break{break-before:page;}
.improved{color:var(--report-positive);}
.worsened{color:var(--report-negative);}`;
}

export function reportBody(model: ReportModel) {
  const m = reportMessages(model.locale),
    t = (key: string) => (m as Record<string, string>)[key] ?? key;
  const parts: string[] = [];

  parts.push(`<header class="cover">
<h1>${escape(model.title)}</h1>
<p class="kind">${escape(model.subtitle)}</p>
<p><span class="confidential">${escape(model.confidential)}</span></p>
${definitionList(model.identity)}
</header>`);

  parts.push(
    section(
      "summary",
      t("executiveSummary"),
      model.summary.map((line) => `<p>${escape(line)}</p>`).join(""),
    ),
  );

  parts.push(
    section(
      "participation",
      t("participation"),
      `<p class="note">${escape(model.participationNote)}</p>` +
        table(
          [
            { head: t("field"), cell: (r: { label: string }) => escape(r.label), wide: true },
            { head: t("value"), cell: (r: { value: string }) => escape(r.value), numeric: true },
          ],
          model.participation,
        ),
    ),
  );

  parts.push(
    section(
      "methodology",
      t("methodology"),
      model.methodologyParagraphs.map((line) => `<p>${escape(line)}</p>`).join("") +
        definitionList(model.methodology),
    ),
  );

  const scoreColumns: Column<MetricRow>[] = [
    { head: t("metric"), cell: (r) => escape(r.label), wide: true },
    { head: t("value"), cell: valueCell, numeric: true },
    { head: t("band"), cell: (r) => escape(r.band ?? ""), },
    { head: t("coverage"), cell: (r) => percentCell(r.coverage), numeric: true },
    {
      head: t("contributors"),
      cell: (r) => (r.contributorCount === null ? "" : escape(r.contributorCount)),
      numeric: true,
    },
    { head: t("status"), cell: (r) => escape(r.statusLabel) },
    { head: t("reason"), cell: (r) => escape(r.reasonText) },
  ];
  const scoreRows = [...(model.overall ? [model.overall] : []), ...model.dimensions];
  parts.push(
    section(
      "results",
      t("overall"),
      barChart(scoreRows, model, t("scale")) + table(scoreColumns, scoreRows),
    ),
  );

  if (model.departments.rows.length)
    parts.push(
      section(
        "departments",
        t("departments"),
        table(
          [
            { head: t("group"), cell: (r) => escape(r.groupLabel), wide: true },
            { head: t("metric"), cell: (r) => escape(r.label) },
            { head: t("value"), cell: valueCell, numeric: true },
            { head: t("gap"), cell: (r) => escape(r.gapPoints ?? ""), numeric: true },
            {
              head: t("contributors"),
              cell: (r) => (r.contributorCount === null ? "" : escape(r.contributorCount)),
              numeric: true,
            },
            { head: t("status"), cell: (r) => escape(r.statusLabel) },
            { head: t("reason"), cell: (r) => escape(r.reasonText) },
          ],
          model.departments.rows,
        ),
      ),
    );

  if (model.questions.length) {
    const blocks = model.questions
      .map((question) => {
        const distribution = question.bins.length
          ? table(
              [
                { head: t("option"), cell: (b: { label: string }) => escape(b.label), wide: true },
                { head: t("count"), cell: (b: { count: number }) => escape(b.count), numeric: true },
                {
                  head: t("share"),
                  cell: (b: { share: string }) => percentCell(b.share),
                  numeric: true,
                },
              ],
              question.bins,
            )
          : "";
        // A distribution-only metric has no single value; the shares below are
        // the answer, so it gets no "published — " line with nothing after it.
        const summary =
          question.value !== null
            ? `<p>${escape(t("value"))}: ${escape(question.value)}</p>`
            : question.status === "AVAILABLE"
              ? ""
              : `<p class="withheld">${escape(question.statusLabel)} — ${escape(question.reasonText)}</p>`;
        return `<div class="finding"><h3>${escape(question.label)}</h3>${summary}${distribution}</div>`;
      })
      .join("");
    parts.push(section("questions", t("questions"), blocks));
  }

  const rankList = (
    rows: { label: string; value: string; band: string | null }[],
    heading: string,
  ) =>
    `<h3>${escape(heading)}</h3>` +
    (rows.length
      ? `<ol>${rows
          .map(
            (r) =>
              `<li>${escape(r.label)} — ${escape(r.value)}${r.band ? ` (${escape(r.band)})` : ""}</li>`,
          )
          .join("")}</ol>`
      : `<p class="withheld">${escape(t("none"))}</p>`);
  parts.push(
    section(
      "ranking",
      `${t("strengths")} · ${t("risks")}`,
      rankList(model.strengths, t("strengths")) + rankList(model.risks, t("risks")),
    ),
  );

  const findings = model.recommendations.length
    ? model.recommendations
        .map(
          (item) => `<article class="finding">
<h3><span class="badge sev-${escape(item.severity)}">${escape(item.severityLabel)}</span>${escape(item.order)}. ${escape(item.title)}</h3>
<p class="kind">${escape(t("computedFinding"))} · ${escape(item.groupLabel)} · ${escape(item.metricLabel)}</p>
<p>${escape(item.body)}</p>
<p><strong>${escape(t("suggestedAction"))}:</strong> ${escape(item.action)}</p>
<p><strong>${escape(t("rationale"))}:</strong> ${escape(item.rationale)}</p>
${
  item.evidence.length
    ? table(
        [
          { head: t("metric"), cell: (e: { label: string }) => escape(e.label), wide: true },
          { head: t("group"), cell: (e: { groupLabel: string }) => escape(e.groupLabel) },
          { head: t("value"), cell: (e: { value: string }) => escape(e.value), numeric: true },
          { head: t("band"), cell: (e: { band: string | null }) => escape(e.band ?? "") },
        ],
        item.evidence,
      )
    : ""
}
<p class="kind">${escape(t("ruleReference"))}: ${escape(item.ruleReference)} · ${escape(t("rulesVersion"))} ${escape(item.rulesVersion)}</p>
${
  item.commentary
    ? `<div class="commentary"><h4>${escape(t("consultantCommentary"))}</h4>
<p class="disclaimer">${escape(t("consultantCommentaryNote"))}</p>
${definitionList(
  [
    { label: t("followUpStatus"), value: item.commentary.statusLabel },
    { label: t("owner"), value: item.commentary.owner },
    ...(item.commentary.dueDate
      ? [{ label: t("dueDate"), value: item.commentary.dueDate }]
      : []),
    ...(item.commentary.notes
      ? [{ label: t("consultantNotes"), value: item.commentary.notes }]
      : []),
    ...(item.commentary.resolution
      ? [{ label: t("resolution"), value: item.commentary.resolution }]
      : []),
  ],
)}</div>`
    : ""
}
</article>`,
        )
        .join("")
    : `<p class="withheld">${escape(t("noRecommendations"))}</p>`;
  parts.push(section("recommendations", t("recommendations"), findings));

  const trends = model.history.length
    ? model.history
        .map(
          (trend) => `<h3>${escape(trend.label)}</h3>` +
            table(
              [
                { head: t("trendRound"), cell: (p: { roundLabel: string }) => escape(p.roundLabel), wide: true },
                { head: t("period"), cell: (p: { periodStart: string }) => escape(p.periodStart) },
                {
                  head: t("trendValue"),
                  cell: (p: { value: string | null; statusLabel: string }) => valueCell(p),
                  numeric: true,
                },
                {
                  head: t("contributors"),
                  cell: (p: { contributorCount: number | null }) =>
                    p.contributorCount === null ? "" : escape(p.contributorCount),
                  numeric: true,
                },
                { head: t("status"), cell: (p: { statusLabel: string }) => escape(p.statusLabel) },
                { head: t("reason"), cell: (p: { reasonText: string }) => escape(p.reasonText) },
              ],
              trend.points,
            ),
        )
        .join("")
    : "";
  parts.push(
    section(
      "history",
      t("history"),
      `<p class="note">${escape(model.historyNote)}</p>${trends}`,
    ),
  );

  const comparison = model.comparison;
  parts.push(
    section(
      "comparison",
      t("comparison"),
      comparison
        ? `<h3>${escape(comparison.heading)}</h3>
${definitionList([
  { label: t("classification"), value: comparison.classificationLabel },
  { label: t("reviewedBy"), value: comparison.reviewedBy ?? t("none") },
  { label: t("reviewedAt"), value: comparison.reviewedAt },
  { label: t("rationale"), value: comparison.rationale },
])}
${comparison.notComparableNote ? `<p class="note">${escape(comparison.notComparableNote)}</p>` : ""}
${
  comparison.caveats.length
    ? `<p class="note"><strong>${escape(t("caveats"))}:</strong></p><ul>${comparison.caveats
        .map((c) => `<li>${escape(c)}</li>`)
        .join("")}</ul>`
    : ""
}
${table(
  [
    { head: t("group"), cell: (r: { groupLabel: string }) => escape(r.groupLabel), wide: true },
    { head: t("metric"), cell: (r: { label: string }) => escape(r.label) },
    {
      head: t("earlier"),
      cell: (r: { earlier: string | null }) => escape(r.earlier ?? ""),
      numeric: true,
    },
    {
      head: t("later"),
      cell: (r: { later: string | null }) => escape(r.later ?? ""),
      numeric: true,
    },
    {
      head: t("pointChange"),
      cell: (r: { pointChange: string | null; verdict: string | null }) =>
        r.pointChange === null
          ? ""
          : `<span class="${r.verdict === t("improved") ? "improved" : r.verdict === t("worsened") ? "worsened" : ""}">${escape(r.pointChange)}</span>`,
      numeric: true,
    },
    { head: t("status"), cell: (r: { statusLabel: string }) => escape(r.statusLabel) },
    { head: t("reason"), cell: (r: { reasonText: string }) => escape(r.reasonText) },
  ],
  comparison.rows,
)}`
        : `<p class="withheld">${escape(t("noComparison"))}</p>`,
    ),
  );

  parts.push(
    section(
      "withheld",
      t("withheldSummary"),
      model.withheld.length
        ? table(
            [
              { head: t("group"), cell: (r: { groupLabel: string }) => escape(r.groupLabel), wide: true },
              { head: t("metric"), cell: (r: { label: string }) => escape(r.label) },
              { head: t("status"), cell: (r: { statusLabel: string }) => escape(r.statusLabel) },
              { head: t("reason"), cell: (r: { reasonText: string }) => escape(r.reasonText) },
            ],
            model.withheld,
          )
        : `<p>${escape(t("withheldNone"))}</p>`,
    ),
  );

  parts.push(
    section(
      "limitations",
      t("limitations"),
      `<ul class="limits">${model.limitations
        .map((line) => `<li>${escape(line)}</li>`)
        .join("")}</ul>`,
    ),
  );

  parts.push(
    section(
      "manifest",
      t("manifest"),
      definitionList([
        ...model.manifest,
        { label: t("themeVersion"), value: REPORT_THEME_VERSION },
      ]),
    ),
  );

  return parts.join("\n");
}

export function reportHtml(
  model: ReportModel,
  fontCss: string,
  theme: ReportTheme = reportTheme(),
) {
  return `<!doctype html><html lang="${model.locale}" dir="${model.direction}"><head>
<meta charset="utf-8">
<title>${escape(model.title)}</title>
<style>${fontCss}</style>
<style>${reportStyles(model, theme)}</style>
</head><body>${reportBody(model)}</body></html>`;
}

// The renderer draws headers and footers in their own document, so they carry
// their own copy of the fonts and tokens. Page numbering lives here because a
// paged renderer supplies the counters, not the page content.
export function reportFooterTemplate(
  model: ReportModel,
  fontCss: string,
  theme: ReportTheme = reportTheme(),
) {
  const m = reportMessages(model.locale),
    t = (key: string) => (m as Record<string, string>)[key] ?? key;
  return `<style>${fontCss}</style>
<div dir="${model.direction}" style="font-family:${fontStack(model.locale)};font-size:7pt;color:${theme["ink-muted"]};width:100%;padding:0 ${theme["page-margin-side"]};display:flex;justify-content:space-between;">
<span>${escape(model.identity[0]?.value ?? "")} · ${escape(model.identity[2]?.value ?? "")}</span>
<span>${escape(t("page"))} <span class="pageNumber"></span> ${escape(t("of"))} <span class="totalPages"></span></span>
</div>`;
}

export function reportHeaderTemplate(model: ReportModel, theme: ReportTheme = reportTheme()) {
  return `<div dir="${model.direction}" style="font-size:6pt;color:${theme["ink-muted"]};width:100%;padding:0 ${theme["page-margin-side"]};text-align:${model.direction === "rtl" ? "left" : "right"};">${escape(
    model.confidential,
  )}</div>`;
}
