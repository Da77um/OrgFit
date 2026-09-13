// ---------------------------------------------------------------------------
// Local staff password credentials.
//
// This module exists only because P-005 has not yet supplied a real identity
// provider and the product needs a sign-in and an activation screen it can
// actually be driven through. It is reachable only while
// access.local_access_enabled() is true — see db/migrations/016_local_access.sql
// for the switch and why it is off by default.
//
// Three rules it is written around:
//
//   * A password never leaves this module in any form but a verified boolean
//     or an encoded hash. It is never logged, never returned, never put in an
//     error and never written to a column that is not the hash column.
//   * Verification is constant-time against the derived key, and a request for
//     an address that has no credential still pays the KDF cost, so the
//     response time does not tell a caller whether an account exists.
//   * The encoding carries its own parameters, so raising the cost later does
//     not invalidate credentials created under the old ones.
// ---------------------------------------------------------------------------

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

// 2^15 * 8 * 128 bytes = 32 MiB of working memory per verification. Node's
// default maxmem is exactly 32 MiB, which this would sit on the boundary of, so
// the budget is stated rather than inherited.
type Cost = { N: number; r: number; p: number };
const COST: Cost = { N: 1 << 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAXMEM = 96 * 1024 * 1024;

function derive(password: string, salt: Buffer, cost: Cost): Promise<Buffer> {
  const options: ScryptOptions = { ...cost, maxmem: MAXMEM };
  return new Promise((resolve, reject) =>
    scryptCallback(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      options,
      (error, key) => (error ? reject(error) : resolve(key as Buffer)),
    ),
  );
}

// $scrypt$N=32768,r=8,p=1$<salt base64url>$<key base64url>
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return `$scrypt$N=${COST.N},r=${COST.r},p=${COST.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  encoded: string | null | undefined,
): Promise<boolean> {
  // No credential: still do the work, so an unknown address and a wrong
  // password are indistinguishable from outside.
  const parts = (encoded ?? "").split("$");
  if (parts.length !== 5 || parts[1] !== "scrypt") {
    await derive(password, DUMMY_SALT, COST);
    return false;
  }
  const params = Object.fromEntries(
    parts[2].split(",").map((pair) => {
      const [k, v] = pair.split("=");
      return [k, Number(v)];
    }),
  );
  const cost = { N: params.N, r: params.r, p: params.p };
  if (
    !Number.isInteger(cost.N) ||
    !Number.isInteger(cost.r) ||
    !Number.isInteger(cost.p) ||
    cost.N < 1 << 14 ||
    cost.N > 1 << 20
  ) {
    await derive(password, DUMMY_SALT, COST);
    return false;
  }
  const salt = Buffer.from(parts[3], "base64url");
  const expected = Buffer.from(parts[4], "base64url");
  const actual = await derive(password, salt, cost);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const DUMMY_SALT = Buffer.alloc(16, 7);

// Re-exported so a server module needs one import. The rule itself lives in
// src/password-policy.ts, which has no Node dependency and is therefore safe in
// the activation form's browser bundle.
export {
  PASSWORD_POLICY,
  checkPasswordPolicy,
  type PolicyFailure,
} from "./password-policy";
