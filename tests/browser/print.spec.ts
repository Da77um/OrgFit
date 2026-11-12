import { test, expect } from "@playwright/test";
import { ids } from "../../scripts/seed";
import { STAFF, publishedRound } from "./published-round";

// D-186: one-click printing. The print button calls window.print(); under
// print emulation the page shows the identity header and the same published,
// suppressed values the screen shows, without navigation, live status,
// release controls or the follow-up form.
test("results print in Arabic and English: every view, print emulation", async ({ page }) => {
  test.setTimeout(240000);
  const { roundId } = await publishedRound(page);
  const views = [
    { ar: "النظرة العامة", en: "Overview", key: "overview" },
    { ar: "الأقسام", en: "Departments", key: "departments" },
    { ar: "تحليل الأسئلة", en: "Question analysis", key: "questions" },
    { ar: "التوصيات", en: "Recommendations", key: "recommendations" },
  ] as const;
  for (const locale of ["ar", "en"] as const) {
    await page.request.patch(`${STAFF}/api/v1/profile`, {
      headers: { Origin: STAFF },
      data: { locale },
    });
    await page.goto(`${STAFF}/organizations/${ids.orgA}/results/${roundId}`);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    // window.print is replaced so the test can see the button call it.
    await page.evaluate(() => {
      (window as unknown as { printed: number }).printed = 0;
      window.print = () => {
        (window as unknown as { printed: number }).printed++;
      };
    });
    for (const view of views) {
      await page.emulateMedia({ media: "screen" });
      await page.getByRole("button", { name: view[locale], exact: true }).click();
      const print = page.getByRole("button", { name: locale === "ar" ? "طباعة" : "Print", exact: true });
      await expect(print).toBeVisible();
      await expect(
        page.getByText(locale === "ar" ? "حفظ بتنسيق PDF" : "Save as PDF", { exact: false }),
      ).toBeVisible();
      // On screen the print header is absent.
      await expect(page.locator(".print-header")).toBeHidden();
      await print.click();
      expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBeGreaterThan(0);

      await page.emulateMedia({ media: "print" });
      const header = page.locator(".print-header");
      await expect(header).toBeVisible();
      await expect(header).toContainText(locale === "ar" ? "منظمة تجريبية" : "");
      await expect(header).toContainText(view[locale]);
      await expect(header.locator("svg").first()).toBeVisible();
      await expect(page.locator(".results-tabs")).toBeHidden();
      await expect(page.locator(".print-bar")).toBeHidden();
      await expect(page.locator(".appbar")).toBeHidden();
      if (view.key === "recommendations") {
        // The suggested action (the client's "guidelines") prints; the
        // follow-up form does not.
        await expect(
          page.getByText(locale === "ar" ? "الإجراء المقترح" : "Suggested action", { exact: false }).first(),
        ).toBeVisible();
        await expect(page.locator("textarea").first()).toBeHidden();
      }
      // The page fits the paper width: nothing wider than the body.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
      ).toBe(true);
      await page.screenshot({ path: `work/print-${view.key}-${locale}.png`, fullPage: true });
    }
    await page.emulateMedia({ media: "screen" });
  }
});
