import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  SESSION_COOKIE,
  respondentInput,
  translateRespondentError,
  publicError,
  exchange,
  status,
  refresh,
  instrument,
  draftCreate,
  draftSave,
  draftRead,
  draftStartOver,
  review,
  finalize,
} from "../../../../../../src/respondent";
import { respondentMessages } from "../../../../../../src/respondent-i18n";
import { localeOf, type Locale } from "../../../../../../src/i18n";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public respondent API. It lives on the respondent origin only.
//
// Deliberate properties:
//  * every response carries Cache-Control: no-store, and the token never
//    appears in a URL, a query string, a redirect or a log line — the browser
//    reads it from the fragment and POSTs it once;
//  * error bodies carry a coarse code and a localized sentence, never an
//    internal identifier, a correlation ID, a stack, a participant or an answer;
//  * there is no idempotency-key cache, because such a cache would be exactly
//    the identity-to-answer bridge the blueprint forbids.
const MAX_BODY = 2 * 1024 * 1024;

function localeFrom(request: Request): Locale {
  const cookie = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)orgfit-survey-locale=(ar|en)/)?.[1];
  return localeOf(
    cookie ??
      request.headers.get("accept-language")?.split(",")[0]?.split("-")[0],
  );
}
const noStore = (body: unknown, init: ResponseInit = {}) =>
  NextResponse.json(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...(init.headers ?? {}),
    },
  });
const ok = (data: unknown, status = 200) => noStore({ data }, { status });

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}
// Mutations must originate from the respondent origin itself. The session
// cookie is SameSite=Lax, and this check is the second, explicit barrier.
function checkOrigin(request: Request) {
  const expected = process.env.RESPONDENT_ORIGIN;
  if (!expected) throw publicError("TEMPORARILY_UNAVAILABLE");
  if (
    request.headers.get("origin") !== expected ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw publicError("SESSION_REQUIRED");
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw publicError("MALFORMED");
}
async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (Number(request.headers.get("content-length")) > MAX_BODY)
    throw publicError("MALFORMED");
  const reader = request.body?.getReader();
  if (!reader) throw publicError("MALFORMED");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw publicError("MALFORMED");
    }
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw publicError("MALFORMED");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw publicError("VALIDATION_FAILED");
  return result.data;
}
function errorBody(error: unknown, locale: Locale) {
  const app = translateRespondentError(error);
  const m = respondentMessages(locale);
  const message =
    app.status === 401
      ? m.sessionExpired
      : app.status === 404
        ? m.unavailable
        : app.status === 422
          ? m.invalidAnswers
          : app.status === 409
            ? m.closed
            : m.serviceUnavailable;
  return noStore({ code: app.code, message }, { status: app.status });
}

async function handle(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const locale = localeFrom(req);
  try {
    const path = (await ctx.params).path.join("/");
    const jar = await cookies();
    const session = jar.get(SESSION_COOKIE)?.value;
    if (req.method !== "GET") checkOrigin(req);

    if (req.method === "POST" && path === "invitations/exchange") {
      const input = await body(req, respondentInput.exchangeInput);
      const result = await exchange(input.token);
      const res = ok(result.context);
      if (result.session)
        res.cookies.set(SESSION_COOKIE, result.session, {
          ...cookieOptions(),
          maxAge: 43200,
        });
      return res;
    }
    if (req.method === "GET" && path === "status")
      return ok(await status(session));
    if (req.method === "POST" && path === "session/refresh") {
      await body(req, z.object({}).strict());
      return ok(await refresh(session));
    }
    if (req.method === "GET" && path === "instrument")
      return ok(await instrument(session));
    if (req.method === "POST" && path === "draft")
      return ok(
        await draftCreate(session, await body(req, respondentInput.draftCreateInput)),
        201,
      );
    if (req.method === "PUT" && path === "draft")
      return ok(
        await draftSave(session, await body(req, respondentInput.draftSaveInput)),
      );
    if (req.method === "POST" && path === "resume")
      return ok(
        await draftRead(session, await body(req, respondentInput.resumeInput)),
      );
    if (req.method === "POST" && path === "draft/start-over") {
      await body(req, respondentInput.startOverInput);
      await draftStartOver(session);
      return new NextResponse(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (req.method === "POST" && path === "review")
      return ok(
        await review(session, await body(req, respondentInput.answersInput)),
      );
    if (req.method === "POST" && path === "finalize") {
      const result = await finalize(
        session,
        await body(req, respondentInput.answersInput),
      );
      // Generic acceptance only. No response identifier, no submission time and
      // no indication of whether this attempt or an earlier one wrote the row.
      return ok({ access: result.access });
    }
    if (req.method === "POST" && path === "locale") {
      const input = await body(
        req,
        z.object({ locale: z.enum(["ar", "en"]) }).strict(),
      );
      const res = ok(input);
      res.cookies.set("orgfit-survey-locale", input.locale, {
        ...cookieOptions(),
        httpOnly: false,
        maxAge: 31536000,
      });
      return res;
    }
    return errorBody(publicError("DRAFT_UNAVAILABLE"), locale);
  } catch (e) {
    return errorBody(e, locale);
  }
}
export { handle as GET, handle as POST, handle as PUT };
