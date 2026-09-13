// Checkpoint F — the full functional journey.
//
// One real staff journey across two NEW synthetic organizations, driven through
// the product's own screens wherever a screen exists, with the real privacy
// processor, publication job, report renderer and attachment scanner run under
// their own credentials in between. Nothing is mocked. The respondent journeys
// the gate repeats on narrow screens and in both languages run in
// journey.spec.ts and accessibility.spec.ts; this file adds the respondents who
// answer THIS campaign in a browser, and the boundary checks around them.
//
// The tests are serial and share state: each one is a stage of one journey, so
// a failure names the stage that broke.
import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import pg from "pg";
import { configureGateway } from "../../src/gateway-db";
import { setCustodianSecret } from "../../src/key-custody";
import { exchange, instrument, finalize } from "../../src/respondent";
import { processCampaign } from "../../src/processor";
import { releaseCampaign } from "../../src/publication";
import { configureReport, reportPool, closeReportPool } from "../../src/report-db";
import { renderDueReports } from "../../src/report-worker";
import { configureScanner, scannerPool, closeScannerPool } from "../../src/scanner-db";
import { scanDueAttachments } from "../../src/attachment-worker";
import { formatInZone } from "../../src/zoned-time";
import {
  newIdentity,
  newQuestion,
  tr,
  type Instrument,
} from "../../src/instrument-input";

const STAFF = "http://127.0.0.1:3000";
const SURVEY = "http://localhost:3001";
const BUILTIN_Q = "44000000-0000-4000-8000-000000000001";
const BUILTIN_V = "44000000-0000-4000-9000-000000000001";
// Free text a respondent types. It must never appear on any staff surface.
const SECRET_TEXT = "نص-حر-سري-لا-يظهر-للموظفين";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

// ---- shared journey state ---------------------------------------------------
const stamp = Date.now().toString(36).toUpperCase();
const P = { code: `CFP${stamp}`, id: "" }; // primary organization, Arabic
const Q = { code: `CFQ${stamp}`, id: "" }; // second organization, English
const S = {
  deptCodes: [`CFA${stamp}`, `CFB${stamp}`],
  participantIds: [] as string[],
  names: [] as string[],
  questionnaireId: "",
  v1: "",
  v2: "",
  family: "",
  seriesId: "",
  r1: "",
  r2: "",
  r3: "",
  c1: "",
  links: [] as { name: string; token: string }[],
  comparisonId: "",
  reportHrefs: [] as string[],
  visitId: "",
  attachmentHref: "",
  qCampaign: "",
  qRound: "",
};

let admin: Page;
test.beforeAll(async ({ browser }) => {
  admin = await signedIn(browser, "admin");
});
test.afterAll(async () => {
  await admin.context().close();
});

// ---- helpers ------------------------------------------------------------------
async function signedIn(browser: Browser, identity: "admin" | "staff", viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${STAFF}/login`);
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption(identity);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${STAFF}/workspace`);
  return page;
}
const headers = (extra: Record<string, string> = {}) => ({
  Origin: STAFF,
  "Idempotency-Key": randomUUID(),
  ...extra,
});
async function api<T = Record<string, unknown>>(
  page: Page,
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  data?: unknown,
  extra: Record<string, string> = {},
  expected?: number,
): Promise<T> {
  const r = await page.request.fetch(`${STAFF}/api/v1/${path}`, {
    method,
    headers: method === "GET" ? { Origin: STAFF } : headers(extra),
    data: method === "GET" ? undefined : (data ?? {}),
    failOnStatusCode: false,
  });
  const text = await r.text();
  if (expected !== undefined) expect(r.status(), `${method} ${path}: ${text}`).toBe(expected);
  else expect(r.ok(), `${method} ${path}: ${r.status()} ${text}`).toBe(true);
  return (text ? JSON.parse(text).data : undefined) as T;
}
const setLocale = (page: Page, locale: "ar" | "en") =>
  api(page, "PATCH", "profile", { locale });
async function fixture() {
  return JSON.parse(await readFile("work/e2e-fixture.json", "utf8"));
}
async function operator() {
  const f = await fixture();
  const client = new pg.Client({ connectionString: f.migration });
  await client.connect();
  await client.query("SET ROLE orgfit_core_owner");
  return client;
}
const noOverflow = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);

function answersFor(d: Instrument, seed: number) {
  const out: Record<string, string | string[]> = {};
  for (const q of d.sections.flatMap((s) => s.questions)) {
    if (q.type === "RATING_5") out[q.id] = String((seed % 5) + 1);
    else if (q.type === "LONG_TEXT") out[q.id] = `${SECRET_TEXT} ${seed}`;
  }
  return out;
}
// Real acceptances through the gateway credential only.
async function submitThroughGateway(tokens: string[], seedBase: number) {
  const f = await fixture();
  process.env.INVITATION_DIGEST_KEY = f.invitationDigestKey;
  process.env.INVITATION_DIGEST_KEY_VERSION = f.invitationDigestKeyVersion;
  configureGateway(f.gateway);
  try {
    for (let i = 0; i < tokens.length; i++) {
      const opened = await exchange(tokens[i]);
      const d = (await instrument(opened.session!)).document;
      await finalize(opened.session!, { answers: answersFor(d, seedBase + i) });
    }
  } finally {
    configureGateway(undefined);
  }
}
async function processAndRelease(campaignId: string) {
  const f = await fixture();
  process.env.CAMPAIGN_KEY_CUSTODY_DIRECTORY = f.custodyDirectory;
  process.env.CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY = f.custodianPublicKey;
  setCustodianSecret(f.custodianSecretKey);
  const core = new pg.Pool({ connectionString: f.processor, max: 2 });
  const anon = new pg.Pool({ connectionString: f.anonymous, max: 2 });
  try {
    const processed = await processCampaign(core, anon, campaignId);
    const released = await releaseCampaign(core, anon, campaignId);
    return { processed, released };
  } finally {
    await core.end();
    await anon.end();
    setCustodianSecret(undefined);
  }
}
async function closeByApi(campaignId: string, org: string) {
  const db = await operator();
  const revision = (await db.query("select revision from core.campaign where id=$1", [campaignId])).rows[0]
    .revision as string;
  await db.end();
  await api(admin, "POST", `organizations/${org}/campaigns/${campaignId}/close`, { reason: "اكتمال الجمع" }, {
    "If-Match": `"${revision}"`,
  });
}
// A campaign on the given participants, launched, with every link issued.
async function campaignByApi(org: string, roundId: string, versionId: string, participantIds: string[]) {
  const created = await api<{ id: string; revision: string }>(admin, "POST", `organizations/${org}/campaigns`, {
    roundId,
    questionnaireVersionId: versionId,
    target: { mode: "SELECTED", participantIds },
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    timezone: "Asia/Riyadh",
  }, {}, 201);
  await api(admin, "POST", `organizations/${org}/campaigns/${created.id}/launch`, {}, {
    "If-Match": `"${created.revision}"`,
  });
  const list = await api<{ items: { invitationId: string; generation: number }[] }>(
    admin,
    "GET",
    `organizations/${org}/campaigns/${created.id}/participation`,
  );
  const tokens: string[] = [];
  for (const item of list.items) {
    const issued = await api<{ url: string }>(
      admin,
      "POST",
      `organizations/${org}/campaigns/${created.id}/invitations/${item.invitationId}/issue`,
      { expectedGeneration: item.generation },
    );
    tokens.push(issued.url.split("#")[1]);
  }
  return { campaignId: created.id, tokens };
}

