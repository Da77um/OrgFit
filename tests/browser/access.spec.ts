import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { bootstrapDevAdmin } from "../../scripts/bootstrap-dev-admin";

// ---------------------------------------------------------------------------
// The public overview page, password sign-in and invitation activation, in a
// real browser against the real staff application and database.
//
// The administrator here is SYNTHETIC: a throwaway account created in the
// harness's own throwaway database with a generated password. The development
// administrator's credentials are never used, typed or read by any test.
// ---------------------------------------------------------------------------

const STAFF = "http://127.0.0.1:3000";
const EMAIL = `e2e-admin-${randomUUID().slice(0, 8)}@example.invalid`;
const PASSWORD = `E2e${randomUUID().slice(0, 10)}7`;

async function migration() {
  return JSON.parse(await readFile("work/e2e-fixture.json", "utf8")).migration as string;
}

test.beforeAll(async () => {
  const outcome = await bootstrapDevAdmin(
    await migration(),
    { email: EMAIL, password: PASSWORD, displayName: "مسؤول تجريبي" },
    {},
  );
  expect(outcome.result).toBe("CREATED");
});

async function setLocale(page: Page, locale: "ar" | "en") {
  await page.request.post("/api/v1/locale", {
    headers: { Origin: STAFF },
    data: { locale },
  });
}

async function signIn(page: Page, email = EMAIL, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("البريد الإلكتروني").fill(email);
  await page.getByLabel("كلمة المرور", { exact: true }).fill(password);
  await page.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();
}

