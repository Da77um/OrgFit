import * as oidc from "openid-client";
import { sql } from "kysely";
import { readConfig } from "./config";
import { authDatabase } from "./db";
import { AppError, assertMfa, digest, secret } from "./security";

export const sessionCookie = () =>
  readConfig().STAFF_ORIGIN.startsWith("https:")
    ? "__Host-orgfit-staff"
    : "orgfit-staff-dev";
export const flowCookie = () =>
  readConfig().STAFF_ORIGIN.startsWith("https:")
    ? "__Host-orgfit-flow"
    : "orgfit-flow-dev";
export const cookieOptions = () => ({
  httpOnly: true,
  secure: readConfig().STAFF_ORIGIN.startsWith("https:"),
  sameSite: "lax" as const,
  path: "/",
});
async function client() {
  const c = readConfig();
  return oidc.discovery(
    new URL(c.OIDC_ISSUER),
    c.OIDC_CLIENT_ID,
    c.OIDC_CLIENT_SECRET,
    undefined,
    {
      execute: [
        oidc.enableNonRepudiationChecks,
        ...(c.OIDC_ISSUER.startsWith("http:")
          ? [oidc.allowInsecureRequests]
          : []),
      ],
    },
  );
}
export async function beginLogin() {
  const c = readConfig(),
    config = await client(),
    verifier = oidc.randomPKCECodeVerifier(),
    state = oidc.randomState(),
    nonce = oidc.randomNonce(),
    flow = secret();
  await sql`select access.begin_oidc(${digest(flow)},${state},${nonce},${verifier})`.execute(
    authDatabase(),
  );
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: `${c.STAFF_ORIGIN}/api/v1/auth/callback`,
    scope: "openid",
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
    acr_values: c.OIDC_MFA_ACR.replaceAll(",", " "),
    max_age: "0",
  });
  return { url, flow };
}
export async function finishLogin(url: URL, flow: string | undefined) {
  if (!flow || !/^[A-Za-z0-9_-]{43}$/.test(flow))
    throw new AppError("SESSION_REQUIRED", 401);
  const { rows } = await sql<{
    state: string;
    nonce: string;
    verifier: string;
  }>`select * from access.consume_oidc(${digest(flow)})`.execute(
    authDatabase(),
  );
  if (!rows[0]) throw new AppError("SESSION_REQUIRED", 401);
  const c = readConfig(),
    f = rows[0];
  const tokens = await oidc.authorizationCodeGrant(await client(), url, {
    pkceCodeVerifier: f.verifier,
    expectedState: f.state,
    expectedNonce: f.nonce,
    idTokenExpected: true,
    maxAge: 300,
  });
  const claims = tokens.claims();
  if (!claims || claims.iss !== c.OIDC_ISSUER)
    throw new AppError("SESSION_REQUIRED", 401);
  assertMfa({ acr: claims.acr, amr: claims.amr }, c.OIDC_MFA_ACR);
  const token = secret();
  const result = await sql<{
    ok: boolean;
  }>`select access.issue_session(${claims.iss},${claims.sub},${digest(token)}) as ok`.execute(
    authDatabase(),
  );
  if (!result.rows[0].ok) throw new AppError("SESSION_REQUIRED", 401);
  return token;
}
