import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import {
  beginLogin,
  finishLogin,
  sessionCookie,
  flowCookie,
  cookieOptions,
} from "../../../../../../src/auth";
import { readConfig } from "../../../../../../src/config";
import { withStaff, requireAccess } from "../../../../../../src/db";
import {
  AppError,
  accessInput,
  createStaffInput,
  checkMutation,
  digest,
  jsonInput,
  uuid,
} from "../../../../../../src/security";
import { response, safeError, requestLocale } from "../../../../../../src/http";
import { directoryRoute } from "../../../../../../src/directory";
import { importRoute } from "../../../../../../src/imports";
import { instrumentRoute } from "../../../../../../src/instruments";
import {
  campaignRoute,
  invitationRoute,
} from "../../../../../../src/campaigns";
import { resultsRoute } from "../../../../../../src/results";
import { recommendationActionRoute } from "../../../../../../src/recommendations";
import { historyRoute } from "../../../../../../src/history";
import { reportRoute } from "../../../../../../src/reports";
import { visitRoute } from "../../../../../../src/visits";
type Context = { params: Promise<{ path: string[] }> };
// The one route that carries bytes rather than JSON.
const attachmentContent =
  /^organizations\/[\w-]+\/visits\/[\w-]+\/attachments\/[\w-]+\/content$/;
export const dynamic = "force-dynamic";
async function handle(req: Request, ctx: Context) {
  const locale = requestLocale(req);
  try {
    const path = (await ctx.params).path.join("/"),
      config = readConfig(),
      jar = await cookies();
    if (!["GET", "HEAD"].includes(req.method))
      // One route streams bytes rather than JSON: the visit attachment upload.
      // The same-origin and CSRF checks are unchanged for it.
      checkMutation(
        req,
        config.STAFF_ORIGIN,
        req.method === "PUT" && attachmentContent.test(path),
      );
    if (req.method === "GET" && path === "auth/start") {
      const { url, flow } = await beginLogin();
      const res = NextResponse.redirect(url);
      res.cookies.set(flowCookie(), flow, { ...cookieOptions(), maxAge: 300 });
      return res;
    }
    if (req.method === "GET" && path === "auth/callback") {
      try {
        const token = await finishLogin(
          new URL(
            `${config.STAFF_ORIGIN}/api/v1/auth/callback${new URL(req.url).search}`,
          ),
          jar.get(flowCookie())?.value,
        );
        const profile = await withStaff(token, async (_tx, p) => p);
        const res = NextResponse.redirect(`${config.STAFF_ORIGIN}/`);
        res.cookies.set(sessionCookie(), token, {
          ...cookieOptions(),
          maxAge: 43200,
        });
        res.cookies.set(flowCookie(), "", { ...cookieOptions(), maxAge: 0 });
        res.cookies.set("orgfit-locale", profile.locale, {
          ...cookieOptions(),
          maxAge: 31536000,
        });
        return res;
      } catch {
        const res = safeError(new AppError("SESSION_REQUIRED", 401), locale);
        res.cookies.set(flowCookie(), "", { ...cookieOptions(), maxAge: 0 });
        return res;
      }
    }
    if (req.method === "POST" && path === "locale") {
      const data = await jsonInput(
        req,
        z.object({ locale: z.enum(["ar", "en"]) }).strict(),
      );
      const res = response(data);
      res.cookies.set("orgfit-locale", data.locale, {
        ...cookieOptions(),
        maxAge: 31536000,
      });
      return res;
    }
    return await withStaff(
      jar.get(sessionCookie())?.value,
      async (tx, profile) => {
        if (req.method === "GET" && (path === "profile" || path === "home"))
          return response(profile);
        if (req.method === "PATCH" && path === "profile") {
          const data = await jsonInput(
            req,
            z.object({ locale: z.enum(["ar", "en"]) }).strict(),
          );
          await sql`select access.set_locale(${data.locale})`.execute(tx);
          const res = response(data);
          res.cookies.set("orgfit-locale", data.locale, {
            ...cookieOptions(),
            maxAge: 31536000,
          });
          return res;
        }
        if (req.method === "POST" && path === "auth/logout") {
          await jsonInput(req, z.object({}).strict());
          await sql`select access.logout()`.execute(tx);
          const res = new NextResponse(null, { status: 204 });
          res.cookies.set(sessionCookie(), "", {
            ...cookieOptions(),
            maxAge: 0,
          });
          return res;
        }
        const directoryResponse =
          (await resultsRoute(req, path, tx)) ??
          (await recommendationActionRoute(req, path, tx)) ??
          (await historyRoute(req, path, tx)) ??
          (await reportRoute(req, path, tx)) ??
          (await visitRoute(req, path, tx)) ??
          (await instrumentRoute(req, path, tx)) ??
          (await invitationRoute(req, path, tx)) ??
          (await campaignRoute(req, path, tx)) ??
          (await directoryRoute(req, path, tx, profile)) ??
          (await importRoute(req, path, tx));
        if (directoryResponse) return directoryResponse;
        if (
          req.method === "GET" &&
          /^organizations\/[\w-]+\/access$/.test(path)
        ) {
          const org = uuid.parse(path.split("/")[1]);
          await requireAccess(tx, org, "directory.manage");
          return response({ allowed: true });
        }
        if (req.method === "GET" && path === "staff")
          return response({
            items: (
              await sql<{
                data: unknown;
              }>`select access.list_staff() as data`.execute(tx)
            ).rows[0].data,
            nextCursor: null,
          });
        if (req.method === "GET" && path === "audit")
          return response({
            items: (
              await sql<{
                data: unknown;
              }>`select access.audit() as data`.execute(tx)
            ).rows[0].data,
            nextCursor: null,
          });
        if (
          (req.method === "POST" && path === "staff") ||
          (req.method === "PATCH" && /^staff\/[\w-]+$/.test(path))
        ) {
          if (profile.role !== "SUPER_ADMIN")
            throw new AppError("FORBIDDEN", 403);
          const target =
            path === "staff" ? null : uuid.parse(path.split("/")[1]);
          const body = target
            ? await jsonInput(req, accessInput)
            : await jsonInput(req, createStaffInput);
          const idem = uuid.safeParse(req.headers.get("idempotency-key"));
          if (!idem.success) throw new AppError("PRECONDITION_REQUIRED", 400);
          const revision = req.headers
            .get("if-match")
            ?.match(/^"([1-9][0-9]*)"$/)?.[1];
          if (target && !revision)
            throw new AppError("PRECONDITION_REQUIRED", 400);
          const hash = digest(
            JSON.stringify({ target, revision: revision ?? null, body }),
          );
          const result = await sql<{
            id: string;
          }>`select access.save_staff(${target}::uuid,${revision ?? null}::bigint,${JSON.stringify(body)}::jsonb,${idem.data}::uuid,${hash}) as id`.execute(
            tx,
          );
          return response({ id: result.rows[0].id }, target ? 200 : 201);
        }
        throw new AppError("NOT_FOUND", 404);
      },
    );
  } catch (e) {
    return safeError(
      e instanceof z.ZodError ? new AppError("VALIDATION_FAILED", 422) : e,
      locale,
    );
  }
}
export {
  handle as GET,
  handle as POST,
  handle as PATCH,
  handle as PUT,
  handle as DELETE,
};
