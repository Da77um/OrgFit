import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ids } from "../../scripts/seed";

// The guided "send a questionnaire" flow (D-189): pickers only, the existing
// endpoints in order, the existing launch review, links through the existing
// export. Directory data is prepared through the API; the flow itself never
// types an identifier.
const BUILTIN_VERSION = "44000000-0000-4000-9000-000000000001";
const BUILTIN_QUESTIONNAIRE = "44000000-0000-4000-8000-000000000001";

async function signIn(page: Page, origin: string) {
  await page.goto("/login");
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  const call = async (path: string, method: "GET" | "POST" | "PATCH" = "GET", data?: unknown) => {
    const r = await page.request.fetch(`/api/v1/${path}`, {
      method,
      headers: { Origin: origin, "Idempotency-Key": randomUUID() },
      ...(data ? { data } : {}),
    });
    const body = await r.json();
    expect(r.ok(), JSON.stringify(body)).toBe(true);
    return body.data;
  };
  await call("profile", "PATCH", { locale: "ar" });
  return call;
}

test("guided send from a published questionnaire to a department, pickers only, then launch and issue links", async ({
  page,
  baseURL,
}) => {
  const call = await signIn(page, baseURL!);
  const org = `organizations/${ids.orgA}`;
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const department = await call(`${org}/departments`, "POST", {
    code: `SND${suffix}`,
    nameAr: `قسم الإرسال ${suffix}`,
    nameEn: `Sending ${suffix}`,
  });
  for (let n = 1; n <= 6; n++)
    await call(`${org}/participants`, "POST", {
      privateReference: `SND-${suffix}-${n}`,
      displayName: `مستلم ${suffix} ${n}`,
      departmentId: department.id,
    });
  const family = (await call(`questionnaires/${BUILTIN_QUESTIONNAIRE}`)).family_key as string;
  const seriesOfFamily = async () =>
    ((await call(`${org}/assessment-series?status=ACTIVE`)).items as { questionnaire_family_id: string }[]).filter(
      (s) => s.questionnaire_family_id === family,
    ).length;
  const before = await seriesOfFamily();

  // Start from the published questionnaire itself.
  await page.goto(`/questionnaires/${BUILTIN_QUESTIONNAIRE}/versions/${BUILTIN_VERSION}`);
  const entry = page.getByTestId("send-entry");
  await expect(entry).toBeVisible();
  await entry.getByLabel("المنظمة").selectOption({ label: "منظمة تجريبية أ" });
  await entry.getByRole("button", { name: "إرسال إلى منظمة" }).click();
  await expect(page).toHaveURL(new RegExp(`/${org}/send\\?version=${BUILTIN_VERSION}$`));
  await expect(page.getByRole("heading", { name: "إرسال استبانة", level: 1 })).toBeVisible();

  // The questionnaire arrives preselected; no field asks for an identifier.
  await expect(page.getByLabel("الاستبانة", { exact: true })).toHaveValue(BUILTIN_VERSION);
  await expect(page.getByTestId("send-form").getByText(/معرّف/)).toHaveCount(0);
  await page.getByLabel("قسم", { exact: true }).check();
  await page
    .getByLabel("القسم", { exact: true })
    .selectOption({ label: `قسم الإرسال ${suffix} (6 مشارك نشط)` });
  await expect(page.getByTestId("send-count")).toHaveText("عدد المستلمين: 6");
  await expect(page.getByText("أقل من الحد الأدنى")).toHaveCount(0);
  await expect(page.getByTestId("send-stops")).toHaveCount(0);
  // The round label is proposed from the questionnaire and the month.
  const proposed = await page.getByLabel("اسم الجولة").inputValue();
  expect(proposed).toContain(" — ");
  await page.getByLabel("اسم الجولة").fill(`إرسال موجّه ${suffix}`);
  await page.screenshot({ path: "work/send-guided-ar.png", fullPage: true });

  await page.getByRole("button", { name: "إنشاء الحملة وفتح مراجعة الإطلاق" }).click();
  await expect(page).toHaveURL(new RegExp(`/${org}/campaigns/[0-9a-f-]{36}$`));
  const campaignId = page.url().split("/").at(-1)!;
  // The existing launch review, unchanged.
  await expect(page.getByRole("heading", { name: "مراجعة ما سيتم تجميده" })).toBeVisible();
  await expect(page.getByText("عدد المدعوين: 6", { exact: false })).toBeVisible();
  await expect(page.getByText("قابلة للنشر", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("غير قابلة للنشر")).toHaveCount(0);
  expect(await seriesOfFamily()).toBe(Math.max(before, 1));

  await page.getByRole("button", { name: "إطلاق الحملة" }).click();
  await expect(page.getByText("مفتوحة")).toBeVisible();
  const distribute = page.getByTestId("distribute");
  await expect(distribute.getByRole("heading", { name: "إيصال الروابط إلى المشاركين" })).toBeVisible();
  await expect(distribute.getByText("لا يرسل النظام أي رسالة", { exact: false })).toBeVisible();
  await expect(distribute.getByText("تنتهي صلاحيته بعد ٢٤ ساعة", { exact: false })).toBeVisible();
  // A refused export is reported beside the button, not at the page top far
  // above it; the retry offered there sends the same request.
  await page.route(
    "**/link-exports",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "TEMPORARILY_UNAVAILABLE", message: "الخدمة غير متاحة حاليًا. حاول مرة أخرى لاحقًا." }),
      }),
    { times: 1 },
  );
  await distribute.getByRole("button", { name: "إصدار الروابط لجميع المشاركين" }).click();
  await expect(distribute.getByRole("alert")).toContainText("لم يتأكد حفظ هذا التغيير");
  await expect(distribute.getByRole("alert")).toBeInViewport();
  await distribute.getByRole("button", { name: "إعادة إرسال الطلب نفسه" }).click();
  await expect(page.getByText("الملف جاهز للتنزيل")).toBeVisible();
  await expect(distribute.getByText("الملف جاهز للتنزيل")).toBeVisible();
  const download = distribute.getByRole("link", { name: "تنزيل" });
  const href = (await download.getAttribute("href"))!;
  expect(href).toMatch(new RegExp(`/api/v1/${org}/campaigns/${campaignId}/link-exports/[0-9a-f-]{36}$`));
  const csv = await (await page.request.get(href, { headers: { Origin: baseURL! } })).text();
  const rows = csv.trim().split(/\r?\n/);
  expect(rows).toHaveLength(7);
  for (const row of rows.slice(1)) expect(row).toMatch(/"http:\/\/localhost:\d+\/s#[A-Za-z0-9_-]{43}"$/);
  // Everyone has a link now; issuing again needs the explicit replacement.
  await expect(distribute.getByRole("button", { name: "إصدار الروابط لجميع المشاركين" })).toBeDisabled();
  await expect(distribute.getByLabel(/استبدال الروابط المُصدرة سابقًا أيضًا \(6\)/)).toBeVisible();
  await expect(page.getByText("بلا رابط")).toHaveCount(0);
  await page.screenshot({ path: "work/send-distribute-ar.png", fullPage: true });

  // A second send of the same questionnaire reuses the series.
  await page.goto(`/${org}/send?version=${BUILTIN_VERSION}`);
  await expect(page.getByLabel("الاستبانة", { exact: true })).toHaveValue(BUILTIN_VERSION);
  await page.getByLabel("قسم", { exact: true }).check();
  await page
    .getByLabel("القسم", { exact: true })
    .selectOption({ label: `قسم الإرسال ${suffix} (6 مشارك نشط)` });
  await page.getByLabel("اسم الجولة").fill(`إرسال موجّه ثانٍ ${suffix}`);
  await page.getByRole("button", { name: "إنشاء الحملة وفتح مراجعة الإطلاق" }).click();
  await expect(page).toHaveURL(new RegExp(`/${org}/campaigns/[0-9a-f-]{36}$`));
  expect(await seriesOfFamily()).toBe(Math.max(before, 1));
});

