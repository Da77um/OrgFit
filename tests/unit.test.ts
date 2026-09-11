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
