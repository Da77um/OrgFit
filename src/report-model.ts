import type { Locale } from "./i18n";
import { direction as textDirection } from "./i18n";
import { fill, localeText, reportMessages } from "./report-i18n";
import {
  rankDimensions,
  type GroupDefinition,
  type MetricDefinition,
  type SafeCell,
} from "./disclosure";
import type { Translation } from "./instrument-input";

// ---------------------------------------------------------------------------
// The report document model.
//
// One pure function turns a frozen job source into the exact set of rows,
// sentences and numbers a report contains. BOTH renderers consume it: the PDF
// and the workbook cannot disagree about a value, a status or a suppression
// reason, because neither of them ever looks at a cell.
//
// The single rule that matters here is enforced structurally rather than by
// discipline: `cellRow` is the only path from a stored cell to a printable row,
// and it reads value, coverage, contributor count and band ONLY inside the
// AVAILABLE branch. A withheld cell therefore cannot carry a number into a
// model field, an XLSX cell, an SVG bar or a chart label, whatever a caller
// asks for. It is also pure — no clock, no database, no locale guessing.
// ---------------------------------------------------------------------------

export type ReportFormat = "PDF" | "XLSX";

export type SourceRecommendation = {
  id: string;
  groupKey: string;
  metricKey: string;
  ruleKey: string;
  ruleHash: string;
  rulesVersion: string;
  priority: number;
  severity: string;
  text: {
    title: Translation;
    body: Translation;
    action: Translation;
    rationale: Translation;
  };
  evidence: {
    items: { metricKey: string; groupKey: string; value: string; unit: string; band: string | null }[];
  };
  action: {
    status: string;
    ownerName: string | null;
    dueDate: string | null;
    staffNotes: string | null;
    resolution: string | null;
    updatedAt: string;
  } | null;
};

export type SourceTrend = {
  metricKey: string;
  label: Translation;
  direction: "HIGH_GOOD" | "HIGH_RISK" | null;
  points: {
    roundId: string;
    label: string;
    periodStart: string;
    releaseState: string;
    value: string | null;
    contributorCount: number | null;
    band: { key: string; label: Translation } | null;
    status: "COMPARABLE" | "NOT_COMPARABLE" | "GAP";
    reasonCode: string | null;
  }[];
};

export type SourceComparison = {
  id: string;
  rationale: string;
  reviewedAt: string;
  reviewedBy: string | null;
  classification: string;
  comparable: boolean;
  populationCaveats: string[];
  left: { roundId: string; label: string; snapshotId: string; periodStart: string; periodEnd: string | null; contributorCount: number; threshold: number };
  right: { roundId: string; label: string; snapshotId: string; periodStart: string; periodEnd: string | null; contributorCount: number; threshold: number };
  cells: {
    metricKey: string;
    groupKey: string;
    label: Translation;
    groupLabel: Translation;
    direction: "HIGH_GOOD" | "HIGH_RISK" | null;
    status: "COMPARABLE" | "GAP" | "NOT_COMPARABLE";
    reasonCode: string | null;
    left: SafeCell | null;
    right: SafeCell | null;
    pointChange: string | null;
    percentChange: string | null;
    improved: boolean | null;
  }[];
};

export type ReportSource = {
  schemaVersion: 1;
  locale: Locale;
  format: ReportFormat;
  requestedAt: string;
  organization: { id: string; code: string; nameAr: string; nameEn: string | null; timezone: string };
  series: { id: string; nameAr: string; nameEn: string | null; purpose: string };
  round: {
    id: string;
    label: string;
    periodStart: string;
    periodEnd: string | null;
    state: string;
    versionId: string;
    compatibilityGroup: string | null;
  };
  campaign: {
    id: string;
    timezone: string;
    startsAt: string;
    endsAt: string | null;
    closedAt: string | null;
    threshold: number;
    locales: string[];
    releaseState: string;
  };
  participation: {
    invited: number;
    completed: number;
    revoked: number;
    outstanding: number;
    eligible: number;
    rate: string | null;
  };
  snapshot: {
    id: string;
    campaignId: string;
    roundId: string;
    releaseRevision: number;
    threshold: number;
    contributorCount: number;
    generatedAt: string;
    period: Record<string, unknown>;
    manifest: Record<string, unknown>;
    contentHash: string;
    reviewReference: string;
    versions: Record<string, unknown>;
    groups: GroupDefinition[];
    metrics: MetricDefinition[];
    cells: SafeCell[];
  };
  recommendations: SourceRecommendation[];
  context: {
    history?: { seriesId: string; trends: SourceTrend[] } | null;
    comparison?: SourceComparison | null;
  };
};

