import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { scoringFixture } from "../scoring-fixtures";
import { newIdentity, tr } from "../../src/instrument-input";

test("AR/EN scoring sandbox, golden score, boundary inputs, no posts and reload clears answers", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3000/");
  const localeResponse = await page.request.patch("/api/v1/profile", {
    headers: { Origin: "http://127.0.0.1:3000" },
    data: { locale: "ar" },
  });
  expect(localeResponse.status()).toBe(200);
  const d = scoringFixture();
  d.dimensions[0].bands = [
    {
      ...newIdentity(),
      lower: "0",
      upper: "100.0",
      label: tr("نطاق توضيحي", "Illustrative band"),
      severity: "NONE",
      semantic: "HEALTH",
    },
  ];
  d.sections[0].questions[1].scoring.reverse = true;
  const headers = {
    Origin: "http://127.0.0.1:3000",
    "Idempotency-Key": randomUUID(),
  };
  const created = await page.request.post("/api/v1/questionnaires", {
    headers,
    data: { title: d.title },
  });
  expect(created.status()).toBe(201);
  let v = (await created.json()).data;
  const url = `/api/v1/questionnaires/${v.questionnaire_id}/versions/${v.id}`;
  const saved = await page.request.patch(url, {
    headers: { ...headers, "Idempotency-Key": randomUUID(), "If-Match": '"1"' },
    data: d,
  });
  expect(saved.status()).toBe(200);
  v = (await saved.json()).data;
  await page.goto(`/questionnaires/${v.questionnaire_id}/versions/${v.id}`);
  await page
    .getByRole("button", { name: "معاينة تجريبية", exact: true })
    .click();
  let posts = 0;
  page.on("request", (r) => {
    if (["POST", "PATCH", "PUT"].includes(r.method())) posts++;
  });
  await page
    .getByRole("button", { name: "حساب الدرجات التجريبية", exact: true })
    .click();
  await expect(
    page.getByText("بيانات غير كافية", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "تعبئة أعلى القيم التجريبية", exact: true })
    .click();
  await expect(page.getByText("66.7 / 100", { exact: true })).toBeVisible();
  await page.getByLabel("سؤال 1", { exact: true }).selectOption("4");
  await page.getByLabel("سؤال 2", { exact: true }).selectOption("2");
  await page.getByLabel("سؤال 3", { exact: true }).selectOption("5");
  await expect(page.getByText("83.3 / 100", { exact: true })).toBeVisible();
  await expect(page.getByText("[0, 100.0]", { exact: true })).toBeVisible();
  await expect(
    page.getByText("لا توجد درجة كلية مهيأة.", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "work/scoring-ar-320.png", fullPage: true });
  await page.getByLabel("لغة المعاينة").selectOption("en");
  await expect(page.locator(".instrument-preview")).toHaveAttribute(
    "dir",
    "ltr",
  );
  await expect(page.getByText("83.3 / 100", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Question 2", { exact: true })).toHaveValue("2");
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.screenshot({
    path: "work/scoring-en-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Clear preview", exact: true })
    .click();
  await expect(
    page.getByText("Insufficient data", { exact: true }),
  ).toBeVisible();
  expect(posts).toBe(0);
  expect((await (await page.request.get(url)).json()).data.revision).toBe(
    v.revision,
  );
  await page.reload();
  await page
    .getByRole("button", { name: "معاينة تجريبية", exact: true })
    .click();
  await expect(page.getByLabel("سؤال 1", { exact: true })).toHaveValue("");
  // A malformed SUM draft must return the normal validation response, not 500.
  const malformed = scoringFixture(1, "CHECKBOXES", "SUM");
  malformed.sections[0].questions[0].scoring.mode = "OPTION_SUM";
  malformed.sections[0].questions[0].validation = {
    minSelections: 3,
    maxSelections: 2,
  };
  const rejected = await page.request.patch(url, {
    headers: {
      ...headers,
      "Idempotency-Key": randomUUID(),
      "If-Match": `"${v.revision}"`,
    },
    data: malformed,
  });
  expect(rejected.status()).toBe(422);
  expect((await (await page.request.get(url)).json()).data.revision).toBe(
    v.revision,
  );
});
