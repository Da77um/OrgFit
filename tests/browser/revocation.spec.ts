import { test, expect, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { ids } from "../../scripts/seed";
import { configureReport, reportPool, closeReportPool } from "../../src/report-db";
import { renderDueReports } from "../../src/report-worker";
import { publishedRound, STAFF } from "./published-round";

// ---------------------------------------------------------------------------
// Post-Audit Repair Pass 3 in a real browser.
//
// A Super Admin withdraws a published release from the round's results page
// (reason, incident reference, typed fingerprint, acknowledgement that
// downloaded copies cannot be recalled). Results, the report download and the
// results tabs then refuse; the notice says how many downloads already
// happened. An ordinary staff member sees the notice without the written reason
// and is never offered the form. The Settings screen shows job health.
// ---------------------------------------------------------------------------

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
test.describe.configure({ mode: "serial" });

async function signInAs(browser: Browser, identity: "admin" | "staff", locale: "ar" | "en") {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.request.post(`${STAFF}/api/v1/locale`, { headers: { Origin: STAFF }, data: { locale } });
  await page.goto(`${STAFF}/login`);
  await page.locator('a[href*="auth/start"]').first().click();
  await page.getByLabel("Identity").selectOption(identity);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${STAFF}/workspace`);
  // Sign-in restores the account's saved language; set the one this check reads.
  const saved = await page.request.patch(`${STAFF}/api/v1/profile`, { headers: { Origin: STAFF, "Idempotency-Key": randomUUID() }, data: { locale } });
  expect(saved.status()).toBe(200);
  return page;
}

test("a Super Admin withdraws a release through the results page; every dependent surface refuses", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const { roundId } = await publishedRound(page);
  const org = ids.orgA;
  const fixture = JSON.parse(await readFile("work/e2e-fixture.json", "utf8"));

  // A report drawn by the renderer and downloaded once before the withdrawal.
  const requested = await page.request.post(`${STAFF}/api/v1/organizations/${org}/reports`, {
    headers: { Origin: STAFF, "Idempotency-Key": randomUUID() },
    data: { roundId, format: "XLSX", locale: "ar", comparisonId: null },
  });
  expect(requested.status()).toBe(202);
  const jobId = (await requested.json()).data.id as string;
  process.env.REPORT_ENCRYPTION_KEY = fixture.reportEncryptionKey;
  process.env.REPORT_LOCAL_DIRECTORY = fixture.reportDirectory;
  configureReport(fixture.report);
  try {
    const drawn = await renderDueReports(reportPool(), 10);
    expect(drawn.find((d) => d.jobId === jobId)?.state).toBe("READY");
  } finally {
    await closeReportPool();
  }
  expect((await page.request.get(`${STAFF}/api/v1/organizations/${org}/reports/${jobId}/download`, { headers: { Origin: STAFF } })).status()).toBe(200);

  const status = (await (await page.request.get(`${STAFF}/api/v1/organizations/${org}/assessments/${roundId}/release`, { headers: { Origin: STAFF } })).json()).data as { fingerprint: string; canRevoke: boolean };
  expect(status.canRevoke).toBe(true);

  // ---- the Super Admin screen, in Arabic ----
  await page.goto(`${STAFF}/organizations/${org}/results/${roundId}`);
  await expect(page.getByText("النتيجة العامة").first()).toBeVisible({ timeout: 30_000 });
  const panel = page.locator("details.release-revoke");
  await panel.locator("summary").click();
  await expect(panel.getByText("لا يمكن استرجاع الملفات التي نُزّلت قبل السحب")).toBeVisible();
  const submit = panel.getByRole("button", { name: "سحب الإصدار" });
  await expect(submit).toBeDisabled();
  await panel.getByLabel("فئة السبب").selectOption("PRIVACY_INCIDENT");
  await panel.getByLabel(/^السبب/).fill("ظهر قسم صغير يمكن التعرف على أفراده من النتائج المنشورة.");
  await panel.getByLabel("مرجع الحادثة أو القرار").fill("INC-BROWSER-1");
  // A wrong fingerprint keeps the action disabled.
  const confirm = panel.getByLabel(/للتأكيد/);
  await confirm.fill("00000000");
  await panel.getByRole("checkbox").check();
  await expect(submit).toBeDisabled();
  await confirm.fill(status.fingerprint);
  await expect(submit).toBeEnabled();
  const axeForm = await new AxeBuilder({ page }).include("details.release-revoke").withTags(TAGS).analyze();
  expect.soft(axeForm.violations.map((v) => v.id)).toEqual([]);
  await page.screenshot({ path: "work/pass3-revoke-form-ar.png", fullPage: true });
  await submit.click();

  const notice = page.getByRole("note").filter({ hasText: "سُحب هذا الإصدار" });
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toContainText("حادثة خصوصية");
  await expect(notice).toContainText("نُزّلت تقارير هذا الإصدار 1 مرة قبل سحبه");
  await expect(notice).toContainText("INC-BROWSER-1");
  await expect(page.getByText("النتائج غير متاحة لهذه الجولة.")).toBeVisible();
  await expect(page.locator("details.release-revoke")).toHaveCount(0);
  await page.screenshot({ path: "work/pass3-revoked-ar.png", fullPage: true });
  const axeNotice = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect.soft(axeNotice.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join("|")}`)).toEqual([]);

  // ---- server-side refusals after the click ----
  for (const view of ["", "/departments", "/questions", "/recommendations"]) {
    const res = await page.request.get(`${STAFF}/api/v1/organizations/${org}/assessments/${roundId}/results${view}`, { headers: { Origin: STAFF } });
    expect(res.status(), view).toBe(409);
    expect((await res.json()).code).toBe("RESULTS_UNAVAILABLE");
  }
  const download = await page.request.get(`${STAFF}/api/v1/organizations/${org}/reports/${jobId}/download`, { headers: { Origin: STAFF } });
  expect(download.status()).toBe(409);
  expect((await download.json()).code).toBe("RESULTS_UNAVAILABLE");

  // ---- an ordinary staff member, in English ----
  // The seeded staff account reads results of organization A; granted before
  // it signs in, because a capability change ends existing sessions.
  const operator = new pg.Client({ connectionString: fixture.migration });
  await operator.connect();
  await operator.query("SET ROLE orgfit_core_owner");
  await operator.query("insert into access.staff_capability(staff_user_id,capability) values($1,'results.read') on conflict do nothing", [ids.staff]);
  await operator.end();
  const staffPage = await signInAs(browser, "staff", "en");
  await staffPage.goto(`${STAFF}/organizations/${org}/results/${roundId}`);
  const staffNotice = staffPage.getByRole("note").filter({ hasText: "This release was withdrawn" });
  await expect(staffNotice).toBeVisible({ timeout: 30_000 });
  await expect(staffNotice).toContainText("Privacy incident");
  await expect(staffNotice).toContainText("Downloaded copies cannot be recalled");
  await expect(staffNotice).not.toContainText("INC-BROWSER-1");
  await expect(staffNotice).not.toContainText("identifiable");
  await expect(staffPage.locator("details.release-revoke")).toHaveCount(0);
  const refused = await staffPage.request.post(`${STAFF}/api/v1/organizations/${org}/assessments/${roundId}/release/revocation`, {
    headers: { Origin: STAFF, "Idempotency-Key": randomUUID() },
    data: { snapshotId: randomUUID(), reasonCode: "PRIVACY_INCIDENT", reason: "not allowed for staff", incidentReference: "X", confirmation: status.fingerprint },
  });
  expect(refused.status()).toBe(403);
  await staffPage.setViewportSize({ width: 375, height: 800 });
  await staffPage.reload();
  await expect(staffPage.getByRole("note").filter({ hasText: "This release was withdrawn" })).toBeVisible({ timeout: 30_000 });
  expect(await staffPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await staffPage.screenshot({ path: "work/pass3-revoked-en-375.png", fullPage: true });
  await staffPage.context().close();

  // ---- Settings: job health for the Super Admin ----
  await page.goto(`${STAFF}/settings`);
  const jobs = page.locator("section[aria-labelledby='jobs-heading']");
  await expect(jobs).toBeVisible({ timeout: 30_000 });
  await expect(jobs.getByRole("row", { name: /privacy:process/ })).toBeVisible();
  await expect(page.getByText("إصدارات مسحوبة")).toBeVisible();
  await page.locator("#jobs-heading").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "work/pass3-settings-jobs-ar.png", fullPage: true });
  const axeSettings = await new AxeBuilder({ page }).include("section[aria-labelledby='jobs-heading']").withTags(TAGS).analyze();
  expect.soft(axeSettings.violations.map((v) => v.id)).toEqual([]);
});
