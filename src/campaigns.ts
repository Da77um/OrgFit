import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { type Tx } from "./db";
import { AppError, digest, jsonInput, uuid } from "./security";
import { preconditions } from "./directory";
import { response } from "./http";
import {
  seriesInput,
  roundInput,
  campaignInput,
  reasonInput,
  endDateInput,
  issueInput,
  rotateInput,
  revokeInput,
  linkExportInput,
} from "./campaign-input";
import { archiveInput } from "./directory-input";
import {
  invitationToken,
  invitationUrl,
  tokenDigest,
  digestKeyVersion,
} from "./invitation-token";
import { putExport, getExport, EXPORT_TTL_HOURS } from "./link-storage";
import { createCampaignKey } from "./key-custody";

export type Campaign = {
  id: string;
  organization_id: string;
  round_id: string;
  instrument_scope_id: string;
  version_id: string;
  state: "DRAFT" | "SCHEDULED" | "OPEN" | "CLOSED" | "CANCELLED";
  starts_at: Date;
  ends_at: Date | null;
  timezone: string;
  target_mode: "SINGLE" | "SELECTED" | "DEPARTMENT" | "ALL";
  requested_target: Record<string, unknown>;
  locales: string[];
  roster_frozen_at: Date | null;
  frozen_manifest: Record<string, unknown> | null;
  frozen_invited_count: number | null;
  privacy_policy_version: number;
  threshold: number;
  closed_at: Date | null;
  close_kind: string | null;
  close_reason: string | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  release_state: string;
  archived: boolean;
  revision: string;
};
export type Participation = {
  items: {
    invitationId: string;
    participantId: string;
    displayReference: string;
    displayName: string;
    status: "READY" | "COMPLETED" | "REVOKED";
    issued: boolean;
    generation: number;
    reportGroupId: string | null;
  }[];
  totals: {
    invited: number;
    completed: number;
    revoked: number;
    outstanding: number;
    eligible: number;
    rate: string | null;
  };
};
export type IssuedLink = {
  invitationId: string;
  displayReference: string;
  generation: number;
  url: string;
};

export async function campaignRead(tx: Tx, org: string) {
  const { rows } = await sql<{
    ok: boolean;
  }>`select core.campaign_readable(${org}::uuid) ok`.execute(tx);
  if (!rows[0].ok) throw new AppError("NOT_FOUND", 404);
}
export async function campaignWrite(tx: Tx, org: string) {
  const { rows } = await sql<{
    allowed: boolean;
    capable: boolean;
  }>`select access.has_org(${org}::uuid) allowed, access.has_capability('campaigns.manage') capable`.execute(
    tx,
  );
  if (!rows[0].allowed) throw new AppError("NOT_FOUND", 404);
  if (!rows[0].capable) throw new AppError("FORBIDDEN", 403);
}

