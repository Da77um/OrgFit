import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { type Tx, requireAccess } from "./db";
import { AppError, digest, jsonInput, uuid } from "./security";
import { preconditions } from "./directory";
import { response } from "./http";
import { seriesHistory, comparisonView } from "./history";
import { resolveCampaign } from "./results";
import { getReport } from "./report-storage";
import { ATTACHMENT_CSP } from "./csp";
import {
  putParticipationExport,
  getParticipationExport,
  PARTICIPATION_EXPORT_TTL_HOURS,
} from "./participation-storage";

// ---------------------------------------------------------------------------
// The staff report surface.
//
// Requesting a report is asynchronous by design: the staff request assembles
// and FREEZES the render input, and a separate process under a separate
// credential draws it. Nothing here renders, and nothing here reads bytes it
// did not just authorize.
//
// The history and comparison halves of the input are produced by exactly the
// same functions the history screen uses, so a report cannot show a trend the
// screen would not. The database then re-checks the whole frozen document
// before storing it (publication.check_report_input), so a defect in this file
// cannot put a withheld number into a report.
//
// Named participation exports live here too, and deliberately apart: their own
// path, their own capability, their own key, their own storage prefix. They are
// never attached to, merged into or derivable from an assessment report.
// ---------------------------------------------------------------------------

export const reportRequestInput = z
  .object({
    roundId: uuid,
    format: z.enum(["PDF", "XLSX"]),
    locale: z.enum(["ar", "en"]),
    comparisonId: uuid.nullable().default(null),
  })
  .strict();

