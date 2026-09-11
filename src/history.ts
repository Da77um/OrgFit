import { sql } from "kysely";
import { z } from "zod";
import { type Tx, requireAccess } from "./db";
import { AppError, digest, jsonInput, uuid } from "./security";
import { preconditions } from "./directory";
import { response } from "./http";
import { getVersion } from "./instruments";
import type { Instrument } from "./instrument-input";
import { readSnapshot } from "./results";
import type { GroupDefinition, MetricDefinition, SafeCell } from "./disclosure";
import {
  CLASSIFICATIONS,
  compareSnapshots,
  proposeMapping,
  trendSeries,
  type Classification,
  type ComparisonSide,
} from "./comparison";

// ---------------------------------------------------------------------------
// The staff history surface.
//
// It reads published snapshots and pinned instrument definitions, and nothing
// else. There is no roster here, no participant identifier, no cross-round
// join of any person, and no path from a round to an answer: a history is a
// sequence of releases that each already passed disclosure on their own.
//
// Two things are offered. The TREND is automatic and conservative: it plots a
// company metric across rounds only while the measurement itself is unchanged,
// and shows an explicit break otherwise. The COMPARISON is a reviewed judgement
// between exactly two rounds of one series, and it produces a number only where
// a named reviewer accepted the mapping AND the pinned definitions still agree.
// ---------------------------------------------------------------------------

type HistoryRound = {
  roundId: string;
  label: string;
  periodStart: string;
  periodEnd: string | null;
  state: string;
  versionId: string;
  campaignId: string | null;
  releaseState: string | null;
  snapshotId: string | null;
  contributorCount: number | null;
  generatedAt: string | null;
  threshold: number | null;
  companyGroupKey: string | null;
  metrics: MetricDefinition[];
  cells: SafeCell[];
};
type SeriesHistory = {
  seriesId: string;
  organizationId: string;
  nameAr: string;
  nameEn: string | null;
  purpose: string;
  status: string;
  rounds: HistoryRound[];
};

// A pinned questionnaire version, read from the immutable instrument tables the
// round froze. Published versions cannot change, so this is a historic read
// even though it is a live query.
async function pinnedInstrument(tx: Tx, versionId: string): Promise<Instrument> {
  const { rows } = await sql<{
    questionnaire_id: string;
    organization_id: string | null;
  }>`select questionnaire_id, organization_id from instrument.questionnaire_version where id=${versionId}::uuid`.execute(
    tx,
  );
  if (!rows.length) throw new AppError("NOT_FOUND", 404);
  const version = await getVersion(
    tx,
    rows[0].organization_id,
    rows[0].questionnaire_id,
    versionId,
  );
  return version.document;
}

export async function seriesHistory(tx: Tx, seriesId: string) {
  const { rows } = await sql<{
    data: SeriesHistory;
  }>`select publication.series_history(${seriesId}::uuid) as data`.execute(tx);
  const history = rows[0].data;
  // Only released rounds need their instrument, and only to decide whether the
  // measurement is still the same one.
  const instruments = new Map<string, Instrument>();
  for (const round of history.rounds)
    if (round.snapshotId && !instruments.has(round.versionId))
      instruments.set(round.versionId, await pinnedInstrument(tx, round.versionId));
  return {
    ...history,
    rounds: history.rounds.map(({ cells: _cells, metrics: _metrics, ...rest }) => rest),
    trends: trendSeries(
      history.rounds.map((round) => ({
        roundId: round.roundId,
        label: round.label,
        periodStart: round.periodStart,
        releaseState: round.releaseState ?? round.state,
        contributorCount: round.contributorCount,
        instrument: round.snapshotId
          ? (instruments.get(round.versionId) ?? null)
          : null,
        metrics: round.metrics,
        cells: round.cells,
        companyGroupKey: round.companyGroupKey,
      })),
    ),
  };
}

type ComparisonContext = {
  id: string;
  organizationId: string;
  seriesId: string;
  classification: Classification;
  metricMapping: { schemaVersion: 1; metrics: { leftKey: string; rightKey: string }[] };
  rationale: string;
  reviewedAt: string;
  reviewedBy: string | null;
  left: ContextSide;
  right: ContextSide;
};
type ContextSide = {
  roundId: string;
  label: string;
  periodStart: string;
  periodEnd: string | null;
  versionId: string;
  campaignId: string;
  snapshotId: string;
  threshold: number;
  contributorCount: number;
  generatedAt: string;
  lineage: Record<string, string | null>;
};

