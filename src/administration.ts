import { NextResponse } from "next/server";
import { sql, type RawBuilder } from "kysely";
import { z } from "zod";
import { readConfig } from "./config";
import type { Profile, Tx } from "./db";
import { response } from "./http";
import {
  cursorKinds,
  decodeCursor,
  encodeCursor,
  pageSize,
  readQuery,
} from "./pagination";
import {
  AppError,
  accessInput,
  createStaffInput,
  digest,
  invitationInput,
  jsonInput,
  secret,
  uuid,
} from "./security";

// ---------------------------------------------------------------------------
// Staff administration, audit history, global settings and the caller's own
// sessions.
//
// Authorization is layered and every layer refuses on its own: the page checks
// the role before it renders, this module checks it before it touches the
// database, and each routine checks access.is_admin() or access.actor() again
// inside the transaction. Hiding a control is presentation, not a boundary.
//
// Every list is a keyset page (src/pagination.ts). None of these routes calls
// the 100-row routines from migrations 001 and 016 any more.
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = [
  "STAFF_CREATED",
  "ACCESS_CHANGED",
  "SESSIONS_REVOKED",
  "PROFILE_UPDATED",
  "LOGOUT",
  "BOOTSTRAP",
  "DIRECTORY_CHANGED",
  "IMPORT_CHANGED",
  "IMPORT_ERRORS_DOWNLOADED",
  "INSTRUMENT_CHANGED",
  "SERIES_CHANGED",
  "ROUND_CHANGED",
  "CAMPAIGN_CHANGED",
  "CAMPAIGN_LAUNCHED",
  "CAMPAIGN_END_DATE_CHANGED",
  "INVITATION_ISSUED",
  "INVITATION_ROTATED",
  "INVITATION_REVOKED",
  "LINK_EXPORT_CREATED",
  "LINK_EXPORT_DOWNLOADED",
  "RECOMMENDATION_ACTION_CHANGED",
  "COMPARISON_REVIEWED",
  "REPORT_REQUESTED",
  "REPORT_DOWNLOADED",
  "PARTICIPATION_EXPORT_CREATED",
  "PARTICIPATION_EXPORT_DOWNLOADED",
  "VISIT_CHANGED",
  "VISIT_TRANSITIONED",
  "VISIT_AMENDED",
  "FOLLOW_UP_CHANGED",
  "ATTACHMENT_UPLOADED",
  "ATTACHMENT_SCANNED",
  "ATTACHMENT_DOWNLOADED",
  "ATTACHMENT_DELETED",
  "INVITATION_CREATED",
  "INVITATION_ACCEPTED",
  "PASSWORD_SET",
  "SETTINGS_CHANGED",
  "AUDIT_EXPORTED",
  "RELEASE_REVOKED",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const EXPORT_MAX_ROWS = 5000;

const datetime = z.iso.datetime({ offset: true });
const auditFilterShape = {
  action: z.enum(AUDIT_ACTIONS).optional(),
  actorId: uuid.optional(),
  targetId: uuid.optional(),
  organizationId: uuid.optional(),
  from: datetime.optional(),
  to: datetime.optional(),
};
export const auditFilters = z.object(auditFilterShape).strict();
export type AuditFilters = z.infer<typeof auditFilters>;

export const settingsInput = z
  .object({
    defaultTimezone: z.string().trim().min(1).max(100),
    defaultCampaignThreshold: z.int().min(5).max(1000),
    staffInvitationHours: z.int().min(1).max(168),
  })
  .strict();

const empty = z.object({}).strict();

function requireAdmin(profile: Profile) {
  if (profile.role !== "SUPER_ADMIN") throw new AppError("FORBIDDEN", 403);
}

async function scalar<T>(
  tx: Tx,
  query: RawBuilder<{ data: T }>,
): Promise<T> {
  return (await query.execute(tx)).rows[0].data;
}

type Page = { items: unknown[]; next: unknown };
const page = (result: Page) =>
  response({ items: result.items, nextCursor: encodeCursor(result.next) });

function idempotencyKey(req: Request) {
  const idem = uuid.safeParse(req.headers.get("idempotency-key"));
  if (!idem.success) throw new AppError("PRECONDITION_REQUIRED", 400);
  return idem.data;
}

function ifMatch(req: Request) {
  const revision = req.headers.get("if-match")?.match(/^"([1-9][0-9]*)"$/)?.[1];
  if (!revision) throw new AppError("PRECONDITION_REQUIRED", 400);
  return revision;
}

/** Values that a spreadsheet would execute are written as text. */
export function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export type AuditRow = {
  id: string;
  action: string;
  fieldNames: string[];
  occurredAt: string;
  actorId: string;
  actorName: string | null;
  actorEmail: string | null;
  organizationId: string | null;
  organizationCode: string | null;
  organizationNameAr: string | null;
  organizationNameEn: string | null;
  targetId: string | null;
  targetWithheld: boolean;
  targetStaffName: string | null;
};

// The export carries exactly the columns the audit browser shows: when, what,
// which field names (never values), who, which organization and the target
// identifier where one may be shown. The audit trail stores no credential,
// answer, draft or response identifier, so none can appear here.
export function auditCsv(rows: AuditRow[]) {
  const header = [
    "occurred_at_utc",
    "action",
    "field_names",
    "actor_email",
    "actor_name",
    "organization_code",
    "target_id",
    "event_id",
  ];
  const lines = [header.join(",")];
  for (const r of rows)
    lines.push(
      [
        r.occurredAt,
        r.action,
        r.fieldNames.join(" "),
        r.actorEmail,
        r.actorName,
        r.organizationCode,
        r.targetWithheld ? "withheld" : r.targetId,
        r.id,
      ]
        .map(csvCell)
        .join(","),
    );
  // A byte-order mark so a spreadsheet opens Arabic names as UTF-8.
  return String.fromCharCode(0xfeff) + lines.join("\r\n") + "\r\n";
}

export async function administrationRoute(
  req: Request,
  path: string,
  tx: Tx,
  profile: Profile,
): Promise<Response | null> {
  const url = new URL(req.url);
  const method = req.method;
  const segments = path.split("/");

  // --- the caller's own sessions ------------------------------------------
  if (segments[0] === "profile" && segments[1] === "sessions") {
    if (method === "GET" && segments.length === 2) {
      readQuery(url, {});
      return response({
        items: await scalar(tx, sql`select access.my_sessions() as data`),
      });
    }
    if (method === "POST" && path === "profile/sessions/revoke-others") {
      await jsonInput(req, empty);
      const revoked = await scalar<number>(
        tx,
        sql`select access.revoke_my_other_sessions() as data`,
      );
      return response({ revoked });
    }
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[3] === "revoke"
    ) {
      const target = uuid.safeParse(segments[2]);
      if (!target.success) throw new AppError("NOT_FOUND", 404);
      await jsonInput(req, empty);
      await sql`select access.revoke_my_session(${target.data}::uuid)`.execute(tx);
      return new NextResponse(null, { status: 204 });
    }
    return null;
  }

  // --- global settings -----------------------------------------------------
  if (segments[0] === "settings") {
    if (method === "GET" && path === "settings") {
      readQuery(url, {});
      return response(await scalar(tx, sql`select access.settings() as data`));
    }
    if (method === "GET" && path === "settings/status") {
      requireAdmin(profile);
      readQuery(url, {});
      const config = readConfig();
      const status = await scalar<{ localAccessEnabled: boolean }>(
        tx,
        sql`select access.system_status() as data`,
      );
      return response({
        settings: await scalar(tx, sql`select access.settings() as data`),
        history: await scalar(tx, sql`select access.settings_history() as data`),
        status,
        authentication: {
          // An issuer is a public identifier, shown as its origin only.
          identityProvider: new URL(config.OIDC_ISSUER).origin,
          passwordPathEnabled: status.localAccessEnabled,
          production: process.env.NODE_ENV === "production",
        },
      });
    }
    if (method === "PATCH" && path === "settings") {
      requireAdmin(profile);
      const revision = ifMatch(req);
      const idem = idempotencyKey(req);
      const body = await jsonInput(req, settingsInput);
      const hash = digest(JSON.stringify({ revision, body }));
      return response(
        await scalar(
          tx,
          sql`select access.save_settings(${revision}::bigint,${JSON.stringify(body)}::jsonb,${idem}::uuid,${hash}) as data`,
        ),
      );
    }
    return null;
  }

  // --- audit history -------------------------------------------------------
  if (segments[0] === "audit") {
    if (method === "GET" && path === "audit") {
      requireAdmin(profile);
      const q = readQuery(url, {
        ...auditFilterShape,
        limit: pageSize,
        cursor: z.string().max(1000).optional(),
      });
      const { limit, cursor, ...filters } = q;
      const after = decodeCursor(cursor ?? null, cursorKinds.time);
      return page(
        await scalar<Page>(
          tx,
          sql`select access.audit_page(${JSON.stringify(filters)}::jsonb,${after?.[0] ?? null}::timestamptz,${after?.[1] ?? null}::uuid,${limit}) as data`,
        ),
      );
    }
    if (method === "POST" && path === "audit/exports") {
      requireAdmin(profile);
      const body = await jsonInput(
        req,
        z.object({ filters: auditFilters }).strict(),
      );
      const result = await scalar<{
        exportId: string;
        items: AuditRow[];
        truncated: boolean;
      }>(
        tx,
        sql`select access.audit_export(${JSON.stringify(body.filters)}::jsonb,${EXPORT_MAX_ROWS}) as data`,
      );
      // A selection larger than the bound is refused, not silently shortened:
      // the administrator narrows the filters and exports again.
      if (result.truncated) throw new AppError("EXPORT_TOO_LARGE", 422);
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
      return new NextResponse(auditCsv(result.items), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="orgfit-audit-${stamp}Z.csv"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-OrgFit-Export-Rows": String(result.items.length),
        },
      });
    }
    return null;
  }

  if (segments[0] !== "staff") return null;

  // --- staff invitations -----------------------------------------------------
  // The only way a new staff account comes into existence on the local
  // password path. The role, the capabilities and the organizations are the
  // administrator's choice and are frozen onto the invitation row; the person
  // activating it supplies a name and a password and nothing else.
  if (segments[1] === "invitations") {
    requireAdmin(profile);
    if (method === "GET" && segments.length === 2) {
      const q = readQuery(url, {
        q: z.string().trim().max(320).optional(),
        state: z.enum(["PENDING", "EXPIRED", "CONSUMED", "REVOKED"]).optional(),
        limit: pageSize,
        cursor: z.string().max(1000).optional(),
      });
      const after = decodeCursor(q.cursor ?? null, cursorKinds.time);
      const filters = { ...(q.q ? { q: q.q } : {}), ...(q.state ? { state: q.state } : {}) };
      return page(
        await scalar<Page>(
          tx,
          sql`select access.invitation_page(${JSON.stringify(filters)}::jsonb,${after?.[0] ?? null}::timestamptz,${after?.[1] ?? null}::uuid,${q.limit}) as data`,
        ),
      );
    }
    if (method === "POST" && segments.length === 2) {
      const body = await jsonInput(req, invitationInput);
      const idem = idempotencyKey(req);
      // The secret is generated here, stored only as a digest, and returned
      // exactly once — the same shape the respondent invitation uses. It is
      // not sent anywhere: the administrator delivers it out of band.
      const token = secret();
      const id = await scalar<string>(
        tx,
        sql`select access.create_invitation(${digest(token)},${JSON.stringify(body)}::jsonb,${idem}::uuid,${digest(JSON.stringify(body))}) as data`,
      );
      const issued = await scalar<boolean>(
        tx,
        sql`select access.invitation_token_matches(${id}::uuid,${digest(token)}) as data`,
      );
      if (!issued)
        // An idempotent retry of a request that already succeeded. The link
        // was shown to whoever made the first request and its secret was never
        // stored, so there is no link to show: a fresh token here would look
        // usable and open nothing.
        return response({ id, url: null, replayed: true }, 200);
      return response(
        { id, url: `${readConfig().STAFF_ORIGIN}/activate#${token}`, replayed: false },
        201,
      );
    }
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[3] === "revoke"
    ) {
      await jsonInput(req, empty);
      await sql`select access.revoke_invitation(${uuid.parse(segments[2])}::uuid)`.execute(tx);
      return new NextResponse(null, { status: 204 });
    }
    return null;
  }

  // Organization choices for the access editor: every organization, archived
  // ones included, because an existing assignment to one must stay visible.
  if (method === "GET" && path === "staff/organizations") {
    requireAdmin(profile);
    readQuery(url, {});
    const items = await tx
      .selectFrom("core.organization")
      .select(["id", "code", "name_ar", "name_en", "status"])
      .orderBy("code")
      .limit(1000)
      .execute();
    return response({ items, truncated: items.length === 1000 });
  }

  if (method === "GET" && path === "staff") {
    requireAdmin(profile);
    const q = readQuery(url, {
      q: z.string().trim().max(200).optional(),
      role: z.enum(["SUPER_ADMIN", "STAFF"]).optional(),
      status: z.enum(["ACTIVE", "DISABLED"]).optional(),
      limit: pageSize,
      cursor: z.string().max(1000).optional(),
    });
    const after = decodeCursor(q.cursor ?? null, cursorKinds.staff);
    const filters = {
      ...(q.q ? { q: q.q } : {}),
      ...(q.role ? { role: q.role } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    return page(
      await scalar<Page>(
        tx,
        sql`select access.staff_page(${JSON.stringify(filters)}::jsonb,${after?.[0] ?? null},${after?.[1] ?? null}::uuid,${q.limit}) as data`,
      ),
    );
  }

  if (method === "GET" && segments.length === 2) {
    requireAdmin(profile);
    const target = uuid.safeParse(segments[1]);
    if (!target.success) throw new AppError("NOT_FOUND", 404);
    readQuery(url, {});
    return response(
      await scalar(tx, sql`select access.staff_record(${target.data}::uuid) as data`),
    );
  }

  if (
    method === "POST" &&
    segments.length === 3 &&
    segments[2] === "revoke-sessions"
  ) {
    requireAdmin(profile);
    const target = uuid.safeParse(segments[1]);
    if (!target.success) throw new AppError("NOT_FOUND", 404);
    await jsonInput(req, empty);
    await sql`select access.revoke_sessions(${target.data}::uuid)`.execute(tx);
    return new NextResponse(null, { status: 204 });
  }

  if (
    (method === "POST" && path === "staff") ||
    (method === "PATCH" && segments.length === 2)
  ) {
    requireAdmin(profile);
    const target = path === "staff" ? null : uuid.parse(segments[1]);
    const body = target
      ? await jsonInput(req, accessInput)
      : await jsonInput(req, createStaffInput);
    // Registering an identity-provider account binds the issuer this
    // installation actually trusts. Any other issuer, including the reserved
    // local-password one, could never sign in and is refused as invalid.
    if (!target && "issuer" in body && body.issuer !== readConfig().OIDC_ISSUER)
      throw new AppError("VALIDATION_FAILED", 422);
    const idem = idempotencyKey(req);
    const revision = target ? ifMatch(req) : null;
    const hash = digest(JSON.stringify({ target, revision, body }));
    const id = await scalar<string>(
      tx,
      sql`select access.save_staff(${target}::uuid,${revision}::bigint,${JSON.stringify(body)}::jsonb,${idem}::uuid,${hash}) as data`,
    );
    return response({ id }, target ? 200 : 201);
  }
  return null;
}