export async function getSeries(tx: Tx, org: string, id: string) {
  await campaignRead(tx, org);
  const { rows } = await sql<
    Record<string, unknown>
  >`select * from core.assessment_series where id=${id}::uuid and organization_id=${org}::uuid`.execute(
    tx,
  );
  if (!rows.length) throw new AppError("NOT_FOUND", 404);
  return rows[0];
}
export async function listSeries(tx: Tx, org: string, url: URL) {
  await campaignRead(tx, org);
  const q = z
    .object({
      status: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).default("ACTIVE"),
      cursor: uuid.optional(),
    })
    .strict()
    .parse(Object.fromEntries(url.searchParams));
  const { rows } = await sql<{
    id: string;
  }>`select * from core.assessment_series where organization_id=${org}::uuid and (${q.status}='ALL' or status=${q.status}) and (${q.cursor ?? null}::uuid is null or id>${q.cursor ?? null}::uuid) order by id limit 51`.execute(
    tx,
  );
  return {
    items: rows.slice(0, 50),
    nextCursor: rows.length > 50 ? rows[49].id : null,
  };
}
export async function getRound(tx: Tx, org: string, id: string) {
  await campaignRead(tx, org);
  const { rows } = await sql<
    Record<string, unknown>
  >`select r.*,(select id from core.campaign c where c.organization_id=r.organization_id and c.round_id=r.id) campaign_id from core.assessment_round r where r.id=${id}::uuid and r.organization_id=${org}::uuid`.execute(
    tx,
  );
  if (!rows.length) throw new AppError("NOT_FOUND", 404);
  return rows[0];
}
export async function listRounds(tx: Tx, org: string, url: URL) {
  await campaignRead(tx, org);
  const q = z
    .object({ seriesId: uuid.optional(), cursor: uuid.optional() })
    .strict()
    .parse(Object.fromEntries(url.searchParams));
  const { rows } = await sql<{
    id: string;
  }>`select r.*,c.id campaign_id,c.state campaign_state,core.effective_state(c.state,c.starts_at,c.ends_at) campaign_effective_state
     from core.assessment_round r left join core.campaign c on c.organization_id=r.organization_id and c.round_id=r.id
     where r.organization_id=${org}::uuid and (${q.seriesId ?? null}::uuid is null or r.series_id=${q.seriesId ?? null}::uuid)
     and (${q.cursor ?? null}::uuid is null or r.id>${q.cursor ?? null}::uuid) order by r.id limit 51`.execute(
    tx,
  );
  return {
    items: rows.slice(0, 50),
    nextCursor: rows.length > 50 ? rows[49].id : null,
  };
}
// Every campaign read normalizes the schedule first, so a late scheduler can
// never present a passed end boundary as still open.
export async function getCampaign(tx: Tx, org: string, id: string) {
  const { rows } = await sql<Campaign>`select * from core.campaign_view(${org}::uuid,${id}::uuid)`.execute(
    tx,
  );
  if (!rows.length) throw new AppError("NOT_FOUND", 404);
  return rows[0];
}
export async function campaignDetail(tx: Tx, org: string, id: string) {
  const campaign = await getCampaign(tx, org, id);
  const groups = await sql<{
    id: string;
  }>`select id,kind,department_id,label from core.report_group where organization_id=${org}::uuid and campaign_id=${id}::uuid order by kind,id`.execute(
    tx,
  );
  const round = await getRound(tx, org, campaign.round_id);
  return { ...campaign, reportGroups: groups.rows, round };
}
export async function launchReview(tx: Tx, org: string, id: string) {
  const { rows } = await sql<{
    data: unknown;
  }>`select core.launch_review(${org}::uuid,${id}::uuid) data`.execute(tx);
  return rows[0].data;
}
export async function participation(tx: Tx, org: string, id: string) {
  const { rows } = await sql<{
    data: Participation;
  }>`select core.participation(${org}::uuid,${id}::uuid) data`.execute(tx);
  return rows[0].data;
}

const requestHash = (value: unknown) => digest(JSON.stringify(value));

