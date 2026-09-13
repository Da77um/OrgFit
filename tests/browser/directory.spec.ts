import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ids } from "../../scripts/seed";
async function login(page: Page) {
  await page.goto("/login");
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3000/workspace");
  await page.request.patch("/api/v1/profile", {
    headers: { Origin: "http://127.0.0.1:3000" },
    data: { locale: "ar" },
  });
}
test("Arabic directory forms, reviewed CSV import, English detail and mobile layout", async ({
  page,
}) => {
  await login(page);
  await page.goto(`/organizations/${ids.orgA}/departments`);
  await page.getByRole("button", { name: "إضافة", exact: true }).click();
  await page.getByLabel("الرمز *", { exact: true }).fill("BROWSER");
  await page
    .getByLabel("الاسم بالعربية *", { exact: true })
    .fill("قسم المتابعة الميدانية");
  await page.getByLabel("الاسم بالإنجليزية").fill("Field follow-up");
  await page.getByRole("button", { name: "حفظ", exact: true }).click();
  await expect(page.getByText("تم الحفظ.")).toBeVisible();
  await page.goto(`/organizations/${ids.orgA}/participants`);
  await page.getByRole("button", { name: "إضافة", exact: true }).click();
  await page.getByLabel("المرجع الخاص *").fill("BROWSER_PERSON");
  await page.getByLabel("الاسم *", { exact: true }).fill("مشارك تجريبي");
  await page
    .locator("#editor select[name=relation]")
    .selectOption({ label: "قسم المتابعة الميدانية (BROWSER)" });
  await page.getByRole("button", { name: "حفظ", exact: true }).click();
  await expect(page.getByText("تم الحفظ.")).toBeVisible();
  await page.getByRole("link", { name: "استيراد المشاركين" }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "directory.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "privateReference,displayName,departmentCode\nBROWSER_IMPORT,اسم مستورد,BROWSER\nBROWSER_PERSON,Duplicate,BROWSER\nBAD_DEPT,Bad,UNKNOWN",
    ),
  });
  await page.getByRole("button", { name: "رفع ومراجعة الملف" }).click();
  await expect(
    page.getByRole("heading", { name: "مطابقة الأعمدة" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "معاينة والتحقق" }).click();
  await expect(page.getByText("صفوف صحيحة: 1 · أخطاء: 2")).toBeVisible();
  await page.reload();
  await expect(page.getByText("صفوف صحيحة: 1 · أخطاء: 2")).toBeVisible();
  await page.screenshot({
    path: "work/directory-import-desktop.png",
    fullPage: true,
  });
  await expect(
    page.getByRole("button", { name: "اعتماد الصفوف الصحيحة" }),
  ).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "اعتماد الصفوف الصحيحة" }).click();
  await expect(page.getByText("اكتمل الاستيراد: 1")).toBeVisible();
  await page.goto(`/organizations/${ids.orgA}/participants`);
  await page
    .locator("li")
    .filter({ hasText: "BROWSER_IMPORT" })
    .getByRole("link", { name: "التفاصيل" })
    .click();
  await expect(
    page.getByText("هذا سجل دليل خاص. لا تتوفر إجابات أو درجات فردية."),
  ).toBeVisible();
  await page.getByRole("button", { name: "تعديل", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "work/directory-ar-320.png", fullPage: true });
  await page
    .getByText("الحساب", { exact: true })
    .click()
    .catch(async () => {
      await page.locator("main > details > summary").click();
    });
  await page.getByLabel("اللغة", { exact: true }).selectOption("en");
  await page.getByRole("button", { name: "حفظ اللغة" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#editor select[name=relation]")).toContainText(
    "Field follow-up",
  );
  await expect(page.getByLabel("Private reference *")).toHaveValue(
    "BROWSER_IMPORT",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "work/directory-en-320.png", fullPage: true });
});
test("organization create, settings edit and archive preserve the workspace", async ({
  page,
}) => {
  await login(page);
  await page.goto("/organizations");
  await page.getByRole("button", { name: "إضافة", exact: true }).click();
  await page.getByLabel("الرمز *", { exact: true }).fill("NEW_BROWSER_ORG");
  await page
    .getByLabel("الاسم بالعربية *", { exact: true })
    .fill("منظمة لاختبار الإعدادات");
  await page.getByLabel("الاسم بالإنجليزية").fill("Settings test organization");
  await page.getByRole("button", { name: "حفظ", exact: true }).click();
  await expect(page.getByText("تم الحفظ.")).toBeVisible();
  await page
    .locator("li")
    .filter({ hasText: "NEW_BROWSER_ORG" })
    .getByRole("link", { name: "التفاصيل" })
    .click();
  await page.getByRole("link", { name: "إعدادات المنظمة" }).click();
  await page.getByRole("button", { name: "تعديل", exact: true }).click();
  await page.getByLabel("القطاع", { exact: true }).fill("Consulting");
  await page.getByRole("button", { name: "حفظ", exact: true }).click();
  await expect(page.getByText("تم الحفظ.")).toBeVisible();
  await expect(page.getByText("Consulting", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "أرشفة", exact: true }).click();
  await page.getByLabel("سبب الأرشفة *").fill("Synthetic archive check");
  await page
    .locator("form")
    .getByRole("button", { name: "أرشفة", exact: true })
    .click();
  await expect(
    page.locator(".directory-list").getByText("مؤرشف", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "منظمة لاختبار الإعدادات", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "تعديل", exact: true }),
  ).toHaveCount(0);
});
test("HTTP directory access, substitution and mutation preconditions", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("staff");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3000/workspace");
  const request = page.request,
    headers = {
      Origin: "http://127.0.0.1:3000",
      "Idempotency-Key": randomUUID(),
      "If-Match": '"1"',
    };
  for (const resource of ["departments", "participants", "imports"]) {
    const base = `/api/v1/organizations/${ids.orgB}/${resource}`;
    for (const suffix of [
      "",
      `/${ids.orgA}`,
      ...(resource === "imports" ? [`/${ids.orgA}/errors`] : []),
    ])
      expect((await request.get(base + suffix)).status()).toBe(404);
    expect((await request.post(base, { headers, data: {} })).status()).toBe(
      404,
    );
    for (const action of resource === "imports"
      ? ["validate", "commit"]
      : ["archive"])
      expect(
        (
          await request.post(`${base}/${ids.orgA}/${action}`, {
            headers,
            data: {},
          })
        ).status(),
      ).toBe(404);
    if (resource !== "imports")
      expect(
        (
          await request.patch(`${base}/${ids.orgA}`, { headers, data: {} })
        ).status(),
      ).toBe(404);
  }
  expect(
    (await request.get(`/api/v1/organizations/${ids.orgB}`)).status(),
  ).toBe(404);
  expect(
    (
      await request.patch(`/api/v1/organizations/${ids.orgB}`, {
        headers,
        data: {},
      })
    ).status(),
  ).toBe(404);
  expect(
    (
      await request.post("/api/v1/organizations", { headers, data: {} })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(`/api/v1/organizations/${ids.orgA}/departments`, {
        headers: { ...headers, Origin: "https://foreign.invalid" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(`/api/v1/organizations/${ids.orgA}/departments`, {
        headers: { Origin: headers.Origin },
        data: { code: "X", nameAr: "X" },
      })
    ).status(),
  ).toBe(400);
});