export type MetricRow = {
  metricKey: string;
  label: string;
  description: string;
  kind: "OVERALL" | "DIMENSION" | "QUESTION";
  direction: "HIGH_GOOD" | "HIGH_RISK" | null;
  unit: string;
  status: string;
  statusLabel: string;
  reasonCode: string | null;
  reasonText: string;
  /** Present only where the cell is AVAILABLE. Never a placeholder zero. */
  value: string | null;
  numeric: number | null;
  coverage: string | null;
  coverageNumeric: number | null;
  contributorCount: number | null;
  band: string | null;
};

export type DepartmentRow = MetricRow & {
  groupKey: string;
  groupLabel: string;
  gapPoints: string | null;
  gapNumeric: number | null;
};

export type QuestionBlock = MetricRow & {
  bins: { key: string; label: string; count: number; share: string; shareNumeric: number }[];
};

export type RecommendationBlock = {
  id: string;
  order: number;
  severity: string;
  severityLabel: string;
  priority: number;
  groupLabel: string;
  metricLabel: string;
  title: string;
  body: string;
  action: string;
  rationale: string;
  ruleReference: string;
  rulesVersion: string;
  evidence: { label: string; groupLabel: string; value: string; band: string | null }[];
  commentary: {
    statusLabel: string;
    status: string;
    owner: string;
    dueDate: string | null;
    notes: string | null;
    resolution: string | null;
    updatedAt: string;
  } | null;
};

export type LabelledValue = { label: string; value: string };

export type ReportModel = {
  locale: Locale;
  direction: "rtl" | "ltr";
  title: string;
  subtitle: string;
  confidential: string;
  identity: LabelledValue[];
  summary: string[];
  participation: LabelledValue[];
  participationNote: string;
  methodologyParagraphs: string[];
  methodology: LabelledValue[];
  overall: MetricRow | null;
  dimensions: MetricRow[];
  departments: { groups: { key: string; label: string }[]; rows: DepartmentRow[] };
  questions: QuestionBlock[];
  strengths: { label: string; value: string; band: string | null }[];
  risks: { label: string; value: string; band: string | null }[];
  recommendations: RecommendationBlock[];
  history: TrendBlock[];
  historyNote: string;
  comparison: ComparisonBlock | null;
  withheld: { label: string; groupLabel: string; statusLabel: string; reasonText: string }[];
  limitations: string[];
  manifest: LabelledValue[];
};

export type TrendBlock = {
  metricKey: string;
  label: string;
  direction: "HIGH_GOOD" | "HIGH_RISK" | null;
  points: {
    roundLabel: string;
    periodStart: string;
    status: string;
    statusLabel: string;
    reasonText: string;
    value: string | null;
    numeric: number | null;
    contributorCount: number | null;
  }[];
};

export type ComparisonBlock = {
  heading: string;
  classificationLabel: string;
  comparable: boolean;
  notComparableNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string;
  rationale: string;
  caveats: string[];
  rows: {
    label: string;
    groupLabel: string;
    statusLabel: string;
    reasonText: string;
    earlier: string | null;
    later: string | null;
    earlierNumeric: number | null;
    laterNumeric: number | null;
    pointChange: string | null;
    pointNumeric: number | null;
    percentChange: string | null;
    verdict: string | null;
  }[];
};

const numberOrNull = (value: string | null) =>
  value === null ? null : Number.isFinite(Number(value)) ? Number(value) : null;

// THE gate. Value, coverage, contributor count and band are read inside the
// AVAILABLE branch and nowhere else, so a withheld cell has no path to a number.
function cellRow(
  metric: MetricDefinition,
  cell: SafeCell | undefined,
  locale: Locale,
): MetricRow {
  const m = reportMessages(locale);
  const status = cell?.status ?? "UNSCORED";
  const reasonCode = cell ? cell.reasonCode : "NOT_RELEASED";
  const base = {
    metricKey: metric.key,
    label: localeText(metric.label, locale),
    description: localeText(metric.description, locale),
    kind: metric.kind,
    direction: metric.direction,
    unit: metric.unit,
    status,
    statusLabel: (m as Record<string, string>)[status] ?? status,
    reasonCode,
    reasonText: reasonCode ? ((m as Record<string, string>)[reasonCode] ?? "") : "",
  };
  if (!cell || cell.status !== "AVAILABLE")
    return {
      ...base,
      value: null,
      numeric: null,
      coverage: null,
      coverageNumeric: null,
      contributorCount: null,
      band: null,
    };
  return {
    ...base,
    value: cell.value,
    numeric: numberOrNull(cell.value),
    coverage: cell.coverage,
    coverageNumeric: numberOrNull(cell.coverage),
    contributorCount: cell.contributorCount,
    band: cell.band ? localeText(cell.band.label, locale) : null,
  };
}

