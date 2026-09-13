import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ids } from "../../scripts/seed";
import {
  SURVEY,
  STAFF,
  launchCampaign,
  publishJourneyInstrument,
  signIn,
} from "./journey-fixture";
import { publishedRound } from "./published-round";

// Automated accessibility regressions (Phase 13).
//
// axe-core against WCAG 2.0/2.1/2.2 A and AA rules, on real pages in both
// languages and at a phone width. What this proves and does not prove is
// stated plainly: an automated rule engine finds a subset of failures — missing
// names, broken ARIA, insufficient contrast of rendered text, landmark and
// heading structure. It does not prove a screen reader announces things in a
// sensible order, that focus moves sensibly, or that the content is
// understandable. Those are checked by hand and by the journey spec, and a
// clean run here is not a conformance claim.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function audit(page: Page, name: string) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = result.violations.map(
    (v) =>
      `${v.id} [${v.impact}] ${v.help}\n` +
      v.nodes
        .slice(0, 5)
        .map((n) => `    ${n.target.join(" ")} — ${n.failureSummary?.split("\n")[1] ?? ""}`)
        .join("\n"),
  );
  // Soft, so one run names every failing screen rather than only the first.
  expect.soft(summary, `${name}\n${summary.join("\n")}`).toEqual([]);
}

// The page has loaded and no loading state is still on screen. (Not
// "networkidle": the development server holds a live reload connection open.)
async function settled(page: Page) {
  await page.waitForLoadState("load");
  await expect(page.locator(".state-loading")).toHaveCount(0, { timeout: 20_000 });
}

test.describe.configure({ mode: "serial" });

test("respondent screens in Arabic and English, at 320px and desktop", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const staffContext = await browser.newContext();
  const staff = await staffContext.newPage();
  await signIn(staff);
  const stamp = Date.now().toString(36).toUpperCase();
  const instrument = await publishJourneyInstrument(staff, stamp);
  const { tokens } = await launchCampaign(staff, instrument, `${stamp}X`, 2);
  await staffContext.close();

  for (const [width, locale] of [
    [320, "ar"],
    [1280, "en"],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    page.on("dialog", (d) => void d.accept());
    // The bare origin, with no invitation.
    await page.goto(`${SURVEY}/s`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await audit(page, `blocked ${locale} ${width}`);

    // A fresh document: a fragment-only navigation would not reload the page.
    await page.goto("about:blank");
    await page.goto(`${SURVEY}/s#${tokens[locale === "ar" ? 0 : 1]}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    if (locale === "en") await page.getByTestId("locale-toggle").click();
    const t = (ar: string, en: string) => (locale === "ar" ? ar : en);
    await page.getByRole("button", { name: t("استئناف من جهاز آخر", "Resume on another device") }).click();
    await audit(page, `welcome ${locale} ${width}`);

    await page.getByRole("button", { name: t("ابدأ الاستبانة", "Start the questionnaire") }).click();
    // Section one with a broken rule shown beside its field.
    const years = page.getByLabel(t("كم سنة عملت في المنظمة؟", "How many years"));
    await years.fill("99");
    await years.blur();
    await page.getByRole("radio", { name: "3", exact: true }).check();
    await page.getByRole("button", { name: t("حفظ ومتابعة لاحقًا", "Save and continue later") }).click();
    await expect(page.getByTestId("resume-code")).toBeVisible();
    await audit(page, `section 1 ${locale} ${width}`);

    await years.fill("9");
    await page.getByRole("button", { name: t("التالي", "Next") }).click();
    await audit(page, `section 2 (matrix, checkboxes, date) ${locale} ${width}`);
    await page.getByRole("button", { name: t("التالي", "Next") }).click();
    await audit(page, `section 3 (text, dropdown, yes/no) ${locale} ${width}`);

    await page.getByRole("button", { name: t("مراجعة الإجابات", "Review your answers") }).click();
    await audit(page, `review with missing answers ${locale} ${width}`);

    // Answer the rest and open the confirmation dialog.
    await page.getByRole("button", { name: t("السابق", "Back") }).click();
    await page.getByLabel(t("نمط العمل", "Work pattern")).selectOption({ index: 1 });
    await page.getByRole("radio", { name: t("نعم", "Yes") }).check();
    await page.getByRole("button", { name: t("السابق", "Back") }).click();
    for (const row of instrument.q.matrix.rows)
      await page
        .getByRole("group", { name: row.label[locale] })
        .getByRole("radio")
        .first()
        .check();
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: t("التالي", "Next") }).click();
    await page.getByRole("button", { name: t("مراجعة الإجابات", "Review your answers") }).click();
    await page.getByRole("button", { name: t("إرسال نهائي", "Submit final answers") }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await audit(page, `confirmation dialog ${locale} ${width}`);
    await page.getByRole("button", { name: t("تأكيد وإرسال", "Confirm and submit") }).click();
    await expect(page.getByRole("heading", { name: t("تم استلام إجاباتك", "Your answers were received") })).toBeVisible();
    await audit(page, `accepted ${locale} ${width}`);
    await context.close();
  }
});

test("staff screens in Arabic at 320px and in English at desktop", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const setup = await browser.newContext();
  const seed = await setup.newPage();
  const round = await publishedRound(seed);
  await setup.close();

  const org = `${STAFF}/organizations/${ids.orgA}`;
  const screens: [string, string][] = [
    ["overview page", `${STAFF}/`],
    ["sign-in", `${STAFF}/login`],
    ["activation without a link", `${STAFF}/activate`],
    ["workspace home", `${STAFF}/workspace`],
    ["organizations", `${STAFF}/organizations`],
    ["organization overview", `${org}/overview`],
    ["settings", `${org}/settings`],
    ["departments", `${org}/departments`],
    ["participants", `${org}/participants`],
    ["assessments and campaigns", `${org}/assessments`],
    ["campaign", `${org}/campaigns/${round.campaignId}`],
    ["results", `${org}/results/${round.roundId}`],
    ["history", `${org}/history`],
    ["field visits", `${org}/visits`],
    ["questionnaire library", `${STAFF}/questionnaires`],
  ];
  for (const [width, locale] of [
    [320, "ar"],
    [1280, "en"],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await signIn(page);
    const set = await page.request.patch(`${STAFF}/api/v1/profile`, {
      headers: { Origin: STAFF },
      data: { locale },
    });
    expect(set.status()).toBe(200);
    for (const [name, url] of screens) {
      await page.goto(url);
      await settled(page);
      await expect(page.locator("main").first()).toBeVisible();
      await audit(page, `${name} ${locale} ${width}`);
    }
    // The results tabs and the visit form are the densest surfaces.
    await page.goto(`${org}/results/${round.roundId}`);
    await settled(page);
    for (const tab of await page.locator("ul.tabs button").all()) {
      await tab.click();
      await settled(page);
      await audit(page, `results tab "${await tab.textContent()}" ${locale} ${width}`);
    }
    await page.goto(`${org}/visits`);
    await settled(page);
    await page.getByRole("button", { name: locale === "ar" ? "زيارة جديدة" : "New visit" }).click();
    await audit(page, `new visit form ${locale} ${width}`);
    await context.close();
  }
});
