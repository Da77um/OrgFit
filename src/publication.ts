import pg from "pg";
import { instrumentSchema, type Instrument, type Translation } from "./instrument-input";
import { ENGINE_VERSION } from "./scoring";
import {
  buildReleasePlan,
  DisclosureError,
  DISCLOSURE_VERSION,
  type ReleasePlan,
  type ResponseRecord,
  type TypedValue,
} from "./disclosure";
import { reconcile } from "./processor";
import {
  evaluateRecommendations,
  RULES_VERSION,
  type RecommendationInstance,
} from "./recommendation-engine";

// ---------------------------------------------------------------------------
// The release job. It runs inside the privacy boundary, under the processor's
// own credentials, and it is the only writer publication storage has.
//
// Direction of travel is strictly one way: anonymous answers in, an approved
// aggregate plan out. Nothing it reads from the anonymous database — a response
// id, an answer, a per-person score — appears anywhere in what it writes.
//
// It publishes only a campaign whose accepted and processed counts already
// reconcile. A count mismatch, an unfinished batch or an open campaign blocks
// the release; it is never repaired by adjusting a number.
// ---------------------------------------------------------------------------

export type ReleaseOutcome = {
  campaignId: string;
  state:
    | "PUBLISHED"
    | "REUSED"
    | "INSUFFICIENT_DATA"
    | "BLOCKED"
    | "NOT_READY"
    | "FAILED";
  snapshotId: string | null;
  contributorCount: number | null;
  metricsReleased: number | null;
  recommendationsReleased: number | null;
  note?: string;
};

type ManifestRow = {
  organization_id: string;
  questionnaire_version_id: string;
  instrument_snapshot: { manifest?: unknown; instrument?: unknown } | null;
  instrument_hash: string;
  threshold: number;
};

// The pinned questionnaire the batch was processed against, taken from the
// anonymous manifest rather than from a live core table: a later instrument
// edit must never rewrite a published result.
function pinnedInstrument(row: ManifestRow): Instrument {
  const parsed = instrumentSchema.safeParse(row.instrument_snapshot?.instrument);
  if (!parsed.success) throw new DisclosureError("PINNED_INSTRUMENT_MISSING");
  return parsed.data;
}

async function readAnonymous(anon: pg.Pool, org: string, campaignId: string) {
  const manifest = (
    await anon.query<ManifestRow>(
      `SELECT organization_id, questionnaire_version_id, instrument_snapshot,
              encode(instrument_hash,'hex') AS instrument_hash, threshold
         FROM anonymous.anonymous_campaign_manifest WHERE organization_id=$1 AND id=$2`,
      [org, campaignId],
    )
  ).rows[0];
  if (!manifest) throw new DisclosureError("MANIFEST_MISSING");
  // The committed batch marker. It is campaign-level and identifies no
  // submission; it is what proves this anonymous output is the finished one.
  const marker = (
    await anon.query<{ id: string; response_count: number }>(
      `SELECT id, response_count FROM anonymous.processed_batch
        WHERE organization_id=$1 AND campaign_id=$2`,
      [org, campaignId],
    )
  ).rows[0];
  if (!marker) throw new DisclosureError("BATCH_MARKER_MISSING");
  const groups = (
    await anon.query<{ id: string; kind: string; label: Translation }>(
      `SELECT id, kind, label FROM anonymous.anonymous_group
        WHERE organization_id=$1 AND campaign_id=$2`,
      [org, campaignId],
    )
  ).rows;
  const responses = (
    await anon.query<{
      id: string;
      report_group_id: string;
      scores: ResponseRecord["scores"] | null;
      answers: ResponseRecord["answers"] | null;
    }>(
      `SELECT r.id, r.report_group_id,
              (SELECT jsonb_agg(jsonb_build_object('definitionKey',s.definition_key,
                 'normalized',s.normalized_value::text,'coverage',s.coverage::text,'status',s.status))
                 FROM anonymous.response_score s
                WHERE s.organization_id=r.organization_id AND s.campaign_id=r.campaign_id
                  AND s.response_id=r.id AND s.engine_version=$3) AS scores,
              (SELECT jsonb_agg(jsonb_build_object('questionKey',a.question_key,'typedValue',a.typed_value))
                 FROM anonymous.anonymous_answer a
                WHERE a.organization_id=r.organization_id AND a.campaign_id=r.campaign_id
                  AND a.response_id=r.id) AS answers
         FROM anonymous.anonymous_response r
        WHERE r.organization_id=$1 AND r.campaign_id=$2 AND r.validity='VALID'`,
      [org, campaignId, ENGINE_VERSION],
    )
  ).rows;
  return {
    manifest,
    marker,
    groups: groups.map((g) => ({
      id: g.id,
      kind: g.kind as "COMPANY" | "DEPARTMENT" | "OTHER",
      label: g.label,
    })),
    // The response id is read to join answers to scores and is dropped right
    // here. It never enters the plan and never reaches publication storage.
    responses: responses.map<ResponseRecord>((r) => ({
      groupId: r.report_group_id,
      scores: r.scores ?? [],
      answers: (r.answers ?? []) as {
        questionKey: string;
        typedValue: TypedValue;
      }[],
    })),
  };
}

