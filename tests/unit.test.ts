import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config";
import { ar, en, localeOf, direction } from "../src/i18n";
import {
  assertMfa,
  checkMutation,
  sameOrigin,
  jsonInput,
  sessionDigest,
  createStaffInput,
} from "../src/security";
import { safeError } from "../src/http";
import { z } from "zod";
import { RequestFailure } from "../apps/staff/app/staff-request";
import {
  afterSetAside,
  conflictOf,
  isConflict,
  recoverConflict,
  settleSave,
} from "../apps/staff/app/questionnaires/conflict";
import {
  blankInstrument,
  definitionIssues,
  newIdentity,
  newQuestion,
  tr,
  type Instrument,
} from "../src/instrument-input";
import { describeLocation, issueMessage } from "../src/instrument-i18n";
import type { Version } from "../src/instruments";
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
test("development treats the loopback names as one origin; nothing else is relaxed", () => {
  const origin = "http://127.0.0.1:3000";
  const env = process.env as Record<string, string | undefined>;
  const before = env.NODE_ENV;
  try {
    env.NODE_ENV = "development";
    for (const alias of ["http://localhost:3000", "http://[::1]:3000", origin])
      assert.equal(sameOrigin(alias, origin), true, alias);
    assert.equal(sameOrigin("http://127.0.0.1:3000", "http://localhost:3001"), false);
    for (const refused of [
      null,
      "",
      "null",
      "http://localhost:3001", // another port
      "https://localhost:3000", // another protocol
      "http://evil.test:3000",
      "http://localhost.evil.test:3000",
      "http://127.0.0.2:3000",
      "http://localhost:3000/path", // not an origin
    ])
      assert.equal(sameOrigin(refused, origin), false, String(refused));
    assert.equal(sameOrigin("http://localhost:3000", "https://staff.example"), false);
    // Exact everywhere else: production, and the test runner itself.
    for (const mode of ["production", "test"]) {
      env.NODE_ENV = mode;
      assert.equal(sameOrigin("http://localhost:3000", origin), false, mode);
      assert.equal(sameOrigin(origin, origin), true, mode);
    }
  } finally {
    env.NODE_ENV = before;
  }
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

test("readiness failures are logged as fixed codes, never as driver messages (D-168)", async () => {
  const { readinessCode } = await import("../src/readiness-log");
  assert.equal(readinessCode(Object.assign(new Error("ENOENT: no such file, open '/x/cert.crt'"), { code: "ENOENT" })), "ENOENT");
  assert.equal(readinessCode(Object.assign(new Error("password authentication failed for user \"orgfit_gateway\""), { code: "28P01" })), "28P01");
  assert.equal(readinessCode(new Error("timeout expired")), "CONNECT_TIMEOUT");
  assert.equal(readinessCode(new Error("Unready")), "UNREADY");
  // A code that is not a plain token, and any other message, never reach the log.
  assert.equal(readinessCode(Object.assign(new Error("x"), { code: "postgres://u:secret@h/db" })), "UNKNOWN");
  assert.equal(readinessCode(new Error("connect to postgres://u:secret@h failed")), "UNKNOWN");
  assert.equal(readinessCode("text"), "UNKNOWN");
});

test("a refused gateway configuration logs which check refused, never the value (D-184)", async () => {
  const { readinessCode } = await import("../src/readiness-log");
  const { gatewayUrl, assertNoForeignCredentials } = await import("../src/gateway-db");
  const saved = { url: process.env.GATEWAY_DATABASE_URL, env: process.env.NODE_ENV };
  const reason = (fn: () => unknown) => {
    try {
      fn();
      return "NO_ERROR";
    } catch (e) {
      assert.equal((e as { code?: string }).code, "TEMPORARILY_UNAVAILABLE");
      return readinessCode(e);
    }
  };
  const withUrl = (value: string | undefined) => () => {
    if (value === undefined) delete process.env.GATEWAY_DATABASE_URL;
    else process.env.GATEWAY_DATABASE_URL = value;
    return gatewayUrl();
  };
  try {
    (process.env as Record<string, string>).NODE_ENV = "production";
    const good = "postgres://orgfit_gateway:hunter2@db.example/orgfit?sslmode=verify-full";
    const cases: [string | undefined, string][] = [
      [undefined, "TEMPORARILY_UNAVAILABLE:GATEWAY_URL_MISSING"],
      ['"' + good + '"', "TEMPORARILY_UNAVAILABLE:GATEWAY_URL_UNPARSEABLE"],
      [good.replace("postgres:", "mysql:"), "TEMPORARILY_UNAVAILABLE:GATEWAY_URL_PROTOCOL"],
      [good.replace("orgfit_gateway", "orgfit_staff"), "TEMPORARILY_UNAVAILABLE:GATEWAY_URL_ROLE"],
      [good.replace("hunter2", "CHANGE_ME"), "TEMPORARILY_UNAVAILABLE:GATEWAY_URL_PASSWORD"],
      [good.replace("verify-full", "require"), "TEMPORARILY_UNAVAILABLE:GATEWAY_URL_SSLMODE"],
      [good, "NO_ERROR"],
    ];
    for (const [value, expected] of cases) {
      const logged = reason(withUrl(value));
      assert.equal(logged, expected, String(value));
      assert.doesNotMatch(logged, /hunter2|example|orgfit_staff/);
    }
    assert.equal(
      reason(() => assertNoForeignCredentials({ PROCESSOR_DATABASE_URL: "postgres://p:hunter2@h/db" })),
      "TEMPORARILY_UNAVAILABLE:FOREIGN_CREDENTIAL_PROCESSOR_DATABASE_URL",
    );
    // A reason that is not a plain token never reaches the log.
    assert.equal(readinessCode(Object.assign(new Error("x"), { code: "X", reason: "postgres://u:s@h" })), "X");
  } finally {
    if (saved.url === undefined) delete process.env.GATEWAY_DATABASE_URL;
    else process.env.GATEWAY_DATABASE_URL = saved.url;
    if (saved.env === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = saved.env;
  }
});

test("a refused staff sign-in answers SESSION_REQUIRED and carries only a fixed stage for the log (D-169)", async () => {
  const { SignInRefused, finishLogin } = await import("../src/auth");
  const e = new SignInRefused("MFA_NOT_PROVEN");
  assert.equal(e.code, "SESSION_REQUIRED");
  assert.equal(e.status, 401);
  assert.equal(e.stage, "MFA_NOT_PROVEN");
  // A missing or malformed flow cookie is refused before any database or provider call.
  await assert.rejects(finishLogin(new URL("https://staff.example/api/v1/auth/callback?code=x"), undefined), (err: unknown) =>
    err instanceof SignInRefused && err.stage === "FLOW_COOKIE_MISSING");
  await assert.rejects(finishLogin(new URL("https://staff.example/api/v1/auth/callback?code=x"), "not-a-flow"), (err: unknown) =>
    err instanceof SignInRefused && err.stage === "FLOW_COOKIE_MISSING");
});

test("a sign-in refusal's mismatching values are logged only in local development (D-170)", async () => {
  const { SignInRefused, signInRefusalLog } = await import("../src/auth");
  const e = new SignInRefused("MFA_NOT_PROVEN", { accepted: "urn:mfa", acr: "urn:pwd\nforged", amr: ["pwd", "otp"] });
  const local = { NODE_ENV: "development", STAFF_ORIGIN: "http://127.0.0.1:3000" };
  const lines = signInRefusalLog(e, local);
  assert.equal(lines[0], "sign-in refused: MFA_NOT_PROVEN");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^sign-in refused \(development detail\): MFA_NOT_PROVEN \{/);
  // Provider values are JSON-quoted: a newline cannot start a forged log line.
  assert.ok(!lines[1].includes("\n"));
  assert.ok(lines[1].includes('"amr":"pwd otp"'));
  // Production, a deployed origin, or no origin: the stage line only.
  for (const env of [
    { NODE_ENV: "production", STAFF_ORIGIN: "http://127.0.0.1:3000" },
    { NODE_ENV: "development", STAFF_ORIGIN: "https://orgfit-staff.vercel.app" },
    { NODE_ENV: "development" },
    { NODE_ENV: "development", STAFF_ORIGIN: "not a url" },
  ])
    assert.deepEqual(signInRefusalLog(e, env), ["sign-in refused: MFA_NOT_PROVEN"]);
  // A failure that is not a refusal names no stage and carries no detail.
  assert.deepEqual(signInRefusalLog(new Error("postgres://u:secret@h"), local), ["sign-in refused: PROFILE_OR_UNKNOWN"]);
  // A refusal without detail keeps the single line.
  assert.deepEqual(signInRefusalLog(new SignInRefused("FLOW_COOKIE_MISSING"), local), ["sign-in refused: FLOW_COOKIE_MISSING"]);
});
// The questionnaire editor's conflict recovery (the deadlock: one stale
// revision used to freeze the editor with no way back to a clean save).
const draftVersion = (
  revision: string,
  document: Instrument = blankInstrument(),
  state: Version["state"] = "DRAFT",
): Version => ({
  id: "v",
  scope_id: "s",
  questionnaire_id: "q",
  organization_id: null,
  version_number: 1,
  state,
  revision,
  document,
  schema_hash: null,
  engine_version: "e",
});
const refusal = (code: string) => new RequestFailure("refused", "REJECTED", { status: 409, code });
test("questionnaire editor: a stale-revision conflict always leaves a reachable path back to a clean save", () => {
  // A minimal server: a save is accepted only against its current revision.
  let server = draftVersion("2"); // another window already saved revision 2
  const patch = (page: Version, document: Instrument) => {
    if (page.revision !== server.revision) throw refusal("REVISION_CONFLICT");
    server = draftVersion(String(Number(server.revision) + 1), document);
    return server;
  };
  const edits = { ...blankInstrument(), title: { ar: "تعديلاتي", en: "My edits" } };
  // The page's save is refused, and recognised as a conflict, not an error.
  assert.throws(
    () => patch(draftVersion("1"), edits),
    (e) => isConflict(e) && conflictOf(e) === "STALE",
  );
  assert.equal(isConflict(refusal("IDEMPOTENCY_CONFLICT")), false);
  // "Keep my edits": the fresh revision is adopted and the edits are untouched.
  const kept = recoverConflict(server, edits);
  assert.ok(kept.outcome === "KEPT");
  assert.equal(kept.doc, edits);
  assert.equal(kept.dirty, true);
  // The normal save now succeeds and the page is clean: validate/publish reopen.
  const saved = patch(kept.version, kept.doc);
  assert.equal(settleSave(kept.doc, kept.doc, saved).dirty, false);
  assert.deepEqual(server.document.title, edits.title);
  // A version that stopped being editable never silently takes or drops edits.
  assert.equal(recoverConflict(draftVersion("9", blankInstrument(), "PUBLISHED"), edits).outcome, "NOT_DRAFT");
  assert.equal(recoverConflict(server, edits, false).outcome, "NOT_DRAFT");
  assert.equal(conflictOf(refusal("STATE_CONFLICT")), "NOT_DRAFT");
  // Without edits, reloading simply shows the server document.
  const loaded = recoverConflict(server, null);
  assert.ok(loaded.outcome === "LOADED" && loaded.doc === server.document);
});
test("questionnaire editor: a set-aside save is adopted only when the fresh revision is provably that save", () => {
  const sent = blankInstrument();
  const mine = { ...sent, title: { ar: "أحدث", en: "Newer" } };
  // It landed: the server holds exactly what was sent, one revision on.
  const landed = afterSetAside({ body: sent, revision: "4" }, draftVersion("5", structuredClone(sent)), mine);
  assert.ok(landed.outcome === "KEPT" && landed.version.revision === "5" && landed.doc === mine);
  // It did not land: the revision is unchanged and the edits are kept.
  assert.equal(afterSetAside({ body: sent, revision: "4" }, draftVersion("4", sent), mine).outcome, "KEPT");
  // Someone else wrote: never adopted silently over their content.
  const other = { ...sent, title: { ar: "زميل", en: "Colleague" } };
  assert.equal(afterSetAside({ body: sent, revision: "4" }, draftVersion("5", other), mine).outcome, "CONFLICT");
});
test("questionnaire editor: a confirmed save never replaces edits typed while it was in flight", () => {
  const sent = blankInstrument();
  const typed = { ...sent, title: { ar: "كتبت أثناء الحفظ", en: "Typed during save" } };
  const saved = draftVersion("3", structuredClone(sent));
  assert.deepEqual(settleSave(sent, typed, saved), { doc: typed, dirty: true });
  assert.deepEqual(settleSave(sent, sent, saved), { doc: saved.document, dirty: false });
});
// The publish checklist names the place, not an identifier (Phase 2).
const checklistFixture = () => {
  const d = blankInstrument();
  d.locales = ["ar", "en"];
  d.title = tr("استبيان", "Survey");
  d.privacyText = tr("خصوصية", "Privacy");
  const question = (prompt: ReturnType<typeof tr>) => ({ ...newQuestion("MULTIPLE_CHOICE"), prompt });
  d.sections = [1, 2].map((n) => ({
    ...newIdentity(),
    title: tr(`القسم رقم ${n}`, `Part ${n}`),
    content: tr(),
    questions: [question(tr("سؤال أول", "First")), question(tr("سؤال ثان", "Second")), question(tr("", ""))],
  }));
  return d;
};
test("publish checklist: every issue keeps its stable path and names its section, question and language", () => {
  const d = checklistFixture();
  const target = d.sections[1].questions[2];
  const issues = definitionIssues(d, true);
  const prompt = issues.find((i) => i.path === `${target.id}.en` && i.code === "TRANSLATION_REQUIRED");
  assert.ok(prompt, "the empty English prompt is reported against its stable id");
  assert.deepEqual(
    { kind: prompt.location?.kind, id: prompt.location?.id, section: prompt.location?.section?.n, question: prompt.location?.question?.n, locale: prompt.location?.locale },
    { kind: "question", id: target.id, section: 2, question: 3, locale: "en" },
  );
  assert.equal(describeLocation(prompt.location!, "ar"), "القسم 2 «القسم رقم 2» · السؤال 3 — English");
  assert.equal(describeLocation(prompt.location!, "en"), "Section 2 «Part 2» · Question 3 — English");
  // An option names the question it belongs to, by position and prompt.
  const option = issues.find((i) => i.location?.kind === "option");
  assert.ok(option);
  assert.match(describeLocation(option.location!, "en"), /^Section 1 «Part 1» · Question 1 «First» · Option [0-9]+ — (العربية|English)$/);
  // A secondary field is named; instrument-level text names itself.
  d.sections[0].questions[0].help = tr("مساعدة", "");
  const help = definitionIssues(d, true).find((i) => i.path === `${d.sections[0].questions[0].id}.help.en`);
  assert.equal(describeLocation(help!.location!, "en"), "Section 1 «Part 1» · Question 1 «First» · Help — English");
  d.privacyText = tr("خصوصية", "");
  const privacy = definitionIssues(d, true).find((i) => i.path === "privacyText.en");
  assert.equal(describeLocation(privacy!.location!, "ar"), "إشعار الخصوصية — English");
  // No issue on a known node is left as a bare identifier.
  for (const i of definitionIssues(d, true)) assert.ok(i.location, `${i.code} at ${i.path} has a location`);
});
test("publish checklist: no questions and too many answer items are different instructions", () => {
  const empty = blankInstrument();
  assert.ok(definitionIssues(empty, true).some((i) => i.code === "NO_QUESTIONS"));
  assert.ok(!definitionIssues(empty, true).some((i) => i.code === "QUESTION_COUNT"));
  assert.ok(!definitionIssues(empty, false).some((i) => i.code === "NO_QUESTIONS"), "only publication asks");
  const large = checklistFixture();
  large.sections[0].questions = Array.from({ length: 201 }, () => newQuestion("SHORT_TEXT"));
  const codes = definitionIssues(large, false).map((i) => i.code);
  assert.ok(codes.includes("QUESTION_COUNT") && !codes.includes("NO_QUESTIONS"));
  assert.equal(issueMessage("NO_QUESTIONS", "en").startsWith("Add at least one question before publishing"), true);
  assert.equal(issueMessage("NO_QUESTIONS", "ar").startsWith("أضف سؤالاً واحداً على الأقل قبل النشر"), true);
  assert.notEqual(issueMessage("QUESTION_COUNT", "ar"), issueMessage("NO_QUESTIONS", "ar"));
  assert.equal(issueMessage("NOT_A_CODE", "en"), "Review the referenced field.");
});
