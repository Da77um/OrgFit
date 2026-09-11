import { createHmac, timingSafeEqual } from "node:crypto";
import { readConfig } from "./config";
import { AppError, secret } from "./security";

// A bearer invitation credential: 256 random bits, revealed once at issuance.
// The raw value is never written to the database, an idempotency receipt, an
// audit row or a log line. Only a keyed digest and its key version persist.
export const invitationToken = () => secret();
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

function digestKey() {
  const value = process.env.INVITATION_DIGEST_KEY;
  if (!value || !/^[a-f0-9]{64}$/.test(value))
    throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  return Buffer.from(value, "hex");
}
export function digestKeyVersion() {
  const value = process.env.INVITATION_DIGEST_KEY_VERSION ?? "v1";
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(value))
    throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  return value;
}
// Keyed, not plain: a stolen database copy alone does not permit an offline
// search over the token space. Rotation of this key is a Phase 14 procedure.
export function tokenDigest(token: string) {
  if (!tokenPattern.test(token)) throw new AppError("NOT_FOUND", 404);
  return createHmac("sha256", digestKey()).update(token).digest();
}
export function digestsEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}
// The respondent origin carries the token in the fragment so that it never
// reaches a server access log, a Referer header or a proxy query string.
export const invitationUrl = (token: string) =>
  `${readConfig().RESPONDENT_ORIGIN}/s#${token}`;
