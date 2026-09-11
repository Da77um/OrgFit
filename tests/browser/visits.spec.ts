import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ids } from "../../scripts/seed";
import {
  configureScanner,
  scannerPool,
  closeScannerPool,
} from "../../src/scanner-db";
import { scanDueAttachments } from "../../src/attachment-worker";

const STAFF = "http://127.0.0.1:3000";

// The field-visit journey in the real application: a consultant records a
// visit, moves it through its states, adds a follow-up action, attaches a file,
// a SEPARATE process scans that file, and only then does a download link exist.
//
// The point of doing this in a browser rather than only against the route is
// that the quarantine has to be visible. A staff member must be able to see
// that a file is not yet readable, rather than click a link that fails.

async function login(page: Page) {
  await page.goto(`${STAFF}/login`);
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${STAFF}/`);
}

// A scan run under the scanner's own credential, exactly as the operator script
// would. The browser session plays no part in it and is never handed to it.
async function runScanner() {
  const fixture = JSON.parse(await readFile("work/e2e-fixture.json", "utf8"));
  process.env.ATTACHMENT_ENCRYPTION_KEY = fixture.attachmentEncryptionKey;
  process.env.ATTACHMENT_LOCAL_DIRECTORY = fixture.attachmentDirectory;
  configureScanner(fixture.scanner);
  try {
    return await scanDueAttachments(scannerPool(), 10);
  } finally {
    await closeScannerPool();
    configureScanner(undefined);
  }
}

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "latin1",
);

test("Arabic visit journey: record, complete, attach, scan, download", async ({
  page,
}) => {
  await login(page);
  await page.request.patch(`${STAFF}/api/v1/profile`, {
    headers: { Origin: STAFF },
    data: { locale: "ar" },
  });

  await page.goto(`${STAFF}/organizations/${ids.orgA}/visits`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "الزيارات الميدانية",
  );
  // The screen says what a visit is, and what it is not, before it offers to
  // create one.
  await expect(
    page.getByText("مادة استشارية سرية", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("لا تُرسل هذه الشاشة أي بريد", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("لا توجد زيارات مسجلة.")).toBeVisible();

  await page.getByRole("button", { name: "زيارة جديدة" }).click();
  await page
    .getByLabel("الغرض")
    .fill("زيارة ميدانية لتقييم بيئة العمل في الفروع");
  await page.getByLabel("بداية الزيارة").fill("2026-10-05T09:00");
  await page.getByLabel("نهاية الزيارة").fill("2026-10-05T14:00");
  await page
    .getByLabel("ملاحظات", { exact: true })
    .fill("قوبل فريق التشغيل في الفرع الرئيسي.");
  await page.getByRole("button", { name: "حفظ" }).click();

  await expect(page).toHaveURL(/\/visits\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "زيارة ميدانية لتقييم بيئة العمل في الفروع",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("definition").filter({ hasText: "مسودة" }),
  ).toBeVisible();

  // The state machine, through the buttons the screen actually offers. There is
  // no control that jumps a state.
  await expect(page.getByRole("button", { name: "إنهاء" })).toHaveCount(0);
  await page.getByRole("button", { name: "جدولة" }).click();
  await expect(page.getByRole("button", { name: "بدء" })).toBeVisible();
  await page.getByRole("button", { name: "بدء" }).click();
  await page.getByRole("button", { name: "إنهاء" }).click();
  await expect(
    page.getByRole("button", { name: "تعديل بعد الإنهاء" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "جدولة" })).toHaveCount(0);

  // A follow-up action: an internal task with an owner and a due date, and no
  // message of any kind.
  await page.getByRole("button", { name: "إجراء متابعة جديد" }).click();
  await page.getByLabel("العنوان").fill("توثيق قنوات التصعيد للمشرفين");
  await page.getByLabel("تاريخ الاستحقاق").fill("2026-11-01");
  await page.locator("form").getByRole("button", { name: "حفظ" }).click();
  await expect(
    page.getByRole("rowheader", { name: "توثيق قنوات التصعيد للمشرفين" }),
  ).toBeVisible();

  // The attachment. It arrives quarantined and says so, and no download link
  // exists for it yet.
  await expect(
    page.getByText("لا يمكن تنزيل أي مرفق قبل اكتمال فحصه", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("إضافة مرفق").setInputFiles({
    name: "تقرير-الزيارة.pdf",
    mimeType: "application/pdf",
    buffer: PDF,
  });
  await expect(
    page.getByRole("cell", { name: "في الحجر — بانتظار الفحص" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "تنزيل" })).toHaveCount(0);

  const outcomes = await runScanner();
  expect(outcomes.length).toBeGreaterThan(0);
  expect(outcomes.some((o) => o.state === "CLEAN")).toBe(true);

  await page.reload();
  await expect(page.getByRole("cell", { name: "مفحوص وسليم" })).toBeVisible();
  const download = page.getByRole("link", { name: "تنزيل" });
  await expect(download).toBeVisible();
  const href = (await download.getAttribute("href")) ?? "";
  const response = await page.request.get(`${STAFF}${href}`, {
    headers: { Origin: STAFF },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/octet-stream");
  expect(response.headers()["content-disposition"]).toContain("attachment");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["content-security-policy"]).toContain("sandbox");
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(Buffer.from(await response.body())).toEqual(PDF);

  // 320 px: the tables scroll inside their own boxes, the page does not.
  await page.setViewportSize({ width: 320, height: 720 });
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "work/visits-ar-320.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // English keeps the same screen, the same states and the same guarantees.
  await page.request.patch(`${STAFF}/api/v1/profile`, {
    headers: { Origin: STAFF },
    data: { locale: "en" },
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByText("Scanned and clean")).toBeVisible();
  await expect(
    page.getByText("They are not linked to survey answers", { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: "work/visits-en-desktop.png", fullPage: true });
});

test("a rejected file never becomes downloadable", async ({ page }) => {
  await login(page);
  await page.request.patch(`${STAFF}/api/v1/profile`, {
    headers: { Origin: STAFF },
    data: { locale: "en" },
  });
  await page.goto(`${STAFF}/organizations/${ids.orgA}/visits`);
  await page.getByRole("button", { name: "New visit" }).click();
  await page.getByLabel("Purpose").fill("Attachment rejection check");
  await page.getByLabel("Starts").fill("2026-10-06T09:00");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/visits\/[0-9a-f-]{36}$/);

  // An executable wearing a PDF name. The browser calls it a PDF; the bytes do
  // not, and the bytes decide.
  await page.getByLabel("Add attachment").setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 0x90)]),
  });
  await expect(
    page.getByRole("cell", { name: "Quarantined — awaiting scan" }),
  ).toBeVisible();
  await runScanner();
  await page.reload();
  await expect(
    page.getByRole("cell", {
      name: /Rejected — The file contains executable or active content\./,
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Download" })).toHaveCount(0);
});