export function releasePayload(
  organizationId: string,
  campaignId: string,
  batchId: string,
  instrumentHash: string,
  plan: ReleasePlan,
  recommendations: RecommendationInstance[] = [],
) {
  return {
    organizationId,
    campaignId,
    batchId,
    threshold: plan.threshold,
    contributorCount: plan.contributorCount,
    versions: {
      scoring: ENGINE_VERSION,
      disclosure: DISCLOSURE_VERSION,
      rules: RULES_VERSION,
      instrumentHash,
    },
    reviewReference: `disclosure ${DISCLOSURE_VERSION} automated plan validation`,
    reportManifest: {
      schemaVersion: 1,
      instrumentHash,
      engineVersion: ENGINE_VERSION,
      rulesVersion: RULES_VERSION,
      recommendationsReleased: recommendations.length,
      ...plan.summary,
    },
    groups: plan.groups,
    metrics: plan.metrics,
    cells: plan.cells,
    recommendations,
  };
}

export async function releaseCampaign(
  core: pg.Pool,
  anon: pg.Pool,
  campaignId: string,
): Promise<ReleaseOutcome> {
  const readiness = await reconcile(core, anon, campaignId);
  const done = (
    state: ReleaseOutcome["state"],
    note?: string,
  ): ReleaseOutcome => ({
    campaignId,
    state,
    snapshotId: null,
    contributorCount: null,
    metricsReleased: null,
    recommendationsReleased: null,
    note,
  });
  // An open or still-processing campaign yields no assessment metrics at all.
  if (readiness.campaignState !== "CLOSED")
    return done("NOT_READY", "campaign is still collecting");
  if (readiness.batchState === "PURGED" || readiness.acceptedCount < readiness.threshold) {
    // Below the threshold there is nothing to suppress, because nothing was
    // ever decrypted. The outcome is recorded and no snapshot is created.
    await core.query("SELECT publication.mark_release_state($1,$2,$3)", [
      readiness.organizationId,
      campaignId,
      "INSUFFICIENT_DATA",
    ]);
    return done("INSUFFICIENT_DATA", "campaign never reached the threshold");
  }
  if (readiness.blocked)
    return done("BLOCKED", "accepted and processed counts do not reconcile");

  const { manifest, marker, groups, responses } = await readAnonymous(
    anon,
    readiness.organizationId,
    campaignId,
  );
  // Three counts must agree before anything is released: the accepted
  // invitations, the marker the processor committed, and the rows actually
  // read back now. A disagreement blocks the release and is not reconciled by
  // publishing the smaller number.
  if (
    responses.length !== readiness.acceptedCount ||
    marker.response_count !== readiness.acceptedCount
  )
    return done("BLOCKED", "anonymous response count does not reconcile");
  const instrument = pinnedInstrument(manifest);
  const plan = buildReleasePlan({
    threshold: Math.max(manifest.threshold, readiness.threshold),
    instrument,
    groups,
    responses,
  });
  // Recommendations are computed from the approved plan, never from the
  // responses that produced it, and they are published in the same transaction
  // as the cells they cite. There is no later pass that could add one after a
  // reader has already seen the release without it.
  const recommendations = evaluateRecommendations({
    instrument,
    groups: plan.groups,
    metrics: plan.metrics,
    cells: plan.cells,
    companyGroupKey: plan.companyGroupKey,
  });
  const result = (
    await core.query<{ data: { snapshotId: string; reused: boolean } }>(
      "SELECT publication.publish_release($1) AS data",
      [
        JSON.stringify(
          releasePayload(
            readiness.organizationId,
            campaignId,
            marker.id,
            manifest.instrument_hash,
            plan,
            recommendations,
          ),
        ),
      ],
    )
  ).rows[0].data;
  return {
    campaignId,
    state: result.reused ? "REUSED" : "PUBLISHED",
    snapshotId: result.snapshotId,
    contributorCount: plan.contributorCount,
    metricsReleased: plan.summary.metricsReleased,
    recommendationsReleased: recommendations.length,
  };
}

// Operator entry point. Output is campaign-level counts and states only.
export async function releaseDueCampaigns(
  core: pg.Pool,
  anon: pg.Pool,
  limit = 20,
) {
  // The processor holds no SELECT on core.campaign; its queue is a routine that
  // returns campaign identifiers and nothing else.
  const due = (
    await core.query<{ due: string[] }>(
      "SELECT publication.due_campaigns('RELEASE',$1) AS due",
      [limit],
    )
  ).rows[0].due;
  const outcomes: ReleaseOutcome[] = [];
  for (const id of due) {
    try {
      outcomes.push(await releaseCampaign(core, anon, id));
    } catch (e) {
      outcomes.push({
        campaignId: id,
        state: "FAILED",
        snapshotId: null,
        contributorCount: null,
        metricsReleased: null,
        recommendationsReleased: null,
        // A driver message can quote a value, so only the code is kept.
        note: e instanceof DisclosureError ? e.code : (e as Error).message,
      });
    }
  }
  return outcomes;
}
