import { NextResponse } from "next/server";
import { AppError } from "./security";
import { ConfigurationError } from "./config";
import { localeOf, messages, type Locale } from "./i18n";
const codes: Record<string, number> = {
  SESSION_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  LAST_ADMIN: 409,
  STATE_CONFLICT: 409,
  DEPARTMENT_CYCLE: 409,
  DEPARTMENT_IN_USE: 409,
  IMPORT_EXPIRED: 409,
  IMPORT_CHANGED: 409,
  PRECONDITION_REQUIRED: 400,
  // Phase: landing and local access. A throttled sign-in is neither a bad
  // request nor a wrong password; the caller is told to wait, and is told the
  // same thing whether or not the address exists.
  RATE_LIMITED: 429,
  VALIDATION_FAILED: 422,
  // A campaign audience outside its questionnaire's target (021).
  OUTSIDE_QUESTIONNAIRE_TARGET: 422,
  NO_ELIGIBLE_PARTICIPANTS: 422,
  // Phase 12. A visit that cannot move where the caller asked, and an
  // attachment that has not been proven clean, are both conflicts rather than
  // validation problems: the request was well formed and the record said no.
  VISIT_IMMUTABLE: 409,
  ATTACHMENT_IMMUTABLE: 409,
  ATTACHMENT_UNAVAILABLE: 409,
  CONSULTANT_INACTIVE: 422,
  AMENDMENT_REASON_REQUIRED: 422,
  CANCELLATION_REASON_REQUIRED: 422,
  CLOSURE_REASON_REQUIRED: 422,
  ATTACHMENT_TOO_LARGE: 413,
};
export function safeError(error: unknown, locale: Locale = "ar") {
  const m = messages(locale);
  let code = "TEMPORARILY_UNAVAILABLE",
    status = 503;
  if (error instanceof AppError) {
    code = error.code;
    status = error.status;
  } else if (
    !(error instanceof ConfigurationError) &&
    error instanceof Error &&
    codes[error.message]
  ) {
    code = error.message;
    status = codes[code];
  } else if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["23505", "23503", "23514", "23502", "22P02"].includes(String(error.code))
  ) {
    code = "VALIDATION_FAILED";
    status = 422;
  }
  const message =
    status === 401
      ? m.denied
      : status === 403
        ? m.forbidden
        : status === 404
          ? m.notFound
          : status === 409
            ? m.conflict
            : status === 429
              ? m.rateLimited
              : status === 413
                ? m.tooLarge
                : status < 500
                  ? m.invalid
                  : m.unavailable;
  return NextResponse.json(
    { code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
export const response = (data: unknown, status = 200) =>
  NextResponse.json(
    { data },
    { status, headers: { "Cache-Control": "no-store" } },
  );
export const requestLocale = (r: Request) =>
  localeOf(r.headers.get("accept-language")?.split(",")[0]?.split("-")[0]);