// The scored instrument written into the cloned draft: one dimension of two
// ratings, an optional free-text question, an overall score, bands and one
// deterministic recommendation rule — all bilingual.
function scoredDocument(base: Instrument): Instrument {
  const d = structuredClone(base);
  d.locales = ["ar", "en"];
  d.title = tr("استبانة بيئة العمل — نقطة الفحص و", "Work environment — Checkpoint F");
  d.introduction = tr("", "");
  d.privacyText = tr("إشعار خصوصية تجريبي لنقطة الفحص.", "Synthetic Checkpoint F privacy notice.");
  const bands = () => [
    { ...newIdentity(), lower: "0", upper: "50", label: tr("منخفض", "Low"), severity: "HIGH" as const, semantic: "RISK" as const },
    { ...newIdentity(), lower: "50", upper: "100", label: tr("مرتفع", "High"), severity: "NONE" as const, semantic: "HEALTH" as const },
  ];
  const dimension = {
    ...newIdentity(),
    name: tr("الدعم", "Support"),
    description: tr("الدعم في العمل", "Support at work"),
    mode: "AVERAGE" as const,
    coverage: "0.5",
    direction: "HIGH_GOOD" as const,
    denominator: null,
    bands: bands(),
  };
  const rating = (ar: string, en: string) => {
    const q = newQuestion("RATING_5");
    q.prompt = tr(ar, en);
    q.dimensionId = dimension.id;
    q.scoring = { enabled: true, reverse: false, weight: "1", mode: "VALUE" };
    return q;
  };
  const text = newQuestion("LONG_TEXT");
  text.prompt = tr("ما الذي يمكن تحسينه؟", "What could improve?");
  text.required = false;
  d.dimensions = [dimension];
  d.sections = [
    {
      ...newIdentity(),
      title: tr("الدعم", "Support"),
      content: tr("", ""),
      questions: [rating("أجد الدعم اللازم.", "I get the support I need."), rating("أعرف إلى من أتوجه.", "I know whom to ask."), text],
    },
  ];
  d.overall = { enabled: true, direction: "HIGH_GOOD", inputs: [{ dimensionId: dimension.id, weight: "1", invert: false }], bands: bands() };
  d.recommendations = [
    {
      ...newIdentity(),
      target: { kind: "OVERALL" },
      groupScope: "COMPANY",
      condition: { mode: "ALL", clauses: [{ mode: "ALL", comparisons: [{ metric: { kind: "OVERALL" }, operator: "GTE", value: "0", upper: null }] }] },
      priority: 10,
      dedupKey: "support-review",
      exclusivityGroup: null,
      title: tr("مراجعة ممارسات الدعم", "Review support practices"),
      body: tr("النتيجة العامة {score} ضمن {band}.", "The overall score is {score}, within {band}."),
      action: tr("راجع توزيع الأعباء", "Review workload distribution"),
      rationale: tr("مبني على {metric}.", "Based on {metric}."),
      enabled: true,
    },
  ] as Instrument["recommendations"];
  return d;
}

