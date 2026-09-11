import { sql } from "kysely";
import { z } from "zod";
import { type Tx } from "./db";
import { AppError, digest, jsonInput, uuid } from "./security";
import { preconditions } from "./directory";
import { response } from "./http";
import type { Translation } from "./instrument-input";

// ---------------------------------------------------------------------------
// The staff recommendation surface.
//
// Reading is a projection of publication.recommendation_instance — rows that
// were computed and frozen with their release — joined to the editable action
// beside them. Nothing here evaluates a rule, recomputes a value or reads a
// cell the disclosure engine withheld: by the time a row exists, the database
// has already proven every metric it cites is an AVAILABLE cell of the same
// snapshot and the same group.
//
// Writing touches the action row only. Status, owner, due date, consultant
// notes and resolution are staff workflow; the computed title, body, action
// text, rationale, evidence and rule version are immutable and are returned to
// the client in their own object so a consultant opinion can never be presented
// as an automatic finding.
// ---------------------------------------------------------------------------

export type RecommendationAction = {
  id: string;
  status: "OPEN" | "IN_PROGRESS" | "DONE" | "DISMISSED";
  ownerStaffId: string | null;
  ownerName: string | null;
  dueDate: string | null;
  staffNotes: string | null;
  resolution: string | null;
  revision: number;
  updatedAt: string;
};
export type RecommendationItem = {
  id: string;
  groupKey: string;
  metricKey: string;
  ruleKey: string;
  ruleHash: string;
  rulesVersion: string;
  priority: number;
  dedupKey: string;
  exclusivityGroup: string | null;
  severity: string;
  text: {
    title: Translation;
    body: Translation;
    action: Translation;
    rationale: Translation;
  };
  evidence: {
    schemaVersion: 1;
    items: {
      metricKey: string;
      groupKey: string;
      value: string;
      unit: string;
      band: string | null;
    }[];
  };
  action: RecommendationAction | null;
};
export type RecommendationRelease =
  | { available: false; campaignId: string; roundId: string; releaseState: string }
  | {
      available: true;
      campaignId: string;
      roundId: string;
      snapshotId: string;
      rulesVersion: string | null;
      items: RecommendationItem[];
    };

// The blueprint's display rule: the first five are shown, the rest stay one
// action away. The cut is by the same deterministic order the release stored,
// never by a score, so it can never reorder around a withheld value.
export const RECOMMENDATION_PREVIEW = 5;

export async function readRecommendations(tx: Tx, campaignId: string) {
  const { rows } = await sql<{
    data: RecommendationRelease;
  }>`select publication.recommendations(${campaignId}::uuid) as data`.execute(tx);
  return rows[0].data;
}

export const actionInput = z
  .object({
    status: z.enum(["OPEN", "IN_PROGRESS", "DONE", "DISMISSED"]),
    ownerStaffId: uuid.nullable().default(null),
    dueDate: z.iso.date().nullable().default(null),
    // Consultant commentary. It is stored and displayed as staff commentary and
    // is never merged into the frozen computed text.
    staffNotes: z.string().max(4000).nullable().default(null),
    resolution: z.string().max(4000).nullable().default(null),
  })
  .strict()
  .refine(
    (v) =>
      !["DONE", "DISMISSED"].includes(v.status) || !!v.resolution?.trim(),
    "RESOLUTION_REQUIRED",
  );

const actionPath = /^organizations\/([\w-]+)\/recommendation-actions\/([\w-]+)$/;

// The path identifier is the recommendation instance: the action row is one to
// one with it and is created on first save, so the client addresses the finding
// it is acting on rather than a row that may not exist yet.
export async function recommendationActionRoute(
  req: Request,
  path: string,
  tx: Tx,
): Promise<Response | null> {
  const match = path.match(actionPath);
  if (!match) return null;
  if (req.method !== "PATCH") throw new AppError("NOT_FOUND", 404);
  const org = uuid.parse(match[1]),
    instance = uuid.parse(match[2]);
  const { idem, revision } = preconditions(req, false);
  const body = await jsonInput(req, actionInput);
  const { rows } = await sql<{ data: unknown }>`
    select core.save_recommendation_action(${org}::uuid,${instance}::uuid,${revision}::bigint,
      ${JSON.stringify(body)}::jsonb,${idem}::uuid,${digest(JSON.stringify({ org, instance, revision, body }))}) as data
  `.execute(tx);
  return response(rows[0].data);
}
