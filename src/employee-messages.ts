import { sql } from "kysely";
import { z } from "zod";
import { type Tx, requireAccess } from "./db";
import { AppError, digest, jsonInput, uuid } from "./security";
import { preconditions } from "./directory";
import { response } from "./http";
import { readConfig } from "./config";
import { digestKeyVersion, invitationToken, tokenDigest } from "./invitation-token";

// ---------------------------------------------------------------------------
// Employee messages, staff half (migration 025).
//
// Reading: any staff member authorized on the organization who holds
// messages.read. Issuing, rotating and revoking the organization's link: a
// Super Admin only. The database enforces both; this module shapes requests.
//
// A message carries a received DAY, a department (or the sender's own short
// "other" text) and the body. There is no sender, no link, no time of day and
// nothing that joins to a participant, an invitation or a campaign, so there is
// nothing here to withhold beyond the rows themselves.
// ---------------------------------------------------------------------------

export type EmployeeMessage = {
  id: string;
  receivedOn: string;
  departmentId: string | null;
  departmentNameAr: string | null;
  departmentNameEn: string | null;
  otherDepartment: string | null;
  body: string;
};
export type MessagePage = { items: EmployeeMessage[]; next: [string, string] | null };
export type MessageLinkStatus = {
  active: boolean;
  issuedAt: string | null;
  issuedByName: string | null;
  organizationActive: boolean;
  canManage: boolean;
};

const PAGE_SIZE = 25;
const day = /^\d{4}-\d{2}-\d{2}$/;

/** The respondent-origin link. The token sits in the fragment, so it never
 *  reaches a server log, a Referer header or a proxy query string. */
export const messageLinkUrl = (token: string) =>
  `${readConfig().RESPONDENT_ORIGIN}/m#${token}`;

export function messageQuery(url: URL) {
  let department: string | undefined, after: string | undefined, afterId: string | undefined;
  for (const [key, value] of url.searchParams) {
    if (key === "locale") continue;
    if (key === "department" && (value === "OTHER" || uuid.safeParse(value).success)) department = value;
    else if (key === "after" && day.test(value)) after = value;
    else if (key === "afterId" && uuid.safeParse(value).success) afterId = value;
    else throw new AppError("UNSUPPORTED_FILTER", 400);
  }
  if (!after !== !afterId) throw new AppError("VALIDATION_FAILED", 422);
  return { filters: department ? { department } : {}, after: after ?? null, afterId: afterId ?? null };
}

const messagesPath = /^organizations\/([\w-]+)\/messages(?:\/(departments|link))?$/;

export async function messageRoute(req: Request, path: string, tx: Tx): Promise<Response | null> {
  const match = path.match(messagesPath);
  if (!match) return null;
  const org = uuid.parse(match[1]);
  await requireAccess(tx, org, "messages.read");
  if (req.method === "GET" && !match[2]) {
    const q = messageQuery(new URL(req.url));
    const { rows } = await sql<{ data: MessagePage }>`
      select core.message_page(${org}::uuid,${JSON.stringify(q.filters)}::jsonb,
        ${q.after}::date,${q.afterId}::uuid,${PAGE_SIZE}) as data`.execute(tx);
    return response(rows[0].data);
  }
  if (req.method === "GET" && match[2] === "departments") {
    const { rows } = await sql<{ data: unknown }>`
      select core.message_departments(${org}::uuid) as data`.execute(tx);
    return response(rows[0].data);
  }
  if (match[2] !== "link") throw new AppError("NOT_FOUND", 404);
  if (req.method === "GET") {
    const { rows } = await sql<{ data: MessageLinkStatus }>`
      select core.message_link_status(${org}::uuid) as data`.execute(tx);
    return response(rows[0].data);
  }
  if (req.method === "POST") {
    const { idem } = preconditions(req, false);
    // An explicit empty JSON body: the organization comes from the path only.
    await jsonInput(req, z.object({}).strict());
    // Shown once. Only the keyed digest is stored; a retry of the same request
    // is answered "replayed" without a link, because the first token is gone.
    const token = invitationToken();
    const { rows } = await sql<{ data: { id: string; replayed: boolean } }>`
      select core.issue_message_link(${org}::uuid,${tokenDigest(token)},${digestKeyVersion()},
        ${idem}::uuid,${digest(JSON.stringify({ op: "issue", org }))}) as data`.execute(tx);
    const result = rows[0].data;
    return response(
      { id: result.id, replayed: result.replayed, url: result.replayed ? null : messageLinkUrl(token) },
      result.replayed ? 200 : 201,
    );
  }
  if (req.method === "DELETE") {
    const { idem } = preconditions(req, false);
    const { rows } = await sql<{ data: { id: string; replayed: boolean } }>`
      select core.revoke_message_link(${org}::uuid,${idem}::uuid,
        ${digest(JSON.stringify({ op: "revoke", org }))}) as data`.execute(tx);
    return response(rows[0].data);
  }
  throw new AppError("NOT_FOUND", 404);
}
