import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { bootstrapDevAdmin } from "../../scripts/bootstrap-dev-admin";
import { ids } from "../../scripts/seed";

// ---------------------------------------------------------------------------
// Post-Audit Repair Pass 1 in a real browser: a Super Admin completes the staff,
// invitation and access workflows through the screens alone; an ordinary staff
// member is refused at the page and at the API; profile session operations stay
// inside the caller's own account; the audit browser reaches past the hundredth
// event; settings keep the floor and refuse a stale save; Arabic, English,
// keyboard and a phone width work.
//
// Every account here is synthetic and created in the harness's own database.
// ---------------------------------------------------------------------------

const STAFF = `http://127.0.0.1:${process.env.E2E_STAFF_PORT ?? 3000}`;
const ADMIN_EMAIL = `adm-${randomUUID().slice(0, 8)}@example.invalid`;
const PASSWORD = `Adm${randomUUID().slice(0, 10)}7`;
const INVITEE = `inv-${randomUUID().slice(0, 8)}@example.invalid`;
const INVITEE_PASSWORD = `Inv${randomUUID().slice(0, 10)}4`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.describe.configure({ mode: "serial" });

async function operator<T>(fn: (db: pg.Client) => Promise<T>) {
  const url = JSON.parse(await readFile("work/e2e-fixture.json", "utf8")).migration as string;
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("SET ROLE orgfit_core_owner");
    return await fn(db);
  } finally {
    await db.end();
  }
}

test.beforeAll(async () => {
  const url = JSON.parse(await readFile("work/e2e-fixture.json", "utf8")).migration as string;
  const outcome = await bootstrapDevAdmin(url, { email: ADMIN_EMAIL, password: PASSWORD, displayName: "مسؤولة الإدارة" }, {});
  expect(outcome.result).toBe("CREATED");
});

async function context(browser: Browser, locale: "ar" | "en" = "ar", viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  await page.request.post("/api/v1/locale", { headers: { Origin: STAFF }, data: { locale } });
  return page;
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  const english = (await page.locator("html").getAttribute("lang")) === "en";
  await page.getByLabel(english ? "Email address" : "البريد الإلكتروني").fill(email);
  await page.getByLabel(english ? "Password" : "كلمة المرور", { exact: true }).fill(password);
  await page.getByRole("button", { name: english ? "Sign in" : "تسجيل الدخول", exact: true }).click();
  await expect(page).toHaveURL(`${STAFF}/workspace`);
}

const settled = (page: Page) => expect(page.locator(".state-loading")).toHaveCount(0, { timeout: 20_000 });

