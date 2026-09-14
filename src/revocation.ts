import { sql } from "kysely";
import { z } from "zod";
import { type Tx, requireAccess } from "./db";
import { AppError, digest, jsonInput, uuid } from "./security";
import { preconditions } from "./directory";
import { response } from "./http";
import { resolveCampaign } from "./results";

// ---------------------------------------------------------------------------
// Withdrawing a published release (Post-Audit Repair Pass 3, SEC-M5).
//
// The decision is a Super Admin's and the database enforces that
// (publication.revoke_release, migration 022). This module only shapes the
// request: a reason category, a written reason, an incident reference, and the
// first eight characters of the release's content hash typed back as
// confirmation, so a stale screen or a mistyped round cannot withdraw a
// different release. Idempotency-Key makes a retry after a lost answer return
// the one revocation instead of a second attempt.
//
// What it cannot do is stated in the product and in the runbook: a file that
// was already downloaded stays wherever it was saved.
// ---------------------------------------------------------------------------

export const REVOCATION_REASONS = [
  "PRIVACY_INCIDENT",
  "CORRECTNESS_ERROR",
  "DATA_INTEGRITY",
  "OWNER_DECISION",
] as const;

export const revocationInput = z
  .object({
    snapshotId: uuid,
    reasonCode: z.enum(REVOCATION_REASONS),
    reason: z.string().trim().min(10).max(2000),
    incidentReference: z.string().trim().min(1).max(200),
    confirmation: z.string().trim().regex(/^[0-9a-fA-F]{8}$/),
  })
  .strict();

export type RevocationResult = {
  id: string;
  snapshotId: string;
  replayed: boolean;
  reportsRevoked: number;
  downloadsBefore: number;
};

export async function releaseStatus(tx: Tx, org: string, campaignId: string) {
  const { rows } = await sql<{ data: unknown }>`
    select publication.release_status(${org}::uuid,${campaignId}::uuid) as data`.execute(tx);
  return rows[0].data;
}

export async function revokeRelease(
  tx: Tx,
  org: string,
  campaignId: string,
  body: z.infer<typeof revocationInput>,
  idem: string,
) {
  const { rows } = await sql<{ data: RevocationResult }>`
    select publication.revoke_release(${org}::uuid,${campaignId}::uuid,${JSON.stringify(body)}::jsonb,
      ${idem}::uuid,${digest(JSON.stringify({ org, campaignId, body }))}) as data`.execute(tx);
  return rows[0].data;
}

const releasePath =
  /^organizations\/([\w-]+)\/assessments\/([\w-]+)\/release(?:\/(revocation))?$/;

export async function revocationRoute(
  req: Request,
  path: string,
  tx: Tx,
): Promise<Response | null> {
  const match = path.match(releasePath);
  if (!match) return null;
  const org = uuid.parse(match[1]),
    roundId = uuid.parse(match[2]);
  for (const [key] of new URL(req.url).searchParams)
    if (key !== "locale") throw new AppError("UNSUPPORTED_FILTER", 400);
  await requireAccess(tx, org, "results.read");
  const campaignId = await resolveCampaign(tx, org, roundId);
  if (req.method === "GET" && !match[3])
    return response(await releaseStatus(tx, org, campaignId));
  if (req.method === "POST" && match[3]) {
    const { idem } = preconditions(req, false);
    const body = await jsonInput(req, revocationInput);
    const result = await revokeRelease(tx, org, campaignId, body, idem);
    return response(result, result.replayed ? 200 : 201);
  }
  throw new AppError("NOT_FOUND", 404);
}
