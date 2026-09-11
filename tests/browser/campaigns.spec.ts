import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ids } from "../../scripts/seed";

const ORIGIN = "http://127.0.0.1:3000";
const BUILTIN_VERSION = "44000000-0000-4000-9000-000000000001";
const BUILTIN_QUESTIONNAIRE = "44000000-0000-4000-8000-000000000001";

test("Arabic campaign journey: review warnings, launch freeze, one-time link, participation and closure", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}/`);
  await page.request.patch("/api/v1/profile", {
    headers: { Origin: ORIGIN },
    data: { locale: "ar" },
  });
  const headers = () => ({
    Origin: ORIGIN,
    "Idempotency-Key": randomUUID(),
  });
  const base = `/api/v1/organizations/${ids.orgA}`;

  // Synthetic directory for this campaign only.
  const department = await page.request.post(`${base}/departments`, {
    headers: headers(),
    data: {
      code: `CAMP${Date.now().toString(36).toUpperCase()}`,
      nameAr: "قسم الحملات",
      nameEn: "Campaign department",
    },
  });
  expect(department.status()).toBe(201);
  const departmentId = (await department.json()).data.id as string;
  for (const n of [1, 2, 3]) {
    const person = await page.request.post(`${base}/participants`, {
      headers: headers(),
      data: {
        privateReference: `CAMP-${Date.now()}-${n}`,
        displayName: `مشارك حملة ${n}`,
        departmentId,
      },
    });
    expect(person.status()).toBe(201);
  }

  const family = (
    await (
      await page.request.get(
        `/api/v1/questionnaires/${BUILTIN_QUESTIONNAIRE}`,
        { headers: { Origin: ORIGIN } },
      )
    ).json()
  ).data.family_key as string;

  await page.goto(`/organizations/${ids.orgA}/assessments`);
  await expect(page.getByRole("heading", { name: "التقييمات" })).toBeVisible();
  await page.getByLabel("اسم السلسلة").fill("سلسلة المتصفح");
  await page.getByLabel("الغرض").fill("قياس تجريبي عبر المتصفح");
  await page.getByLabel("عائلة الاستبانة").fill(family);
  await page
    .locator("form")
    .filter({ hasText: "سلسلة جديدة" })
    .getByRole("button", { name: "إنشاء" })
    .click();
  await expect(page.getByText("تم الحفظ.")).toBeVisible();

  const roundForm = page.locator("form").filter({ hasText: "جولة جديدة" });
  await roundForm.getByLabel("اسم الجولة").fill("جولة المتصفح");
  await roundForm.getByLabel("بداية الفترة").fill("2026-02-01");
  await roundForm.getByLabel("نسخة الاستبانة المنشورة").fill(BUILTIN_VERSION);
  await roundForm.getByRole("button", { name: "إنشاء" }).click();
  await expect(page.getByRole("cell", { name: "جولة المتصفح" })).toBeVisible();

  const campaignForm = page.locator("form").filter({ hasText: "حملة جديدة" });
  await campaignForm
    .getByLabel("نسخة الاستبانة المنشورة")
    .fill(BUILTIN_VERSION);
  await campaignForm.getByLabel("نمط الاستهداف").selectOption("DEPARTMENT");
  await campaignForm.getByLabel("معرّف القسم").fill(departmentId);
  const start = new Date(Date.now() - 60_000);
  const local = (d: Date) =>
    new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
  await campaignForm.getByLabel("بداية الجمع").fill(local(start));
  await campaignForm.getByRole("button", { name: "إنشاء" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/organizations/${ids.orgA}/campaigns/`),
  );

  // The launch review names the frozen shape and warns about releasability.
  await expect(page.getByRole("heading", { name: "مراجعة ما سيتم تجميده" })).toBeVisible();
  await expect(page.getByText("عدد المدعوين: 3")).toBeVisible();
  await expect(page.getByText("غير قابلة للنشر")).toBeVisible();
  await expect(
    page.getByText("عدد المدعوين أقل من الحد الأدنى للنشر", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("لا تعرض هذه الشاشة أي إجابة")).toBeVisible();
  await page.screenshot({ path: "work/campaign-review-ar-desktop.png", fullPage: true });

  await page.getByRole("button", { name: "إطلاق الحملة" }).click();
  await expect(page.getByText("الحالة:")).toBeVisible();
  await expect(page.getByText("مفتوحة")).toBeVisible();
  await expect(page.getByRole("heading", { name: "متابعة المشاركة" })).toBeVisible();
  await expect(
    page.getByText("بانتظار الإجابة: 3", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("بلا رابط").first()).toBeVisible();

  // Issuing reveals the link once; the page never fetches it again.
  await page.getByRole("button", { name: "توليد رابط", exact: true }).first().click();
  const shown = page.getByRole("textbox", { name: "نسخ الرابط" });
  await expect(shown).toBeVisible();
  const link = await shown.inputValue();
  expect(link).toMatch(/^http:\/\/localhost:3001\/s#[A-Za-z0-9_-]{43}$/);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "نسخ الرابط" })).toHaveCount(
    0,
    { timeout: 15_000 },
  );
  // The credential is not retrievable through any staff API.
  const projection = await (
    await page.request.get(
      `${base}/campaigns/${page.url().split("/").pop()}/participation`,
      { headers: { Origin: ORIGIN } },
    )
  ).text();
  expect(projection).not.toContain(link.split("#")[1]);
  expect(projection).not.toContain("token_digest");

  // Narrow layout must not overflow.
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.getByRole("heading", { name: "متابعة المشاركة" })).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "work/campaign-ar-320.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // Manual closure requires a reason and is terminal.
  const closeForm = page.locator("form").filter({ hasText: "إغلاق الجمع" });
  await closeForm.getByLabel("السبب").fill("انتهى الجمع التجريبي");
  await closeForm.getByRole("button", { name: "إغلاق الجمع" }).click();
  await expect(page.getByText("مغلقة", { exact: true })).toBeVisible();
  await expect(
    page.getByText("لا يمكن إعادة فتح حملة مغلقة أو ملغاة"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "إغلاق الجمع" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "توليد رابط" })).toHaveCount(0);
});