// ============================================================================
test("F-1 organizations, departments and a participant import with errors, through the screens", async () => {
  await setLocale(admin, "ar");
  for (const [org, ar, en] of [
    [P, "منظمة نقطة الفحص و", "Checkpoint F organization"],
    [Q, "منظمة ثانية للفحص", "Second checkpoint organization"],
  ] as const) {
    await admin.goto(`${STAFF}/organizations`);
    await admin.getByRole("button", { name: "إضافة", exact: true }).click();
    await admin.getByLabel("الرمز *", { exact: true }).fill(org.code);
    await admin.getByLabel("الاسم بالعربية *", { exact: true }).fill(ar);
    await admin.getByLabel("الاسم بالإنجليزية").fill(en);
    await admin.getByRole("button", { name: "حفظ", exact: true }).click();
    await expect(admin.getByText("تم الحفظ.")).toBeVisible();
    const list = await api<{ items: { id: string; code: string }[] }>(admin, "GET", `organizations?q=${org.code}`);
    org.id = list.items.find((o) => o.code === org.code)!.id;
    expect(org.id).toMatch(/^[0-9a-f-]{36}$/);
  }

  await admin.goto(`${STAFF}/organizations/${P.id}/departments`);
  for (const [code, name] of [
    [S.deptCodes[0], "قسم الهندسة"],
    [S.deptCodes[1], "قسم العمليات"],
  ]) {
    await admin.getByRole("button", { name: "إضافة", exact: true }).click();
    await admin.getByLabel("الرمز *", { exact: true }).fill(code);
    await admin.getByLabel("الاسم بالعربية *", { exact: true }).fill(name);
    await admin.getByRole("button", { name: "حفظ", exact: true }).click();
    await expect(admin.getByText("تم الحفظ.")).toBeVisible();
  }

  // Twelve valid rows; one reference written twice (both copies are refused,
  // because neither can be trusted over the other); one unknown department.
  const rows = Array.from({ length: 12 }, (_, i) => `CF-${stamp}-${i},مشارك ${i + 1},${S.deptCodes[i % 2]}`);
  const csv = [
    "privateReference,displayName,departmentCode",
    ...rows,
    `CF-${stamp}-DUP,نسخة أولى,${S.deptCodes[0]}`,
    `CF-${stamp}-DUP,نسخة ثانية,${S.deptCodes[1]}`,
    `CF-${stamp}-BAD,قسم مجهول,NOPE`,
  ].join("\n");
  await admin.goto(`${STAFF}/organizations/${P.id}/participants`);
  await admin.getByRole("link", { name: "استيراد المشاركين" }).click();
  await admin.locator("input[type=file]").setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await admin.getByRole("button", { name: "رفع ومراجعة الملف" }).click();
  await expect(admin.getByRole("heading", { name: "مطابقة الأعمدة" })).toBeVisible();
  await admin.getByRole("button", { name: "معاينة والتحقق" }).click();
  await expect(admin.getByText("صفوف صحيحة: 12 · أخطاء: 3")).toBeVisible();
  await expect(admin.getByRole("button", { name: "اعتماد الصفوف الصحيحة" })).toBeDisabled();
  await admin.getByRole("checkbox").check();
  await admin.getByRole("button", { name: "اعتماد الصفوف الصحيحة" }).click();
  await expect(admin.getByText("اكتمل الاستيراد: 12")).toBeVisible();

  const people = await api<{ items: { id: string; private_reference: string; display_name: string }[] }>(
    admin,
    "GET",
    `organizations/${P.id}/participants?limit=100`,
  );
  const imported = people.items
    .filter((p) => /^CF-[A-Z0-9]+-\d+$/.test(p.private_reference) && p.private_reference.includes(stamp))
    .sort((a, b) => Number(a.private_reference.split("-").at(-1)) - Number(b.private_reference.split("-").at(-1)));
  expect(imported).toHaveLength(12);
  S.participantIds = imported.map((p) => p.id);
  S.names = imported.map((p) => p.display_name);

  // Organization Q: three people, entered one by one.
  const dept = await api<{ id: string }>(admin, "POST", `organizations/${Q.id}/departments`, { code: `CFQD${stamp}`, nameAr: "قسم", nameEn: "Team" }, {}, 201);
  for (let i = 0; i < 3; i++)
    await api(admin, "POST", `organizations/${Q.id}/participants`, { privateReference: `CFQ-${stamp}-${i}`, displayName: `Person ${i + 1}`, departmentId: dept.id }, {}, 201);
});

test("F-2 clone, edit, preview the scoring and publish an instrument", async () => {
  await admin.goto(`${STAFF}/questionnaires/${BUILTIN_Q}/versions/${BUILTIN_V}`);
  await admin.getByText("نسخ إلى استبيان مخصص مستقل", { exact: true }).click();
  await admin.getByLabel("عنوان النسخة المخصصة — العربية").fill("نسخة نقطة الفحص");
  await admin.getByLabel("عنوان النسخة المخصصة — English").fill("Checkpoint copy");
  await admin.getByRole("combobox", { name: "نطاق النسخة", exact: true }).selectOption(P.id);
  await admin.getByRole("button", { name: "إنشاء نسخة مخصصة" }).click();
  await expect(admin).toHaveURL(new RegExp(`/questionnaires/[0-9a-f-]{36}/versions/[0-9a-f-]{36}\\?organization=${P.id}`));
  const [, qid, vid] = admin.url().match(/questionnaires\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})/)!;
  S.questionnaireId = qid;
  S.v1 = vid;

  const versionPath = `organizations/${P.id}/questionnaires/${qid}/versions/${vid}`;
  const draft = await api<{ revision: string; document: Instrument; state: string }>(admin, "GET", versionPath);
  expect(draft.state).toBe("DRAFT");
  await api(admin, "PATCH", versionPath, scoredDocument(draft.document), { "If-Match": `"${draft.revision}"` });

  // Scoring preview in the browser: computed locally, nothing posted.
  await admin.goto(`${STAFF}/questionnaires/${qid}/versions/${vid}?organization=${P.id}`);
  await admin.getByRole("button", { name: "معاينة تجريبية", exact: true }).click();
  let writes = 0;
  const count = (r: { method(): string }) => {
    if (["POST", "PATCH", "PUT"].includes(r.method())) writes++;
  };
  admin.on("request", count);
  const compute = admin.getByRole("button", { name: "حساب الدرجات التجريبية", exact: true });
  await admin.getByRole("button", { name: "تعبئة أعلى القيم التجريبية", exact: true }).click();
  await compute.click();
  await expect(admin.getByText("100.0 / 100", { exact: true }).first()).toBeVisible();
  await admin.getByRole("combobox", { name: "أجد الدعم اللازم." }).selectOption("1");
  await admin.getByRole("combobox", { name: "أعرف إلى من أتوجه." }).selectOption("1");
  await compute.click();
  await expect(admin.getByText("0.0 / 100", { exact: true }).first()).toBeVisible();
  admin.off("request", count);
  expect(writes).toBe(0);

  await admin.getByRole("button", { name: "نشر النسخة وتثبيتها" }).click();
  await expect.poll(async () => (await api<{ state: string }>(admin, "GET", versionPath)).state).toBe("PUBLISHED");
  // Published content is immutable.
  const published = await api<{ revision: string; document: Instrument }>(admin, "GET", versionPath);
  await api(admin, "PATCH", versionPath, published.document, { "If-Match": `"${published.revision}"` }, 409);
  S.family = (await api<{ family_key: string }>(admin, "GET", `organizations/${P.id}/questionnaires/${qid}`)).family_key;
});

