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

// ---- employee messages (migration 025) ---------------------------------------
test("employee messages: the send input cannot name an organization and is bounded", async () => {
  const { respondentInput, MESSAGE_MAX_CHARS } = await import("../src/respondent");
  const token = "a".repeat(43);
  const dept = "00000000-0000-4000-8000-000000000001";
  const ok = (v: unknown) => respondentInput.messageSendInput.safeParse(v).success;
  assert.ok(ok({ token, departmentId: dept, otherDepartment: null, body: "hello" }));
  assert.ok(ok({ token, departmentId: null, otherDepartment: "Night shift", body: "hello" }));
  // exactly one of a real department or the sender's own text
  assert.ok(!ok({ token, departmentId: dept, otherDepartment: "x", body: "hello" }));
  assert.ok(!ok({ token, departmentId: null, otherDepartment: "   ", body: "hello" }));
  assert.ok(!ok({ token, departmentId: null, otherDepartment: "x".repeat(121), body: "hello" }));
  assert.ok(!ok({ token, departmentId: dept, otherDepartment: null, body: "   " }));
  assert.ok(!ok({ token, departmentId: dept, otherDepartment: null, body: "x".repeat(MESSAGE_MAX_CHARS + 1) }));
  assert.ok(ok({ token, departmentId: dept, otherDepartment: null, body: "x".repeat(MESSAGE_MAX_CHARS) }));
  // nothing that could carry identity or an organization is accepted
  for (const extra of ["organizationId", "participantId", "campaignId", "invitationId", "email", "name"])
    assert.ok(!ok({ token, departmentId: dept, otherDepartment: null, body: "hi", [extra]: "x" }), extra);
  assert.ok(!ok({ token: "short", departmentId: dept, otherDepartment: null, body: "hi" }));
});

test("employee messages: message buckets are counted with their own limits", async () => {
  const { limitFor } = await import("../src/rate-limit");
  const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;
  assert.equal(limitFor("message_ip", env({})), 60);
  assert.equal(limitFor("message_link_open", env({})), 300);
  assert.equal(limitFor("message_link_send", env({})), 30);
  assert.equal(limitFor("message_link_send", env({ RATE_LIMIT_MESSAGE_SEND_PER_LINK: "5" })), 5);
  assert.throws(() => limitFor("message_ip", env({ RATE_LIMIT_MESSAGE_PER_IP: "0" })));
});

test("employee messages: catalogs are complete in both languages", async () => {
  const { respondentAr, respondentEn } = await import("../src/respondent-i18n");
  assert.deepEqual(Object.keys(respondentAr).sort(), Object.keys(respondentEn).sort());
  const { inboxCatalogs } = await import("../src/inbox-i18n");
  assert.deepEqual(Object.keys(inboxCatalogs.ar).sort(), Object.keys(inboxCatalogs.en).sort());
  for (const [k, v] of [...Object.entries(inboxCatalogs.ar), ...Object.entries(inboxCatalogs.en)])
    assert.ok(v.trim().length > 0, k);
  // The notice must not promise anonymity it cannot keep.
  assert.doesNotMatch(respondentEn.msgNoticeBody + respondentEn.msgNoticeLimits, /\banonymous\b/i);
  assert.doesNotMatch(respondentAr.msgNoticeBody + respondentAr.msgNoticeLimits, /مجهول/);
});

test("employee messages: capability and inbox query", async () => {
  const { capabilities, accessInput } = await import("../src/security");
  assert.ok(capabilities.includes("messages.read"));
  assert.ok(
    accessInput.safeParse({ role: "STAFF", status: "ACTIVE", capabilities: [...capabilities], organizationIds: [] }).success,
  );
  const { messageQuery } = await import("../src/employee-messages");
  const u = (q: string) => new URL(`https://staff.test/api/v1/organizations/x/messages${q}`);
  assert.deepEqual(messageQuery(u("")).filters, {});
  assert.deepEqual(messageQuery(u("?department=OTHER")).filters, { department: "OTHER" });
  assert.throws(() => messageQuery(u("?department=sales")));
  assert.throws(() => messageQuery(u("?participant=1")));
  assert.throws(() => messageQuery(u("?after=2026-09-01")));
  assert.equal(
    messageQuery(u("?after=2026-09-01&afterId=00000000-0000-4000-8000-000000000001")).after,
    "2026-09-01",
  );
});

test("employee messages: the stored row has no identity, correlation or instant column", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("db/migrations/025_employee_messages.sql", "utf8");
  const table = source.match(/CREATE TABLE core\.employee_message \(([\s\S]*?)\n\);/)?.[1];
  assert.ok(table, "table definition found");
  const columns = table
    .split("\n")
    .map((l) => l.trim().match(/^([a-z_]+) (uuid|text|date|timestamptz|bytea|inet|jsonb|bigint|integer)\b/)?.[1])
    .filter(Boolean);
  assert.deepEqual(columns, ["id", "organization_id", "department_id", "other_department", "body", "received_on"]);
  assert.doesNotMatch(table, /participant|invitation|campaign|token|session|ip_|user_agent|timestamptz|link/i);
  // The anonymous store is never touched.
  assert.doesNotMatch(source, /\banonymous\./);
});