export async function saveSeries(
  tx: Tx,
  org: string,
  id: string | null,
  revision: string | null,
  body: unknown,
  idem: string,
  archiving = false,
) {
  const { rows } = await sql<{
    id: string;
  }>`select core.save_series(${org}::uuid,${id}::uuid,${revision}::bigint,${JSON.stringify(body)}::jsonb,${idem}::uuid,${requestHash({ org, id, revision, body, archiving })},${archiving}) id`.execute(
    tx,
  );
  return getSeries(tx, org, rows[0].id);
}
export async function saveRound(
  tx: Tx,
  org: string,
  id: string | null,
  revision: string | null,
  body: unknown,
  idem: string,
) {
  const { rows } = await sql<{
    id: string;
  }>`select core.save_round(${org}::uuid,${id}::uuid,${revision}::bigint,${JSON.stringify(body)}::jsonb,${idem}::uuid,${requestHash({ org, id, revision, body })}) id`.execute(
    tx,
  );
  return getRound(tx, org, rows[0].id);
}
export async function saveCampaign(
  tx: Tx,
  org: string,
  id: string | null,
  revision: string | null,
  body: unknown,
  idem: string,
) {
  const { rows } = await sql<{
    id: string;
  }>`select core.save_campaign(${org}::uuid,${id}::uuid,${revision}::bigint,${JSON.stringify(body)}::jsonb,${idem}::uuid,${requestHash({ org, id, revision, body })}) id`.execute(
    tx,
  );
  return campaignDetail(tx, org, rows[0].id);
}
export async function launchCampaign(
  tx: Tx,
  org: string,
  id: string,
  revision: string | null,
  idem: string,
) {
  await sql`select core.launch_campaign(${org}::uuid,${id}::uuid,${revision}::bigint,${idem}::uuid,${requestHash({ org, id, revision, action: "LAUNCH" })})`.execute(
    tx,
  );
  // Phase 07: a launched campaign must have an authenticated sealed-box public
  // key before any link can be used, so acceptance can never fall back to
  // storing a plaintext answer set. Only the PUBLIC half reaches this process;
  // the private half is written by the custody service and is not returned.
  // If custody fails, this throws and the whole launch transaction rolls back.
  const key = await createCampaignKey();
  await sql`select core.register_campaign_key(${org}::uuid,${id}::uuid,${key.keyReference},${key.publicKey})`.execute(
    tx,
  );
  return campaignDetail(tx, org, id);
}
export async function campaignTransition(
  tx: Tx,
  org: string,
  id: string,
  revision: string | null,
  action: "CLOSE" | "CANCEL" | "ARCHIVE" | "END_DATE",
  args: { reason?: string; endsAt?: string | null },
  idem: string,
) {
  await sql`select core.campaign_transition(${org}::uuid,${id}::uuid,${revision}::bigint,${action},${args.reason ?? null},${args.endsAt ?? null}::timestamptz,${idem}::uuid,${requestHash({ org, id, revision, action, args })})`.execute(
    tx,
  );
  return campaignDetail(tx, org, id);
}

// The raw credential exists only in this function's memory and in the single
// response that reveals it. It is never persisted, logged or reconstructable.
export async function invitationAction(
  tx: Tx,
  org: string,
  campaignId: string,
  invitationId: string,
  action: "ISSUE" | "ROTATE" | "REVOKE",
  args: { expectedGeneration: number; reason?: string },
  idem: string,
): Promise<IssuedLink | { invitationId: string; status: string; generation: number }> {
  const token = action === "REVOKE" ? null : invitationToken();
  const { rows } = await sql<{
    data: {
      replayed: boolean;
      generation: number;
      status: string;
      displayReference: string;
    };
  }>`select core.invitation_action(${org}::uuid,${campaignId}::uuid,${invitationId}::uuid,${action},${args.expectedGeneration},${args.reason ?? null},${token ? tokenDigest(token) : null},${token ? digestKeyVersion() : null},${idem}::uuid,${requestHash({ org, campaignId, invitationId, action, args })}) data`.execute(
    tx,
  );
  const result = rows[0].data;
  if (action === "REVOKE")
    return {
      invitationId,
      status: result.status,
      generation: result.generation,
    };
  // A replayed issue receipt must never hand back a new or old credential.
  if (result.replayed) throw new AppError("TOKEN_ALREADY_ISSUED", 409);
  return {
    invitationId,
    displayReference: result.displayReference,
    generation: result.generation,
    url: invitationUrl(token!),
  };
}