const CONTENT_TYPE = {
  PDF: "application/pdf",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;
const EXTENSION = { PDF: "pdf", XLSX: "xlsx" } as const;

async function reportContext(
  tx: Tx,
  org: string,
  roundId: string,
  comparisonId: string | null,
) {
  const { rows } = await sql<{
    series_id: string;
  }>`select series_id from core.assessment_round where organization_id=${org}::uuid and id=${roundId}::uuid`.execute(
    tx,
  );
  if (!rows.length) throw new AppError("NOT_FOUND", 404);
  const history = await seriesHistory(tx, rows[0].series_id);
  return {
    history: { seriesId: history.seriesId, trends: history.trends },
    comparison: comparisonId ? await comparisonView(tx, comparisonId) : null,
  };
}

export async function requestReport(
  tx: Tx,
  org: string,
  body: z.infer<typeof reportRequestInput>,
  idem: string,
) {
  const context = await reportContext(tx, org, body.roundId, body.comparisonId);
  const payload = { ...body, context };
  const { rows } = await sql<{ data: { id: string; replayed: boolean } }>`
    select core.request_report(${org}::uuid,${JSON.stringify(payload)}::jsonb,
      ${idem}::uuid,${digest(JSON.stringify({ org, body }))}) as data`.execute(tx);
  return rows[0].data;
}

export async function listReports(tx: Tx, org: string, roundId: string | null) {
  const { rows } = await sql<{ data: unknown }>`
    select core.report_jobs(${org}::uuid,${roundId}::uuid) as data`.execute(tx);
  return rows[0].data;
}

// Named participation list. Identity and completion status only: the routine
// that produces the rows cannot return a response identifier or a score,
// because it does not read a table that has one.
export function participationCsv(
  rows: {
    displayReference: string;
    displayName: string;
    privateReference: string;
    department: string;
    departmentCode: string;
    status: string;
    issued: boolean;
  }[],
) {
  // Quoted, with leading formula characters neutralized, exactly as the manual
  // link export does: a spreadsheet must not execute exported content.
  const cell = (v: string) =>
    `"${(/^[=+\-@\t\r]/.test(v) ? "'" + v : v).replaceAll('"', '""')}"`;
  return (
    "﻿" +
    ["displayReference,privateReference,displayName,departmentCode,department,status,issued"]
      .concat(
        rows.map((r) =>
          [
            r.displayReference,
            r.privateReference,
            r.displayName,
            r.departmentCode,
            r.department,
            r.status,
            r.issued ? "true" : "false",
          ]
            .map(cell)
            .join(","),
        ),
      )
      .join("\r\n") +
    "\r\n"
  );
}

export async function createParticipationExport(
  tx: Tx,
  org: string,
  campaignId: string,
) {
  const { rows } = await sql<{ data: Parameters<typeof participationCsv>[0] }>`
    select core.participation_export_rows(${org}::uuid,${campaignId}::uuid) as data`.execute(
    tx,
  );
  const exportId = randomUUID();
  const storageKey = await putParticipationExport(
    org,
    exportId,
    Buffer.from(participationCsv(rows[0].data), "utf8"),
  );
  await sql`select core.record_participation_export(${org}::uuid,${campaignId}::uuid,
    ${exportId}::uuid,${randomUUID()}::uuid,${storageKey},${rows[0].data.length},
    ${`${PARTICIPATION_EXPORT_TTL_HOURS} hours`}::interval)`.execute(tx);
  return {
    exportId,
    itemCount: rows[0].data.length,
    expiresInHours: PARTICIPATION_EXPORT_TTL_HOURS,
  };
}

const reportPath = /^organizations\/([\w-]+)\/reports(?:\/([\w-]+))?(?:\/([\w-]+))?$/;
const participationExportPath =
  /^organizations\/([\w-]+)\/participation-exports(?:\/([\w-]+))?(?:\/([\w-]+))?$/;

export async function reportRoute(
  req: Request,
  path: string,
  tx: Tx,
): Promise<Response | null> {
  const report = path.match(reportPath),
    participation = path.match(participationExportPath);
  if (!report && !participation) return null;
  const org = uuid.parse((report ?? participation)![1]);
  const url = new URL(req.url);

  if (participation) {
    const id = participation[2] ? uuid.parse(participation[2]) : null;
    if (req.method === "GET" && id && participation[3] === "download") {
      // Re-authorized here, against the caller's access now: a staff member who
      // lost participation.export after requesting the file cannot fetch it.
      await sql`select core.participation_export_download(${org}::uuid,${id}::uuid)`.execute(
        tx,
      );
      const bytes = await getParticipationExport(org, id);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="participation-${id}.csv"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (req.method === "POST" && !id) {
      // Deliberately not idempotency-keyed to a stored receipt: each request
      // mints a new short-lived file, and a replay must not resurrect an
      // expired one. The capability check is inside the routine.
      preconditions(req, false);
      const body = await jsonInput(
        req,
        z.object({ campaignId: uuid }).strict(),
      );
      return response(
        await createParticipationExport(tx, org, body.campaignId),
        201,
      );
    }
    throw new AppError("NOT_FOUND", 404);
  }

  const id = report![2] ? uuid.parse(report![2]) : null;
  const action = report![3];
  if (req.method === "GET" && id && (action === "download" || action === "view")) {
    // `view` is the same authorized download, served inline so the browser's
    // PDF viewer opens it for printing. The routine stays the authority for
    // both, and runs before the format is even known.
    const { rows } = await sql<{
      data: { storageKey: string; format: "PDF" | "XLSX"; locale: string; roundId: string };
    }>`select core.report_download(${org}::uuid,${id}::uuid) as data`.execute(tx);
    const artifact = rows[0].data;
    const inline = action === "view" && artifact.format === "PDF";
    // A workbook is never rendered inline: a view of one is a 404, not a
    // silent download.
    if (action === "view" && !inline) throw new AppError("NOT_FOUND", 404);
    const bytes = await getReport(org, id);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPE[artifact.format],
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="orgfit-report-${artifact.locale}-${id}.${EXTENSION[artifact.format]}"`,
        // Inline bytes are rendered by the browser, so they carry the file
        // policy; the proxy re-asserts it for this route.
        ...(inline ? { "Content-Security-Policy": ATTACHMENT_CSP } : {}),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (req.method === "GET" && !id) {
    await requireAccess(tx, org, "reports.manage");
    const roundId = url.searchParams.get("roundId");
    for (const [key] of url.searchParams)
      if (!["roundId", "locale"].includes(key))
        throw new AppError("UNSUPPORTED_FILTER", 400);
    return response({
      items: await listReports(tx, org, roundId ? uuid.parse(roundId) : null),
      nextCursor: null,
    });
  }
  if (req.method === "POST" && !id) {
    const { idem } = preconditions(req, false);
    const body = await jsonInput(req, reportRequestInput);
    // Fail early and identically to the routine for an unrelated round, so the
    // history projection below is never built for a campaign the caller may not
    // read. The routine checks again, and it is the authority.
    await requireAccess(tx, org, "results.read");
    await resolveCampaign(tx, org, body.roundId);
    return response(await requestReport(tx, org, body, idem), 202);
  }
  throw new AppError("NOT_FOUND", 404);
}
