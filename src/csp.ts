import { NextRequest, NextResponse } from "next/server";

// The policy an uploaded consulting file is served under.
//
// It is defined here, beside the site policy, because the proxy sets a
// Content-Security-Policy on every response and would otherwise REPLACE a
// stricter one set by a route. A file must never be served under the
// application's own policy: `sandbox` with no allowances denies script,
// network, plugins, forms and same-origin access, so a file that reached CLEAN
// in error still cannot act as a page against this origin.
export const ATTACHMENT_CSP =
  "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
// The only routes that carry file bytes rather than JSON or a page.
const ATTACHMENT_ROUTE =
  /^\/api\/v1\/organizations\/[\w-]+\/visits\/[\w-]+\/attachments\/[\w-]+\/(download|preview)$/;

export function secureResponse(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV !== "production";
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; font-src 'self'; connect-src 'self'${dev ? " ws:" : ""}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
  const attachment = ATTACHMENT_ROUTE.test(request.nextUrl.pathname);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", attachment ? ATTACHMENT_CSP : csp);
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Cache-Control", "no-store");
  res.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  if (request.nextUrl.protocol === "https:")
    res.headers.set("Strict-Transport-Security", "max-age=31536000");
  return res;
}
