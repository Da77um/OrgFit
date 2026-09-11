import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { ids } from "../../scripts/seed";

const STAFF = "http://127.0.0.1:3000";
const SURVEY = "http://localhost:3001";
const BUILTIN_VERSION = "44000000-0000-4000-9000-000000000001";
const BUILTIN_QUESTIONNAIRE = "44000000-0000-4000-8000-000000000001";

// The full respondent journey, driven through the real public origin: fragment
// exchange, welcome and privacy notice, sections, encrypted save, cross-device
// resume with the private code, review, confirmation and the locked accepted
// state. Nothing here is mocked; the staff side genuinely issues the link.
async function issueLink(page: Page) {
  await page.goto(`${STAFF}/login`);
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${STAFF}/`);

  const headers = () => ({ Origin: STAFF, "Idempotency-Key": randomUUID() });
  const base = `${STAFF}/api/v1/organizations/${ids.orgA}`;
  const stamp = Date.now().toString(36).toUpperCase();

  const department = await page.request.post(`${base}/departments`, {
    headers: headers(),
    data: { code: `RESP${stamp}`, nameAr: "قسم المشاركين" },
  });
  expect(department.status()).toBe(201);
  const departmentId = (await department.json()).data.id as string;
  const person = await page.request.post(`${base}/participants`, {
    headers: headers(),
    data: {
      privateReference: `RESP-${stamp}`,
      displayName: "مشارك الاستبانة",
      departmentId,
    },
  });
  expect(person.status()).toBe(201);
  const participantId = (await person.json()).data.id as string;

  const family = (
    await (
      await page.request.get(
        `${STAFF}/api/v1/questionnaires/${BUILTIN_QUESTIONNAIRE}`,
        { headers: { Origin: STAFF } },
      )
    ).json()
  ).data.family_key as string;
  const series = await page.request.post(`${base}/assessment-series`, {
    headers: headers(),
    data: {
      nameAr: "سلسلة المشاركين",
      purpose: "رحلة المشارك عبر المتصفح",
      questionnaireFamilyId: family,
    },
  });
  expect(series.status()).toBe(201);
  const round = await page.request.post(`${base}/assessments`, {
    headers: headers(),
    data: {
      seriesId: (await series.json()).data.id,
      label: "جولة المشاركين",
      periodStart: "2026-03-01",
      questionnaireVersionId: BUILTIN_VERSION,
      populationDefinition: { schemaVersion: 1 },
    },
  });
  expect(round.status()).toBe(201);
  const campaign = await page.request.post(`${base}/campaigns`, {
    headers: headers(),
    data: {
      roundId: (await round.json()).data.id,
      questionnaireVersionId: BUILTIN_VERSION,
      target: { mode: "SINGLE", participantId },
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      timezone: "Asia/Riyadh",
    },
  });
  expect(campaign.status()).toBe(201);
  const created = (await campaign.json()).data as {
    id: string;
    revision: string;
  };
  const launched = await page.request.post(
    `${base}/campaigns/${created.id}/launch`,
    { headers: { ...headers(), "If-Match": `"${created.revision}"` }, data: {} },
  );
  expect(launched.status()).toBe(200);

  const list = await (
    await page.request.get(`${base}/campaigns/${created.id}/participation`, {
      headers: { Origin: STAFF },
    })
  ).json();
  const invitation = list.data.items[0];
  const issued = await page.request.post(
    `${base}/campaigns/${created.id}/invitations/${invitation.invitationId}/issue`,
    { headers: headers(), data: { expectedGeneration: invitation.generation } },
  );
  expect(issued.status()).toBe(200);
  const url = (await issued.json()).data.url as string;
  return { url, campaignId: created.id, invitationId: invitation.invitationId };
}

test("Arabic respondent journey: privacy notice, encrypted save, resume code, submission and lock", async ({
  page,
  context,
}) => {
  const { url, campaignId, invitationId } = await issueLink(page);
  const token = url.split("#")[1];

  // ---- opening the link --------------------------------------------------
  await page.goto(`${SURVEY}/s#${token}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The credential is removed from the address bar and from history at once.
  expect(page.url()).toBe(`${SURVEY}/s`);
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  // The privacy notice states both what is protected and what is not.
  await expect(page.getByRole("heading", { name: "كيف تُعالَج إجاباتك" })).toBeVisible();
  // The campaign's own frozen notice is shown, not a generic default.
  await expect(
    page.getByText("يجب استبداله بإشعار الخصوصية المعتمد", { exact: false }),
  ).toBeVisible();
  // The standing limits are shown alongside it, never only in a policy page.
  await expect(
    page.getByText("ولا يمكن للنظام إثبات من استخدم الرابط", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("وليست ضمانًا رياضيًا", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("يستطيع من يستخدم المتصفح نفسه", { exact: false }),
  ).toBeVisible();

  // ---- answering and saving ---------------------------------------------
  await page.getByRole("button", { name: "ابدأ الاستبانة" }).click();
  await expect(page.getByText("القسم 1 من 1")).toBeVisible();
  await page.getByRole("radio", { name: "4", exact: true }).check();
  await expect(page.getByTestId("save-status")).toHaveText("لم تُحفظ التغييرات بعد");

  await page.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(page.getByTestId("save-status")).toHaveText("تم الحفظ");
  const resumeCode = (await page.getByTestId("resume-code").textContent())!.trim();
  expect(resumeCode).toMatch(/^DF1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText("ولا يملك فريق OrgFit نسخة منه", { exact: false })).toBeVisible();

  // The stored draft really is ciphertext: nothing readable reaches the server.
  const fixture = JSON.parse(await readFile("work/e2e-fixture.json", "utf8"));
  const operator = new pg.Client({ connectionString: fixture.migration });
  await operator.connect();
  await operator.query("SET ROLE orgfit_core_owner");
  const stored = await operator.query<{ blob: string; nonce: number }>(
    `select encode(ciphertext,'escape') blob, octet_length(nonce) nonce
       from intake.draft_blob where invitation_id=$1`,
    [invitationId],
  );
  expect(stored.rows).toHaveLength(1);
  expect(stored.rows[0].nonce).toBe(12);
  expect(stored.rows[0].blob).not.toContain("answers");
  expect(stored.rows[0].blob).not.toContain("versionId");

  // ---- narrow viewport ---------------------------------------------------
  await page.setViewportSize({ width: 320, height: 800 });
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "work/respondent-ar-320.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ---- same-device resume after a real reload ----------------------------
  // The token is already gone from the URL, so this is the ordinary "came back
  // later on the same browser" path: local material plus the invitation session.
  await page.reload();
  await page.getByRole("button", { name: "استئناف إجاباتي المحفوظة" }).click();
  await expect(page.getByTestId("save-status")).toHaveText("تم الحفظ");
  await expect(page.getByRole("radio", { name: "4", exact: true })).toBeChecked();

  // ---- cross-device resume ----------------------------------------------
  // A second browser context: no local storage, only the original link plus the
  // private resume code the respondent kept.
  const other = await context.browser()!.newContext();
  const second = await other.newPage();
  await second.goto(`${SURVEY}/s#${token}`);
  await second.getByRole("button", { name: "استئناف من جهاز آخر" }).click();
  await second.getByTestId("resume-code-input").fill(resumeCode);
  await second.getByRole("button", { name: "استئناف", exact: true }).click();
  await expect(second.getByTestId("save-status")).toHaveText("تم الحفظ");
  await expect(second.getByRole("radio", { name: "4", exact: true })).toBeChecked();
  await other.close();

  // A wrong code cannot open the draft, and reports nothing about it.
  const wrongContext = await context.browser()!.newContext();
  const third = await wrongContext.newPage();
  await third.goto(`${SURVEY}/s#${token}`);
  await third.getByRole("button", { name: "استئناف من جهاز آخر" }).click();
  await third
    .getByTestId("resume-code-input")
    .fill(`DF1.${"0".repeat(32)}.${"A".repeat(43)}`);
  await third.getByRole("button", { name: "استئناف", exact: true }).click();
  await expect(third.getByText("تعذر فتح المسودة بهذا الرمز.")).toBeVisible();
  await wrongContext.close();

  // ---- review, confirmation and acceptance -------------------------------
  await page.getByRole("button", { name: "مراجعة الإجابات" }).click();
  await expect(page.getByRole("heading", { name: "مراجعة الإجابات" })).toBeVisible();
  await page.getByRole("button", { name: "إرسال نهائي" }).click();
  await expect(page.getByRole("heading", { name: "تأكيد الإرسال النهائي" })).toBeVisible();
  await expect(page.getByText("لا يمكن تعديلها أو استرجاعها أو حذفها", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "تأكيد وإرسال" }).click();
  await expect(page.getByRole("heading", { name: "تم استلام إجاباتك" })).toBeVisible();

  // The draft is gone, exactly one envelope exists, and the invitation is done.
  const after = await operator.query<{
    status: string;
    envelopes: number;
    drafts: number;
  }>(
    `select i.status,
            (select count(*)::int from intake.submission_inbox e where e.invitation_id=i.id) envelopes,
            (select count(*)::int from intake.draft_blob d where d.invitation_id=i.id) drafts
       from core.invitation i where i.id=$1`,
    [invitationId],
  );
  expect(after.rows[0]).toEqual({ status: "COMPLETED", envelopes: 1, drafts: 0 });

  // Reopening the same link shows the locked accepted state, never the answers.
  await page.goto(`${SURVEY}/s#${token}`);
  await expect(page.getByRole("heading", { name: "تم استلام إجاباتك" })).toBeVisible();
  await expect(page.getByRole("button", { name: "ابدأ الاستبانة" })).toHaveCount(0);

  // ---- the public surface leaks nothing ---------------------------------
  const statusResponse = await page.request.get(`${SURVEY}/public/v1/status`);
  expect(statusResponse.headers()["cache-control"]).toContain("no-store");
  const body = await statusResponse.text();
  expect(body).not.toContain(token);
  expect(body).not.toContain(invitationId);
  expect(body).toContain("ACCEPTED");
  // A cross-origin mutation is refused before it reaches the database.
  const forged = await page.request.post(`${SURVEY}/public/v1/finalize`, {
    headers: { Origin: STAFF, "content-type": "application/json" },
    data: { answers: {} },
    failOnStatusCode: false,
  });
  expect(forged.status()).toBe(401);
  // There is no staff route that can read this draft or these answers.
  const search = await page.request.get(
    `${STAFF}/api/v1/organizations/${ids.orgA}/campaigns/${campaignId}/participation`,
    { headers: { Origin: STAFF }, failOnStatusCode: false },
  );
  const projection = await search.text();
  expect(projection).not.toContain("answers");
  expect(projection).not.toContain("ciphertext");
  await operator.end();
});

test("English respondent journey renders left to right with a complete catalog", async ({
  page,
}) => {
  const { url } = await issueLink(page);
  await page.goto(`${SURVEY}/s#${url.split("#")[1]}`);
  await page.getByTestId("locale-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(
    page.getByRole("heading", { name: "How your answers are handled" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Start the questionnaire" })).toBeVisible();
  // No Arabic string leaks into the English interface chrome.
  // The toggle deliberately names the OTHER language, so it is excluded.
  const chrome = await page.locator("header strong").textContent();
  expect(chrome).not.toMatch(/[؀-ۿ]/);
  await expect(page.getByTestId("locale-toggle")).toHaveText("العربية");
  await page.screenshot({ path: "work/respondent-en-desktop.png", fullPage: true });
});
