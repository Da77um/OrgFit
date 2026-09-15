import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ids } from "../../scripts/seed";
import { configureReport, reportPool, closeReportPool } from "../../src/report-db";
import { renderDueReports } from "../../src/report-worker";
import { STAFF, publishedRound } from "./published-round";


// The report journey in the real application: a staff member opens a published
// round, asks for an Arabic PDF, a separate renderer process draws it, and the
// staff member downloads it. Nothing in the browser renders a report, and the
// renderer never touches the browser's session.

test("Arabic report journey: request, render under the report credential, download", async ({
  page,
}) => {
  const { roundId } = await publishedRound(page);
  await page.request.patch(`${STAFF}/api/v1/profile`, {
    headers: { Origin: STAFF },
    data: { locale: "ar" },
  });

  await page.goto(`${STAFF}/organizations/${ids.orgA}/results/${roundId}`);
  await page.getByRole("button", { name: "التقارير", exact: true }).click();
  await expect(page.getByRole("heading", { name: "التقارير" })).toBeVisible();
  // The panel states what a report is before it offers to make one.
  await expect(
    page.getByText("لا يُرسل أي ملف تلقائيًا", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("لا توجد تقارير لهذه الجولة بعد.")).toBeVisible();

  await page.getByLabel("الصيغة").selectOption("PDF");
  await page.getByLabel("لغة التقرير").selectOption("ar");
  await page.getByRole("button", { name: "طلب تقرير" }).click();
  await expect(page.getByRole("cell", { name: "في الانتظار" })).toBeVisible();

  // The renderer: its own credential, its own process boundary. It is given no
  // staff session and no organization identifier — only a job.
  const fixture = JSON.parse(await readFile("work/e2e-fixture.json", "utf8"));
  process.env.REPORT_ENCRYPTION_KEY = fixture.reportEncryptionKey;
  process.env.REPORT_LOCAL_DIRECTORY = fixture.reportDirectory;
  configureReport(fixture.report);
  try {
    const outcomes = await renderDueReports(reportPool(), 4);
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes[0].state).toBe("READY");
    // A rendered report reaches for nothing over the network.
    expect(outcomes[0].networkAttempts).toBe(0);
  } finally {
    await closeReportPool();
    configureReport(undefined);
  }

  await page.reload();
  await page.getByRole("button", { name: "التقارير", exact: true }).click();
  await expect(page.getByRole("cell", { name: "جاهز" })).toBeVisible();
  const download = page.getByRole("link", { name: "تنزيل" });
  await expect(download).toBeVisible();

  const href = (await download.getAttribute("href")) ?? "";
  const response = await page.request.get(`${STAFF}${href}`, {
    headers: { Origin: STAFF },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  expect(response.headers()["content-disposition"]).toContain("attachment");
  expect(response.headers()["cache-control"]).toBe("no-store");
  const bytes = Buffer.from(await response.body());
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(20_000);

  // Print opens the same file inline in a new tab, under the file policy the
  // proxy asserts for file bytes — never the application's own.
  const print = page.getByRole("link", { name: "طباعة" });
  await expect(print).toBeVisible();
  await expect(print).toHaveAttribute("target", "_blank");
  const printHref = (await print.getAttribute("href")) ?? "";
  expect(printHref).toBe(href.replace(/\/download$/, "/view"));
  const inline = await page.request.get(`${STAFF}${printHref}`, {
    headers: { Origin: STAFF },
  });
  expect(inline.status()).toBe(200);
  expect(inline.headers()["content-type"]).toBe("application/pdf");
  expect(inline.headers()["content-disposition"]).toMatch(/^inline; /);
  expect(inline.headers()["content-security-policy"]).toMatch(/^sandbox; default-src 'none'/);
  expect(inline.headers()["content-security-policy"]).not.toContain("nonce");
  expect(Buffer.from(await inline.body()).equals(bytes)).toBe(true);

  await page.setViewportSize({ width: 320, height: 720 });
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "work/reports-ar-320.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // English keeps the same panel with the same guarantees.
  await page.request.patch(`${STAFF}/api/v1/profile`, {
    headers: { Origin: STAFF },
    data: { locale: "en" },
  });
  await page.reload();
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Ready" })).toBeVisible();
  await page.screenshot({ path: "work/reports-en-desktop.png", fullPage: true });
});