test("F-3 series, round and campaign through the screens; links obtained manually", async () => {
  await admin.goto(`${STAFF}/organizations/${P.id}/assessments`);
  await admin.getByLabel("اسم السلسلة").fill("سلسلة نقطة الفحص");
  await admin.getByLabel("الغرض").fill("رحلة كاملة");
  await admin.getByLabel("عائلة الاستبانة").fill(S.family);
  await admin.locator("form").filter({ hasText: "سلسلة جديدة" }).getByRole("button", { name: "إنشاء" }).click();
  await expect(admin.getByText("تم الحفظ.")).toBeVisible();
  const roundForm = admin.locator("form").filter({ hasText: "جولة جديدة" });
  await roundForm.getByLabel("اسم الجولة").fill("الجولة الأولى");
  await roundForm.getByLabel("بداية الفترة").fill("2026-01-01");
  await roundForm.getByLabel("نسخة الاستبانة المنشورة").fill(S.v1);
  await roundForm.getByRole("button", { name: "إنشاء" }).click();
  await expect(admin.getByRole("cell", { name: "الجولة الأولى" })).toBeVisible();

  const history = await api<{ items: { id: string; name_ar: string }[] }>(admin, "GET", `organizations/${P.id}/history`);
  S.seriesId = history.items.find((s) => s.name_ar === "سلسلة نقطة الفحص")!.id;
  const db = await operator();
  S.r1 = (await db.query("select id from core.assessment_round where series_id=$1 and label=$2", [S.seriesId, "الجولة الأولى"])).rows[0].id;
  await db.end();

  const form = admin.locator("form").filter({ hasText: "حملة جديدة" });
  await form.getByLabel("نسخة الاستبانة المنشورة").fill(S.v1);
  await form.getByLabel("نمط الاستهداف").selectOption("SELECTED");
  await form.getByLabel("معرّفات المشاركين (سطر لكل معرّف)").fill(S.participantIds.join("\n"));
  // The start is typed as a Riyadh wall-clock time, one minute ago.
  await form.getByLabel("بداية الجمع").fill(formatInZone(new Date(Date.now() - 60_000).toISOString(), "Asia/Riyadh").replace(" ", "T"));
  await form.getByRole("button", { name: "إنشاء" }).click();
  await expect(admin).toHaveURL(new RegExp(`/organizations/${P.id}/campaigns/[0-9a-f-]{36}$`));
  S.c1 = admin.url().split("/").at(-1)!;
  await expect(admin.getByText("عدد المدعوين: 12")).toBeVisible();
  await admin.getByRole("button", { name: "إطلاق الحملة" }).click();
  await expect(admin.getByText("مفتوحة")).toBeVisible();
  await expect(admin.getByText("بانتظار الإجابة: 12", { exact: false })).toBeVisible();

  // Each link is generated by hand and shown once.
  for (let i = 0; i < 12; i++) {
    await admin.getByRole("button", { name: "توليد رابط", exact: true }).first().click();
    await expect(admin.getByRole("textbox", { name: "نسخ الرابط" })).toHaveCount(i + 1);
  }
  for (const row of await admin.locator("tr").filter({ has: admin.getByRole("textbox", { name: "نسخ الرابط" }) }).all()) {
    const box = row.getByRole("textbox", { name: "نسخ الرابط" });
    const url = await box.inputValue();
    expect(url).toMatch(/^http:\/\/localhost:3001\/s#[A-Za-z0-9_-]{43}$/);
    // Left-to-right on an Arabic page, so the link reads as it will be pasted.
    await expect(box).toHaveAttribute("dir", "ltr");
    const text = (await row.textContent()) ?? "";
    // Longest name first, so "مشارك 1" never matches the row of "مشارك 12".
    const name = [...S.names].sort((a, b) => b.length - a.length).find((n) => text.includes(n)) ?? "";
    S.links.push({ name, token: url.split("#")[1] });
  }
  expect(S.links).toHaveLength(12);
  expect(S.links.every((l) => l.name)).toBe(true);
  await admin.reload();
  await expect(admin.getByRole("textbox", { name: "نسخ الرابط" })).toHaveCount(0, { timeout: 15_000 });
});

test("F-4 respondents save, resume on another device and submit in both languages; the outstanding list is live", async ({ browser }) => {
  // ---- respondent 1: Arabic, 320px phone, saves and moves device --------------
  const phone = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
  const p1 = await phone.newPage();
  p1.on("dialog", (d) => void d.accept());
  await p1.goto(`${SURVEY}/s#${S.links[0].token}`);
  await expect(p1.locator("html")).toHaveAttribute("dir", "rtl");
  await p1.getByRole("button", { name: "ابدأ الاستبانة" }).click();
  const radios = p1.locator(".scale");
  await radios.nth(0).getByRole("radio", { name: "4", exact: true }).check();
  await p1.getByLabel("ما الذي يمكن تحسينه؟").fill(`${SECRET_TEXT} الهاتف`);
  await p1.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(p1.getByTestId("save-status")).toHaveText("تم الحفظ");
  await p1.screenshot({ path: "work/cf-respondent-ar-320.png", fullPage: true });
  const code = (await p1.getByTestId("resume-code").textContent())!.trim();
  // Only the handle, key and revision are kept on the device — never an answer.
  const local = await p1.evaluate(() => window.localStorage.getItem("orgfit.survey.draft") ?? "");
  expect(local).not.toContain(SECRET_TEXT);
  expect(Object.keys(JSON.parse(local)).sort()).toEqual(["handle", "key", "revision"]);
  await noOverflow(p1);
  await phone.close();

  // The saved draft is ciphertext at rest.
  const db = await operator();
  const blobs = await db.query(
    `select encode(d.ciphertext,'escape') blob from intake.draft_blob d join core.invitation i on i.id=d.invitation_id where i.campaign_id=$1`,
    [S.c1],
  );
  expect(blobs.rows).toHaveLength(1);
  expect(blobs.rows[0].blob).not.toContain(SECRET_TEXT);

  // Second device, keyboard only for the missing answer, then submit.
  const laptop = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const p1b = await laptop.newPage();
  await p1b.goto(`${SURVEY}/s#${S.links[0].token}`);
  await p1b.getByRole("button", { name: "استئناف من جهاز آخر" }).click();
  await p1b.getByTestId("resume-code-input").fill(code);
  await p1b.keyboard.press("Enter");
  await expect(p1b.getByTestId("save-status")).toHaveText("تم الحفظ");
  await expect(p1b.getByLabel("ما الذي يمكن تحسينه؟")).toHaveValue(`${SECRET_TEXT} الهاتف`);
  const second = p1b.locator(".scale").nth(1).getByRole("radio", { name: "5", exact: true });
  await second.focus();
  await p1b.keyboard.press("Space");
  await expect(second).toBeChecked();
  // A Arabic-Indic-digit payload the instrument forbids is refused by the
  // server, not by the page alone, and consumes nothing.
  const forged = await p1b.request.post(`${SURVEY}/public/v1/finalize`, {
    headers: { Origin: SURVEY, "content-type": "application/json" },
    data: { answers: { "not-a-question": "٩" } },
    failOnStatusCode: false,
  });
  expect(forged.status()).toBe(422);
  await p1b.getByRole("button", { name: "مراجعة الإجابات" }).click();
  await p1b.getByRole("button", { name: "إرسال نهائي" }).click();
  await p1b.getByRole("button", { name: "تأكيد وإرسال" }).click();
  await expect(p1b.getByRole("heading", { name: "تم استلام إجاباتك" })).toBeVisible();
  await laptop.close();

  // ---- respondent 2: English, 375px ---------------------------------------
  const en = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const p2 = await en.newPage();
  await p2.goto(`${SURVEY}/s#${S.links[1].token}`);
  await p2.getByTestId("locale-toggle").click();
  await expect(p2.locator("html")).toHaveAttribute("dir", "ltr");
  await p2.getByRole("button", { name: "Start the questionnaire" }).click();
  // Review before answering names both missing questions and blocks submission.
  await p2.getByRole("button", { name: "Review your answers" }).click();
  await expect(p2.getByText("Required questions still unanswered:")).toBeVisible();
  await expect(p2.getByRole("button", { name: "Submit final answers" })).toBeDisabled();
  await p2.getByRole("button", { name: "I get the support I need." }).click();
  await p2.locator(".scale").nth(0).getByRole("radio", { name: "3", exact: true }).check();
  await p2.locator(".scale").nth(1).getByRole("radio", { name: "3", exact: true }).check();
  await p2.getByRole("button", { name: "Review your answers" }).click();
  await p2.getByRole("button", { name: "Submit final answers" }).click();
  await p2.getByRole("button", { name: "Confirm and submit" }).click();
  await expect(p2.getByRole("heading", { name: "Your answers were received" })).toBeVisible();
  await p2.screenshot({ path: "work/cf-respondent-en-375-accepted.png", fullPage: true });
  await noOverflow(p2);
  await en.close();

  // ---- the staff member sees completion live, and never an answer ----------
  await admin.goto(`${STAFF}/organizations/${P.id}/campaigns/${S.c1}`);
  await expect(admin.getByText("بانتظار الإجابة: 10", { exact: false })).toBeVisible();
  // Nine more through the gateway; one person stays outstanding.
  await submitThroughGateway(S.links.slice(2, 11).map((l) => l.token), 2);
  await admin.reload();
  await expect(admin.getByText("بانتظار الإجابة: 1", { exact: false })).toBeVisible();
  const rowOf = (name: string) =>
    admin.getByRole("row").filter({ has: admin.getByRole("cell", { name, exact: true }) });
  const outstanding = rowOf(S.links[11].name);
  await expect(outstanding.getByText("لم تُسلَّم بعد")).toBeVisible();
  await admin.screenshot({ path: "work/cf-participation-ar.png", fullPage: true });
  await expect(rowOf(S.links[0].name).getByText("مكتملة")).toBeVisible();
  const participation = await admin.request.get(`${STAFF}/api/v1/organizations/${P.id}/campaigns/${S.c1}/participation`, { headers: { Origin: STAFF } });
  const projection = await participation.text();
  expect(projection).not.toContain(SECRET_TEXT);
  for (const l of S.links) expect(projection).not.toContain(l.token);
  expect(await admin.locator("main").textContent()).not.toContain(SECRET_TEXT);
});

test("F-5 close, process and publish; safe analytics and recommendations", async () => {
  await admin.goto(`${STAFF}/organizations/${P.id}/campaigns/${S.c1}`);
  const closeForm = admin.locator("form").filter({ hasText: "إغلاق الجمع" });
  await closeForm.getByLabel("السبب").fill("انتهت فترة الجمع");
  await closeForm.getByRole("button", { name: "إغلاق الجمع" }).click();
  await expect(admin.getByText("مغلقة", { exact: true })).toBeVisible();

  const { processed, released } = await processAndRelease(S.c1);
  expect(processed.processedCount).toBe(11);
  expect(released.state).toBe("PUBLISHED");
  // Intake is purged once the anonymous batch is proven.
  const db = await operator();
  const intake = await db.query(
    `select (select count(*)::int from intake.submission_inbox e join core.invitation i on i.id=e.invitation_id where i.campaign_id=$1) envelopes,
            (select count(*)::int from intake.draft_blob d join core.invitation i on i.id=d.invitation_id where i.campaign_id=$1) drafts`,
    [S.c1],
  );
  await db.end();
  expect(intake.rows[0]).toEqual({ envelopes: 0, drafts: 0 });

  await admin.reload();
  await admin.getByRole("link", { name: "عرض النتائج المنشورة" }).click();
  await expect(admin).toHaveURL(`${STAFF}/organizations/${P.id}/results/${S.r1}`);
  await expect(admin.locator(".tile").filter({ hasText: "عدد المساهمين" }).getByText("11")).toBeVisible();
  await admin.getByRole("button", { name: "الأقسام", exact: true }).click();
  await expect(admin.getByRole("columnheader", { name: "قسم الهندسة" })).toBeVisible();
  await expect(admin.getByRole("columnheader", { name: "قسم العمليات" })).toBeVisible();
  await admin.getByRole("button", { name: "التوصيات", exact: true }).click();
  await expect(admin.getByText("مراجعة ممارسات الدعم").first()).toBeVisible();
  await admin.getByRole("button", { name: "تحليل الأسئلة", exact: true }).click();
  await expect(admin.getByText("لا يمكن للنظام إظهار إجابة فرد", { exact: false })).toBeVisible();
  expect(await admin.locator("body").textContent()).not.toContain(SECRET_TEXT);
  for (const view of ["", "/departments", "/questions", "/recommendations"]) {
    const r = await admin.request.get(`${STAFF}/api/v1/organizations/${P.id}/assessments/${S.r1}/results${view}`, { headers: { Origin: STAFF } });
    expect(r.status()).toBe(200);
    const body = await r.text();
    expect(body).not.toContain(SECRET_TEXT);
    for (const id of S.participantIds) expect(body).not.toContain(id);
    // No filter a staff member could use to narrow to a person.
    const filtered = await admin.request.get(`${STAFF}/api/v1/organizations/${P.id}/assessments/${S.r1}/results${view}?participantId=${S.participantIds[0]}`, { headers: { Origin: STAFF }, failOnStatusCode: false });
    expect(filtered.status()).toBe(400);
  }
  await admin.setViewportSize({ width: 320, height: 800 });
  await noOverflow(admin);
  await admin.screenshot({ path: "work/cf-results-ar-320.png", fullPage: true });
  await admin.setViewportSize({ width: 1280, height: 900 });
});

test("F-6 a second compatible round is compared; an incompatible version is refused", async () => {
  // Round 2: same series, same version, ten contributors.
  await api(admin, "POST", `organizations/${P.id}/assessments`, {
    seriesId: S.seriesId, label: "الجولة الثانية", periodStart: "2026-06-01", questionnaireVersionId: S.v1, populationDefinition: { schemaVersion: 1 },
  }, {}, 201);
  const db = await operator();
  const roundOf = async (label: string) =>
    (await db.query("select id from core.assessment_round where series_id=$1 and label=$2", [S.seriesId, label])).rows[0].id as string;
  S.r2 = await roundOf("الجولة الثانية");
  const c2 = await campaignByApi(P.id, S.r2, S.v1, S.participantIds);
  await submitThroughGateway(c2.tokens.slice(0, 10), 20);
  await closeByApi(c2.campaignId, P.id);
  expect((await processAndRelease(c2.campaignId)).released.state).toBe("PUBLISHED");

  // Version 2 re-specifies a scored item: the same rating now scores in reverse.
  const v1Path = `organizations/${P.id}/questionnaires/${S.questionnaireId}/versions/${S.v1}`;
  const v1 = await api<{ revision: string }>(admin, "GET", v1Path);
  const next = await api<{ id: string; revision: string; document: Instrument }>(admin, "POST", `${v1Path}/new-version`, {}, { "If-Match": `"${v1.revision}"` }, 201);
  S.v2 = next.id;
  const doc = structuredClone(next.document);
  const rating = doc.sections[0].questions.find((q) => q.type === "RATING_5")!;
  rating.scoring = { ...rating.scoring, reverse: true };
  const v2Path = `organizations/${P.id}/questionnaires/${S.questionnaireId}/versions/${S.v2}`;
  const saved = await api<{ revision: string }>(admin, "PATCH", v2Path, doc, { "If-Match": `"${next.revision}"` });
  await api(admin, "POST", `${v2Path}/publish`, {}, { "If-Match": `"${saved.revision}"` });
  await api(admin, "POST", `organizations/${P.id}/assessments`, {
    seriesId: S.seriesId, label: "الجولة الثالثة", periodStart: "2026-09-01", questionnaireVersionId: S.v2, populationDefinition: { schemaVersion: 1 },
  }, {}, 201);
  S.r3 = await roundOf("الجولة الثالثة");
  await db.end();
  const c3 = await campaignByApi(P.id, S.r3, S.v2, S.participantIds);
  await submitThroughGateway(c3.tokens.slice(0, 8), 40);
  await closeByApi(c3.campaignId, P.id);
  expect((await processAndRelease(c3.campaignId)).released.state).toBe("PUBLISHED");

  // The compatible pair, reviewed through the history screen.
  await admin.goto(`${STAFF}/organizations/${P.id}/history/${S.seriesId}`);
  const section = admin.locator("section").filter({ has: admin.getByRole("heading", { name: "مراجعة مقارنة جديدة" }) });
  await section.getByLabel("الجولة الأقدم").selectOption(S.r1);
  await section.getByLabel("الجولة الأحدث").selectOption(S.r2);
  await section.getByRole("button", { name: "فحص التوافق" }).click();
  await expect(section.getByText("نسخة واحدة مطابقة", { exact: false })).toBeVisible();
  await section.getByLabel("مسوّغ المراجعة").fill("النسخة نفسها والمجتمع نفسه");
  await section.getByRole("button", { name: "حفظ المراجعة" }).click();
  await expect(admin.getByRole("table", { name: "المقارنة" })).toBeVisible();
  await admin.screenshot({ path: "work/cf-history-ar.png", fullPage: true });
  // CF-002: the Arabic classification is set as words in the page's face and
  // direction, never in the mono LTR readout that pulls Arabic letters apart;
  // and the arrow between the two rounds follows the reading direction.
  const fact = admin.locator("dd.fact-text").first();
  await expect(fact).toHaveText("نسخة واحدة مطابقة");
  expect(await fact.evaluate((el) => [getComputedStyle(el).fontFamily, getComputedStyle(el).direction].join("|"))).not.toMatch(/Mono|\|ltr$/);
  await expect(admin.getByRole("heading", { name: "الجولة الأولى ← الجولة الثانية" })).toBeVisible();
  // CF-004: every signed change in the Arabic table is isolated left to right,
  // so "-5.7" cannot print as "5.7-".
  const changes = admin.getByRole("table", { name: "المقارنة" }).locator("tbody td:nth-child(4), tbody td:nth-child(5)");
  for (const cell of await changes.all())
    await expect(cell.locator('bdi[dir="ltr"]')).toHaveCount(1);
  // …and so is a date written beside Arabic words in the comparisons list.
  await expect(admin.getByRole("button", { name: /نسخة واحدة مطابقة/ }).locator('bdi[dir="ltr"]')).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
  const comparisons = await api<{ items: { id: string; classification: string }[] }>(admin, "GET", `organizations/${P.id}/comparisons?seriesId=${S.seriesId}`);
  const identical = comparisons.items.find((c) => c.classification === "IDENTICAL");
  expect(identical).toBeTruthy();
  S.comparisonId = identical!.id;
  // The changed-population disclosure is printed with the comparison (P-009).
  await expect(admin.getByRole("heading", { name: /تنبيهات|caveat/i }).first()).toBeVisible();

  // The incompatible pair: the screen says the metric is not equivalent, and
  // the server refuses an equivalence claim for it.
  await section.getByLabel("الجولة الأقدم").selectOption(S.r1);
  await section.getByLabel("الجولة الأحدث").selectOption(S.r3);
  await section.getByRole("button", { name: "فحص التوافق" }).click();
  await expect(section.getByRole("note")).toBeVisible();
  const proposal = await api<{ pairs: { leftKey: string; rightKey: string; equivalent: boolean }[] }>(admin, "GET", `organizations/${P.id}/comparisons/proposal?left=${S.r1}&right=${S.r3}`);
  const changed = proposal.pairs.filter((p) => !p.equivalent);
  expect(changed.length).toBeGreaterThan(0);
  await api(admin, "POST", `organizations/${P.id}/comparisons`, {
    leftRoundId: S.r1, rightRoundId: S.r3, classification: "REVIEWED_EQUIVALENT",
    mapping: changed.map((p) => ({ leftKey: p.leftKey, rightKey: p.rightKey })), rationale: "محاولة مطابقة غير صحيحة",
  }, {}, 422);
});

test("F-7 Arabic and English PDF and XLSX from the reports screen, organization-scoped and free of answers", async () => {
  await admin.goto(`${STAFF}/organizations/${P.id}/results/${S.r2}`);
  await admin.getByRole("button", { name: "التقارير", exact: true }).click();
  const requests = [["PDF", "ar"], ["XLSX", "ar"], ["PDF", "en"], ["XLSX", "en"]] as const;
  for (const [n, [format, locale]] of requests.entries()) {
    await admin.getByLabel("الصيغة").selectOption(format);
    await admin.getByLabel("لغة التقرير").selectOption(locale);
    await admin.getByRole("button", { name: "طلب تقرير" }).click();
    // Every request is stored before the renderer runs: a job left behind would
    // be rendered later inside another spec.
    await expect(admin.getByRole("cell", { name: "في الانتظار" })).toHaveCount(n + 1);
  }
  const f = await fixture();
  process.env.REPORT_ENCRYPTION_KEY = f.reportEncryptionKey;
  process.env.REPORT_LOCAL_DIRECTORY = f.reportDirectory;
  configureReport(f.report);
  try {
    const outcomes = await renderDueReports(reportPool(), 8);
    expect(outcomes.map((o) => o.state)).toEqual(["READY", "READY", "READY", "READY"]);
    // A PDF render reports its network attempts (none); a workbook uses no
    // browser and reports null.
    expect(outcomes.every((o) => !o.networkAttempts)).toBe(true);
  } finally {
    await closeReportPool();
    configureReport(undefined);
  }
  await admin.reload();
  await admin.getByRole("button", { name: "التقارير", exact: true }).click();
  const links = admin.getByRole("link", { name: "تنزيل" });
  await expect(links).toHaveCount(4);
  for (const link of await links.all()) S.reportHrefs.push((await link.getAttribute("href"))!);

  const seen = { pdf: 0, xlsxAr: 0, xlsxEn: 0 };
  for (const href of S.reportHrefs) {
    const r = await admin.request.get(`${STAFF}${href}`, { headers: { Origin: STAFF } });
    expect(r.status()).toBe(200);
    expect(r.headers()["cache-control"]).toBe("no-store");
    expect(r.headers()["content-disposition"]).toContain("attachment");
    const bytes = Buffer.from(await r.body());
    const n = S.reportHrefs.indexOf(href);
    await writeFile(`work/cf-report-${n}.${r.headers()["content-type"] === "application/pdf" ? "pdf" : "xlsx"}`, bytes);
    if (r.headers()["content-type"] === "application/pdf") {
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      seen.pdf++;
      continue;
    }
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as unknown as ArrayBuffer);
    const strings: string[] = [];
    book.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => strings.push(String(cell.value ?? "")))));
    const all = strings.join("\n");
    expect(all).not.toContain(SECRET_TEXT);
    for (const name of S.names) expect(all).not.toContain(name);
    for (const id of S.participantIds) expect(all).not.toContain(id);
    const rtl = book.worksheets[0].views[0]?.rightToLeft === true;
    if (/[؀-ۿ]/.test(book.worksheets[0].name) || rtl) {
      expect(rtl).toBe(true);
      seen.xlsxAr++;
    } else seen.xlsxEn++;
  }
  expect(seen).toEqual({ pdf: 2, xlsxAr: 1, xlsxEn: 1 });
});

