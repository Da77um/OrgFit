import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ids } from "../../scripts/seed";

// Campaign launch bounded by the questionnaire target (021), through the UI.
const BUILTIN_VERSION = "44000000-0000-4000-9000-000000000001";
const BUILTIN_QUESTIONNAIRE = "44000000-0000-4000-8000-000000000001";

test("the default campaign audience is everyone the questionnaire targets, enforced at launch", async ({
  page,
  baseURL,
}) => {
  const origin = baseURL!;
  await page.goto("/login");
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  const call = async (path: string, method: "GET" | "POST" | "PATCH", data?: unknown, revision?: string) => {
    const r = await page.request.fetch(`/api/v1/${path}`, {
      method,
      headers: {
        Origin: origin,
        "Idempotency-Key": randomUUID(),
        ...(revision ? { "If-Match": `"${revision}"` } : {}),
      },
      ...(data ? { data } : {}),
    });
    const body = await r.json();
    expect(r.ok(), JSON.stringify(body)).toBe(true);
    return body.data;
  };
  await call("profile", "PATCH", { locale: "en" });
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const org = `organizations/${ids.orgA}`;
  const hr = await call(`${org}/departments`, "POST", { code: `HR${suffix}`, nameAr: `HR ${suffix}`, nameEn: `Human Resources ${suffix}` });
  const empty = await call(`${org}/departments`, "POST", { code: `EM${suffix}`, nameAr: `EM ${suffix}`, nameEn: `Empty ${suffix}` });
  await call(`${org}/participants`, "POST", { privateReference: `H-${suffix}`, displayName: `HR person ${suffix}`, departmentId: hr.id });
  await call(`${org}/participants`, "POST", { privateReference: `N-${suffix}`, displayName: `No department ${suffix}` });

  const draft = await call(`${org}/questionnaires`, "POST", {
    title: { ar: "استبيان الموارد البشرية", en: `HR survey ${suffix}` },
    source: { organizationId: null, questionnaireId: BUILTIN_QUESTIONNAIRE, versionId: BUILTIN_VERSION },
    target: { mode: "DEPARTMENTS", departmentIds: [hr.id] },
  });
  const version = await call(`${org}/questionnaires/${draft.questionnaire_id}/versions/${draft.id}/publish`, "POST", {}, draft.revision);
  const family = (await call(`${org}/questionnaires/${draft.questionnaire_id}`, "GET")).family_key;
  const series = await call(`${org}/assessment-series`, "POST", { nameAr: `سلسلة ${suffix}`, purpose: "اختبار", questionnaireFamilyId: family });
  await call(`${org}/assessments`, "POST", {
    seriesId: series.id,
    label: `Round ${suffix}`,
    periodStart: "2026-03-01",
    questionnaireVersionId: version.id,
    populationDefinition: { schemaVersion: 1 },
  });

  await page.goto(`/${org}/assessments`);
  const form = page.locator("form").filter({ hasText: "New campaign" });
  await form.getByLabel("Round").selectOption({ label: `Round ${suffix}` });
  await form.getByLabel("Published questionnaire version").fill(version.id);
  await expect(form.getByLabel("Targeting")).toHaveValue("ALL");
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await form.getByLabel("Collection starts").fill(local(new Date(Date.now() - 60_000)));
  await form.getByLabel("Time zone").fill(Intl.DateTimeFormat().resolvedOptions().timeZone);
  await form.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(new RegExp(`/${org}/campaigns/`));

  // Only the HR person is in the questionnaire's target; the person without a
  // department is not invited.
  await expect(page.getByTestId("campaign-questionnaire-target")).toContainText(`Human Resources ${suffix}`);
  await expect(page.getByText("Invited: 1", { exact: false })).toBeVisible();

  // Narrow the questionnaire to a department with nobody in it: the review
  // explains, and the launch is refused with the same explanation.
  const current = await call(`${org}/questionnaires/${draft.questionnaire_id}`, "GET");
  await call(`${org}/questionnaires/${draft.questionnaire_id}/target`, "POST", { mode: "DEPARTMENTS", departmentIds: [empty.id] }, current.revision);
  await page.reload();
  const problem = "No active participants fall within the questionnaire's target.";
  await expect(page.getByRole("alert").filter({ hasText: problem })).toBeVisible();
  await page.screenshot({ path: "work/campaign-target-problem-en.png", fullPage: true });
  await page.getByRole("button", { name: "Launch campaign" }).click();
  await expect(page.getByText(problem).last()).toBeVisible();
  await expect(page.getByText("Invited: 0", { exact: false })).toBeVisible();

  // Entire organization again: every active participant is invited at launch,
  // including the person without a department. The browser specs share one
  // database, so the organization's size is counted here, not assumed.
  const again = await call(`${org}/questionnaires/${draft.questionnaire_id}`, "GET");
  await call(`${org}/questionnaires/${draft.questionnaire_id}/target`, "POST", { mode: "ORGANIZATION" }, again.revision);
  let active = 0;
  for (let cursor: string | null = null, first = true; first || cursor; first = false) {
    const listed: { items: unknown[]; nextCursor: string | null } = await call(
      `${org}/participants?status=ACTIVE&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      "GET",
    );
    active += listed.items.length;
    cursor = listed.nextCursor;
  }
  expect(active).toBeGreaterThanOrEqual(2);
  await page.reload();
  await expect(page.getByTestId("campaign-questionnaire-target")).toContainText("Entire organization");
  await expect(page.getByText(`Invited: ${active}`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Launch campaign" }).click();
  await expect(page.getByText(`Outstanding: ${active}`, { exact: false })).toBeVisible();
  await page.screenshot({ path: "work/campaign-target-launched-en.png", fullPage: true });
});
