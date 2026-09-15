import { createHmac } from "node:crypto";
import { sql } from "kysely";
import { authDatabase } from "./db";
import { AppError, sessionDigest } from "./security";
import { clientBucket, windowStart, WINDOW_SECONDS } from "./rate-limit";

// ---------------------------------------------------------------------------
// Staff-side application rate limits (Post-Audit Repair Pass 4, SEC-M1).
//
// The staff application's pre-session endpoints (identity-provider start and
// callback, development password sign-in, invitation inspection and
// activation) are limited per client address, and every signed-in API request
// is limited per session. Counting uses access.staff_rate_hit (migration 024)
// under the orgfit_auth credential, with the same fixed windows and windowed
// HMAC keys as the public gateway (src/rate-limit.ts): no address, cookie or
// session value is stored, and a key is unrelated from one window to the next.
//
// These limits are a second line. The edge proxy's own limits (P-002) remain
// the first, and the per-address bucket works only where a trusted proxy
// header is configured (RATE_LIMIT_CLIENT_IP_HEADER); the development password
// path keeps its per-account lock (016) as well.
// ---------------------------------------------------------------------------

export type StaffBucket =
  | "auth_start_ip"
  | "auth_callback_ip"
  | "password_ip"
  | "invitation_ip"
  | "activate_ip"
  | "api_session";

const DEFAULTS: Record<StaffBucket, number> = {
  auth_start_ip: 30,
  auth_callback_ip: 30,
  password_ip: 20,
  invitation_ip: 30,
  activate_ip: 10,
  api_session: 600,
};
const ENV: Record<StaffBucket, string> = {
  auth_start_ip: "STAFF_RATE_LIMIT_AUTH_PER_IP",
  auth_callback_ip: "STAFF_RATE_LIMIT_AUTH_PER_IP",
  password_ip: "STAFF_RATE_LIMIT_PASSWORD_PER_IP",
  invitation_ip: "STAFF_RATE_LIMIT_INVITATION_PER_IP",
  activate_ip: "STAFF_RATE_LIMIT_ACTIVATE_PER_IP",
  api_session: "STAFF_RATE_LIMIT_API_PER_SESSION",
};

export function staffLimitFor(bucket: StaffBucket, env: Record<string, string | undefined> = process.env) {
  const raw = env[ENV[bucket]];
  if (raw === undefined || raw === "") return DEFAULTS[bucket];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100000)
    throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  return value;
}

// A key derived from the invitation-digest key under a staff-specific label,
// so staff counters can equal neither a gateway counter nor a stored digest.
function staffRateKey(env: Record<string, string | undefined> = process.env) {
  const value = env.INVITATION_DIGEST_KEY;
  if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  return createHmac("sha256", Buffer.from(value, "hex")).update("orgfit/staff-rate-limit/v1").digest();
}

export function staffRateDigest(bucket: StaffBucket, material: string, start: Date, env: Record<string, string | undefined> = process.env) {
  return createHmac("sha256", staffRateKey(env))
    .update(bucket)
    .update(" ")
    .update(start.toISOString())
    .update(" ")
    .update(material)
    .digest();
}

export class StaffRateLimited extends AppError {
  constructor(readonly retryAfter: number) {
    super("RATE_LIMITED", 429);
  }
}

async function hit(bucket: StaffBucket, material: string) {
  const start = windowStart();
  let result: { allowed: boolean; retryAfter: number };
  try {
    const { rows } = await sql<{ data: { allowed: boolean; retryAfter: number } }>`
      select access.staff_rate_hit(${bucket},${staffRateDigest(bucket, material, start)},${start},${staffLimitFor(bucket)},${WINDOW_SECONDS}) as data`.execute(
      authDatabase(),
    );
    result = rows[0].data;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  }
  if (!result.allowed) throw new StaffRateLimited(result.retryAfter);
}

const PRE_SESSION: Record<"auth/start" | "auth/callback" | "auth/password" | "auth/invitation" | "auth/activate", StaffBucket> = {
  "auth/start": "auth_start_ip",
  "auth/callback": "auth_callback_ip",
  "auth/password": "password_ip",
  "auth/invitation": "invitation_ip",
  "auth/activate": "activate_ip",
};
export const isPreSessionPath = (path: string): path is keyof typeof PRE_SESSION => path in PRE_SESSION;

/** Count one pre-session request against its per-address bucket. Without a
 *  trusted proxy header there is no address to count, and nothing is counted. */
export async function limitPreSession(path: keyof typeof PRE_SESSION, headers: Headers) {
  const address = clientBucket(headers);
  if (address) await hit(PRE_SESSION[path], address);
}

/** Count one signed-in API request against its session. No cookie, no count:
 *  the session check that follows refuses the request anyway. */
export async function limitSession(token: string | undefined) {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  await hit("api_session", sessionDigest(token));
}