const dateText = (value: string | null | undefined) =>
  !value ? "" : String(value).slice(0, 10);
const instantText = (value: string | null | undefined) =>
  !value ? "" : new Date(value).toISOString().replace("T", " ").slice(0, 16) + "Z";

export function buildReportModel(source: ReportSource): ReportModel {
  const locale = source.locale,
    m = reportMessages(locale),
    text = (key: string) => (m as Record<string, string>)[key] ?? key;
  const snapshot = source.snapshot;
  const companyGroup = snapshot.groups.find((g) => g.kind === "COMPANY");
  const companyKey = companyGroup?.key ?? "";
  const cellAt = (groupKey: string, metricKey: string) =>
    snapshot.cells.find((c) => c.groupKey === groupKey && c.metricKey === metricKey);

  const scored = snapshot.metrics.filter(
    (x) => x.kind === "OVERALL" || x.kind === "DIMENSION",
  );
  const overallMetric = snapshot.metrics.find((x) => x.kind === "OVERALL");
  const overall = overallMetric
    ? cellRow(overallMetric, cellAt(companyKey, overallMetric.key), locale)
    : null;
  const dimensions = snapshot.metrics
    .filter((x) => x.kind === "DIMENSION")
    .map((metric) => cellRow(metric, cellAt(companyKey, metric.key), locale));

  const departmentGroups = snapshot.groups.filter((g) => g.kind !== "COMPANY");
  const departmentRows: DepartmentRow[] = [];
  for (const group of departmentGroups)
    for (const metric of scored) {
      const row = cellRow(metric, cellAt(group.key, metric.key), locale);
      const company = cellRow(metric, cellAt(companyKey, metric.key), locale);
      // A gap needs BOTH cells released. One published side and one withheld
      // side yields no difference, because a difference would republish the
      // withheld one relative to a known number.
      const gap =
        row.numeric !== null && company.numeric !== null
          ? row.numeric - company.numeric
          : null;
      departmentRows.push({
        ...row,
        groupKey: group.key,
        groupLabel: localeText(group.label, locale),
        gapPoints: gap === null ? null : gap.toFixed(1),
        gapNumeric: gap === null ? null : Number(gap.toFixed(1)),
      });
    }

  const questions: QuestionBlock[] = snapshot.metrics
    .filter((x) => x.kind === "QUESTION")
    .map((metric) => {
      const cell = cellAt(companyKey, metric.key);
      const row = cellRow(metric, cell, locale);
      const bins =
        row.status === "AVAILABLE" && cell?.distribution
          ? cell.distribution.bins.map((bin) => ({
              key: bin.key,
              label: localeText(bin.label, locale),
              count: bin.count,
              share: bin.share,
              shareNumeric: numberOrNull(bin.share) ?? 0,
            }))
          : [];
      return { ...row, bins };
    });

  const ranked = rankDimensions({
    cells: snapshot.cells,
    metrics: snapshot.metrics,
    companyGroupKey: companyKey,
  });
  const rankRow = (entry: {
    label: Translation;
    value: string;
    band: { label: Translation } | null;
  }) => ({
    label: localeText(entry.label, locale),
    value: entry.value,
    band: entry.band ? localeText(entry.band.label, locale) : null,
  });

  const groupLabelOf = (key: string) =>
    localeText(snapshot.groups.find((g) => g.key === key)?.label, locale);
  const metricLabelOf = (key: string) =>
    localeText(snapshot.metrics.find((x) => x.key === key)?.label, locale) || key;
  // Frozen evidence cites a band by its stable key. A report prints the band's
  // name, not the identifier, and falls back to nothing rather than to a raw key.
  const bandLabelOf = (metricKey: string, bandKey: string | null) => {
    if (!bandKey) return null;
    const band = snapshot.metrics
      .find((x) => x.key === metricKey)
      ?.bands.find((b) => b.key === bandKey);
    return band ? localeText(band.label, locale) : null;
  };

  const recommendations: RecommendationBlock[] = source.recommendations.map(
    (item, index) => ({
      id: item.id,
      order: index + 1,
      severity: item.severity,
      severityLabel: text(item.severity),
      priority: item.priority,
      groupLabel: groupLabelOf(item.groupKey),
      metricLabel: metricLabelOf(item.metricKey),
      title: localeText(item.text.title, locale),
      body: localeText(item.text.body, locale),
      action: localeText(item.text.action, locale),
      rationale: localeText(item.text.rationale, locale),
      ruleReference: `${item.ruleKey} · ${item.ruleHash.slice(0, 16)}`,
      rulesVersion: item.rulesVersion,
      evidence: (item.evidence.items ?? []).map((e) => ({
        label: metricLabelOf(e.metricKey),
        groupLabel: groupLabelOf(e.groupKey),
        value: e.value,
        band: bandLabelOf(e.metricKey, e.band),
      })),
      // Consultant commentary is a separate object with its own heading and its
      // own disclaimer. It is never merged into the computed text above.
      commentary: item.action
        ? {
            status: item.action.status,
            statusLabel: text(item.action.status),
            owner: item.action.ownerName ?? text("unassigned"),
            dueDate: item.action.dueDate,
            notes: item.action.staffNotes,
            resolution: item.action.resolution,
            updatedAt: instantText(item.action.updatedAt),
          }
        : null,
    }),
  );

  const trends = source.context.history?.trends ?? [];
  const history: TrendBlock[] = trends.map((trend) => ({
    metricKey: trend.metricKey,
    label: localeText(trend.label, locale) || trend.metricKey,
    direction: trend.direction,
    points: trend.points.map((point) => ({
      roundLabel: point.label,
      periodStart: dateText(point.periodStart),
      status: point.status,
      statusLabel: text(point.status),
      reasonText: point.reasonCode ? text(point.reasonCode) : "",
      value: point.status === "COMPARABLE" ? point.value : null,
      numeric: point.status === "COMPARABLE" ? numberOrNull(point.value) : null,
      contributorCount:
        point.status === "COMPARABLE" ? point.contributorCount : null,
    })),
  }));

  const c = source.context.comparison ?? null;
  const comparison: ComparisonBlock | null = c
    ? {
        heading: fill(text("comparisonOf"), {
          left: c.left.label,
          right: c.right.label,
        }),
        classificationLabel: text(c.classification),
        comparable: c.comparable,
        notComparableNote: c.comparable ? null : text("notComparable"),
        reviewedBy: c.reviewedBy,
        reviewedAt: instantText(c.reviewedAt),
        rationale: c.rationale,
        caveats: c.populationCaveats.map((code) => text(code)),
        rows: c.cells.map((row) => {
          const earlier = row.left && row.left.status === "AVAILABLE" ? row.left.value : null;
          const later = row.right && row.right.status === "AVAILABLE" ? row.right.value : null;
          return {
            label: localeText(row.label, locale),
            groupLabel: localeText(row.groupLabel, locale),
            statusLabel: text(row.status),
            reasonText: row.reasonCode ? text(row.reasonCode) : "",
            earlier,
            later,
            earlierNumeric: numberOrNull(earlier),
            laterNumeric: numberOrNull(later),
            pointChange: row.pointChange,
            pointNumeric: numberOrNull(row.pointChange),
            percentChange: row.percentChange,
            verdict:
              row.improved === null
                ? row.status === "COMPARABLE"
                  ? text("unchanged")
                  : null
                : row.improved
                  ? text("improved")
                  : text("worsened"),
          };
        }),
      }
    : null;

  const withheld = [
    ...scored.flatMap((metric) =>
      snapshot.groups.map((group) => ({
        metric,
        group,
        row: cellRow(metric, cellAt(group.key, metric.key), locale),
      })),
    ),
    ...snapshot.metrics
      .filter((x) => x.kind === "QUESTION")
      .map((metric) => ({
        metric,
        group: companyGroup!,
        row: cellRow(metric, cellAt(companyKey, metric.key), locale),
      })),
  ]
    .filter((entry) => entry.group && entry.row.status !== "AVAILABLE")
    .map((entry) => ({
      label: entry.row.label,
      groupLabel: localeText(entry.group.label, locale),
      statusLabel: entry.row.statusLabel,
      reasonText: entry.row.reasonText,
    }));

  const releasedCount = scored.filter(
    (metric) => cellAt(companyKey, metric.key)?.status === "AVAILABLE",
  ).length;

  const summary: string[] = [
    overall && overall.value !== null
      ? fill(text("summaryOverall"), {
          value: overall.value,
          band: overall.band ?? text("none"),
        })
      : fill(text("summaryOverallWithheld"), {
          reason: overall?.reasonText ?? text("NOT_RELEASED"),
        }),
    fill(text("summaryContributors"), {
      contributors: String(snapshot.contributorCount),
      threshold: String(snapshot.threshold),
    }),
    fill(text("summaryMetrics"), {
      released: String(releasedCount),
      total: String(scored.length),
      withheld: String(scored.length - releasedCount),
    }),
    recommendations.length
      ? fill(text("summaryRecommendations"), {
          count: String(recommendations.length),
        })
      : text("summaryNoRecommendations"),
  ];

  const versions = snapshot.versions as Record<string, string | null>;
  const manifest = snapshot.manifest as Record<string, unknown>;

  return {
    locale,
    direction: textDirection(locale),
    title: text("reportTitle"),
    subtitle: text("documentKind"),
    confidential: text("confidential"),
    identity: [
      {
        label: text("organization"),
        value:
          localeText(
            { ar: source.organization.nameAr, en: source.organization.nameEn },
            locale,
          ) || source.organization.code,
      },
      {
        label: text("series"),
        value: localeText(
          { ar: source.series.nameAr, en: source.series.nameEn },
          locale,
        ),
      },
      { label: text("round"), value: source.round.label },
      {
        label: text("period"),
        value: `${dateText(source.round.periodStart)} — ${dateText(source.round.periodEnd) || "…"}`,
      },
      { label: text("purpose"), value: source.series.purpose },
      { label: text("timezone"), value: source.campaign.timezone },
      { label: text("generated"), value: instantText(snapshot.generatedAt) },
      { label: text("rendered"), value: instantText(source.requestedAt) },
      { label: text("snapshotId"), value: snapshot.id },
    ],
    summary,
    participation: [
      { label: text("invited"), value: String(source.participation.invited) },
      { label: text("completed"), value: String(source.participation.completed) },
      { label: text("revoked"), value: String(source.participation.revoked) },
      { label: text("outstanding"), value: String(source.participation.outstanding) },
      {
        label: text("rate"),
        value:
          source.participation.rate === null
            ? text("notApplicable")
            : `${(Number(source.participation.rate) * 100).toFixed(1)}%`,
      },
      { label: text("contributors"), value: String(snapshot.contributorCount) },
      { label: text("threshold"), value: String(snapshot.threshold) },
    ],
    participationNote: text("participationNote"),
    methodologyParagraphs: [
      text("methodologyBody"),
      fill(text("methodologyThreshold"), { threshold: String(snapshot.threshold) }),
      text("methodologyDeterministic"),
      text("methodologyScope"),
    ],
    methodology: [
      { label: text("instrumentVersion"), value: String(versions.instrument ?? "") },
      {
        label: text("instrumentHash"),
        value: String(manifest.instrumentHash ?? "").slice(0, 32),
      },
      { label: text("engine"), value: String(versions.scoring ?? "") },
      {
        label: text("disclosure"),
        value: String(manifest.disclosureVersion ?? ""),
      },
      { label: text("rulesVersion"), value: String(versions.rules ?? text("none")) },
      { label: text("privacyVersion"), value: String(versions.privacy ?? "") },
      { label: text("reviewReference"), value: snapshot.reviewReference },
    ],
    overall,
    dimensions,
    departments: {
      groups: departmentGroups.map((g) => ({
        key: g.key,
        label: localeText(g.label, locale),
      })),
      rows: departmentRows,
    },
    questions,
    strengths: ranked.strengths.map(rankRow),
    risks: ranked.weaknesses.map(rankRow),
    recommendations,
    history,
    historyNote: history.length ? text("historyNote") : text("noHistory"),
    comparison,
    withheld,
    limitations: [
      text("limitationsBody"),
      text("limitationsDifferencing"),
      text("limitationsDescriptive"),
      text("limitationsNoIndividual"),
    ],
    manifest: [
      { label: text("snapshotId"), value: snapshot.id },
      { label: text("contentHash"), value: snapshot.contentHash },
      { label: text("engine"), value: String(versions.scoring ?? "") },
      { label: text("disclosure"), value: String(manifest.disclosureVersion ?? "") },
      { label: text("rulesVersion"), value: String(versions.rules ?? text("none")) },
      { label: text("privacyVersion"), value: String(versions.privacy ?? "") },
      { label: text("instrumentVersion"), value: String(versions.instrument ?? "") },
      {
        label: text("instrumentHash"),
        value: String(manifest.instrumentHash ?? ""),
      },
      { label: text("reviewReference"), value: snapshot.reviewReference },
    ],
  };
}