test("a department with no participants is stopped before submit, with the way to fix it", async ({
  page,
  baseURL,
}) => {
  const call = await signIn(page, baseURL!);
  const org = `organizations/${ids.orgA}`;
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  await call(`${org}/departments`, "POST", {
    code: `EMP${suffix}`,
    nameAr: `قسم فارغ ${suffix}`,
  });
  const small = await call(`${org}/departments`, "POST", {
    code: `SML${suffix}`,
    nameAr: `قسم صغير ${suffix}`,
  });
  for (let n = 1; n <= 3; n++)
    await call(`${org}/participants`, "POST", {
      privateReference: `SML-${suffix}-${n}`,
      displayName: `صغير ${suffix} ${n}`,
      departmentId: small.id,
    });
  // Nothing may be created while the form is only being filled in.
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && /\/(assessment-series|assessments|campaigns)(\/|$)/.test(r.url())) writes.push(r.url());
  });

  // The Assessments page's primary action opens the guided form.
  await page.goto(`/${org}/assessments`);
  await page.getByTestId("send-start").first().click();
  await expect(page).toHaveURL(new RegExp(`/${org}/send$`));
  await page.getByLabel("الاستبانة", { exact: true }).selectOption(BUILTIN_VERSION);
  await page.getByLabel("قسم", { exact: true }).check();
  await page.getByLabel("القسم", { exact: true }).selectOption({ label: `قسم فارغ ${suffix} (0 مشارك نشط)` });
  const stops = page.getByTestId("send-stops");
  await expect(stops).toContainText("لا يوجد مشاركون في هذا القسم. أضف المشاركين أو استوردهم أولًا");
  await expect(stops.getByRole("link", { name: "صفحة المشاركين" })).toHaveAttribute("href", `/${org}/participants`);
  await expect(stops.getByRole("link", { name: "استيراد المشاركين" })).toHaveAttribute(
    "href",
    `/${org}/participants/import`,
  );
  const submit = page.getByRole("button", { name: "إنشاء الحملة وفتح مراجعة الإطلاق" });
  await expect(submit).toBeDisabled();
  await page.screenshot({ path: "work/send-empty-department-ar.png", fullPage: true });

  // Below the threshold is a warning, not a stop.
  await page.getByLabel("القسم", { exact: true }).selectOption({ label: `قسم صغير ${suffix} (3 مشارك نشط)` });
  await expect(page.getByText("عدد المستلمين (3) أقل من الحد الأدنى (5)", { exact: false })).toBeVisible();
  await expect(page.getByTestId("send-stops")).toHaveCount(0);
  await expect(submit).toBeEnabled();

  expect(writes).toEqual([]);
});
