import type { ClientBase } from "pg";
import { digest, secret } from "./security";
import { tokenDigest, tokenPattern } from "./invitation-token";

// Phase 06 delivers the gateway VALIDATION AND STATUS contract only. There is
// no draft, no answer submission, no encrypted intake envelope and no anonymous
// finalization here; Phase 07 owns those and the HTTP surface that exposes this.
//
// Deliberate properties, verified by tests:
//  - Opening never consumes an invitation and never marks it completed.
//  - No participant name, participant identifier or organization name is
//    returned, and no answer or score exists to return.
//  - Every failure is the same generic UNAVAILABLE: an unknown token, a revoked
//    invitation, a rotated-away generation and a cancelled campaign are not
//    distinguishable by a link holder.
export type GatewayAccess =
  | "OPEN"
  | "NOT_YET_OPEN"
  | "CLOSED"
  | "ACCEPTED"
  | "SESSION_EXPIRED"
  | "UNAVAILABLE";
export type GatewayContext = {
  access: GatewayAccess;
  campaignId?: string;
  versionId?: string;
  locales?: string[];
  notice?: Record<string, unknown>;
  endsAt?: string | null;
};
const unavailable: GatewayContext = { access: "UNAVAILABLE" };

// The session credential is generated here and returned once; only its digest
// is stored, exactly as with the invitation token itself.
export function newSessionCredential() {
  const value = secret();
  return { value, digest: digest(value) };
}
export async function exchange(
  db: ClientBase,
  token: string,
): Promise<{ context: GatewayContext; session: string | null }> {
  if (!tokenPattern.test(token)) return { context: unavailable, session: null };
  const session = newSessionCredential();
  const { rows } = await db.query(
    "SELECT core.gateway_exchange($1,$2) AS data",
    [tokenDigest(token), session.digest],
  );
  const context = rows[0].data as GatewayContext;
  return {
    context,
    session: context.access === "UNAVAILABLE" ? null : session.value,
  };
}
export async function status(
  db: ClientBase,
  sessionValue: string,
): Promise<GatewayContext> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionValue)) return unavailable;
  const { rows } = await db.query("SELECT core.gateway_status($1) AS data", [
    digest(sessionValue),
  ]);
  return rows[0].data as GatewayContext;
}
