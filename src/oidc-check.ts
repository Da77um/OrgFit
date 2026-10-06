import { randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import type { Finding, Outcome } from "./preflight";

// ---------------------------------------------------------------------------
// Checks a staff environment's identity provider settings before anyone signs
// in (D-167). src/auth.ts fails every one of these with the same opaque
// SESSION_REQUIRED, so a misconfigured provider is otherwise found only by a
// failed login. Nobody is signed in and no token is issued: the client
// credential is proven by presenting it with a code that cannot exist, which a
// provider must reject as invalid_grant AFTER authenticating the client, or as
// invalid_client when the credential is wrong (RFC 6749 §5.2).
//
// Prints names and outcomes only; never a secret.
// ---------------------------------------------------------------------------

/** Auth0's documented acr value for a sign-in that used multi-factor authentication. */
export const AUTH0_MFA_ACR = "http://schemas.openid.net/pape/policies/2007/06/multi-factor";

export async function checkOidc(
  env: Record<string, string | undefined>,
  options: { production: boolean },
): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (check: string, outcome: Outcome, detail: string) => out.push({ check, outcome, detail });
  const required = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_MFA_ACR", "STAFF_ORIGIN"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    add("oidc-variables", "FAIL", `missing: ${missing.join(", ")}`);
    return out;
  }
  const issuer = env.OIDC_ISSUER!;
  const accepted = env.OIDC_MFA_ACR!.split(",");
  const callback = `${env.STAFF_ORIGIN}/api/v1/auth/callback`;
  add("callback-url", "PASS", `register exactly ${callback} as an allowed callback URL`);
  if (!issuer.startsWith("https://") && options.production) {
    add("issuer-https", "FAIL", "OIDC_ISSUER must be https in production");
    return out;
  }

  // Discovery exactly as src/auth.ts performs it.
  let config: oidc.Configuration;
  try {
    config = await oidc.discovery(new URL(issuer), env.OIDC_CLIENT_ID!, env.OIDC_CLIENT_SECRET!, undefined, {
      execute: [oidc.enableNonRepudiationChecks, ...(issuer.startsWith("http:") ? [oidc.allowInsecureRequests] : [])],
    });
  } catch (e) {
    add("discovery", "FAIL", `provider metadata unavailable or inconsistent (${(e as { code?: string }).code ?? (e as Error).name})`);
    return out;
  }
  const meta = config.serverMetadata();
  add("discovery", "PASS", "provider metadata reachable");

  // src/auth.ts compares the ID token's iss to OIDC_ISSUER byte for byte.
  if (meta.issuer === issuer) add("issuer-exact", "PASS", "OIDC_ISSUER equals the provider's issuer");
  else
    add("issuer-exact", "FAIL", meta.issuer.replace(/\/$/, "") === issuer.replace(/\/$/, "")
      ? "OIDC_ISSUER differs from the provider's issuer only by a trailing slash; copy it exactly"
      : "OIDC_ISSUER differs from the provider's issuer");

  const has = (list: unknown, value: string) => Array.isArray(list) && list.includes(value);
  add("code-flow", has(meta.response_types_supported, "code") ? "PASS" : "FAIL", "authorization code flow");
  if (meta.code_challenge_methods_supported === undefined) add("pkce", "WARN", "provider does not advertise PKCE methods; S256 is required");
  else add("pkce", has(meta.code_challenge_methods_supported, "S256") ? "PASS" : "FAIL", "PKCE S256");
  add("id-token-signature", has(meta.id_token_signing_alg_values_supported, "RS256") ? "PASS" : "FAIL", "RS256-signed ID tokens (verified against the provider's keys)");
  if (meta.token_endpoint_auth_methods_supported === undefined)
    add("client-auth-method", "WARN", "provider does not advertise token endpoint methods; OrgFit sends client_secret_post");
  else
    add("client-auth-method", has(meta.token_endpoint_auth_methods_supported, "client_secret_post") ? "PASS" : "FAIL",
      "OrgFit sends the secret in the POST body (client_secret_post); set the application to that method");

  if (Array.isArray(meta.acr_values_supported)) {
    const unsupported = accepted.filter((a) => !has(meta.acr_values_supported, a));
    add("mfa-acr", unsupported.length ? "FAIL" : "PASS", unsupported.length ? "OIDC_MFA_ACR names a value the provider does not support" : "accepted acr values are supported");
  } else add("mfa-acr", "WARN", "provider does not list acr values; a real MFA sign-in must show the acr claim");
  if (/\.auth0\.com$/.test(new URL(issuer).hostname) && !accepted.includes(AUTH0_MFA_ACR))
    add("mfa-acr-auth0", "FAIL", "for Auth0, OIDC_MFA_ACR must be the multi-factor policy URI");

  // The client credential, without signing anyone in.
  try {
    const res = await fetch(meta.token_endpoint!, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: `orgfit-oidc-check-${randomBytes(16).toString("hex")}`,
        redirect_uri: callback,
        code_verifier: randomBytes(32).toString("base64url"),
        client_id: env.OIDC_CLIENT_ID!,
        client_secret: env.OIDC_CLIENT_SECRET!,
      }),
    });
    const error = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    if (res.ok) add("client-credential", "FAIL", "the provider issued tokens for a code that cannot exist");
    else if (error === "invalid_grant") add("client-credential", "PASS", "client id and secret accepted (the probe code was rejected, as it must be)");
    else if (error === "invalid_client" || error === "unauthorized_client")
      add("client-credential", "FAIL", `${error}: wrong OIDC_CLIENT_ID or OIDC_CLIENT_SECRET, or the application does not use client_secret_post`);
    else add("client-credential", "WARN", `inconclusive (${error ?? `HTTP ${res.status}`})`);
  } catch {
    add("client-credential", "FAIL", "token endpoint unreachable");
  }
  return out;
}
