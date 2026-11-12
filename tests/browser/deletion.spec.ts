import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { tr } from "../../src/instrument-input";

// D-187 / D-188: deletion asks for the exact title or code before it can run.
async function login(page: Page, baseURL: string) {
  await page.goto("/login");
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${baseURL}/workspace`);
  await page.request.patch("/api/v1/profile", {
    headers: { Origin: baseURL },
    data: { locale: "ar" },
  });
}

test("Arabic library: deleting a questionnaire requires typing its title", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  const name = `استبيان للحذف ${randomUUID().slice(0, 6)}`;
  const r = await page.request.post("/api/v1/questionnaires", {
    headers: { Origin: baseURL!, "Idempotency-Key": randomUUID() },
    data: { title: tr(name, "") },
  });
  expect(r.ok()).toBe(true);
  await page.goto("/questionnaires");
  const card = page.locator("li.card").filter({ hasText: name });
  // Built-in templates never offer Delete.
  await expect(
    page.locator("li.card").filter({ hasText: "قالب توضيحي" }).first().getByRole("button", { name: "حذف" }),
  ).toHaveCount(0);
  await card.getByRole("button", { name: "حذف", exact: true }).click();
  const form = card.getByTestId("questionnaire-delete");
  await expect(form).toContainText("لا يمكن التراجع عن الحذف.");
  const confirm = form.getByRole("button", { name: "حذف الاستبيان", exact: true });
  await expect(confirm).toBeDisabled();
  await form.getByRole("textbox").fill("عنوان آخر");
  await expect(confirm).toBeDisabled();
  await form.getByRole("textbox").fill(name);
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: "work/delete-questionnaire-ar.png", fullPage: true });
  await confirm.click();
  await expect(page.getByText("حُذف الاستبيان.", { exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.getByLabel("الحالة").selectOption("ALL");
  await page.getByRole("button", { name: "بحث", exact: true }).click();
  await expect(page.locator("li.card").filter({ hasText: name })).toHaveCount(0);
});

test("Arabic organization overview: deleting requires typing the code, then returns to the list", async ({
  page,
  baseURL,
}) => {
  await login(page, baseURL!);
  const code = `DEL_${randomUUID().slice(0, 6).toUpperCase()}`;
  const r = await page.request.post("/api/v1/organizations", {
    headers: { Origin: baseURL!, "Idempotency-Key": randomUUID() },
    data: { code, nameAr: `منظمة للحذف ${code}` },
  });
  expect(r.ok()).toBe(true);
  const created = (await r.json()).data;
  await page.goto(`/organizations/${created.id}/overview`);
  const panel = page.getByTestId("organization-delete");
  await panel.getByRole("button", { name: "حذف المنظمة", exact: true }).click();
  const form = page.getByTestId("organization-delete-form");
  await expect(form).toContainText("لا يمكن التراجع عن الحذف.");
  await expect(form).toContainText(code);
  const confirm = form.getByRole("button", { name: "حذف المنظمة", exact: true });
  await expect(confirm).toBeDisabled();
  await form.getByRole("textbox").fill(`${code}X`);
  await expect(confirm).toBeDisabled();
  await form.getByRole("textbox").fill(code);
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: "work/delete-organization-ar.png", fullPage: true });
  await confirm.click();
  await expect(page).toHaveURL(/\/organizations$/);
  const gone = await page.request.get(`/api/v1/organizations/${created.id}`);
  expect(gone.status()).toBe(404);

});