test("F-8 a field visit with a follow-up and a scanned attachment", async () => {
  await admin.goto(`${STAFF}/organizations/${P.id}/visits`);
  await admin.getByRole("button", { name: "زيارة جديدة" }).click();
  await admin.getByLabel("الغرض").fill("زيارة ميدانية بعد نشر النتائج");
  await admin.getByLabel("بداية الزيارة").fill("2026-10-12T09:30");
  await admin.getByRole("button", { name: "حفظ" }).click();
  await expect(admin).toHaveURL(/\/visits\/[0-9a-f-]{36}$/);
  S.visitId = admin.url().split("/").at(-1)!;
  await expect(admin.getByRole("definition").filter({ hasText: "2026-10-12 09:30 Asia/Riyadh" })).toBeVisible();
  await admin.getByRole("button", { name: "جدولة" }).click();
  await admin.getByRole("button", { name: "إجراء متابعة جديد" }).click();
  await admin.getByLabel("العنوان").fill("مراجعة توزيع الأعباء مع الإدارة");
  await admin.getByLabel("تاريخ الاستحقاق").fill("2026-11-01");
  await admin.locator("form").getByRole("button", { name: "حفظ" }).click();
  await expect(admin.getByRole("rowheader", { name: "مراجعة توزيع الأعباء مع الإدارة" })).toBeVisible();
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
  await admin.getByLabel("إضافة مرفق").setInputFiles({ name: "محضر.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(admin.getByRole("cell", { name: "في الحجر — بانتظار الفحص" })).toBeVisible();
  await expect(admin.getByRole("link", { name: "تنزيل" })).toHaveCount(0);

  const f = await fixture();
  process.env.ATTACHMENT_ENCRYPTION_KEY = f.attachmentEncryptionKey;
  process.env.ATTACHMENT_LOCAL_DIRECTORY = f.attachmentDirectory;
  configureScanner(f.scanner);
  try {
    const outcomes = await scanDueAttachments(scannerPool(), 10);
    expect(outcomes.some((o) => o.state === "CLEAN")).toBe(true);
  } finally {
    await closeScannerPool();
    configureScanner(undefined);
  }
  await admin.reload();
  await expect(admin.getByRole("cell", { name: "مفحوص وسليم" })).toBeVisible();
  await admin.screenshot({ path: "work/cf-visit-ar.png", fullPage: true });
  S.attachmentHref = (await admin.getByRole("link", { name: "تنزيل" }).getAttribute("href"))!;
  const r = await admin.request.get(`${STAFF}${S.attachmentHref}`, { headers: { Origin: STAFF } });
  expect(r.status()).toBe(200);
  expect(Buffer.from(await r.body())).toEqual(pdf);
});

test("F-9 organization Q: a below-threshold campaign releases nothing, in English", async () => {
  await setLocale(admin, "en");
  const people = await api<{ items: { id: string; private_reference: string }[] }>(admin, "GET", `organizations/${Q.id}/participants?limit=100`);
  const ids = people.items.map((p) => p.id);
  expect(ids).toHaveLength(3);
  const questionnaire = await api<{ family_key: string }>(admin, "GET", `questionnaires/${BUILTIN_Q}`);
  const series = await api<{ id: string }>(admin, "POST", `organizations/${Q.id}/assessment-series`, { nameAr: "سلسلة قصيرة", purpose: "حالة دون الحد", questionnaireFamilyId: questionnaire.family_key }, {}, 201);
  const round = await api<{ id: string }>(admin, "POST", `organizations/${Q.id}/assessments`, { seriesId: series.id, label: "Small round", periodStart: "2026-07-01", questionnaireVersionId: BUILTIN_V, populationDefinition: { schemaVersion: 1 } }, {}, 201);
  S.qRound = round.id;
  const c = await campaignByApi(Q.id, round.id, BUILTIN_V, ids);
  S.qCampaign = c.campaignId;
  await submitThroughGateway(c.tokens, 60);
  await closeByApi(c.campaignId, Q.id);
  const { processed, released } = await processAndRelease(c.campaignId);
  // Below five, nothing is decrypted and nothing is released.
  expect(processed.processedCount ?? 0).toBe(0);
  expect(released.state).toBe("INSUFFICIENT_DATA");

  await admin.goto(`${STAFF}/organizations/${Q.id}/campaigns/${c.campaignId}`);
  await expect(admin.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(admin.getByRole("link", { name: "View published results" })).toHaveCount(0);
  // The campaign states the final outcome itself (CF-003).
  await expect(admin.getByText("so no results will ever be published for it", { exact: false })).toBeVisible();
  await admin.goto(`${STAFF}/organizations/${Q.id}/results/${round.id}`);
  // Never "will be available": this round closed below the threshold (CF-003).
  await expect(admin.getByText("never if fewer people than the threshold took part", { exact: false })).toBeVisible();
  await expect(admin.getByText("Results will be available", { exact: false })).toHaveCount(0);
  await expect(admin.locator(".tile").filter({ hasText: "Contributors" })).toHaveCount(0);
  await admin.screenshot({ path: "work/cf-below-threshold-en.png", fullPage: true });
  await setLocale(admin, "ar");
});

test("F-10 organization scoping: a staff member of Q cannot reach P's results, reports, visits or attachment", async ({ browser }) => {
  const staff = await api<{ items: { id: string; email: string; role: string; status: string; revision: string | number }[] }>(admin, "GET", "staff");
  const member = staff.items.find((s) => s.role === "STAFF" && s.status === "ACTIVE" && s.email?.includes("staff"))!;
  expect(member).toBeTruthy();
  // The list carries no access detail, so the original assignment is read from
  // the database and put back exactly afterwards: later specs sign in as this
  // member and depend on it.
  const db = await operator();
  const original = {
    role: member.role,
    status: member.status,
    capabilities: (await db.query("select capability from access.staff_capability where staff_user_id=$1 order by capability", [member.id])).rows.map((r) => r.capability as string),
    organizationIds: (await db.query("select organization_id from access.organization_access where staff_user_id=$1 order by organization_id", [member.id])).rows.map((r) => r.organization_id as string),
  };
  await db.end();
  const replace = async (body: unknown) => {
    const fresh = (await api<{ items: { id: string; revision: string | number }[] }>(admin, "GET", "staff")).items.find((s) => s.id === member.id)!;
    await api(admin, "PATCH", `staff/${member.id}`, body, { "If-Match": `"${fresh.revision}"` });
  };
  await replace({ role: "STAFF", status: "ACTIVE", capabilities: ["directory.manage", "campaigns.manage", "participation.read", "results.read", "reports.manage", "visits.manage", "instruments.manage"], organizationIds: [Q.id] });
  try {
    const page = await signedIn(browser, "staff");
    const get = (path: string) => page.request.get(`${STAFF}${path}`, { headers: { Origin: STAFF }, failOnStatusCode: false }).then((r) => r.status());
    // Its own organization answers.
    expect(await get(`/api/v1/organizations/${Q.id}/campaigns/${S.qCampaign}/participation`)).toBe(200);
    // Every P resource is indistinguishable from one that does not exist.
    for (const path of [
      `/api/v1/organizations/${P.id}/assessments/${S.r1}/results`,
      `/api/v1/organizations/${P.id}/history/${S.seriesId}`,
      `/api/v1/organizations/${P.id}/comparisons/${S.comparisonId}`,
      `/api/v1/organizations/${P.id}/visits/${S.visitId}`,
      `/api/v1/organizations/${P.id}/campaigns/${S.c1}/participation`,
      S.reportHrefs[0],
      S.attachmentHref,
    ])
      expect([403, 404], path).toContain(await get(path));
    // Substituting Q into a P identifier does not reach P's rows either.
    for (const path of [
      `/api/v1/organizations/${Q.id}/visits/${S.visitId}`,
      `/api/v1/organizations/${Q.id}/assessments/${S.r1}/results`,
      S.reportHrefs[0].replace(P.id, Q.id),
      S.attachmentHref.replace(P.id, Q.id),
    ])
      expect([403, 404], path).toContain(await get(path));
    // A report request naming P's round from Q is refused.
    const request = await page.request.post(`${STAFF}/api/v1/organizations/${Q.id}/reports`, {
      headers: headers(), data: { roundId: S.r2, format: "PDF", locale: "ar" }, failOnStatusCode: false,
    });
    expect([403, 404, 422]).toContain(request.status());
    // And the screens say so instead of rendering P's data.
    await page.goto(`${STAFF}/organizations/${P.id}/visits/${S.visitId}`);
    await expect(page.getByText("زيارة ميدانية بعد نشر النتائج")).toHaveCount(0);
    await page.context().close();
  } finally {
    await replace(original);
  }
});