async function side(tx: Tx, context: ContextSide): Promise<ComparisonSide> {
  const snapshot = await readSnapshot(tx, context.campaignId);
  // A revoked or superseded release cannot be compared: there is nothing
  // published to compare with.
  if (!snapshot.available) throw new AppError("RESULTS_UNAVAILABLE", 409);
  return {
    roundId: context.roundId,
    campaignId: context.campaignId,
    snapshotId: snapshot.id,
    label: context.label,
    periodStart: context.periodStart,
    periodEnd: context.periodEnd,
    threshold: snapshot.threshold,
    contributorCount: snapshot.contributorCount,
    instrument: await pinnedInstrument(tx, context.versionId),
    metrics: snapshot.metrics as MetricDefinition[],
    groups: snapshot.groups as GroupDefinition[],
    cells: snapshot.cells as SafeCell[],
    lineage: context.lineage,
  };
}

export async function comparisonView(tx: Tx, id: string) {
  const { rows } = await sql<{
    data: ComparisonContext;
  }>`select publication.comparison_context(${id}::uuid) as data`.execute(tx);
  const context = rows[0].data;
  const left = await side(tx, context.left),
    right = await side(tx, context.right);
  const result = compareSnapshots({
    classification: context.classification,
    pairs: context.metricMapping.metrics ?? [],
    left,
    right,
  });
  const summary = (s: ComparisonSide) => ({
    roundId: s.roundId,
    snapshotId: s.snapshotId,
    label: s.label,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    threshold: s.threshold,
    contributorCount: s.contributorCount,
    // Group labels stay as each round froze them, so a renamed department reads
    // under the name it had at the time.
    groups: s.groups,
    metrics: s.metrics,
  });
  return {
    id: context.id,
    seriesId: context.seriesId,
    rationale: context.rationale,
    reviewedAt: context.reviewedAt,
    reviewedBy: context.reviewedBy,
    left: summary(left),
    right: summary(right),
    ...result,
  };
}

export const comparisonInput = z
  .object({
    leftRoundId: uuid,
    rightRoundId: uuid,
    classification: z.enum(CLASSIFICATIONS),
    mapping: z
      .array(z.object({ leftKey: z.string().max(200), rightKey: z.string().max(200) }).strict())
      .max(100)
      .default([]),
    rationale: z.string().trim().min(1).max(2000),
  })
  .strict();

// The review aid: what the two versions actually say about each other, with no
// cell and no value in it. A reviewer sees which metrics still measure the same
// thing before deciding, rather than after.
async function proposal(tx: Tx, org: string, left: string, right: string) {
  const rounds = await sql<{
    id: string;
    series_id: string;
    questionnaire_version_id: string;
    period_start: string;
    label: string;
  }>`select id, series_id, questionnaire_version_id, period_start, label
       from core.assessment_round where organization_id=${org}::uuid and id in (${left}::uuid,${right}::uuid)`.execute(
    tx,
  );
  if (rounds.rows.length !== 2) throw new AppError("NOT_FOUND", 404);
  const l = rounds.rows.find((r) => r.id === left)!,
    r = rounds.rows.find((row) => row.id === right)!;
  if (l.series_id !== r.series_id) throw new AppError("VALIDATION_FAILED", 422);
  const suggestion = proposeMapping(
    await pinnedInstrument(tx, l.questionnaire_version_id),
    await pinnedInstrument(tx, r.questionnaire_version_id),
  );
  return {
    leftRoundId: l.id,
    rightRoundId: r.id,
    identicalVersion: l.questionnaire_version_id === r.questionnaire_version_id,
    ...suggestion,
    // A version that did not change at all needs no equivalence judgement.
    suggestion: (l.questionnaire_version_id === r.questionnaire_version_id
      ? "IDENTICAL"
      : suggestion.suggestion) as Classification,
  };
}

const historyPath = /^organizations\/([\w-]+)\/history(?:\/([\w-]+))?$/;
const comparisonPath = /^organizations\/([\w-]+)\/comparisons(?:\/([\w-]+))?$/;

