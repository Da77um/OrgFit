import { randomUUID, createHash } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { type Tx } from "./db";
import { AppError, binaryInput, digest, jsonInput, uuid } from "./security";
import { preconditions } from "./directory";
import { response } from "./http";
import { ATTACHMENT_CSP } from "./csp";
import {
  putAttachment,
  getAttachment,
  deleteAttachment,
  objectKey,
} from "./attachment-storage";
import { allowedTypes, ATTACHMENT_MAX_BYTES } from "./attachment-types";

// ---------------------------------------------------------------------------
// The staff field-visit surface.
//
// Visits are confidential CONSULTING material. Three things about this file are
// deliberate and worth stating rather than inferring:
//
//   1. Nothing here reads a response, a draft, an invitation, a participant or
//      an anonymous row, and there is no parameter by which a caller could ask
//      for one. A visit's only assessment relationship is a round identifier,
//      which the database re-checks against the same organization.
//   2. Every routine below re-checks visits.manage inside the database. Holding
//      results.read, campaigns.manage or reports.manage reaches nothing here,
//      and a panel's visibility is never the permission.
//   3. Attachment bytes are quarantined on arrival. This file stores and serves
//      them; it never decides that one is safe. That verdict belongs to a
//      separate credential (src/attachment-worker.ts), and until it lands the
//      download route refuses.
//
// The upload is two calls rather than three. `POST .../attachments` mints a row
// and a GENERATED object name; `PUT .../attachments/:id/content` streams the
// bytes. The content call authorizes and moves the row to QUARANTINED FIRST and
// writes the object second, inside one transaction, so bytes are never written
// for a row the caller may not touch, and a failed write leaves an UPLOADING row
// that retention sweeps rather than a downloadable file.
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().trim().max(max);
const instant = z.iso.datetime({ offset: true });

