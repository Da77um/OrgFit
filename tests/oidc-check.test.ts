import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { testProvider } from "./oidc-provider";
import { AUTH0_MFA_ACR, checkOidc } from "../src/oidc-check";

// D-167: oidc:check against the synthetic provider. It finds each mistake that
// src/auth.ts would otherwise surface only as a failed sign-in.

const PORT = 4417;
const issuer = `http://127.0.0.1:${PORT}`;
const good = {
  OIDC_ISSUER: issuer,
  OIDC_CLIENT_ID: "orgfit-test",
  OIDC_CLIENT_SECRET: "synthetic-oidc-test-secret",
  OIDC_MFA_ACR: "urn:test:mfa",
  STAFF_ORIGIN: "http://127.0.0.1:3000",
};
let server: Server;
test.before(async () => {
  server = await testProvider(PORT);
});
test.after(() => new Promise<void>((r) => server.close(() => r())));

const outcome = (findings: { check: string; outcome: string }[], check: string) => findings.find((f) => f.check === check)?.outcome;

test("a correct configuration passes, and the callback URL to register is named", async () => {
  const findings = await checkOidc(good, { production: false });
  assert.deepEqual(findings.filter((f) => f.outcome === "FAIL"), []);
  assert.equal(outcome(findings, "client-credential"), "PASS");
  assert.equal(outcome(findings, "issuer-exact"), "PASS");
  assert.match(findings.find((f) => f.check === "callback-url")!.detail, /http:\/\/127\.0\.0\.1:3000\/api\/v1\/auth\/callback/);
});

test("a wrong client secret or id is reported without signing anyone in", async () => {
  assert.equal(outcome(await checkOidc({ ...good, OIDC_CLIENT_SECRET: "wrong" }, { production: false }), "client-credential"), "FAIL");
  assert.equal(outcome(await checkOidc({ ...good, OIDC_CLIENT_ID: "someone-else" }, { production: false }), "client-credential"), "FAIL");
});

test("an issuer that differs only by a trailing slash is reported, although discovery tolerates it", async () => {
  // openid-client's discovery accepts the slash, but src/auth.ts compares the
  // ID token's iss to OIDC_ISSUER exactly, so every sign-in would fail.
  const findings = await checkOidc({ ...good, OIDC_ISSUER: `${issuer}/` }, { production: false });
  assert.equal(outcome(findings, "discovery"), "PASS");
  assert.equal(outcome(findings, "issuer-exact"), "FAIL");
  assert.match(findings.find((f) => f.check === "issuer-exact")!.detail, /trailing slash/);
});

test("missing variables, and http in production, are refused before any request", async () => {
  const partial: Record<string, string> = { ...good };
  delete partial.OIDC_CLIENT_SECRET;
  assert.deepEqual(await checkOidc(partial, { production: false }), [
    { check: "oidc-variables", outcome: "FAIL", detail: "missing: OIDC_CLIENT_SECRET" },
  ]);
  assert.equal(outcome(await checkOidc(good, { production: true }), "issuer-https"), "FAIL");
});

test("an unreachable provider fails discovery", async () => {
  assert.equal(outcome(await checkOidc({ ...good, OIDC_ISSUER: "http://127.0.0.1:1" }, { production: false }), "discovery"), "FAIL");
});

test("the Auth0 MFA value is the documented multi-factor policy URI", () => {
  assert.equal(AUTH0_MFA_ACR, "http://schemas.openid.net/pape/policies/2007/06/multi-factor");
});
