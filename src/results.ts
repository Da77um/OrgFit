import { sql } from "kysely";
import { type Tx, requireAccess } from "./db";
import { AppError, uuid } from "./security";
import { response } from "./http";
import {
  rankDimensions,
  type MetricDefinition,
  type GroupDefinition,
  type SafeCell,
} from "./disclosure";
import {
  readRecommendations,
  RECOMMENDATION_PREVIEW,
  type RecommendationRelease,
} from "./recommendations";

// ---------------------------------------------------------------------------
// The staff analytics read model.
//
// It reads exactly one thing: publication.snapshot, the routine that returns
// the current published release. orgfit_staff holds no privilege on any
// publication table, none on the anonymous database, and none on any answer,
// draft or envelope. There is no candidate view, no recalculation endpoint and
// no live score: an open campaign has a release state and no numbers.
//
// Every view below is a PROJECTION of cells that were already approved. It
// never derives a new value, so no view can produce a number the disclosure
// engine withheld.
// ---------------------------------------------------------------------------

export type Snapshot =
  | {
      available: false;
      campaignId: string;
      roundId: string;
      releaseState: string;
      campaignState: string;
      threshold: number;
    }
  | {
      available: true;
      campaignId: string;
      roundId: string;
      id: string;
      releaseRevision: number;
      releaseState: string;
      threshold: number;
      contributorCount: number;
      generatedAt: string;
      period: Record<string, unknown>;
      manifest: Record<string, unknown>;
      contentHash: string;
      versions: Record<string, unknown>;
      groups: GroupDefinition[];
      metrics: MetricDefinition[];
      cells: SafeCell[];
    };

// Only the views the release contract defines. An unsupported slice is a
// refusal, not a silently ignored parameter: an arbitrary filter is exactly how
// a small population gets isolated.
export const RESULT_VIEWS = [
  "overview",
  "departments",
  "questions",
  "recommendations",
] as const;
export type ResultView = (typeof RESULT_VIEWS)[number];

export async function resolveCampaign(tx: Tx, org: string, roundId: string) {
  const { rows } = await sql<{ id: string }>`
    select id from core.campaign where organization_id=${org}::uuid and round_id=${roundId}::uuid
  `.execute(tx);
  if (!rows.length) throw new AppError("NOT_FOUND", 404);
  return rows[0].id;
}

export async function readSnapshot(tx: Tx, campaignId: string) {
  const { rows } = await sql<{
    data: Snapshot;
  }>`select publication.snapshot(${campaignId}::uuid) as data`.execute(tx);
  return rows[0].data;
}

const companyCells = (s: Extract<Snapshot, { available: true }>) =>
  new Map(
    s.cells
      .filter((c) => c.groupKey === companyKey(s))
      .map((c) => [c.metricKey, c]),
  );
const companyKey = (s: Extract<Snapshot, { available: true }>) =>
  s.groups.find((g) => g.kind === "COMPANY")!.key;

// The overview and dimension view: overall score, dimension bars and radar,
// bands, and strengths/weaknesses ranked from released cells only.
export function overviewView(s: Extract<Snapshot, { available: true }>) {
  const company = companyKey(s),
    byKey = companyCells(s);
  const metrics = s.metrics.filter(
    (m) => m.kind === "OVERALL" || m.kind === "DIMENSION",
  );
  return {
    view: "overview" as const,
    period: s.period,
    contributorCount: s.contributorCount,
    threshold: s.threshold,
    versions: s.versions,
    // The disclosure policy version lives in the frozen release manifest, so a
    // later change to the algorithm can never be read back onto this release.
    manifest: s.manifest,
    generatedAt: s.generatedAt,
    companyGroupKey: company,
    metrics,
    cells: metrics.map(
      (m) =>
        byKey.get(m.key) ?? {
          groupKey: company,
          metricKey: m.key,
          status: "UNSCORED" as const,
          reasonCode: "NO_VALID_SCORE" as const,
          contributorCount: null,
          value: null,
          coverage: null,
          distribution: null,
          band: null,
        },
    ),
    ...rankDimensions({
      cells: s.cells,
      metrics: s.metrics,
      companyGroupKey: company,
    }),
  };
}