async function axe(page: Page, name: string) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = result.violations.map((v) => `${v.id} [${v.impact}] ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect.soft(summary, `${name}\n${summary.join("\n")}`).toEqual([]);
}

let admin: Page;
let inviteePage: Page;

test("Super Admin: invite, activate, edit access, end sessions, disable and re-enable — all through the UI", async ({ browser }) => {
  test.setTimeout(240_000);
  admin = await context(browser);
  await signIn(admin, ADMIN_EMAIL, PASSWORD);

  // Reached from the workspace navigation, not by typing a URL.
  await admin.getByRole("navigation", { name: "الإدارة والحساب" }).getByRole("link", { name: "الموظفون والصلاحيات" }).click();
  await expect(admin).toHaveURL(`${STAFF}/staff`);
  await expect(admin.getByRole("heading", { level: 1, name: "الموظفون والصلاحيات" })).toBeVisible();
  await settled(admin);

  // Issue an invitation with a capability and an organization.
  const form = admin.locator("form").filter({ has: admin.getByRole("heading", { name: "إصدار دعوة" }) });
  await form.getByLabel("البريد الإلكتروني").fill(INVITEE);
  await form.getByLabel("مدة الصلاحية بالساعات").fill("24");
  await form.getByRole("checkbox", { name: /قراءة النتائج الآمنة/ }).check();
  await form.getByRole("checkbox", { name: /منظمة تجريبية أ/ }).check();
  await form.getByRole("button", { name: "إصدار الدعوة" }).click();
  await expect(form.getByRole("heading", { name: "رابط التفعيل — يظهر مرة واحدة" })).toBeFocused();
  const link = await form.locator("#invite-link").inputValue();
  expect(link).toMatch(/\/activate#[A-Za-z0-9_-]{43}$/);
  const invitations = admin.locator("section").filter({ has: admin.getByRole("heading", { name: "دعوات الموظفين" }) });
  await expect(invitations.getByRole("row").filter({ hasText: INVITEE })).toContainText("بانتظار التفعيل");
  await admin.screenshot({ path: "work/admin-staff-ar.png", fullPage: true });

  // The invitee activates in their own browser and signs in.
  inviteePage = await context(browser);
  await inviteePage.goto(link);
  await inviteePage.reload();
  await inviteePage.getByLabel("الاسم الظاهر").fill("موظف مدعو للإدارة");
  await inviteePage.getByLabel("كلمة المرور", { exact: true }).fill(INVITEE_PASSWORD);
  await inviteePage.getByLabel("تأكيد كلمة المرور").fill(INVITEE_PASSWORD);
  await inviteePage.getByRole("button", { name: "تفعيل الحساب" }).click();
  await expect(inviteePage.getByText("تم تفعيل حسابك")).toBeVisible();
  await signIn(inviteePage, INVITEE, INVITEE_PASSWORD);

  // The administrator finds the account by search and opens it.
  await admin.reload();
  await settled(admin);
  await expect(invitations.getByRole("row").filter({ hasText: INVITEE })).toContainText("مُستخدمة");
  await admin.getByLabel("الاسم أو البريد").fill(INVITEE);
  await admin.getByRole("button", { name: "بحث", exact: true }).click();
  await admin.getByRole("link", { name: "موظف مدعو للإدارة" }).click();
  await settled(admin);
  await expect(admin.getByRole("heading", { level: 1, name: "موظف مدعو للإدارة" })).toBeVisible();
  await expect(admin.getByRole("checkbox", { name: /قراءة النتائج الآمنة/ })).toBeChecked();
  await expect(admin.getByRole("checkbox", { name: /منظمة تجريبية أ/ })).toBeChecked();
  await admin.screenshot({ path: "work/admin-staff-detail-ar.png", fullPage: true });

  // Edit access: add a capability. The invitee's session ends.
  await admin.getByRole("checkbox", { name: /إدارة الزيارات والمرفقات/ }).check();
  await admin.getByRole("button", { name: "حفظ الوصول" }).click();
  await expect(admin.getByText("حُفظ الوصول وأُنهيت جلسات الحساب.")).toBeVisible();
  expect((await inviteePage.request.get("/api/v1/profile")).status()).toBe(401);
  const caps = await operator((db) => db.query("SELECT capability FROM access.staff_capability c JOIN access.staff_user u ON u.id=c.staff_user_id WHERE u.email=$1 ORDER BY 1", [INVITEE]));
  expect(caps.rows.map((r) => r.capability)).toEqual(["results.read", "visits.manage"]);

  // End all sessions, with an in-place confirmation reachable by keyboard.
  await signIn(inviteePage, INVITEE, INVITEE_PASSWORD);
  await admin.getByRole("button", { name: "إنهاء كل الجلسات" }).click();
  await expect(admin.getByRole("button", { name: "تأكيد إنهاء الجلسات" })).toBeFocused();
  await admin.keyboard.press("Enter");
  await expect(admin.getByText("أُنهيت جميع الجلسات.")).toBeVisible();
  expect((await inviteePage.request.get("/api/v1/profile")).status()).toBe(401);

  // Disable, then re-enable.
  await admin.getByRole("button", { name: "تعطيل الحساب" }).click();
  await admin.getByRole("button", { name: "تأكيد التعطيل" }).click();
  await expect(admin.locator(".page-meta")).toContainText("معطَّل");
  await inviteePage.goto("/login");
  await inviteePage.getByLabel("البريد الإلكتروني").fill(INVITEE);
  await inviteePage.getByLabel("كلمة المرور", { exact: true }).fill(INVITEE_PASSWORD);
  await inviteePage.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();
  await expect(inviteePage.locator(".alert-danger")).toContainText("بيانات الدخول غير صحيحة.");
  await admin.getByRole("button", { name: "إعادة تفعيل الحساب" }).click();
  await expect(admin.locator(".page-meta")).toContainText("نشط");

  // Stale revision: a second tab saves first, this one is told to reload.
  const second = await admin.context().newPage();
  await second.goto(admin.url());
  await settled(second);
  await second.getByRole("checkbox", { name: /إنتاج التقارير/ }).check();
  await second.getByRole("button", { name: "حفظ الوصول" }).click();
  await expect(second.getByText("حُفظ الوصول وأُنهيت جلسات الحساب.")).toBeVisible();
  await admin.getByRole("checkbox", { name: /إدارة الدليل/ }).check();
  await admin.getByRole("button", { name: "حفظ الوصول" }).click();
  await expect(admin.getByRole("alert").filter({ hasText: "تغيّر هذا السجل منذ فتحه" })).toBeVisible();
  await admin.getByRole("button", { name: "إعادة التحميل" }).click();
  await expect(admin.getByRole("checkbox", { name: /إنتاج التقارير/ })).toBeChecked();
  await second.close();

  await admin.goto("/staff");
  await settled(admin);

  // Withdraw a pending invitation and register an identity-provider account.
  const other = `wd-${randomUUID().slice(0, 8)}@example.invalid`;
  await form.getByLabel("البريد الإلكتروني").fill(other);
  await form.getByRole("button", { name: "إصدار الدعوة" }).click();
  await expect(form.locator("#invite-link")).toBeVisible();
  const row = invitations.getByRole("row").filter({ hasText: other });
  await row.getByRole("button", { name: "سحب الدعوة" }).click();
  await row.getByRole("button", { name: "تأكيد السحب" }).click();
  await expect(invitations.getByRole("row").filter({ hasText: other })).toContainText("مسحوبة");

  const register = admin.locator("form").filter({ has: admin.getByRole("heading", { name: "تسجيل حساب لدى موفر الهوية" }) });
  const registered = `oidc-${randomUUID().slice(0, 8)}@example.invalid`;
  await register.getByLabel("البريد الإلكتروني").fill(registered);
  await register.locator("#reg-name").fill("موظف موفر هوية");
  await register.getByLabel("معرّف الحساب لدى الموفر").fill(`subject-${randomUUID()}`);
  await register.getByRole("button", { name: "تسجيل الحساب" }).click();
  await expect(register.getByText("تم تسجيل الحساب.")).toBeVisible();
  const row2 = await operator((db) => db.query("SELECT issuer, role, status FROM access.staff_user WHERE email=$1", [registered]));
  expect(row2.rows[0]).toEqual({ issuer: "http://127.0.0.1:4010", role: "STAFF", status: "ACTIVE" });
  await axe(admin, "staff list ar");
});

test("ordinary staff cannot open or call administrator screens; own profile works", async ({ browser }) => {
  const page = await context(browser);
  await signIn(page, INVITEE, INVITEE_PASSWORD);
  await expect(page.getByRole("link", { name: "الموظفون والصلاحيات" })).toHaveCount(0);
  for (const path of ["/staff", `/staff/${ids.admin}`, "/audit", "/settings"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "هذه الصفحة للمسؤول العام" }), path).toBeVisible();
    await expect(page.locator("table")).toHaveCount(0);
  }
  for (const path of ["staff", `staff/${ids.admin}`, "staff/invitations", "staff/organizations", "audit", "settings/status"])
    expect((await page.request.get(`/api/v1/${path}`)).status(), path).toBe(403);
  for (const [path, data] of [
    ["staff/invitations", { email: "x@example.invalid", role: "SUPER_ADMIN", capabilities: [], organizationIds: [], locale: "ar", expiresInHours: 1 }],
    [`staff/${ids.admin}/revoke-sessions`, {}],
    ["audit/exports", { filters: {} }],
  ] as const)
    expect((await page.request.post(`/api/v1/${path}`, { headers: { Origin: STAFF, "Idempotency-Key": randomUUID() }, data })).status(), path).toBe(403);
  expect((await page.request.fetch("/api/v1/settings", { method: "PATCH", headers: { Origin: STAFF, "Idempotency-Key": randomUUID(), "If-Match": '"1"' }, data: { defaultTimezone: "UTC", defaultCampaignThreshold: 5, staffInvitationHours: 1 } })).status()).toBe(403);

  await page.goto("/workspace");
  await page.getByRole("navigation", { name: "الإدارة والحساب" }).getByRole("link", { name: "حسابي" }).click();
  await settled(page);
  await expect(page.getByRole("heading", { level: 1, name: "حسابي" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "الإدارة والحساب" }).getByRole("link", { name: "سجل التدقيق" })).toHaveCount(0);
  await page.context().close();
});

test("profile sessions: end another own session; another person's session is out of reach", async ({ browser }) => {
  const a = await context(browser);
  const b = await context(browser);
  await signIn(a, INVITEE, INVITEE_PASSWORD);
  await signIn(b, INVITEE, INVITEE_PASSWORD);
  await a.goto("/profile");
  await settled(a);
  const sessions = a.getByRole("region", { name: "الجلسات النشطة" });
  expect(await sessions.locator("tbody tr").count()).toBeGreaterThanOrEqual(2);
  await expect(sessions.getByText("هذه الجلسة")).toHaveCount(1);
  await expect(a.getByText("حساب كلمة مرور محلي لبيئة التطوير", { exact: false })).toBeVisible();

  // The administrator's session id, submitted through the invitee's profile operation.
  const adminSessions = await (await admin.request.get("/api/v1/profile/sessions")).json();
  const adminSession = adminSessions.data.items.find((s: { current: boolean }) => s.current).id;
  const r = await a.request.post(`/api/v1/profile/sessions/${adminSession}/revoke`, { headers: { Origin: STAFF, "Idempotency-Key": randomUUID() }, data: {} });
  expect(r.status()).toBe(404);
  expect((await admin.request.get("/api/v1/profile")).status()).toBe(200);

  await a.getByRole("button", { name: "إنهاء كل الجلسات الأخرى" }).click();
  await a.getByRole("button", { name: "تأكيد", exact: true }).click();
  await expect(a.getByText(/أُنهيت \d+ من الجلسات الأخرى\./)).toBeVisible();
  await expect(sessions.locator("tbody tr")).toHaveCount(1);
  await b.goto("/workspace");
  await expect(b).toHaveURL(/\/login\?expired=1$/);
  await axe(a, "profile ar");

  // Logout from the profile screen still ends the current session.
  await a.getByRole("button", { name: "تسجيل الخروج" }).click();
  await expect(a).toHaveURL(/\/login$/);
  await a.context().close();
  await b.context().close();
});

test("audit: more than 100 same-timestamp events reachable in the browser, filters, export", async () => {
  test.setTimeout(180_000);
  const adminId = (await operator((db) => db.query("SELECT id FROM access.staff_user WHERE email=$1", [ADMIN_EMAIL]))).rows[0].id;
  await operator((db) =>
    db.query(
      "INSERT INTO ops.audit_log(actor_id,action,target_id,field_names,occurred_at) SELECT $1,'PROFILE_UPDATED',gen_random_uuid(),ARRAY['locale'],'2026-09-03T09:00:00.5Z' FROM generate_series(1,130)",
      [adminId],
    ),
  );
  const expected = (await operator((db) => db.query("SELECT count(*)::int n FROM ops.audit_log WHERE action='PROFILE_UPDATED' AND actor_id=$1", [adminId]))).rows[0].n;
  await admin.goto("/workspace");
  await admin.getByRole("navigation", { name: "الإدارة والحساب" }).getByRole("link", { name: "سجل التدقيق" }).click();
  await settled(admin);
  await admin.getByLabel("الإجراء").selectOption("PROFILE_UPDATED");
  await admin.getByRole("button", { name: "تطبيق" }).click();
  await expect(admin).toHaveURL(/action=PROFILE_UPDATED/);
  const table = admin.getByRole("region", { name: "الأحداث الإدارية، الأحدث أولًا" });
  await expect(table.locator("tbody tr")).toHaveCount(50);
  // Filter by actor from a row.
  await table.locator("tbody tr").first().getByRole("button").click();
  await expect(admin).toHaveURL(new RegExp(`actorId=${adminId}`));
  await expect(table.locator("tbody tr")).toHaveCount(50);
  for (let shown = 50; shown < expected; shown += 50) {
    await admin.getByRole("button", { name: "عرض المزيد" }).click();
    await expect(table.locator("tbody tr")).toHaveCount(Math.min(expected, shown + 50));
  }
  await expect(admin.getByRole("button", { name: "عرض المزيد" })).toHaveCount(0);
  await expect(table.locator("tbody tr")).toHaveCount(expected);
  await expect(admin.getByText("اكتملت القائمة.", { exact: false })).toBeVisible();
  await admin.screenshot({ path: "work/admin-audit-ar.png" });

  const download = admin.waitForEvent("download");
  await admin.getByRole("button", { name: "تصدير المحدد (CSV)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^orgfit-audit-\d{8}T\d{6}Z\.csv$/);
  const csv = (await readFile(await file.path())).toString("utf8");
  expect(csv.trim().split("\r\n")).toHaveLength(expected + 1);
  await expect(admin.getByText("نُزِّل ملف التصدير", { exact: false })).toBeVisible();
  await axe(admin, "audit ar");
});

test("settings: defaults saved as a new version, floor kept, stale save refused, retention truthful", async () => {
  await admin.goto("/settings");
  await settled(admin);
  await expect(admin.getByText("مقترحة — غير معتمدة").first()).toBeVisible();
  await expect(admin.getByText("للتطوير فقط؛ جلسات كلمة المرور", { exact: false })).toBeVisible();
  const threshold = admin.getByLabel("الحد الأدنى الافتراضي للمساهمين في الحملة");
  await expect(threshold).toHaveAttribute("min", "5");
  const stale = await admin.context().newPage();
  await stale.goto("/settings");
  await settled(stale);

  await threshold.fill("6");
  await admin.getByRole("button", { name: "حفظ القيم الافتراضية" }).click();
  await expect(admin.getByText("حُفظ إصدار جديد من القيم الافتراضية.")).toBeVisible();
  await expect(admin.getByRole("region", { name: "سجل الإصدارات" }).locator("tbody tr")).toHaveCount(2);

  await stale.getByLabel("مدة دعوة الموظف الافتراضية (ساعات)").fill("12");
  await stale.getByRole("button", { name: "حفظ القيم الافتراضية" }).click();
  await expect(stale.getByRole("alert").filter({ hasText: "تغيّر هذا السجل منذ فتحه" })).toBeVisible();
  await stale.close();

  // The floor: the browser's own constraint is bypassed and the server refuses.
  const current = (await (await admin.request.get("/api/v1/settings")).json()).data;
  const low = await admin.request.fetch("/api/v1/settings", { method: "PATCH", headers: { Origin: STAFF, "Idempotency-Key": randomUUID(), "If-Match": `"${current.revision}"` }, data: { defaultTimezone: "Asia/Riyadh", defaultCampaignThreshold: 4, staffInvitationHours: 72 } });
  expect(low.status()).toBe(422);
  await axe(admin, "settings ar");

  // Put the default back so later specs see the seeded value.
  await threshold.fill("5");
  await admin.getByRole("button", { name: "حفظ القيم الافتراضية" }).click();
  await expect(admin.getByRole("region", { name: "سجل الإصدارات" }).locator("tbody tr")).toHaveCount(3);
});

test("English LTR, phone width and keyboard on every new screen", async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await context(browser, "en", { width: 375, height: 800 });
  await signIn(page, ADMIN_EMAIL, PASSWORD);
  // Sign-in applies the account's saved language (Arabic); switch with the
  // app bar control, which persists English on the profile.
  // (Retried: a click that lands before hydration has no handler yet.)
  await expect(async () => {
    await page.getByTestId("appbar-locale").click();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  for (const [path, heading] of [
    ["/staff", "Staff and access"],
    ["/audit", "Audit history"],
    ["/settings", "Global settings and system status"],
    ["/profile", "My account"],
  ] as const) {
    await page.goto(path);
    await settled(page);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    // On failure, name the widest offenders rather than only saying "too wide".
    const offenders = await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
        ? []
        : [...document.querySelectorAll("main *")]
            .filter((e) => e.getBoundingClientRect().right > innerWidth + 1 || e.getBoundingClientRect().left < -1)
            .filter((e) => !e.closest(".table-wrap"))
            .slice(0, 8)
            .map((e) => `${e.tagName.toLowerCase()}.${e.className} ${Math.round(e.getBoundingClientRect().width)}px`),
    );
    expect(offenders, `${path} at 375`).toEqual([]);
    await page.screenshot({ path: `work/admin-${path.slice(1)}-en-375.png`, fullPage: true });
    await axe(page, `${path} en 375`);
  }
  // Keyboard: skip link, then into the page; the focused control is visible.
  await page.goto("/staff");
  await settled(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => document.activeElement?.id === "staff-q");
  }
  expect(reached).toBe(true);
  await page.keyboard.type(ADMIN_EMAIL);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: "مسؤولة الإدارة" })).toBeVisible();
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe("none");
  // Restore the administrator's Arabic preference for any later spec.
  await expect(async () => {
    await page.getByTestId("appbar-locale").click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl", { timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await page.context().close();
  await inviteePage.context().close();
});
