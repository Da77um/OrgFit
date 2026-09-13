import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { illustrativeTemplates } from "../../src/instrument-templates";
import {
  newQuestion,
  questionTypes,
  tr,
  newIdentity,
} from "../../src/instrument-input";
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
test("Arabic library, blank editor, keyboard ordering, autosave and immutable publication", async ({
  page,
}) => {
  await login(page);
  await page.goto("/questionnaires");
  await page.getByRole("button", { name: "إنشاء استبيان فارغ" }).click();
  await page
    .getByLabel("عنوان الاستبيان — العربية", { exact: true })
    .fill("استبيان اختبار المتصفح");
  await page
    .getByLabel("عنوان الاستبيان — English", { exact: true })
    .fill("Browser instrument");
  await page.getByRole("button", { name: "إنشاء", exact: true }).click();
  await expect(page).toHaveURL(/versions/);
  await page
    .getByLabel("إشعار الخصوصية — العربية")
    .fill("إشعار خصوصية تجريبي فقط.");
  await page.getByRole("button", { name: "إضافة قسم", exact: true }).click();
  await page.getByLabel("عنوان القسم — العربية").fill("القسم الأول");
  await page.getByRole("button", { name: "إضافة سؤال", exact: true }).click();
  await page.getByLabel("السؤال / المحتوى — العربية").fill("سؤال أول");
  await expect(page.getByLabel("إجابة مطلوبة")).toBeChecked();
  await page.getByRole("button", { name: "إضافة سؤال", exact: true }).click();
  await page.getByLabel("السؤال / المحتوى — العربية").nth(1).fill("سؤال ثان");
  await page.getByLabel("إجابة مطلوبة").nth(1).uncheck();
  const second = page.locator(".builder-question").nth(1);
  await second.getByRole("button", { name: "نقل لأعلى", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".builder-question summary").first()).toContainText(
    "سؤال ثان",
  );
  await expect(page.getByText("تم الحفظ.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".builder-question summary").first()).toContainText(
    "سؤال ثان",
  );
  await page.getByRole("button", { name: "نشر النسخة وتثبيتها" }).click();
  await expect(
    page.getByRole("heading", { name: /منشور وثابت/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "حفظ الآن" })).toHaveCount(0);
  await page.getByRole("button", { name: "إنشاء نسخة مسودة جديدة" }).click();
  await expect(page.getByRole("heading", { name: /النسخة 2/ })).toBeVisible();
  await expect(
    page.getByLabel("السؤال / المحتوى — العربية").first(),
  ).toHaveValue("سؤال ثان");
  await page.setViewportSize({ width: 320, height: 850 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "work/instrument-editor-ar-320.png",
    fullPage: true,
  });
});
// Phase 09: the versioned rule editor. A rule is ordinary version content, so
// it must survive the same autosave and reload path as a question, and it must
// be expressible only as bounded numeric comparisons over known metrics.
test("Arabic recommendation rule editor persists bounded rules with the draft", async ({
  page,
}) => {
  await login(page);
  await page.goto("/questionnaires");
  await page.getByRole("button", { name: "إنشاء استبيان فارغ" }).click();
  await page
    .getByLabel("عنوان الاستبيان — العربية", { exact: true })
    .fill("استبيان قواعد التوصيات");
  await page.getByRole("button", { name: "إنشاء", exact: true }).click();
  await expect(page).toHaveURL(/versions/);
  // A rule can only target a metric the version computes, so the dimension
  // comes first; a rule pointing at nothing is refused before it can be saved.
  await page.getByRole("button", { name: "الأبعاد والتفسير" }).click();
  await page.getByRole("button", { name: "إضافة بعد" }).click();
  await page.getByLabel("اسم البعد — العربية").fill("عبء العمل");
  await page.getByRole("button", { name: "قواعد التوصيات" }).click();
  await expect(
    page.getByText("لا تعتمد على ذكاء اصطناعي", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "إضافة قاعدة" }).click();
  await page.getByLabel("مفتاح منع التكرار").fill("workload-review");
  await page.getByLabel("الأولوية (الأصغر أولًا)").fill("20");
  await page
    .getByLabel("العنوان — العربية", { exact: true })
    .fill("مراجعة توزيع الأعباء");
  // The comparison is a metric, an operator and a bounded number: there is no
  // free expression field to type into.
  await expect(
    page.getByRole("option", { name: /Overall score/ }).first(),
  ).toBeAttached();
  await page.getByLabel("المقارنة").selectOption("BETWEEN");
  await expect(page.getByLabel("إلى (غير شامل)")).toBeVisible();
  await page.getByLabel("القيمة (٠ إلى ١٠٠)").fill("40");
  await page.getByLabel("إلى (غير شامل)").fill("70");
  await expect(page.getByText("تم الحفظ.", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "قواعد التوصيات" }).click();
  await expect(page.getByLabel("مفتاح منع التكرار")).toHaveValue(
    "workload-review",
  );
  await expect(page.getByLabel("القيمة (٠ إلى ١٠٠)")).toHaveValue("40");
  await expect(page.getByLabel("إلى (غير شامل)")).toHaveValue("70");
  await expect(
    page.getByLabel("العنوان — العربية"),
  ).toHaveValue("مراجعة توزيع الأعباء");
});
test("all-type AR/EN preview, bilingual completeness, no collection and stale HTTP writes", async ({
  page,
}) => {
  await login(page);
  const headers = {
    Origin: "http://127.0.0.1:3000",
    "Idempotency-Key": randomUUID(),
  };
  const root = `/api/v1/organizations/${ids.orgA}/questionnaires`;
  const created = await page.request.post(root, {
    headers,
    data: { title: tr("جميع الأنواع", "All types") },
  });
  expect(created.status()).toBe(201);
  let v = (await created.json()).data;
  const d = illustrativeTemplates()[0];
  d.title = tr("جميع الأنواع", "All types");
  d.sections[0].questions = questionTypes.map((type) => {
    const q = newQuestion(type);
    q.prompt = tr(`سؤال ${type}`, `Question ${type}`);
    for (const o of [...q.options, ...q.rows, ...q.columns])
      o.label = tr("تسمية", "Label");
    return q;
  });
  const url = `${root}/${v.questionnaire_id}/versions/${v.id}`;
  const saved = await page.request.patch(url, {
    headers: { ...headers, "Idempotency-Key": randomUUID(), "If-Match": '"1"' },
    data: d,
  });
  expect(saved.status()).toBe(200);
  v = (await saved.json()).data;
  expect(
    (
      await page.request.patch(url, {
        headers: {
          ...headers,
          "Idempotency-Key": randomUUID(),
          "If-Match": '"1"',
        },
        data: d,
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await page.request.patch(url, {
        headers: {
          ...headers,
          "Idempotency-Key": randomUUID(),
          "If-Match": `"${v.revision}"`,
        },
        data: { ...d, skipLogic: [] },
      })
    ).status(),
  ).toBe(422);
  await page.goto(
    `/questionnaires/${v.questionnaire_id}/versions/${v.id}?organization=${ids.orgA}`,
  );
  await page
    .getByRole("button", { name: "معاينة تجريبية", exact: true })
    .click();
  let answerPosts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" || r.method() === "PATCH") answerPosts++;
  });
  await page
    .getByLabel("سؤال SHORT_TEXT", { exact: true })
    .fill("Synthetic only");
  await page.getByLabel("لغة المعاينة").selectOption("en");
  await expect(page.locator(".instrument-preview")).toHaveAttribute(
    "dir",
    "ltr",
  );
  await expect(
    page.getByLabel("Question SHORT_TEXT", { exact: true }),
  ).toHaveValue("Synthetic only");
  await expect(
    page.getByText("Progress: 1 / 11", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 850 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "work/instrument-preview-en-320.png",
    fullPage: true,
  });
  await page.getByLabel("Preview language").selectOption("ar");
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.screenshot({
    path: "work/instrument-preview-ar-desktop.png",
    fullPage: true,
  });
  expect(answerPosts).toBe(0);
  const incomplete = structuredClone(d);
  incomplete.sections[0].questions[0].prompt.en = "";
  const updated = await page.request.patch(url, {
    headers: {
      ...headers,
      "Idempotency-Key": randomUUID(),
      "If-Match": `"${v.revision}"`,
    },
    data: incomplete,
  });
  expect(updated.status()).toBe(200);
  v = (await updated.json()).data;
  const publish = await page.request.post(url + "/publish", {
    headers: {
      ...headers,
      "Idempotency-Key": randomUUID(),
      "If-Match": `"${v.revision}"`,
    },
    data: {},
  });
  expect(publish.status()).toBe(422);
  expect(
    (await publish.json()).issues.some(
      (i: { code: string }) => i.code === "TRANSLATION_REQUIRED",
    ),
  ).toBe(true);
});
test("built-in clone remains illustrative and source stays immutable", async ({
  page,
}) => {
  await login(page);
  await page.goto(
    "/questionnaires/44000000-0000-4000-8000-000000000001/versions/44000000-0000-4000-9000-000000000001",
  );
  await expect(
    page.getByText("قالب توضيحي فقط، غير معتمد علمياً."),
  ).toBeVisible();
  await page.getByText("نسخ إلى استبيان مخصص مستقل", { exact: true }).click();
  await page.getByLabel("عنوان النسخة المخصصة — العربية").fill("نسخة خاصة");
  await page.getByLabel("عنوان النسخة المخصصة — English").fill("Custom copy");
  await page
    .getByRole("combobox", { name: "نطاق النسخة", exact: true })
    .selectOption(ids.orgA);
  await page.getByRole("button", { name: "إنشاء نسخة مخصصة" }).click();
  await expect(page).toHaveURL(new RegExp(`organization=${ids.orgA}`));
  await expect(page.getByLabel("المقدمة — العربية")).toContainText(
    "غير معتمد علمياً",
  );
});

test("English dimension and band editors persist scoring declarations without computing", async ({
  page,
}) => {
  await login(page);
  const headers = {
    Origin: "http://127.0.0.1:3000",
    "Idempotency-Key": randomUUID(),
  };
  const root = "/api/v1/questionnaires",
    d = illustrativeTemplates()[0];
  const dim = {
    ...newIdentity(),
    name: tr("الدعم", "Support"),
    description: tr(),
    mode: "WEIGHTED_AVERAGE" as const,
    coverage: "0.8",
    direction: "HIGH_GOOD" as const,
    denominator: null,
    bands: [
      {
        ...newIdentity(),
        lower: "0",
        upper: "100",
        label: tr("نطاق تجريبي", "Illustrative band"),
        severity: "NONE" as const,
        semantic: "HEALTH" as const,
      },
    ],
  };
  d.dimensions = [dim];
  d.sections[0].questions[0].dimensionId = dim.id;
  d.sections[0].questions[0].scoring.enabled = true;
  const created = await page.request.post(root, {
    headers,
    data: { title: d.title },
  });
  expect(created.status()).toBe(201);
  const v = (await created.json()).data;
  const saved = await page.request.patch(
    `${root}/${v.questionnaire_id}/versions/${v.id}`,
    {
      headers: {
        ...headers,
        "Idempotency-Key": randomUUID(),
        "If-Match": '"1"',
      },
      data: d,
    },
  );
  expect(saved.status()).toBe(200);
  await page.request.patch("/api/v1/profile", {
    headers: { Origin: headers.Origin },
    data: { locale: "en" },
  });
  await page.goto(`/questionnaires/${v.questionnaire_id}/versions/${v.id}`);
  await page
    .getByRole("button", { name: "Dimensions and bands", exact: true })
    .click();
  await expect(page.getByLabel("Dimension name — English")).toHaveValue(
    "Support",
  );
  await expect(page.getByLabel("Band label — English")).toHaveValue(
    "Illustrative band",
  );
  await page.getByLabel("Minimum coverage (0 to 1)").fill("0.9");
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByLabel("Reverse scoring").check();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Reverse scoring")).toBeChecked();
  await page
    .getByRole("button", { name: "Dimensions and bands", exact: true })
    .click();
  await expect(page.getByLabel("Minimum coverage (0 to 1)")).toHaveValue("0.9");
  await page.setViewportSize({ width: 320, height: 850 });
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "work/instrument-dimensions-en-320.png",
    fullPage: true,
  });
});
