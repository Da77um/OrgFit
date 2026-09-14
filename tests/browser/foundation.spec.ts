import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import pg from "pg";
async function login(page: Page, subject = "staff", mode = "normal") {
  await page.goto("/login");
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption(subject);
  await page.getByLabel("Test case").selectOption(mode);
  await page.getByRole("button", { name: "Sign in" }).click();
}
test("anonymous APIs and staff page denied; respondent build has no staff API", async ({
  page,
  request,
}) => {
  expect((await request.get("/api/v1/profile")).status()).toBe(401);
  // "/" is the public overview page now; the workspace moved to /workspace and
  // is still refused without a session.
  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  expect(
    (await request.get(`http://127.0.0.1:${process.env.E2E_RESPONDENT_PORT ?? 3001}/api/v1/profile`)).status(),
  ).toBe(404);
  // The survey origin serves the respondent shell and nothing else. Opened
  // without an invitation fragment it reports the generic unavailable state and
  // never hints that a questionnaire exists.
  await page.goto(`http://127.0.0.1:${process.env.E2E_RESPONDENT_PORT ?? 3001}/s`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "استبانة OrgFit",
  );
  await expect(
    page.getByText("هذا الرابط غير صالح أو لم يعد متاحًا."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "ابدأ الاستبانة" })).toHaveCount(
    0,
  );
});
test("real signed OIDC login, org scoping, persistent AR/EN, CSRF, logout and mobile layout", async ({
  page,
  request,
}) => {
  await login(page);
  await expect(page).toHaveURL(`http://127.0.0.1:${process.env.E2E_STAFF_PORT ?? 3000}/workspace`);
  await expect(page.getByText("منظمة تجريبية أ")).toBeVisible();
  await expect(page.getByText("منظمة تجريبية ب")).toHaveCount(0);
  await page.getByLabel("اللغة").selectOption("en");
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/profile") && r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "حفظ اللغة" }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(
    page.getByRole("heading", { name: "Authorized organizations" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "work/staff-en-320.png", fullPage: true });
  await page.getByLabel("Language").selectOption("ar");
  await page.getByRole("button", { name: "Save language" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.screenshot({ path: "work/staff-ar-320.png", fullPage: true });
  const cookies = await page.context().cookies();
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  expect(
    (
      await request.patch("/api/v1/profile", {
        headers: { Cookie: cookie, Origin: "https://evil.invalid" },
        data: { locale: "en" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.get("/api/v1/staff", { headers: { Cookie: cookie } })
    ).status(),
  ).toBe(403);
  const res = await page.request.get("/health/ready");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  expect(res.headers()["referrer-policy"]).toBe("no-referrer");
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(
    (
      await request.get("/api/v1/profile", { headers: { Cookie: cookie } })
    ).status(),
  ).toBe(401);
});
for (const [subject, mode] of [
  ["unknown", "normal"],
  ["disabled", "normal"],
  ["staff", "no-mfa"],
  ["staff", "bad-state"],
  ["staff", "bad-nonce"],
  ["staff", "bad-audience"],
  ["staff", "bad-issuer"],
  ["staff", "bad-signature"],
  ["staff", "expired"],
]) {
  test(`OIDC denies ${subject}/${mode}`, async ({ page }) => {
    await login(page, subject, mode);
    await expect(page.locator("body")).toContainText("SESSION_REQUIRED");
    expect((await page.request.get("/api/v1/profile")).status()).toBe(401);
  });
}
test("disabling a logged-in staff member denies the next request", async ({
  page,
}) => {
  await login(page);
  await expect(page).toHaveURL(`http://127.0.0.1:${process.env.E2E_STAFF_PORT ?? 3000}/workspace`);
  const { migration } = JSON.parse(
    await readFile("work/e2e-fixture.json", "utf8"),
  );
  const operator = new pg.Client({ connectionString: migration });
  await operator.connect();
  try {
    await operator.query("SET ROLE orgfit_core_owner");
    await operator.query(
      "UPDATE access.staff_user SET status='DISABLED' WHERE provider_subject='staff'",
    );
    expect((await page.request.get("/api/v1/profile")).status()).toBe(401);
  } finally {
    await operator.query(
      "UPDATE access.staff_user SET status='ACTIVE' WHERE provider_subject='staff'",
    );
    await operator.end();
  }
});
