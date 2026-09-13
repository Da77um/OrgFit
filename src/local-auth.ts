// ---------------------------------------------------------------------------
// The local sign-in and invitation-activation paths.
//
// Sits beside src/auth.ts, which owns OIDC and is not modified. Both run on the
// orgfit_auth credential, which can execute the access-flow routines and read
// no table directly; every decision below is taken by a routine in
// db/migrations/016_local_access.sql, and every one of them refuses outright
// while access.local_access_enabled() is false.
//
// The caller of `authenticate` gets one of a small set of outcomes and never an
// exception carrying a database message. "No such address" and "wrong password"
// are the SAME outcome by construction, not by a branch that happens to return
// the same string today.
// ---------------------------------------------------------------------------

import { sql } from "kysely";
import { authDatabase } from "./db";
import { digest, secret } from "./security";
import { hashPassword, verifyPassword } from "./password";
import type { Locale } from "./i18n";

export const LOCAL_ISSUER = "urn:orgfit:local-password";

const emailDigest = (email: string) => digest(email.trim().toLowerCase());

export type SignInResult =
  | { outcome: "SIGNED_IN"; token: string }
  | { outcome: "REJECTED" }
  | { outcome: "RATE_LIMITED" }
  | { outcome: "UNAVAILABLE" };

export async function authenticate(
  email: string,
  password: string,
): Promise<SignInResult> {
  const address = email.trim().toLowerCase();
  const key = emailDigest(address);
  const db = authDatabase();
  let challenge: {
    staff_user_id: string | null;
    password_hash: string | null;
    locked: boolean;
  };
  try {
    const { rows } = await sql<{
      staff_user_id: string | null;
      password_hash: string | null;
      locked: boolean;
    }>`select * from access.password_challenge(${address},${key})`.execute(db);
    // An unknown address returns NO row. Treating that as an absent credential
    // here — rather than letting the missing row throw — is what keeps it on
    // exactly the same path, status and timing as a wrong password.
    challenge = rows[0] ?? {
      staff_user_id: null,
      password_hash: null,
      locked: false,
    };
  } catch {
    return { outcome: "UNAVAILABLE" };
  }
  if (challenge.locked) return { outcome: "RATE_LIMITED" };
  // Runs the key derivation whether or not a credential was found.
  const ok = await verifyPassword(password, challenge.password_hash);
  if (!ok || !challenge.staff_user_id) {
    await sql`select access.password_failed(${key})`.execute(db);
    return { outcome: "REJECTED" };
  }
  const token = secret();
  const { rows } = await sql<{
    ok: boolean;
  }>`select access.issue_password_session(${challenge.staff_user_id}::uuid,${key},${digest(token)}) as ok`.execute(
    db,
  );
  if (!rows[0]?.ok) return { outcome: "REJECTED" };
  return { outcome: "SIGNED_IN", token };
}

export type InvitationState =
  | "VALID"
  | "EXPIRED"
  | "CONSUMED"
  | "REVOKED"
  | "INVALID"
  | "ALREADY_REGISTERED"
  | "ACTIVATED";

export type InvitationView = {
  state: InvitationState;
  email?: string;
  role?: "SUPER_ADMIN" | "STAFF";
  locale?: Locale;
  expiresAt?: string;
};

// A token that is not a 256-bit base64url secret is INVALID without a query, so
// a malformed value cannot become a database round trip.
export const tokenShape = /^[A-Za-z0-9_-]{43}$/;

export async function inspectInvitation(token: string): Promise<InvitationView> {
  if (!tokenShape.test(token)) return { state: "INVALID" };
  const { rows } = await sql<{ data: InvitationView }>`
    select access.inspect_invitation(${digest(token)}) as data`.execute(
    authDatabase(),
  );
  return rows[0].data;
}

export async function activateInvitation(
  token: string,
  displayName: string,
  password: string,
): Promise<InvitationView> {
  if (!tokenShape.test(token)) return { state: "INVALID" };
  const hash = await hashPassword(password);
  // The provider subject for a local account is generated and meaningless. It
  // exists because (issuer, provider_subject) is unique on every staff row; the
  // reserved issuer is what keeps this account off the OIDC path entirely.
  const subject = secret();
  const { rows } = await sql<{ data: InvitationView }>`
    select access.accept_invitation(${digest(token)},${displayName.trim()},${hash},${subject}) as data`.execute(
    authDatabase(),
  );
  return rows[0].data;
}

// Whether this installation has the local path switched on at all. Read through
// the staff credential, because the sign-in page is rendered by the staff
// process and a page must not hold the auth credential's reasoning.
export async function localAccessEnabled(): Promise<boolean> {
  try {
    const { rows } = await sql<{
      on: boolean;
    }>`select access.local_access_enabled() as on`.execute(authDatabase());
    return rows[0].on;
  } catch {
    return false;
  }
}
