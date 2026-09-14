import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ids } from "../../scripts/seed";

// Questionnaire -> organization -> department targeting in the library.
async function login(page: Page, origin: string) {
  await page.goto("/login");
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await page.request.patch("/api/v1/profile", {
    headers: { Origin: origin },
    data: { locale: "en" },
  });
}
async function department(page: Page, origin: string, org: string, code: string, name: string) {
  const r = await page.request.post(`/api/v1/organizations/${org}/departments`, {
    headers: { Origin: origin, "Idempotency-Key": randomUUID() },
    data: { code, nameAr: name, nameEn: name },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).data.id as string;
}

test("target departments beneath the organization, clearing them when the organization changes", async ({
  page,
  baseURL,
}) => {
  const origin = baseURL!;
  await login(page, origin);
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  await department(page, origin, ids.orgA, `HR${suffix}`, `Human Resources A ${suffix}`);
  await department(page, origin, ids.orgA, `TECH${suffix}`, `Technology A ${suffix}`);
  await department(page, origin, ids.orgB, `SALES${suffix}`, `Sales B ${suffix}`);

  // No organization: the department filter is unavailable.
  await page.goto("/questionnaires");
  await expect(page.getByTestId("questionnaire-department-filter")).toBeDisabled();

  await page.goto(`/questionnaires?organization=${ids.orgA}`);
  const filter = page.getByTestId("questionnaire-department-filter");
  await expect(filter).toBeEnabled();
  await expect(filter.locator("option", { hasText: `Technology A ${suffix}` })).toHaveCount(1);
  await expect(filter.locator("option", { hasText: `Sales B ${suffix}` })).toHaveCount(0);

  await page.getByRole("button", { name: "Create blank questionnaire" }).click();
  const form = page.getByTestId("questionnaire-create");
  await form.getByLabel("Questionnaire title — العربية", { exact: true }).fill("بيئة العمل");
  await form.getByLabel("Questionnaire title — English", { exact: true }).fill(`Work environment ${suffix}`);
  await expect(form.getByTestId("questionnaire-create-organization")).toHaveValue(ids.orgA);
  await form.getByLabel("Specific departments").check();
  await form.getByLabel(`Human Resources A ${suffix}`).check();
  await form.getByLabel(`Technology A ${suffix}`).check();
  await expect(form.getByLabel(`Sales B ${suffix}`)).toHaveCount(0);

  // Another organization: its own departments only, and nothing kept selected.
  await form.getByTestId("questionnaire-create-organization").selectOption(ids.orgB);
  await expect(form.getByLabel(`Sales B ${suffix}`)).not.toBeChecked();
  await expect(form.getByLabel(`Human Resources A ${suffix}`)).toHaveCount(0);
  await expect(form.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await form.getByTestId("questionnaire-create-organization").selectOption(ids.orgA);
  await expect(form.getByLabel(`Human Resources A ${suffix}`)).not.toBeChecked();
  await expect(form.getByLabel(`Technology A ${suffix}`)).not.toBeChecked();
  await form.getByLabel(`Technology A ${suffix}`).check();
  await page.screenshot({ path: "work/questionnaire-target-create-en.png", fullPage: true });
  await form.getByRole("button", { name: "Create", exact: true }).click();

  await expect(page).toHaveURL(/versions/);
  const summary = page.getByTestId("questionnaire-target-summary");
  await expect(summary).toContainText("Synthetic organization A");
  await expect(summary).toContainText(`Technology A ${suffix}`);
  await expect(summary).not.toContainText(`Human Resources A ${suffix}`);

  // The library shows the organization and the target together, and the
  // department filter narrows to questionnaires that reach that department.
  await page.getByRole("link", { name: "All versions" }).click();
  const edit = page.getByTestId("questionnaire-target-edit");
  await edit.locator("summary").click();
  await edit.getByLabel(`Human Resources A ${suffix}`).check();
  await edit.getByRole("button", { name: "Save target" }).click();
  await expect(page.getByTestId("questionnaire-target-summary")).toContainText(
    `Human Resources A ${suffix}, Technology A ${suffix}`,
  );
  await page.screenshot({ path: "work/questionnaire-target-detail-en.png", fullPage: true });

  await page.goto(`/questionnaires?organization=${ids.orgA}`);
  const card = page.locator(".card", { hasText: `Work environment ${suffix}` });
  await expect(card.getByTestId("questionnaire-target-summary")).toContainText("Synthetic organization A");
  const ops = await department(page, origin, ids.orgA, `OPS${suffix}`, `Operations A ${suffix}`);
  await page.reload();
  await expect(filter.locator("option", { hasText: `Operations A ${suffix}` })).toHaveCount(1);
  await filter.selectOption(ops);
  await expect(page.locator(".card", { hasText: `Work environment ${suffix}` })).toHaveCount(0);
  await filter.selectOption({ label: `Technology A ${suffix}` });
  await expect(page.locator(".card", { hasText: `Work environment ${suffix}` })).toHaveCount(1);

  // Back to the whole organization.
  await page.locator(".card", { hasText: `Work environment ${suffix}` }).getByRole("link").first().click();
  await page.getByTestId("questionnaire-target-edit").locator("summary").click();
  await page.getByTestId("questionnaire-target-edit").getByLabel("Entire organization").check();
  await page.getByRole("button", { name: "Save target" }).click();
  await expect(page.getByTestId("questionnaire-target-summary")).toContainText("Entire organization");
});

test("Arabic right-to-left targeting at 375px without horizontal overflow", async ({ page, baseURL }) => {
  const origin = baseURL!;
  await login(page, origin);
  await page.request.patch("/api/v1/profile", { headers: { Origin: origin }, data: { locale: "ar" } });
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  await department(page, origin, ids.orgA, `FIN${suffix}`, `المالية ${suffix}`);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/questionnaires?organization=${ids.orgA}`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "إنشاء استبيان فارغ" }).click();
  const form = page.getByTestId("questionnaire-create");
  await form.getByLabel("أقسام محددة").check();
  await expect(form.getByLabel(`المالية ${suffix}`)).toBeVisible();
  await expect(form.getByText("اختر قسماً واحداً على الأقل.")).toBeVisible();
  await expect(form.getByRole("button", { name: "إنشاء", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "work/questionnaire-target-create-ar-375.png", fullPage: true });
});