// Department versus company for scored metrics. The gap is computed only where
// BOTH cells are released, and it is a score-point difference from the same
// snapshot; there is no cross-campaign or cross-organization comparison here.
export function departmentsView(s: Extract<Snapshot, { available: true }>) {
  const company = companyKey(s),
    byKey = companyCells(s);
  const metrics = s.metrics.filter(
    (m) => m.kind === "OVERALL" || m.kind === "DIMENSION",
  );
  const keys = new Set(metrics.map((m) => m.key));
  const groups = s.groups.filter((g) => g.kind !== "COMPANY");
  return {
    view: "departments" as const,
    threshold: s.threshold,
    companyGroupKey: company,
    metrics,
    groups,
    cells: s.cells.filter((c) => keys.has(c.metricKey)),
    gaps: s.cells
      .filter(
        (c) =>
          keys.has(c.metricKey) &&
          c.groupKey !== company &&
          c.status === "AVAILABLE" &&
          c.value !== null,
      )
      .map((c) => {
        const base = byKey.get(c.metricKey);
        return {
          groupKey: c.groupKey,
          metricKey: c.metricKey,
          points:
            base?.status === "AVAILABLE" && base.value !== null
              ? (Number(c.value) - Number(base.value)).toFixed(1)
              : null,
        };
      }),
  };
}

// Safe question analysis: released option shares and bounded numeric summaries,
// company level only. Free text and exact dates never appear.
export function questionsView(s: Extract<Snapshot, { available: true }>) {
  const company = companyKey(s),
    byKey = companyCells(s);
  const metrics = s.metrics.filter((m) => m.kind === "QUESTION");
  return {
    view: "questions" as const,
    threshold: s.threshold,
    companyGroupKey: company,
    metrics,
    cells: metrics.flatMap((m) => {
      const cell = byKey.get(m.key);
      return cell ? [cell] : [];
    }),
  };
}

// Recommendations, projected beside the metric and group labels of their own
// snapshot so the reader sees what a finding refers to without the client
// having to look anything up — or being able to ask for anything else.
export function recommendationsView(
  s: Extract<Snapshot, { available: true }>,
  release: RecommendationRelease,
) {
  return {
    view: "recommendations" as const,
    threshold: s.threshold,
    companyGroupKey: companyKey(s),
    rulesVersion: release.available ? release.rulesVersion : null,
    previewCount: RECOMMENDATION_PREVIEW,
    // Metric definitions only: labels, direction and bands are instrument
    // configuration and carry no contributor's value.
    metrics: s.metrics.filter((m) => m.kind !== "QUESTION"),
    items: release.available ? release.items : [],
  };
}

const resultsPath =
  /^organizations\/([\w-]+)\/assessments\/([\w-]+)\/results(?:\/([a-z]+))?$/;

export async function resultsRoute(
  req: Request,
  path: string,
  tx: Tx,
): Promise<Response | null> {
  const match = path.match(resultsPath);
  if (!match) return null;
  if (req.method !== "GET") throw new AppError("NOT_FOUND", 404);
  const org = uuid.parse(match[1]),
    roundId = uuid.parse(match[2]),
    view = (match[3] ?? "overview") as ResultView;
  if (!RESULT_VIEWS.includes(view)) throw new AppError("NOT_FOUND", 404);
  // Locale is presentation. Any other query parameter — a department filter, a
  // participant exclusion, a submission-time slice, a demographic intersection
  // or an alternate partition — is refused rather than ignored.
  for (const [key] of new URL(req.url).searchParams)
    if (key !== "locale") throw new AppError("UNSUPPORTED_FILTER", 400);

  await requireAccess(tx, org, "results.read");
  const campaignId = await resolveCampaign(tx, org, roundId);
  const snapshot = await readSnapshot(tx, campaignId);
  if (!snapshot.available)
    throw new AppError(
      snapshot.releaseState === "REVOKED"
        ? "RESULTS_UNAVAILABLE"
        : "RESULTS_NOT_READY",
      409,
    );
  return response({
    campaignId: snapshot.campaignId,
    roundId: snapshot.roundId,
    snapshotId: snapshot.id,
    releaseRevision: snapshot.releaseRevision,
    contentHash: snapshot.contentHash,
    groups: snapshot.groups,
    ...(view === "recommendations"
      ? recommendationsView(snapshot, await readRecommendations(tx, campaignId))
      : view === "departments"
      ? departmentsView(snapshot)
      : view === "questions"
        ? questionsView(snapshot)
        : overviewView(snapshot)),
  });
}
