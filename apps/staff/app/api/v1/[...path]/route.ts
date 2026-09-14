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
import {
  activateInvitation,
  authenticate,
  inspectInvitation,
} from "../../../../../../src/local-auth";
import { checkPasswordPolicy } from "../../../../../../src/password";
import { readConfig } from "../../../../../../src/config";
import { withStaff, requireAccess } from "../../../../../../src/db";
import {
  AppError,
  checkMutation,
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
import { revocationRoute } from "../../../../../../src/revocation";
import { recommendationActionRoute } from "../../../../../../src/recommendations";
import { historyRoute } from "../../../../../../src/history";
import { reportRoute } from "../../../../../../src/reports";
import { visitRoute } from "../../../../../../src/visits";
import { administrationRoute } from "../../../../../../src/administration";
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
        // `/` is the public overview page; the workspace lives behind its own
        // protected route and is where an authenticated staff member lands.
        const res = NextResponse.redirect(`${config.STAFF_ORIGIN}/workspace`);
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
    // --- local access: sign in, inspect an invitation, activate ------------
    //
    // These three are pre-session by necessity. They carry the same
    // same-origin and JSON checks every other mutation does (checkMutation
    // above), and each one refuses outright unless the database's local access
    // switch is on — see db/migrations/016_local_access.sql.
    if (req.method === "POST" && path === "auth/password") {
      const data = await jsonInput(
        req,
        z
          .object({
            email: z.string().trim().min(3).max(320),
            password: z.string().min(1).max(200),
          })
          .strict(),
      );
      const result = await authenticate(data.email, data.password);
      if (result.outcome === "RATE_LIMITED")
        throw new AppError("RATE_LIMITED", 429);
      // One reply for a wrong password and for an address that is not staff.
      if (result.outcome !== "SIGNED_IN")
        throw new AppError(
          result.outcome === "UNAVAILABLE"
            ? "TEMPORARILY_UNAVAILABLE"
            : "SESSION_REQUIRED",
          result.outcome === "UNAVAILABLE" ? 503 : 401,
        );
      const profile = await withStaff(result.token, async (_tx, p) => p);
      const res = response({ redirect: "/workspace" });
      res.cookies.set(sessionCookie(), result.token, {
        ...cookieOptions(),
        maxAge: 43200,
      });
      res.cookies.set("orgfit-locale", profile.locale, {
        ...cookieOptions(),
        maxAge: 31536000,
      });
      return res;
    }
    if (req.method === "POST" && path === "auth/invitation") {
      const data = await jsonInput(
        req,
        z.object({ token: z.string().max(200) }).strict(),
      );
      return response(await inspectInvitation(data.token));
    }
    if (req.method === "POST" && path === "auth/activate") {
      const data = await jsonInput(
        req,
        z
          .object({
            token: z.string().max(200),
            displayName: z.string().trim().min(1).max(500),
            password: z.string().min(1).max(200),
          })
          .strict(),
      );
      // The policy is enforced here as well as advertised on the screen, so a
      // request that skipped the form cannot install a weaker credential.
      if (checkPasswordPolicy(data.password))
        throw new AppError("VALIDATION_FAILED", 422);
      return response(
        await activateInvitation(data.token, data.displayName, data.password),
      );
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
          (await revocationRoute(req, path, tx)) ??
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
        // Staff, staff invitations, audit history, global settings and the
        // caller's own sessions: src/administration.ts, keyset-paginated.
        const administrationResponse = await administrationRoute(
          req,
          path,
          tx,
          profile,
        );
        if (administrationResponse) return administrationResponse;
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