export async function historyRoute(
  req: Request,
  path: string,
  tx: Tx,
): Promise<Response | null> {
  const history = path.match(historyPath),
    comparison = path.match(comparisonPath);
  if (!history && !comparison) return null;
  const org = uuid.parse((history ?? comparison)![1]);
  const url = new URL(req.url);

  if (history) {
    if (req.method !== "GET") throw new AppError("NOT_FOUND", 404);
    // Presentation only, exactly as on the results surface. A slice of a
    // history is still a slice of published results.
    for (const [key] of url.searchParams)
      if (key !== "locale") throw new AppError("UNSUPPORTED_FILTER", 400);
    await requireAccess(tx, org, "results.read");
    if (history[2]) return response(await seriesHistory(tx, uuid.parse(history[2])));
    // Counted from the campaign's own release state rather than from a
    // publication table: orgfit_staff holds no privilege there, and the
    // release state is the campaign-level fact this list needs.
    const { rows } = await sql<Record<string, unknown>>`
      select s.id, s.name_ar, s.name_en, s.purpose, s.status,
        count(r.id)::int as round_count,
        count(*) filter (where c.release_state='PUBLISHED')::int as released_count
        from core.assessment_series s
        left join core.assessment_round r on r.organization_id=s.organization_id and r.series_id=s.id
        left join core.campaign c on c.organization_id=r.organization_id and c.round_id=r.id
       where s.organization_id=${org}::uuid
       group by s.id order by s.name_ar, s.id limit 100`.execute(tx);
    return response({ items: rows, nextCursor: null });
  }

  if (req.method === "GET" && comparison![2] === "proposal") {
    await requireAccess(tx, org, "instruments.manage");
    const query = z
      .object({ left: uuid, right: uuid })
      .strict()
      .parse(Object.fromEntries(url.searchParams));
    return response(await proposal(tx, org, query.left, query.right));
  }
  if (req.method === "GET" && comparison![2]) {
    await requireAccess(tx, org, "results.read");
    return response(await comparisonView(tx, uuid.parse(comparison![2])));
  }
  if (req.method === "GET") {
    await requireAccess(tx, org, "results.read");
    const seriesId = url.searchParams.get("seriesId");
    for (const [key] of url.searchParams)
      if (!["seriesId", "locale"].includes(key))
        throw new AppError("UNSUPPORTED_FILTER", 400);
    const { rows } = await sql<{
      data: unknown;
    }>`select publication.comparisons(${org}::uuid,${seriesId ? uuid.parse(seriesId) : null}::uuid) as data`.execute(
      tx,
    );
    return response({ items: rows[0].data, nextCursor: null });
  }
  if (req.method === "POST" && !comparison![2]) {
    // Recording that two measurements are the same is an instrument judgement,
    // not a reporting preference.
    await requireAccess(tx, org, "instruments.manage");
    const { idem } = preconditions(req, false);
    const body = await jsonInput(req, comparisonInput);
    if (body.leftRoundId === body.rightRoundId)
      throw new AppError("VALIDATION_FAILED", 422);
    // The equivalence claim is checked against the pinned definitions before it
    // is stored, and again whenever a delta is computed.
    if (body.classification !== "NOT_COMPARABLE") {
      const check = await proposal(tx, org, body.leftRoundId, body.rightRoundId);
      if (body.classification === "IDENTICAL" && !check.identicalVersion)
        throw new AppError("VALIDATION_FAILED", 422);
      const equivalence = new Map(
        check.pairs.map((p) => [`${p.leftKey} ${p.rightKey}`, p.equivalent]),
      );
      for (const pair of body.mapping)
        if (!equivalence.get(`${pair.leftKey} ${pair.rightKey}`))
          throw new AppError("MEASUREMENT_NOT_EQUIVALENT", 422);
    }
    const { rows } = await sql<{ data: { id: string } }>`
      select publication.save_comparison(${org}::uuid,${JSON.stringify(body)}::jsonb,
        ${idem}::uuid,${digest(JSON.stringify({ org, body }))}) as data`.execute(tx);
    return response(await comparisonView(tx, rows[0].data.id), 201);
  }
  throw new AppError("NOT_FOUND", 404);
}