test("overview page: Arabic RTL, every section, working anchors and CTAs, synthetic figures", async ({
  page,
}) => {
  await setLocale(page, "ar");
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "رؤية أوضح للمؤسسات، وقرارات تستند إلى البيانات",
  );
  for (const id of ["overview", "capabilities", "workflow", "faq"])
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  // Every in-page link resolves to an element that exists.
  const anchors = await page.locator('a[href^="#"]').evaluateAll((links) =>
    links.map((a) => a.getAttribute("href")!),
  );
  for (const href of new Set(anchors)) await expect(page.locator(href)).toHaveCount(1);
  // Every other link goes somewhere real.
  const hrefs = await page
    .locator('a[href^="/"]')
    .evaluateAll((links) => [...new Set(links.map((a) => a.getAttribute("href")!))]);
  for (const href of hrefs) expect((await page.request.get(href)).status(), href).toBe(200);

  await expect(page.getByText("بيانات توضيحية").first()).toBeVisible();
  await expect(page.getByText("ليس ضمان إخفاء هوية مطلقًا", { exact: false })).toBeVisible();
  // Checkpoint G (CG-001): the independent privacy review is required and has
  // not happened; the page must never say it is under way.
  await expect(page.getByText("مراجعة خصوصية مستقلة لم تُجرَ بعد", { exact: false })).toBeVisible();
  await expect(page.getByText("وتحت مراجعة خصوصية مستقلة", { exact: false })).toHaveCount(0);
  for (const banned of ["pricing", "trial", "اشتراك", "تجربة مجانية"])
    await expect(page.getByText(banned, { exact: false })).toHaveCount(0);

  await page.getByRole("link", { name: "استكشف المنصة" }).click();
  await expect(page).toHaveURL(/#capabilities$/);

  const faq = page.locator("details").filter({ hasText: "هل يحتاج المشاركون" });
  await faq.locator("summary").click();
  await expect(faq.getByText("لا. يصل المشارك عبر رابط خاص")).toBeVisible();

  await page.getByRole("navigation", { name: "قائمة التنقل" }).first()
    .getByRole("link", { name: "أسئلة متكررة" }).click();
  await expect(page).toHaveURL(/#faq$/);

  await page.locator(".hero-actions").getByRole("link", { name: "تسجيل الدخول" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("overview page: English LTR persists into sign-in; 320px has no sideways scroll; mobile menu", async ({
  page,
}) => {
  await setLocale(page, "ar");
  await page.goto("/");
  await page.getByRole("button", { name: "English" }).first().click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("A clearer view");
  await expect(page.getByText("independent privacy review, not yet carried out, is required", { exact: false })).toBeVisible();
  await expect(page.getByText("under independent privacy review", { exact: false })).toHaveCount(0);
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Staff sign in" })).toBeVisible();

  await setLocale(page, "ar");
  for (const width of [320, 375, 768]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ["/", "/login", "/activate"]) {
      await page.goto(path);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${path} at ${width}`,
      ).toBe(true);
    }
  }
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "فتح قائمة التنقل" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".site-menu")).toBeHidden();
  await toggle.click();
  await expect(page.locator(".site-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".site-menu")).toBeHidden();
  await expect(page.getByRole("button", { name: "فتح قائمة التنقل" })).toBeFocused();
  await page.screenshot({ path: "work/landing-ar-375.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("sign-in: validation, one generic error, rate-limit state, success, logout and expired session", async ({
  page,
}) => {
  await setLocale(page, "ar");
  await page.goto("/login");
  // Nothing is prefilled, and the fields carry password-manager hints.
  await expect(page.getByLabel("البريد الإلكتروني")).toHaveValue("");
  await expect(page.getByLabel("البريد الإلكتروني")).toHaveAttribute("autocomplete", "username");
  await expect(page.getByLabel("كلمة المرور", { exact: true })).toHaveAttribute(
    "autocomplete",
    "current-password",
  );

  await page.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();
  await expect(page.getByText("أدخل بريدك الإلكتروني.")).toBeVisible();
  await expect(page.getByText("أدخل كلمة المرور.")).toBeVisible();

  const password = page.getByLabel("كلمة المرور", { exact: true });
  await password.fill("abc");
  await page.getByRole("button", { name: "إظهار كلمة المرور" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "إخفاء كلمة المرور" }).click();
  await expect(password).toHaveAttribute("type", "password");

  // Wrong password and unknown address: the same words.
  await signIn(page, EMAIL, "Wrong1234");
  await expect(page.locator(".alert-danger")).toContainText("بيانات الدخول غير صحيحة.");
  await signIn(page, "nobody@example.invalid", "Wrong1234");
  await expect(page.locator(".alert-danger")).toContainText("بيانات الدخول غير صحيحة.");

  // The throttled state is a real server status; its screen is checked here
  // with the response stubbed so this test does not lock its own account.
  await page.route("**/api/v1/auth/password", (route) =>
    route.fulfill({ status: 429, contentType: "application/json", body: '{"code":"RATE_LIMITED"}' }),
  );
  await signIn(page, EMAIL, "Wrong1234");
  await expect(page.locator(".alert-danger")).toContainText("محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.");
  await page.unroute("**/api/v1/auth/password");

  await signIn(page);
  await expect(page).toHaveURL(`${STAFF}/workspace`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("مسؤول تجريبي");
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  expect((await page.request.get("/api/v1/staff")).status()).toBe(200);
  await page.goto("/login");
  await expect(page).toHaveURL(`${STAFF}/workspace`);

  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/v1/profile", { headers: { Cookie: cookie } })).status()).toBe(401);

  // A stale cookie is told apart from no cookie at all.
  await page.context().addCookies([
    { name: "orgfit-staff-dev", value: cookie.match(/orgfit-staff-dev=([^;]+)/)?.[1] ?? "x".repeat(43), url: STAFF },
  ]);
  await page.goto("/organizations");
  await expect(page).toHaveURL(/\/login\?expired=1$/);
  await expect(page.locator(".alert-danger")).toContainText("انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة.");
});

test("activation: missing, invalid, valid, reused and expired invitations", async ({ page }) => {
  await setLocale(page, "ar");
  await page.goto("/activate");
  await expect(page.getByRole("heading", { name: "لا توجد دعوة في هذا الرابط" })).toBeVisible();
  await expect(page.getByLabel("كلمة المرور", { exact: true })).toHaveCount(0);

  await page.goto(`/activate#${"A".repeat(43)}`);
  await expect(page.getByRole("heading", { name: "هذه الدعوة غير صالحة" })).toBeVisible();

  await signIn(page);
  await expect(page).toHaveURL(`${STAFF}/workspace`);
  const invite = async (email: string) => {
    const r = await page.request.post("/api/v1/staff/invitations", {
      headers: { Origin: STAFF, "Idempotency-Key": randomUUID() },
      data: { email, role: "STAFF", capabilities: ["results.read"], organizationIds: [], locale: "ar", expiresInHours: 2 },
    });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()).data.url as string;
  };
  const invitee = `invitee-${randomUUID().slice(0, 8)}@example.invalid`;
  const url = await invite(invitee);
  expect(url).toMatch(/\/activate#[A-Za-z0-9_-]{43}$/);
  // The activating person needs no session.
  await page.context().clearCookies();
  await setLocale(page, "ar");

  await page.goto(url);
  await expect(page.locator("dd.bidi")).toHaveText(invitee);
  await expect(page.getByText("موظف", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "تفعيل الحساب" }).click();
  await expect(page.getByText("أدخل الاسم الظاهر.")).toBeVisible();
  await page.getByLabel("الاسم الظاهر").fill("موظفة مدعوة");
  await page.getByLabel("كلمة المرور", { exact: true }).fill("Short1");
  await page.getByLabel("تأكيد كلمة المرور").fill("Short2");
  await page.getByRole("button", { name: "تفعيل الحساب" }).click();
  await expect(page.getByText("كلمة المرور لا تحقق الشروط المطلوبة.")).toBeVisible();
  await expect(page.getByText("كلمتا المرور غير متطابقتين.")).toBeVisible();
  await page.getByLabel("كلمة المرور", { exact: true }).fill(PASSWORD);
  await page.getByLabel("تأكيد كلمة المرور").fill(PASSWORD);
  await page.getByRole("button", { name: "تفعيل الحساب" }).click();
  await expect(page.getByText("تم تفعيل حسابك")).toBeVisible();

  await page.goto(url);
  await page.reload();
  await expect(page.getByRole("heading", { name: "تم استخدام هذه الدعوة من قبل" })).toBeVisible();

  // The activated account signs in with the role the invitation carried.
  await signIn(page, invitee, PASSWORD);
  await expect(page).toHaveURL(`${STAFF}/workspace`);
  expect((await page.request.get("/api/v1/staff")).status()).toBe(403);
  await page.context().clearCookies();

  await signIn(page);
  await expect(page).toHaveURL(`${STAFF}/workspace`);
  const lateEmail = `late-${randomUUID().slice(0, 8)}@example.invalid`;
  const late = await invite(lateEmail);
  const operator = new pg.Client({ connectionString: await migration() });
  await operator.connect();
  try {
    await operator.query("SET ROLE orgfit_core_owner");
    await operator.query(
      "UPDATE access.staff_invitation SET expires_at=clock_timestamp()-interval '1 minute' WHERE email=$1",
      [lateEmail],
    );
  } finally {
    await operator.end();
  }
  await page.context().clearCookies();
  await page.goto(late);
  await page.reload();
  await expect(page.getByRole("heading", { name: "انتهت صلاحية هذه الدعوة" })).toBeVisible();
  await page.screenshot({ path: "work/activate-expired-ar.png" });
});
