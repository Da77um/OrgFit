import { test, expect } from "@playwright/test";
import { ids } from "../../scripts/seed";
import { STAFF, signIn } from "./journey-fixture";

// Visits here are created in organization B: visits.spec.ts asserts that
// organization A starts with none, and the browser specs share one database.
//
// Phase 13, staff side: the language switch on every signed-in screen, and
// times read and shown in the record's own timezone whatever timezone the
// staff member's browser happens to be in.

test("the app bar switches language on an organization screen and on the library, and it persists", async ({
  page,
}) => {
  await signIn(page);
  await page.request.patch(`${STAFF}/api/v1/profile`, {
    headers: { Origin: STAFF },
    data: { locale: "ar" },
  });
  await page.goto(`${STAFF}/organizations/${ids.orgA}/overview`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const toggle = page.getByTestId("appbar-locale");
  await expect(toggle).toHaveText("English");
  await expect(toggle).toHaveAttribute("lang", "en");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(page.getByTestId("appbar-locale")).toHaveText("العربية");

  // The preference is the profile's, so another screen opens in it.
  await page.goto(`${STAFF}/questionnaires`);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.goto(`${STAFF}/workspace`);
  // English punctuation in the English greeting.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Welcome, /);
  await page.getByTestId("appbar-locale").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^مرحبًا، /);
});

test.describe("a staff browser in New York scheduling a visit for Riyadh", () => {
  test.use({ timezoneId: "America/New_York" });

  test("the visit is stored, shown and re-saved in Asia/Riyadh without drifting", async ({
    page,
  }) => {
    await signIn(page);
    await page.request.patch(`${STAFF}/api/v1/profile`, {
      headers: { Origin: STAFF },
      data: { locale: "en" },
    });
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
      "America/New_York",
    );
    await page.goto(`${STAFF}/organizations/${ids.orgB}/visits`);
    await page.getByRole("button", { name: "New visit" }).click();
    await expect(page.getByText("Visit times are read in the time zone set in this form.")).toBeVisible();
    await page.getByLabel("Purpose").fill("Timezone check");
    await page.getByLabel("Starts").fill("2026-10-05T09:00");
    await page.getByLabel("Time zone").fill("Asia/Riyadh");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(/\/visits\/[0-9a-f-]{36}$/);
    const visitId = page.url().split("/").at(-1)!;

    const read = async () =>
      (
        await (
          await page.request.get(
            `${STAFF}/api/v1/organizations/${ids.orgB}/visits/${visitId}`,
            { headers: { Origin: STAFF } },
          )
        ).json()
      ).data as { scheduledStart: string; timezone: string; revision: number };
    const stored = await read();
    // 09:00 in Riyadh (UTC+3) — not 09:00 in New York (13:00Z).
    expect(new Date(stored.scheduledStart).toISOString()).toBe("2026-10-05T06:00:00.000Z");
    await expect(
      page.getByRole("definition").filter({ hasText: "2026-10-05 09:00 Asia/Riyadh" }),
    ).toBeVisible();

    // Open the edit form and save it unchanged, twice. The time must not move.
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: "Edit" }).click();
      await expect(page.getByLabel("Starts")).toHaveValue("2026-10-05T09:00");
      await page.getByLabel("Purpose").fill(`Timezone check ${i}`);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("heading", { level: 2, name: `Timezone check ${i}` })).toBeVisible();
    }
    const after = await read();
    expect(after.revision).toBeGreaterThan(stored.revision);
    expect(new Date(after.scheduledStart).toISOString()).toBe("2026-10-05T06:00:00.000Z");
  });
});

// Attachment refusals on a phone, in Arabic: each one is stated beside the
// control that caused it, in the reader's language, and the page stays inside
// 320px. A file that is refused never offers a download.
test("attachment error states read truthfully beside the control on a 320px Arabic screen", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 720 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await signIn(page);
  await page.request.patch(`${STAFF}/api/v1/profile`, {
    headers: { Origin: STAFF },
    data: { locale: "ar" },
  });
  await page.goto(`${STAFF}/organizations/${ids.orgB}/visits`);
  await page.getByRole("button", { name: "زيارة جديدة" }).click();
  await page.getByLabel("الغرض").fill("فحص رسائل المرفقات على الهاتف");
  await page.getByLabel("بداية الزيارة").fill("2026-10-07T10:00");
  await page.getByRole("button", { name: "حفظ" }).click();
  await expect(page).toHaveURL(/\/visits\/[0-9a-f-]{36}$/);
  const input = page.getByLabel("إضافة مرفق");
  const nearby = page.locator("label:has(input[type=file]) + div > [role=alert]");

  // A type outside the allowlist is refused before anything is sent.
  await input.setInputFiles({ name: "برنامج.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
  await expect(nearby).toContainText("الأنواع المسموح بها");
  await expect(nearby).toBeInViewport();

  // Over the limit: stated as a size refusal, not as a generic failure.
  await input.setInputFiles({
    name: "كبير.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(20 * 1024 * 1024 + 1, 0x20),
  });
  await expect(nearby).toHaveText(/حجم الملف يتجاوز الحد المسموح به/);
  await expect(nearby).toBeInViewport();

  // A connection that drops mid-upload says so, in Arabic, and never a
  // browser's own English network message. Since Post-Audit Repair Pass 2 it
  // also says the upload's outcome is unconfirmed (the bytes may have arrived)
  // instead of the generic "service unavailable" (D-136).
  await page.route("**/attachments/*/content", (route) => route.abort("internetdisconnected"));
  await input.setInputFiles({ name: "تقرير.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  await expect(nearby).toContainText("انقطع الاتصال بالخادم");
  await expect(nearby).toContainText("لم يتأكد حفظ هذا التغيير");
  await expect(nearby).not.toContainText("fetch");
  await page.unroute("**/attachments/*/content");

  const overflowX = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflowX).toBeLessThanOrEqual(0);
  await expect(page.getByRole("link", { name: "تنزيل" })).toHaveCount(0);
  await page.screenshot({ path: "work/p13-attachments-ar-320.png", fullPage: true });
  await context.close();
});
