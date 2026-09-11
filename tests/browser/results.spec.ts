import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ids } from "../../scripts/seed";
import { STAFF, publishedRound } from "./published-round";

test("Arabic results journey: published aggregates, suppression wording and accessible tables", async ({
  page,
}) => {
  const { roundId, campaignId, seriesName } = await publishedRound(page);
  await page.request.patch(`${STAFF}/api/v1/profile`, {
    headers: { Origin: STAFF },
    data: { locale: "ar" },
  });

  // The campaign page offers the release, and only once it is published.
  await page.goto(`${STAFF}/organizations/${ids.orgA}/campaigns/${campaignId}`);
  const link = page.getByRole("link", { name: "عرض النتائج المنشورة" });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(
    `${STAFF}/organizations/${ids.orgA}/results/${roundId}`,
  );
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  // ---- overview ----------------------------------------------------------
  await expect(page.getByRole("heading", { level: 1 })).toContainText("النتائج");
  await expect(
    page.getByText("لا يمكن للنظام إظهار إجابة فرد", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("عدد المساهمين", { exact: true })).toBeVisible();
  // The contributor count moved from a definition list to a stat tile in the
  // design-system pass. The assertion is unchanged in force: the figure must be
  // on screen, beside its own label, and it must be the published 12.
  await expect(
    page.locator(".tile").filter({ hasText: "عدد المساهمين" }).getByText("12"),
  ).toBeVisible();
  const table = page.getByRole("table").first();
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "الحالة" })).toBeVisible();
  // No respondent's free text ever reaches a released view.
  await expect(page.getByText("تعليق 0")).toHaveCount(0);

  // ---- departments -------------------------------------------------------
  await page.getByRole("button", { name: "الأقسام" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "الشركة" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "الهندسة" })).toBeVisible();
  await expect(
    page.getByText("الفروق وصفية فقط", { exact: false }),
  ).toBeVisible();

  // ---- question analysis -------------------------------------------------
  await page.getByRole("button", { name: "تحليل الأسئلة" }).click();
  // Free text is present as a question and explicitly withheld as a value.
  await expect(
    page.getByText("لا تُنشر النصوص الحرة والتواريخ الدقيقة", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("تعليق 1")).toHaveCount(0);

  // ---- recommendations ---------------------------------------------------
  await page.getByRole("button", { name: "التوصيات" }).click();
  await expect(
    page.getByText("اقتراحات استشارية وليست تشخيصًا", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "مراجعة ممارسات الدعم" }),
  ).toBeVisible();
  // The rendered rationale carries only published numbers, and the evidence
  // table names the exact cells it was derived from.
  const evidence = page.getByRole("table").filter({ hasText: "الشواهد المنشورة" });
  await expect(evidence).toBeVisible();
  await expect(page.getByText("النتيجة العامة", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("تعليق 0")).toHaveCount(0);
  // The follow-up beside it is human workflow, saved separately and labelled so.
  await expect(
    page.getByText("محسوبة ومجمّدة مع الإصدار", { exact: false }).first(),
  ).toBeVisible();
  await page.getByLabel("حالة المتابعة").selectOption("IN_PROGRESS");
  await page
    .getByLabel("ملاحظات المستشار", { exact: false })
    .fill("ملاحظة استشارية للاختبار");
  await page.getByRole("button", { name: "حفظ المتابعة" }).click();
  await expect(page.getByText("تم الحفظ.", { exact: true })).toBeVisible();
  // Persisted beside the frozen finding, and readable back through the same
  // results surface rather than from any private store.
  const saved = await (
    await page.request.get(
      `${STAFF}/api/v1/organizations/${ids.orgA}/assessments/${roundId}/results/recommendations`,
      { headers: { Origin: STAFF } },
    )
  ).json();
  expect(saved.data.items[0].action.status).toBe("IN_PROGRESS");
  expect(saved.data.items[0].action.staffNotes).toBe("ملاحظة استشارية للاختبار");
  await page.getByRole("button", { name: "تحليل الأسئلة" }).click();
  await expect(
    page.getByText("لا تُنشر النصوص الحرة والتواريخ الدقيقة", { exact: false }),
  ).toBeVisible();

  // A withheld cell never renders as a zero or an empty bar.
  const withheld = page.locator(".result-withheld");
  expect(await withheld.count()).toBeGreaterThan(0);
  for (const text of await withheld.allInnerTexts()) expect(text.trim()).not.toBe("0");

  // ---- narrow viewport ---------------------------------------------------
  await page.setViewportSize({ width: 320, height: 900 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "work/results-ar-320.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // ---- history -------------------------------------------------------------
  // One released round is already a history of one: the series lists it, the
  // trend plots the published company value, and nothing individual appears.
  await page.goto(`${STAFF}/organizations/${ids.orgA}/history`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "السجل التاريخي",
  );
  await page.getByRole("link", { name: seriesName }).click();
  await expect(page.getByRole("heading", { name: "تطور النتائج" })).toBeVisible();
  const trend = page.getByRole("table").first();
  await expect(trend.getByRole("columnheader", { name: "عدد المساهمين" })).toBeVisible();
  await expect(trend.getByText("منشورة وقابلة للمقارنة").first()).toBeVisible();
  await expect(page.getByText("لا يجري ربط أي مشارك بين الجولات", { exact: false })).toBeVisible();
  await expect(page.getByText("تعليق 0")).toHaveCount(0);
  // A single released round offers nothing to compare yet.
  await expect(page.getByText("لا توجد مقارنات معتمدة")).toBeVisible();
  await page.goto(`${STAFF}/organizations/${ids.orgA}/results/${roundId}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("النتائج");

  // ---- English and unsupported slices -------------------------------------
  await page.request.patch(`${STAFF}/api/v1/profile`, {
    headers: { Origin: STAFF },
    data: { locale: "en" },
  });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Results");
  await page.screenshot({ path: "work/results-en-desktop.png", fullPage: true });
  const refused = await page.request.get(
    `${STAFF}/api/v1/organizations/${ids.orgA}/assessments/${roundId}/results?departmentId=${randomUUID()}`,
    { headers: { Origin: STAFF } },
  );
  expect(refused.status()).toBe(400);
  expect((await refused.json()).code).toBe("UNSUPPORTED_FILTER");
});