export function linkExportCsv(rows: IssuedLink[]) {
  // Values are quoted and leading formula characters are neutralized so a
  // spreadsheet cannot execute exported content.
  const cell = (v: string) =>
    `"${(/^[=+\-@\t\r]/.test(v) ? "'" + v : v).replaceAll('"', '""')}"`;
  return (
    "﻿" +
    ["displayReference,generation,url"]
      .concat(
        rows.map((r) =>
          [r.displayReference, String(r.generation), r.url]
            .map(cell)
            .join(","),
        ),
      )
      .join("\r\n") +
    "\r\n"
  );
}
export async function createLinkExport(
  tx: Tx,
  org: string,
  campaignId: string,
  body: z.infer<typeof linkExportInput>,
  idem: string,
) {
  const order = body.invitationIds
    .map((id, index) => ({ id, expected: body.expectedGenerations[index] }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const tokens = order.map(() => invitationToken());
  const { rows } = await sql<{
    data: {
      invitationId: string;
      displayReference: string;
      generation: number;
      rotated: boolean;
    }[];
  }>`select core.issue_export_plan(${org}::uuid,${campaignId}::uuid,${order.map((o) => o.id)}::uuid[],${order.map((o) => o.expected)}::integer[],${tokens.map((t) => tokenDigest(t))}::bytea[],${digestKeyVersion()},${body.confirmRotation},${idem}::uuid,${requestHash({ org, campaignId, body })}) data`.execute(
    tx,
  );
  const issued: IssuedLink[] = rows[0].data.map((r, index) => ({
    invitationId: r.invitationId,
    displayReference: r.displayReference,
    generation: r.generation,
    url: invitationUrl(tokens[index]),
  }));
  const exportId = randomUUID();
  const storageKey = await putExport(
    org,
    exportId,
    Buffer.from(linkExportCsv(issued), "utf8"),
  );
  await sql`select core.record_link_export(${org}::uuid,${campaignId}::uuid,${exportId}::uuid,${randomUUID()}::uuid,${storageKey},${issued.length},${`${EXPORT_TTL_HOURS} hours`}::interval)`.execute(
    tx,
  );
  return {
    exportId,
    itemCount: issued.length,
    rotatedCount: rows[0].data.filter((r) => r.rotated).length,
    expiresInHours: EXPORT_TTL_HOURS,
  };
}
export async function linkExportKey(tx: Tx, org: string, exportId: string) {
  const { rows } = await sql<{
    key: string;
  }>`select core.link_export_download(${org}::uuid,${exportId}::uuid) key`.execute(
    tx,
  );
  return rows[0].key;
}

const campaignPath =
  /^organizations\/([^/]+)\/(assessment-series|assessments|campaigns)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/;

export async function campaignRoute(
  req: Request,
  path: string,
  tx: Tx,
): Promise<Response | null> {
  const match = path.match(campaignPath);
  if (!match) return null;
  const org = uuid.parse(match[1]),
    kind = match[2],
    id = match[3] ? uuid.parse(match[3]) : null,
    sub = match[4],
    subId = match[5] ? uuid.parse(match[5]) : null;
  if (req.method === "GET") await campaignRead(tx, org);
  else await campaignWrite(tx, org);

  if (kind === "assessment-series") {
    if (sub && sub !== "archive") throw new AppError("NOT_FOUND", 404);
    if (req.method === "GET")
      return response(
        id
          ? await getSeries(tx, org, id)
          : await listSeries(tx, org, new URL(req.url)),
      );
    if (
      (req.method === "POST" && !id) ||
      (req.method === "PATCH" && id && !sub) ||
      (req.method === "POST" && id && sub === "archive")
    ) {
      const { idem, revision } = preconditions(req, !!id);
      const body = await jsonInput(
        req,
        (sub === "archive" ? archiveInput : seriesInput) as z.ZodType<unknown>,
      );
      const data = await saveSeries(
        tx,
        org,
        id,
        revision,
        body,
        idem,
        sub === "archive",
      );
      const res = response(data, id ? 200 : 201);
      res.headers.set("ETag", `"${data.revision}"`);
      return res;
    }
    throw new AppError("NOT_FOUND", 404);
  }

  if (kind === "assessments") {
    if (sub) throw new AppError("NOT_FOUND", 404);
    if (req.method === "GET")
      return response(
        id
          ? await getRound(tx, org, id)
          : await listRounds(tx, org, new URL(req.url)),
      );
    if ((req.method === "POST" && !id) || (req.method === "PATCH" && id)) {
      const { idem, revision } = preconditions(req, !!id);
      const body = await jsonInput(req, roundInput);
      const data = await saveRound(tx, org, id, revision, body, idem);
      const res = response(data, id ? 200 : 201);
      res.headers.set("ETag", `"${data.revision}"`);
      return res;
    }
    throw new AppError("NOT_FOUND", 404);
  }

  // campaigns
  if (req.method === "GET") {
    if (!id) throw new AppError("NOT_FOUND", 404);
    if (!sub) return response(await campaignDetail(tx, org, id));
    if (sub === "launch-review") return response(await launchReview(tx, org, id));
    if (sub === "participation") return response(await participation(tx, org, id));
    if (sub === "link-exports" && subId) {
      await linkExportKey(tx, org, subId);
      const bytes = await getExport(org, subId);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="links-${subId}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    throw new AppError("NOT_FOUND", 404);
  }
  if (req.method === "POST" && !id) {
    const { idem } = preconditions(req, false);
    const body = await jsonInput(req, campaignInput);
    const data = await saveCampaign(tx, org, null, null, body, idem);
    const res = response(data, 201);
    res.headers.set("ETag", `"${data.revision}"`);
    return res;
  }
  if (!id) throw new AppError("NOT_FOUND", 404);
  // A link export changes invitations, not the campaign row, so it carries an
  // idempotency key without an expected campaign revision.
  const { idem, revision } = preconditions(req, sub !== "link-exports");
  if (req.method === "PATCH" && !sub) {
    const body = await jsonInput(req, campaignInput);
    const data = await saveCampaign(tx, org, id, revision, body, idem);
    const res = response(data);
    res.headers.set("ETag", `"${data.revision}"`);
    return res;
  }
  if (req.method === "PUT" && sub === "end-date") {
    const body = await jsonInput(req, endDateInput);
    const data = await campaignTransition(tx, org, id, revision, "END_DATE", body, idem);
    const res = response(data);
    res.headers.set("ETag", `"${data.revision}"`);
    return res;
  }
  if (req.method === "POST" && sub === "launch") {
    await jsonInput(req, z.object({}).strict());
    const data = await launchCampaign(tx, org, id, revision, idem);
    const res = response(data);
    res.headers.set("ETag", `"${data.revision}"`);
    return res;
  }
  if (
    req.method === "POST" &&
    (sub === "close" || sub === "cancel" || sub === "archive")
  ) {
    const body =
      sub === "archive"
        ? ((await jsonInput(req, z.object({}).strict())) as { reason?: string })
        : await jsonInput(req, reasonInput);
    const data = await campaignTransition(
      tx,
      org,
      id,
      revision,
      sub === "close" ? "CLOSE" : sub === "cancel" ? "CANCEL" : "ARCHIVE",
      body,
      idem,
    );
    const res = response(data);
    res.headers.set("ETag", `"${data.revision}"`);
    return res;
  }
  if (req.method === "POST" && sub === "invitations" && subId) {
    throw new AppError("NOT_FOUND", 404);
  }
  if (req.method === "POST" && sub === "link-exports") {
    const body = await jsonInput(req, linkExportInput);
    return response(await createLinkExport(tx, org, id, body, idem), 202);
  }
  throw new AppError("NOT_FOUND", 404);
}

// Invitation actions carry an extra path segment, so they use their own matcher.
const invitationPath =
  /^organizations\/([^/]+)\/campaigns\/([^/]+)\/invitations\/([^/]+)\/(issue|rotate|revoke)$/;
export async function invitationRoute(
  req: Request,
  path: string,
  tx: Tx,
): Promise<Response | null> {
  const match = path.match(invitationPath);
  if (!match) return null;
  if (req.method !== "POST") throw new AppError("NOT_FOUND", 404);
  const org = uuid.parse(match[1]),
    campaignId = uuid.parse(match[2]),
    invitationId = uuid.parse(match[3]),
    action = match[4];
  await campaignWrite(tx, org);
  const { idem } = preconditions(req, false);
  const body = await jsonInput(
    req,
    action === "issue"
      ? issueInput
      : action === "rotate"
        ? rotateInput
        : revokeInput,
  );
  return response(
    await invitationAction(
      tx,
      org,
      campaignId,
      invitationId,
      action === "issue" ? "ISSUE" : action === "rotate" ? "ROTATE" : "REVOKE",
      body,
      idem,
    ),
  );
}
