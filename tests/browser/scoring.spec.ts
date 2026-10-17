import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { scoringFixture } from "../scoring-fixtures";
import { newIdentity, newRule, tr } from "../../src/instrument-input";

test("AR/EN scoring sandbox, golden score, boundary inputs, no posts and reload clears answers", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3000/workspace");
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
  // A malformed SUM draft is work in progress (D-175): it saves, never a 500,
  // and publication refuses it with the normal validation response.
  const malformed = scoringFixture(1, "CHECKBOXES", "SUM");
  malformed.sections[0].questions[0].scoring.mode = "OPTION_SUM";
  malformed.sections[0].questions[0].validation = {
    minSelections: 3,
    maxSelections: 2,
  };
  const accepted = await page.request.patch(url, {
    headers: {
      ...headers,
      "Idempotency-Key": randomUUID(),
      "If-Match": `"${v.revision}"`,
    },
    data: malformed,
  });
  expect(accepted.status()).toBe(200);
  v = (await accepted.json()).data;
  const step = (name: string) =>
    page.request.post(`${url}/${name}`, {
      headers: {
        ...headers,
        "Idempotency-Key": randomUUID(),
        "If-Match": `"${v.revision}"`,
      },
      data: {},
    });
  const validated = await step("validate");
  expect(validated.status()).toBe(200);
  expect(
    (await validated.json()).data.issues.map((i: { code: string }) => i.code),
  ).toContain("SELECTION_RANGE");
  const refused = await step("publish");
  expect(refused.status()).toBe(422);
  expect((await refused.json()).issues.length).toBeGreaterThan(0);
  expect((await (await page.request.get(url)).json()).data.state).toBe("DRAFT");
  // Test scoring says exactly why this dimension is not scored, where, and
  // goes to the question; it never falls back to one generic sentence.
  await page.reload();
  await page
    .getByRole("button", { name: "معاينة تجريبية", exact: true })
    .click();
  await page
    .getByRole("button", { name: "حساب الدرجات التجريبية", exact: true })
    .click();
  const unscored = page.getByTestId("sandbox-unscored");
  await expect(unscored).toContainText("الدعم");
  await expect(unscored).toContainText("لم يُحسب هذا البعد بعد");
  await expect(unscored).toContainText(
    "القسم 1 «قسم» · السؤال 1 «سؤال 1»: راجع الحدين الأدنى والأعلى للاختيارات.",
  );
  await expect(page.getByText("تعذر الحساب", { exact: true })).toHaveCount(0);
  await unscored
    .getByRole("listitem")
    .filter({ hasText: "راجع الحدين الأدنى والأعلى للاختيارات." })
    .getByRole("link", { name: "انتقل إلى الحقل" })
    .click();
  await expect(
    page.getByRole("button", { name: "بناء الاستبيان", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const qid = malformed.sections[0].questions[0].id;
  expect(
    await page.evaluate(
      (id) =>
        !!document
          .getElementById(`item-${id}`)
          ?.contains(document.activeElement),
      qid,
    ),
  ).toBe(true);
});

// Phase 3 of the pipeline repair: the preview can submit test answers. It
// checks required answers as a respondent's final submission does and shows
// the draft's scores, labelled as a test in both languages. Nothing is sent
// or saved, and leaving the preview or reloading clears it.
test("Arabic preview submits test answers locally and shows a labelled, unsaved test result", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3000/workspace");
  await page.request.patch("/api/v1/profile", {
    headers: { Origin: "http://127.0.0.1:3000" },
    data: { locale: "ar" },
  });
  const d = scoringFixture();
  d.dimensions[0].bands = [
    {
      ...newIdentity(),
      lower: "0",
      upper: "50",
      label: tr("منخفض", "Low"),
      severity: "HIGH",
      semantic: "RISK",
    },
    {
      ...newIdentity(),
      lower: "50",
      upper: "100",
      label: tr("مرتفع", "High"),
      severity: "NONE",
      semantic: "HEALTH",
    },
  ];
  d.overall = {
    enabled: true,
    direction: "HIGH_GOOD",
    inputs: [{ dimensionId: d.dimensions[0].id, weight: "1", invert: false }],
    bands: [],
  };
  // One rule that fires below 60, one that does not.
  const target = {
    kind: "DIMENSION" as const,
    dimensionId: d.dimensions[0].id,
  };
  const low = { ...newRule(target), dedupKey: "low" };
  low.condition.clauses[0].comparisons[0].value = "60";
  low.title = tr("دعم منخفض: {score}", "Low support: {score}");
  low.action = tr("راجع قنوات الدعم.", "Review support channels.");
  const high = { ...newRule(target), dedupKey: "high", priority: 200 };
  high.condition.clauses[0].comparisons[0].operator = "GTE";
  high.condition.clauses[0].comparisons[0].value = "60";
  high.title = tr("دعم جيد", "Good support");
  d.recommendations = [low, high];
  const headers = {
    Origin: "http://127.0.0.1:3000",
    "Idempotency-Key": randomUUID(),
  };
  const created = await page.request.post("/api/v1/questionnaires", {
    headers,
    data: { title: d.title },
  });
  const v0 = (await created.json()).data;
  const url = `/api/v1/questionnaires/${v0.questionnaire_id}/versions/${v0.id}`;
  const saved = await page.request.patch(url, {
    headers: { ...headers, "Idempotency-Key": randomUUID(), "If-Match": '"1"' },
    data: d,
  });
  expect(saved.status()).toBe(200);
  const v = (await saved.json()).data;
  await page.goto(`/questionnaires/${v.questionnaire_id}/versions/${v.id}`);
  const preview = () =>
    page.getByRole("button", { name: "معاينة تجريبية", exact: true }).click();
  await preview();
  let writes = 0;
  page.on("request", (r) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(r.method())) writes++;
  });
  const submit = page.getByRole("button", {
    name: "إرسال الإجابات التجريبية",
    exact: true,
  });
  const result = page.getByTestId("test-result");
  // Required answers are checked first, as for a respondent.
  await submit.click();
  await expect(page.getByTestId("test-incomplete")).toContainText("3");
  await expect(
    page.getByText("أكمل هذا السؤال.", { exact: true }).first(),
  ).toBeVisible();
  await expect(result).toHaveCount(0);
  await page.getByLabel("سؤال 1", { exact: true }).selectOption("5");
  await page.getByLabel("سؤال 2", { exact: true }).selectOption("3");
  await page.getByLabel("سؤال 3", { exact: true }).selectOption("1");
  await submit.click();
  await expect(result).toBeVisible();
  // Labelled as a test in Arabic and in English, whatever the preview language.
  await expect(result).toContainText(
    "اختبار فقط: لم يُحفظ ولم يُرسل، وليس نتيجة لأي شخص أو مؤسسة.",
  );
  await expect(result).toContainText(
    "TEST ONLY: not saved, not sent, and not a result for any person or organization.",
  );
  const dimension = result.getByTestId("test-result-dimension");
  await expect(dimension).toContainText("الدعم");
  await expect(dimension).toContainText("50.0 / 100");
  await expect(dimension).toContainText("مرتفع");
  await expect(dimension).toContainText("التغطية");
  await expect(result.getByTestId("test-result-overall")).toContainText(
    "50.0 / 100",
  );
  const recommendations = result.getByTestId("test-result-recommendations");
  await expect(recommendations).toContainText("دعم منخفض: 50.0");
  await expect(recommendations).toContainText("راجع قنوات الدعم.");
  await expect(recommendations).not.toContainText("دعم جيد");
  await expect(recommendations).toContainText("يقل عدد مشاركيها عن ٥");
  await page.setViewportSize({ width: 375, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "work/test-submission-ar-375.png",
    fullPage: true,
  });
  await page.getByLabel("لغة المعاينة").selectOption("en");
  await expect(result).toContainText("اختبار فقط");
  await expect(result).toContainText("TEST ONLY");
  await page.getByLabel("Preview language").selectOption("ar");
  // Back to the answers keeps them in memory; nothing was ever sent.
  await page
    .getByRole("button", { name: "العودة إلى الإجابات", exact: true })
    .click();
  await expect(page.getByLabel("سؤال 1", { exact: true })).toHaveValue("5");
  expect(writes).toBe(0);
  expect((await (await page.request.get(url)).json()).data.revision).toBe(
    v.revision,
  );
  // Leaving the preview clears it, and so does a reload.
  await submit.click();
  await expect(result).toBeVisible();
  await page
    .getByRole("button", { name: "بناء الاستبيان", exact: true })
    .click();
  await preview();
  await expect(result).toHaveCount(0);
  await expect(page.getByLabel("سؤال 1", { exact: true })).toHaveValue("");
  await page.getByLabel("سؤال 1", { exact: true }).selectOption("5");
  await page.getByLabel("سؤال 2", { exact: true }).selectOption("5");
  await page.getByLabel("سؤال 3", { exact: true }).selectOption("5");
  await submit.click();
  await expect(result).toBeVisible();
  await page.reload();
  await preview();
  await expect(result).toHaveCount(0);
  await expect(page.getByLabel("سؤال 1", { exact: true })).toHaveValue("");
  expect(writes).toBe(0);
});
