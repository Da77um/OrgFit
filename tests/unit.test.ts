import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config";
import { ar, en, localeOf, direction } from "../src/i18n";
import {
  assertMfa,
  checkMutation,
  jsonInput,
  sessionDigest,
  createStaffInput,
} from "../src/security";
import { safeError } from "../src/http";
import { z } from "zod";
test("Arabic default and complete English catalog/direction", () => {
  assert.equal(localeOf(undefined), "ar");
  assert.equal(direction("ar"), "rtl");
  assert.equal(direction("en"), "ltr");
  assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
});
test("missing environment is safe and rejects privileged/runtime origin confusion", () => {
  assert.throws(() => readConfig({}), /Configuration unavailable/);
  const env = {
    NODE_ENV: "test",
    STAFF_ORIGIN: "http://127.0.0.1:3000",
    RESPONDENT_ORIGIN: "http://localhost:3001",
    DATABASE_URL: "postgres://orgfit_staff:synthetic@127.0.0.1/db",
    AUTH_DATABASE_URL: "postgres://orgfit_auth:synthetic@127.0.0.1/db",
    OIDC_ISSUER: "http://127.0.0.1:4010",
    OIDC_CLIENT_ID: "test",
    OIDC_CLIENT_SECRET: "synthetic-test-secret",
    OIDC_MFA_ACR: "urn:test:mfa",
  };
  assert.equal(readConfig(env).OIDC_CLIENT_ID, "test");
  for (const patch of [
    { NODE_ENV: "production" },
    { MIGRATION_DATABASE_URL: "secret" },
    { DATABASE_URL: "postgres://orgfit_migrator:secret@127.0.0.1/db" },
    { RESPONDENT_ORIGIN: "http://127.0.0.1:3001" },
  ])
    assert.throws(() => readConfig({ ...env, ...patch }));
});
test("MFA fails closed and opaque sessions reject malformed credentials", () => {
  assert.throws(() => assertMfa({}, "urn:test:mfa"));
  assert.throws(() => assertMfa({ acr: "password" }, "urn:test:mfa"));
  assert.doesNotThrow(() => assertMfa({ acr: "urn:test:mfa" }, "urn:test:mfa"));
  assert.throws(() => sessionDigest("admin"));
});
test("mutations require exact origin and JSON; unknown keys and oversized bodies rejected", async () => {
  assert.throws(() =>
    checkMutation(
      new Request("https://staff.test", {
        method: "POST",
        headers: {
          origin: "https://evil.test",
          "content-type": "application/json",
        },
      }),
      "https://staff.test",
    ),
  );
  await assert.rejects(
    jsonInput(
      new Request("https://staff.test", {
        method: "POST",
        body: '{"locale":"ar","role":"SUPER_ADMIN"}',
      }),
      z.object({ locale: z.string() }).strict(),
    ),
  );
  await assert.rejects(
    jsonInput(
      new Request("https://staff.test", {
        method: "POST",
        body: "x".repeat(2 * 1024 * 1024 + 1),
      }),
      z.any(),
    ),
  );
  assert.equal(
    createStaffInput.safeParse({
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      capabilities: ["raw.read"],
      organizationIds: [],
    }).success,
    false,
  );
});
test("errors never echo SQL, credentials, providers or request bodies", async () => {
  const r = safeError(
    new Error("postgres://secret/password SELECT token_digest"),
  );
  assert.equal(r.status, 503);
  assert.doesNotMatch(await r.text(), /password|SELECT|token_digest/);
});
test("file bytes, including a report opened for printing, are served under the file policy", async () => {
  const { ATTACHMENT_ROUTE, ATTACHMENT_CSP, secureResponse } = await import("../src/csp");
  const { NextRequest } = await import("next/server");
  const org = "/api/v1/organizations/5f8f1c2e-0000-4000-8000-000000000001";
  for (const path of [
    `${org}/reports/5f8f1c2e-0000-4000-8000-000000000002/view`,
    `${org}/visits/v1/attachments/a1/download`,
    `${org}/visits/v1/attachments/a1/preview`,
  ]) {
    assert.ok(ATTACHMENT_ROUTE.test(path), path);
    const res = secureResponse(new NextRequest(`https://staff.test${path}`));
    assert.equal(res.headers.get("Content-Security-Policy"), ATTACHMENT_CSP, path);
  }
  for (const path of [
    `${org}/reports`,
    `${org}/reports/5f8f1c2e-0000-4000-8000-000000000002`,
    `${org}/reports/5f8f1c2e-0000-4000-8000-000000000002/view/x`,
    `/organizations/${org}/reports/x/viewer`,
  ])
    assert.equal(ATTACHMENT_ROUTE.test(path), false, path);
  // The file policy still permits nothing: no script, no same-origin access.
  assert.match(ATTACHMENT_CSP, /^sandbox; /);
  assert.doesNotMatch(ATTACHMENT_CSP, /allow-|script-src/);
});