// A stored object is addressed by a generated name, so the uploaded name is
// display text only. It still may not contain a path separator, a quote or a
// control character: those are what turn a display string into a path or a
// forged header.
const safeFilename = (v: string) =>
  !/[\\/"]/.test(v) &&
  ![...v].some((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  }) &&
  v !== "." &&
  v !== "..";

export const visitInput = z
  .object({
    relatedRoundId: uuid.nullable().default(null),
    assignedConsultantId: uuid,
    scheduledStart: instant,
    scheduledEnd: instant.nullable().default(null),
    timezone: z
      .string()
      .max(100)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
    purpose: text(500).min(1),
    notes: text(5000).nullable().default(null),
    findings: text(5000).nullable().default(null),
    recommendations: text(5000).nullable().default(null),
    followUpDate: z.iso.date().nullable().default(null),
    // Required only when amending a COMPLETED visit; the database is the
    // authority on when that is, and refuses the save without it.
    amendmentReason: text(500).nullable().default(null),
  })
  .strict()
  .refine(
    (v) =>
      !v.scheduledEnd ||
      Date.parse(v.scheduledEnd) > Date.parse(v.scheduledStart),
    "END_BEFORE_START",
  );

export const transitionInput = z
  .object({
    target: z.enum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
    reason: text(500).nullable().default(null),
  })
  .strict()
  .refine(
    (v) => v.target !== "CANCELLED" || !!v.reason,
    "CANCELLATION_REASON_REQUIRED",
  );

export const followUpInput = z
  .object({
    title: text(300).min(1),
    ownerStaffId: uuid,
    dueDate: z.iso.date(),
    status: z.enum(["OPEN", "DONE", "CANCELLED"]).default("OPEN"),
    notes: text(4000).nullable().default(null),
    closureReason: text(500).nullable().default(null),
  })
  .strict()
  .refine(
    (v) => v.status !== "CANCELLED" || !!v.closureReason,
    "CLOSURE_REASON_REQUIRED",
  );

export const attachmentInput = z
  .object({
    filename: z.string().trim().min(1).max(255).refine(safeFilename),
    // Evidence, not authority: the scanner decides what the bytes are, and a
    // disagreement is a rejection rather than a relabelling.
    declaredType: z.enum(allowedTypes as [string, ...string[]]),
  })
  .strict();

export async function listVisits(tx: Tx, org: string, filters: unknown) {
  const { rows } = await sql<{ data: unknown }>`
    select core.visits(${org}::uuid,${JSON.stringify(filters)}::jsonb) as data`.execute(
    tx,
  );
  return rows[0].data;
}
export async function visitDetail(tx: Tx, org: string, id: string) {
  const { rows } = await sql<{ data: unknown }>`
    select core.visit_detail(${org}::uuid,${id}::uuid) as data`.execute(tx);
  return rows[0].data;
}
export async function saveVisit(
  tx: Tx,
  org: string,
  id: string | null,
  revision: string | null,
  body: z.infer<typeof visitInput>,
  idem: string,
) {
  const { rows } = await sql<{ data: unknown }>`
    select core.save_visit(${org}::uuid,${id}::uuid,${revision}::bigint,
      ${JSON.stringify(body)}::jsonb,${idem}::uuid,
      ${digest(JSON.stringify({ org, id, revision, body }))}) as data`.execute(
    tx,
  );
  return rows[0].data;
}
export async function transitionVisit(
  tx: Tx,
  org: string,
  id: string,
  revision: string | null,
  body: z.infer<typeof transitionInput>,
  idem: string,
) {
  const { rows } = await sql<{ data: unknown }>`
    select core.visit_transition(${org}::uuid,${id}::uuid,${revision}::bigint,
      ${body.target},${body.reason},${idem}::uuid,
      ${digest(JSON.stringify({ org, id, revision, body }))}) as data`.execute(
    tx,
  );
  return rows[0].data;
}
export async function saveFollowUp(
  tx: Tx,
  org: string,
  visit: string,
  id: string | null,
  revision: string | null,
  body: z.infer<typeof followUpInput>,
  idem: string,
) {
  const { rows } = await sql<{ data: unknown }>`
    select core.save_follow_up(${org}::uuid,${visit}::uuid,${id}::uuid,${revision}::bigint,
      ${JSON.stringify(body)}::jsonb,${idem}::uuid,
      ${digest(JSON.stringify({ org, visit, id, revision, body }))}) as data`.execute(
    tx,
  );
  return rows[0].data;
}
export async function listFollowUps(tx: Tx, org: string, filters: unknown) {
  const { rows } = await sql<{ data: unknown }>`
    select core.visit_follow_ups(${org}::uuid,${JSON.stringify(filters)}::jsonb) as data`.execute(
    tx,
  );
  return rows[0].data;
}

// Inline preview is offered for the formats a browser can render safely under a
// locked-down policy, and for nothing else. A document is a download.
const PREVIEWABLE = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/;
// The response that carries an attachment. Never sniffed, never framed, never
// cached, and under its own policy that permits no script, no network and no
// subresource of any kind — so even a file that reached CLEAN in error cannot
// act as a page.
function fileHeaders(
  contentType: string,
  filename: string,
  inline: boolean,
): Record<string, string> {
  return {
    "Content-Type": inline ? contentType : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    // The proxy re-asserts this same policy for these routes, so a file is
    // never served under the application policy even if this header is lost.
    "Content-Security-Policy": ATTACHMENT_CSP,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };
}

const visitPath =
  /^organizations\/([\w-]+)\/visits(?:\/([\w-]+))?(?:\/(transition|follow-ups|attachments))?(?:\/([\w-]+))?(?:\/(content|download|preview))?$/;
const followUpListPath = /^organizations\/([\w-]+)\/follow-ups$/;
const consultantPath = /^organizations\/([\w-]+)\/visit-consultants$/;

export async function visitRoute(
  req: Request,
  path: string,
  tx: Tx,
): Promise<Response | null> {
  const consultants = path.match(consultantPath);
  if (consultants) {
    if (req.method !== "GET") throw new AppError("NOT_FOUND", 404);
    const org = uuid.parse(consultants[1]);
    const { rows } = await sql<{ data: unknown }>`
      select core.visit_consultants(${org}::uuid) as data`.execute(tx);
    return response({ items: rows[0].data, nextCursor: null });
  }

  const followUps = path.match(followUpListPath);
  if (followUps) {
    if (req.method !== "GET") throw new AppError("NOT_FOUND", 404);
    const org = uuid.parse(followUps[1]);
    const url = new URL(req.url);
    for (const [key] of url.searchParams)
      if (!["status", "dueBefore", "ownerStaffId", "limit"].includes(key))
        throw new AppError("UNSUPPORTED_FILTER", 400);
    const query = z
      .object({
        status: z.enum(["OPEN", "DONE", "CANCELLED"]).optional(),
        dueBefore: z.iso.date().optional(),
        ownerStaffId: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .strict()
      .parse(Object.fromEntries(url.searchParams));
    return response({
      items: await listFollowUps(tx, org, query),
      nextCursor: null,
    });
  }

  const match = path.match(visitPath);
  if (!match) return null;
  const org = uuid.parse(match[1]);
  const visit = match[2] ? uuid.parse(match[2]) : null;
  const section = match[3] ?? null;
  const child = match[4] ? uuid.parse(match[4]) : null;
  const action = match[5] ?? null;

  // ---- Visit list and creation ----
  if (!visit) {
    if (req.method === "GET") {
      const url = new URL(req.url);
      for (const [key] of url.searchParams)
        if (!["from", "to", "consultantId", "state", "limit"].includes(key))
          throw new AppError("UNSUPPORTED_FILTER", 400);
      const query = z
        .object({
          from: instant.optional(),
          to: instant.optional(),
          consultantId: uuid.optional(),
          state: z
            .enum([
              "DRAFT",
              "SCHEDULED",
              "IN_PROGRESS",
              "COMPLETED",
              "CANCELLED",
            ])
            .optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        })
        .strict()
        .parse(Object.fromEntries(url.searchParams));
      return response({
        items: await listVisits(tx, org, query),
        nextCursor: null,
      });
    }
    if (req.method === "POST") {
      const { idem } = preconditions(req, false);
      const body = await jsonInput(req, visitInput);
      return response(await saveVisit(tx, org, null, null, body, idem), 201);
    }
    throw new AppError("NOT_FOUND", 404);
  }

  // ---- One visit ----
  if (!section) {
    if (req.method === "GET")
      return response(await visitDetail(tx, org, visit));
    if (req.method === "PATCH") {
      const { idem, revision } = preconditions(req, true);
      const body = await jsonInput(req, visitInput);
      return response(await saveVisit(tx, org, visit, revision, body, idem));
    }
    throw new AppError("NOT_FOUND", 404);
  }

  if (section === "transition") {
    if (req.method !== "POST" || child) throw new AppError("NOT_FOUND", 404);
    const { idem, revision } = preconditions(req, true);
    const body = await jsonInput(req, transitionInput);
    return response(
      await transitionVisit(tx, org, visit, revision, body, idem),
    );
  }

  if (section === "follow-ups") {
    if (req.method === "POST" && !child) {
      const { idem } = preconditions(req, false);
      const body = await jsonInput(req, followUpInput);
      return response(
        await saveFollowUp(tx, org, visit, null, null, body, idem),
        201,
      );
    }
    if (req.method === "PATCH" && child) {
      const { idem, revision } = preconditions(req, true);
      const body = await jsonInput(req, followUpInput);
      return response(
        await saveFollowUp(tx, org, visit, child, revision, body, idem),
      );
    }
    throw new AppError("NOT_FOUND", 404);
  }

  // ---- Attachments ----
  if (req.method === "POST" && !child) {
    const { idem } = preconditions(req, false);
    const body = await jsonInput(req, attachmentInput);
    const id = randomUUID();
    const { rows } = await sql<{ data: { id: string; replayed: boolean } }>`
      select core.begin_attachment(${org}::uuid,${visit}::uuid,${id}::uuid,${objectKey(org, id)},
        ${JSON.stringify(body)}::jsonb,${idem}::uuid,
        ${digest(JSON.stringify({ org, visit, body }))}) as data`.execute(tx);
    return response(
      {
        ...rows[0].data,
        contentPath: `/api/v1/organizations/${org}/visits/${visit}/attachments/${rows[0].data.id}/content`,
        maxBytes: ATTACHMENT_MAX_BYTES,
      },
      201,
    );
  }
  if (req.method === "PUT" && child && action === "content") {
    const bytes = await binaryInput(req, ATTACHMENT_MAX_BYTES);
    // Authorize and move the row to QUARANTINED BEFORE the object is written.
    // A caller who may not touch this attachment never causes a byte to be
    // stored, and a storage failure rolls the row back to UPLOADING rather than
    // leaving a quarantined row with nothing behind it.
    const { rows } = await sql<{ data: unknown }>`
      select core.complete_attachment(${org}::uuid,${child}::uuid,${bytes.length},
        ${createHash("sha256").update(bytes).digest()}) as data`.execute(tx);
    await putAttachment(org, child, bytes);
    return response(rows[0].data, 202);
  }
  if (
    req.method === "GET" &&
    child &&
    (action === "download" || action === "preview")
  ) {
    const { rows } = await sql<{
      data: {
        storageKey: string;
        originalName: string;
        contentType: string;
        size: number;
      };
    }>`select core.attachment_download(${org}::uuid,${child}::uuid) as data`.execute(
      tx,
    );
    const file = rows[0].data;
    const inline = action === "preview" && PREVIEWABLE.test(file.contentType);
    // A preview of something that cannot be previewed is a 404, not a silent
    // download: the caller asked for a rendering that does not exist.
    if (action === "preview" && !inline) throw new AppError("NOT_FOUND", 404);
    const bytes = await getAttachment(org, child);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: fileHeaders(file.contentType, file.originalName, inline),
    });
  }
  if (req.method === "DELETE" && child && !action) {
    const { rows } = await sql<{ data: { id: string } }>`
      select core.delete_attachment(${org}::uuid,${child}::uuid) as data`.execute(
      tx,
    );
    // The row is already EXPIRED and unreachable; the bytes go next. A failure
    // here leaves an orphan that retention sweeps, never a live download.
    await deleteAttachment(org, child).catch(() => {});
    return response(rows[0].data);
  }
  throw new AppError("NOT_FOUND", 404);
}
