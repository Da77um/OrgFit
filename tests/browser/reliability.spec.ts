import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { bootstrapDevAdmin } from "../../scripts/bootstrap-dev-admin";
import { ids } from "../../scripts/seed";
import { messages } from "../../src/i18n";
import { visitMessages } from "../../src/visits-i18n";
import { directoryMessages } from "../../src/directory-i18n";
import { resultsMessages } from "../../src/results-i18n";
import { adminMessages } from "../../src/admin-i18n";
import { campaignMessages } from "../../src/campaign-i18n";
import { STAFF, publishedRound } from "./published-round";

// Post-Audit Repair Pass 2 in the real application, against the real server
// and database: bounded staff requests, a lost answer to a change that DID
// commit, the same idempotency key on retry, an ended session that keeps the
// edits, unsaved directory and visit forms across Arabic/English changes, and
// the waiting states of reports and attachments.
//
// Network faults are introduced with Playwright routing: a held request is a
// connection that never answers (the browser's own deadline then fires, in
// real time), and `route.fetch()` followed by `route.abort()` lets the server
// commit a change while the browser never receives its answer.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const ORG = `${STAFF}/api/v1/organizations/${ids.orgA}`;
// Visits made here live in organization B: visits.spec.ts, which runs later in
// a full suite, expects organization A to start with no visits.
const VISITS = `${STAFF}/api/v1/organizations/${ids.orgB}`;

async function login(page: Page, locale: "ar" | "en") {
  await page.goto(`${STAFF}/login`);
  await page.getByRole("link", { name: messages("ar").signin }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${STAFF}/workspace`);
  await setLocale(page, locale);
}
async function setLocale(page: Page, locale: "ar" | "en") {
  const r = await page.request.patch(`${STAFF}/api/v1/profile`, { headers: { Origin: STAFF }, data: { locale } });
  expect(r.status()).toBe(200);
}
async function axe(page: Page, name: string) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = result.violations.map(
    (v) => `${v.id} [${v.impact}] ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`,
  );
  expect.soft(summary, `${name}\n${summary.join("\n")}`).toEqual([]);
}
async function visitsWith(page: Page, purpose: string) {
  const r = await page.request.get(`${VISITS}/visits`);
  expect(r.status()).toBe(200);
  const items = (await r.json()).data.items as { id: string; purpose: string }[];
  return items.filter((v) => v.purpose === purpose);
}
// A request that is never answered. Playwright keeps the route pending; the
// application's own deadline is what ends it.
const hold = (_route: Route) => new Promise<void>(() => {});

test("a delayed read shows loading, a read that never answers times out and recovers", async ({ page }) => {
  test.setTimeout(120_000);
  const m = messages("en");
  const v = visitMessages("en");
  await login(page, "en");

  // Delayed within the deadline: loading, then the list.
  let mode: "delay" | "hang" | "pass" = "delay";
  await page.route(/\/api\/v1\/organizations\/[^/]+\/visits\?/, async (route) => {
    if (mode === "hang") return hold(route);
    if (mode === "delay") await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await page.goto(`${STAFF}/organizations/${ids.orgB}/visits`);
  await expect(page.getByRole("status").filter({ hasText: v.loading })).toBeVisible();
  await expect(page.getByRole("heading", { name: v.list })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: v.loading })).toHaveCount(0, { timeout: 15_000 });

  // Never answered: the 20-second deadline fires for real.
  mode = "hang";
  await page.reload();
  const started = Date.now();
  const problem = page.getByTestId("visits-load-problem");
  await expect(problem).toContainText(m.requestTimeout.replace("{seconds}", "20"), { timeout: 30_000 });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThan(18_000);
  // The loading state and the disabled controls recover.
  await expect(page.getByRole("status").filter({ hasText: v.loading })).toHaveCount(0);
  await expect(page.getByRole("button", { name: v.newVisit })).toBeEnabled();
  await axe(page, "timeout state en");

  mode = "pass";
  await problem.getByRole("button", { name: m.retry }).click();
  await expect(problem).toHaveCount(0);
});

test("a visit whose creation commits but loses its answer is retried with the same key and body: one visit", async ({ page }) => {
  const m = messages("ar");
  const v = visitMessages("ar");
  await login(page, "ar");
  const purpose = `زيارة موثوقية ${randomUUID().slice(0, 8)}`;
  const sent: { key: string; body: string }[] = [];
  let drop = true;
  await page.route(/\/api\/v1\/organizations\/[^/]+\/visits$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    sent.push({ key: request.headers()["idempotency-key"], body: request.postData() ?? "" });
    if (drop) {
      drop = false;
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      return route.abort("connectionreset");
    }
    return route.continue();
  });

  await page.goto(`${STAFF}/organizations/${ids.orgB}/visits`);
  await page.getByRole("button", { name: v.newVisit }).click();
  await page.getByLabel(v.purpose).fill(purpose);
  await page.getByLabel(v.scheduledStart).fill("2026-10-07T09:00");
  const save = page.getByRole("button", { name: v.save, exact: true });
  await save.click();

  const problem = page.getByTestId("visit-page-problem");
  await expect(problem).toContainText(m.outcomeUnknownTitle);
  await expect(problem).toContainText(m.outcomeUnknownBody);
  // The record exists on the server although the browser never heard so.
  expect(await visitsWith(page, purpose)).toHaveLength(1);
  // The edits are still on screen, and the controls are usable again.
  await expect(page.getByLabel(v.purpose)).toHaveValue(purpose);
  await expect(save).toBeEnabled();
  await axe(page, "uncertain outcome ar");
  await page.screenshot({ path: "work/pass2-uncertain-ar.png", fullPage: true });

  await problem.getByRole("button", { name: m.retrySame }).click();
  await expect(page).toHaveURL(/\/visits\/[0-9a-f-]{36}$/);
  expect(sent).toHaveLength(2);
  expect(sent[1].key).toBe(sent[0].key);
  expect(sent[1].body).toBe(sent[0].body);
  expect(await visitsWith(page, purpose)).toHaveLength(1);
});

test("an edit that never answers is uncertain, keeps the edits, and saves once when sent again", async ({ page }) => {
  test.setTimeout(120_000);
  const m = messages("en");
  const v = visitMessages("en");
  await login(page, "en");
  const purpose = `Reliability edit ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${VISITS}/visits`, {
    headers: { Origin: STAFF, "Idempotency-Key": randomUUID() },
    data: {
      relatedRoundId: null,
      assignedConsultantId: ids.admin,
      scheduledStart: "2026-10-08T06:00:00.000Z",
      scheduledEnd: null,
      timezone: "Asia/Riyadh",
      purpose,
      notes: null,
      findings: null,
      recommendations: null,
      followUpDate: null,
      amendmentReason: null,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const visitId = (await created.json()).data.id as string;

  const patches: { key: string; body: string }[] = [];
  let hang = true;
  await page.route(new RegExp(`/visits/${visitId}$`), async (route) => {
    const request = route.request();
    if (request.method() !== "PATCH") return route.continue();
    patches.push({ key: request.headers()["idempotency-key"], body: request.postData() ?? "" });
    if (hang) {
      hang = false;
      return hold(route);
    }
    return route.continue();
  });

  await page.goto(`${STAFF}/organizations/${ids.orgB}/visits/${visitId}`);
  await page.getByRole("button", { name: v.edit, exact: true }).click();
  await page.getByLabel(v.purpose).fill(`${purpose} (edited)`);
  const save = page.getByRole("button", { name: v.save, exact: true });
  await save.click();
  // While it waits, a second click cannot send a second request.
  await expect(save).toBeDisabled();
  await save.click({ force: true }).catch(() => {});
  const problem = page.getByTestId("visit-page-problem");
  await expect(problem).toContainText(m.requestTimeoutChange.replace("{seconds}", "20"), { timeout: 30_000 });
  await expect(problem).toContainText(m.outcomeUnknownTitle);
  expect(patches).toHaveLength(1);
  await expect(save).toBeEnabled();
  await expect(page.getByLabel(v.purpose)).toHaveValue(`${purpose} (edited)`);

  await problem.getByRole("button", { name: m.retrySame }).click();
  await expect(page.getByRole("heading", { level: 2, name: `${purpose} (edited)` })).toBeVisible();
  expect(patches).toHaveLength(2);
  expect(patches[1].key).toBe(patches[0].key);
  expect(patches[1].body).toBe(patches[0].body);
  await expect(page.getByLabel(v.purpose)).toHaveCount(0);
});

test("an ended session during a save keeps the edits and offers sign-in in a new tab", async ({ page }) => {
  const m = messages("ar");
  const v = visitMessages("ar");
  await login(page, "ar");
  await page.route(/\/api\/v1\/organizations\/[^/]+\/visits$/, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 401, contentType: "application/json", body: '{"code":"SESSION_REQUIRED","message":"x"}' })
      : route.continue(),
  );
  await page.goto(`${STAFF}/organizations/${ids.orgB}/visits`);
  await page.getByRole("button", { name: v.newVisit }).click();
  await page.getByLabel(v.purpose).fill("لا تضيع هذه الملاحظة");
  await page.getByLabel(v.scheduledStart).fill("2026-10-09T09:00");
  await page.getByRole("button", { name: v.save, exact: true }).click();
  const problem = page.getByTestId("visit-page-problem");
  await expect(problem).toContainText(m.sessionEndedKeep);
  const link = problem.getByRole("link", { name: m.signInNewTab });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(page).toHaveURL(/\/visits$/);
  await expect(page.getByLabel(v.purpose)).toHaveValue("لا تضيع هذه الملاحظة");
});

test("an unsaved visit form asks before an Arabic → English change: keep, discard, save and continue", async ({ page }) => {
  const ar = messages("ar");
  const en = messages("en");
  const va = visitMessages("ar");
  const ve = visitMessages("en");
  await login(page, "ar");
  await page.goto(`${STAFF}/organizations/${ids.orgB}/visits`);
  await page.getByRole("button", { name: va.newVisit }).click();
  await page.getByLabel(va.purpose).fill("مسودة لم تُحفظ");

  // Keep editing (Escape).
  await page.getByTestId("appbar-locale").click();
  const dialog = page.getByRole("dialog", { name: ar.unsavedTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(ar.unsavedLocale);
  await expect(dialog.getByRole("button", { name: ar.unsavedStay })).toBeFocused();
  await axe(page, "unsaved dialog ar");
  await page.screenshot({ path: "work/pass2-unsaved-dialog-ar.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByLabel(va.purpose)).toHaveValue("مسودة لم تُحفظ");
  // Focus returns to the control that asked.
  await expect(page.getByTestId("appbar-locale")).toBeFocused();

  // A rail link asks too.
  await page.getByRole("link", { name: ar.navOverview }).click();
  await expect(page.getByRole("dialog", { name: ar.unsavedTitle })).toContainText(ar.unsavedNavigate);
  await page.getByRole("button", { name: ar.unsavedStay }).click();
  await expect(page).toHaveURL(/\/visits$/);

  // Discard: the language changes and the draft is gone.
  await page.getByTestId("appbar-locale").click();
  await page.getByRole("button", { name: ar.unsavedDiscard }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByLabel(ve.purpose)).toHaveCount(0);

  // Save that the server refuses: nothing is left, the edits stay.
  await page.getByRole("button", { name: ve.newVisit }).click();
  await page.getByLabel(ve.purpose).fill("Missing a start time");
  await page.getByTestId("appbar-locale").click();
  const enDialog = page.getByRole("dialog", { name: en.unsavedTitle });
  await enDialog.getByRole("button", { name: en.unsavedSave }).click();
  await expect(enDialog.getByRole("alert")).toContainText(en.unsavedSaveFailed);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await enDialog.getByRole("button", { name: en.unsavedStay }).click();
  await expect(page.getByLabel(ve.purpose)).toHaveValue("Missing a start time");

  // Save and continue: saved first, confirmed, then the language changes.
  const purpose = `Saved on switch ${randomUUID().slice(0, 8)}`;
  await page.getByLabel(ve.purpose).fill(purpose);
  await page.getByLabel(ve.scheduledStart).fill("2026-10-10T09:00");
  await page.getByTestId("appbar-locale").click();
  await page.getByRole("dialog", { name: en.unsavedTitle }).getByRole("button", { name: en.unsavedSave }).click();
  await expect(page).toHaveURL(/\/visits\/[0-9a-f-]{36}$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByRole("heading", { level: 2, name: purpose })).toBeVisible();
  expect(await visitsWith(page, purpose)).toHaveLength(1);
});

test("an unsaved directory editor asks before an English → Arabic change and saves on request", async ({ page }) => {
  const ar = messages("ar");
  const en = messages("en");
  const de = directoryMessages("en");
  const da = directoryMessages("ar");
  await login(page, "en");
  await page.goto(`${STAFF}/organizations/${ids.orgA}/participants`);
  await page.getByRole("button", { name: de.new, exact: true }).click();
  const reference = `REL_${randomUUID().slice(0, 8).toUpperCase()}`;
  await page.getByLabel(`${de.privateReference} *`).fill(reference);
  await page.getByLabel(`${de.displayName} *`, { exact: true }).fill("Reliability Person");

  await page.getByTestId("appbar-locale").click();
  const dialog = page.getByRole("dialog", { name: en.unsavedTitle });
  await expect(dialog).toContainText(en.unsavedLocale);
  await axe(page, "unsaved dialog en");
  // Phone width: the dialog fits, its actions wrap, nothing scrolls sideways.
  await page.setViewportSize({ width: 375, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const box = await dialog.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 375).toBeTruthy();
  await page.screenshot({ path: "work/pass2-unsaved-dialog-en-375.png" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await dialog.getByRole("button", { name: en.unsavedSave }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByText(reference)).toBeVisible();
  const listed = await page.request.get(`${ORG}/participants?q=${reference}`);
  expect(((await listed.json()).data.items as unknown[]).length).toBe(1);

  // Arabic department editor, discarded on the way to English.
  await page.goto(`${STAFF}/organizations/${ids.orgA}/departments`);
  await page.getByRole("button", { name: da.new, exact: true }).click();
  await page.getByLabel(`${da.code} *`, { exact: true }).fill("DISCARDED");
  await page.getByTestId("appbar-locale").click();
  await expect(page.getByRole("dialog", { name: ar.unsavedTitle })).toBeVisible();
  // Typing a value back to what it was is not an unsaved change.
  await page.getByRole("button", { name: ar.unsavedStay }).click();
  await page.getByLabel(`${da.code} *`, { exact: true }).fill("");
  await page.getByTestId("appbar-locale").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const departments = await page.request.get(`${ORG}/departments?q=DISCARDED`);
  expect(((await departments.json()).data.items as unknown[]).length).toBe(0);
});

test("reports: a lost request answer makes one job; queued, overdue and refresh states; unmount cancels quietly", async ({ page }) => {
  test.setTimeout(180_000);
  const { roundId } = await publishedRound(page);
  await setLocale(page, "en");
  const m = messages("en");
  const r = resultsMessages("en");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const posts: { key: string; body: string }[] = [];
  let drop = true;
  await page.route(/\/reports$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    posts.push({ key: request.headers()["idempotency-key"], body: request.postData() ?? "" });
    if (drop) {
      drop = false;
      expect((await route.fetch()).status()).toBe(202);
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  const jobs = async () =>
    ((await (await page.request.get(`${ORG}/reports?roundId=${roundId}`)).json()).data.items as unknown[]).length;
  const before = await jobs();

  await page.goto(`${STAFF}/organizations/${ids.orgA}/results/${roundId}`);
  await page.getByRole("button", { name: r.reports, exact: true }).click();
  await page.getByTestId("request-report").click();
  const problem = page.getByTestId("report-request-problem");
  await expect(problem).toContainText(m.outcomeUnknownTitle);
  expect(await jobs()).toBe(before + 1);
  await problem.getByRole("button", { name: m.retrySame }).click();
  await expect(page.getByText(r.reportAccepted)).toBeVisible();
  expect(posts[1].key).toBe(posts[0].key);
  expect(posts[1].body).toBe(posts[0].body);
  expect(await jobs()).toBe(before + 1);
  // Accepted is not drawn.
  await expect(page.getByText(r.jobQueuedNote).first()).toBeVisible();
  await expect(page.getByRole("link", { name: r.download })).toHaveCount(0);

  // A job waiting far beyond the renderer's cadence says so.
  await page.route(new RegExp(`/reports\\?roundId=${roundId}`), async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const old = new Date(Date.now() - 42 * 60_000).toISOString();
    for (const job of body.data.items) if (job.state === "QUEUED") job.createdAt = old;
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("button", { name: r.refreshStatus }).click();
  await expect(page.locator("[data-overdue]").first()).toContainText(
    r.jobOverdue.replace("{minutes}", "42").slice(0, 30),
  );
  await axe(page, "report overdue en");
  await page.screenshot({ path: "work/pass2-report-overdue-en.png", fullPage: true });

  // Leaving the tab while its list is still loading cancels the request
  // without an error on screen or an unhandled failure.
  await page.unroute(new RegExp(`/reports\\?roundId=${roundId}`));
  await page.route(new RegExp(`/reports\\?roundId=${roundId}`), hold);
  await page.getByRole("button", { name: r.overview, exact: true }).click();
  await page.getByRole("button", { name: r.reports, exact: true }).click();
  await page.getByRole("button", { name: r.overview, exact: true }).click();
  await expect(page.getByTestId("report-load-problem")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

test("attachments: accepted is quarantined, waiting and overdue states, refresh", async ({ page }) => {
  const v = visitMessages("ar");
  await login(page, "ar");
  const created = await page.request.post(`${VISITS}/visits`, {
    headers: { Origin: STAFF, "Idempotency-Key": randomUUID() },
    data: {
      relatedRoundId: null,
      assignedConsultantId: ids.admin,
      scheduledStart: "2026-10-11T06:00:00.000Z",
      scheduledEnd: null,
      timezone: "Asia/Riyadh",
      purpose: "زيارة للمرفقات",
      notes: null,
      findings: null,
      recommendations: null,
      followUpDate: null,
      amendmentReason: null,
    },
  });
  expect(created.status()).toBe(201);
  const visitId = (await created.json()).data.id as string;
  await page.goto(`${STAFF}/organizations/${ids.orgB}/visits/${visitId}`);
  await page.getByLabel(v.addAttachment).setInputFiles({
    name: "note.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1"),
  });
  await expect(page.getByText(v.uploadAccepted)).toBeVisible();
  const cell = page.locator("[data-scan-state=QUARANTINED]");
  await expect(cell).toContainText(v.scanWaitingNote);
  await expect(page.getByRole("link", { name: v.download })).toHaveCount(0);

  await page.route(new RegExp(`/visits/${visitId}$`), async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    for (const a of body.data.attachments) a.createdAt = new Date(Date.now() - 25 * 60_000).toISOString();
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("button", { name: v.refreshStatus }).click();
  await expect(cell).toContainText(v.scanOverdue.replace("{minutes}", "25").slice(0, 20));
  await axe(page, "attachment overdue ar");
});

// A change whose answer carried a one-time secret. Retrying the same attempt
// is safe (no second invitation), and the screen says the original link cannot
// be shown again rather than inventing a new one that would match nothing.
test("staff invitation: a lost answer is retried once, no second invitation, no unusable link", async ({ page }) => {
  const a = adminMessages("en");
  const m = messages("en");
  // Staff invitations exist only while the development password switch is on;
  // the development bootstrap turns it on (a no-op if an earlier spec did).
  const migration = JSON.parse(await readFile("work/e2e-fixture.json", "utf8")).migration as string;
  const boot = await bootstrapDevAdmin(migration, { email: `switch-${randomUUID().slice(0, 8)}@example.test`, password: `Rel-${randomUUID()}-9a`, displayName: "Reliability switch" }, {});
  expect(["CREATED", "ALREADY_PRESENT"]).toContain(boot.result);
  await login(page, "en");
  const email = `reliable-${randomUUID().slice(0, 8)}@example.test`;
  // Warm the invitation path first. In one run its first request under
  // `next dev` reset the connection (ECONNRESET inside route.fetch), which is
  // indistinguishable from the fault this test injects on purpose.
  const warm = await page.request.post(`${STAFF}/api/v1/staff/invitations`, {
    headers: { Origin: STAFF, "Idempotency-Key": randomUUID() },
    data: { email: `warm-${randomUUID().slice(0, 8)}@example.test`, locale: "en", expiresInHours: 24, role: "STAFF", capabilities: [], organizationIds: [] },
  });
  expect(warm.status(), await warm.text()).toBe(201);
  const posts: string[] = [];
  let drop = true;
  await page.route(/\/api\/v1\/staff\/invitations$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts.push(route.request().headers()["idempotency-key"]);
    if (drop) {
      drop = false;
      expect((await route.fetch()).status()).toBe(201);
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  await page.goto(`${STAFF}/staff`);
  await page.locator("#inv-email").fill(email);
  await page.getByRole("button", { name: a.issue, exact: true }).click();
  const problem = page.getByTestId("invitation-problem");
  await expect(problem).toContainText(m.outcomeUnknownTitle);
  await problem.getByRole("button", { name: m.retrySame }).click();
  await expect(page.getByRole("heading", { name: a.replayedTitle })).toBeVisible();
  await expect(page.getByText(a.replayedBody)).toBeVisible();
  await expect(page.locator("#invite-link")).toHaveCount(0);
  expect(posts).toHaveLength(2);
  expect(posts[1]).toBe(posts[0]);
  const listed = await page.request.get(`${STAFF}/api/v1/staff/invitations?q=${encodeURIComponent(email)}`);
  expect(((await listed.json()).data.items as unknown[]).length).toBe(1);
});

test("import commit: a lost answer is retried with the same key and the rows are committed once", async ({ page }) => {
  const d = directoryMessages("en");
  const m = messages("en");
  await login(page, "en");
  const stamp = randomUUID().slice(0, 6).toUpperCase();
  let drop = true;
  const keys: string[] = [];
  await page.route(/\/imports\/[0-9a-f-]+\/commit$/, async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    if (drop) {
      drop = false;
      expect((await route.fetch()).status()).toBe(200);
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  await page.goto(`${STAFF}/organizations/${ids.orgA}/participants/import`);
  await page.locator("input[type=file]").setInputFiles({
    name: "reliable.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`privateReference,displayName\nIMP_${stamp}_1,One\nIMP_${stamp}_2,Two`),
  });
  await page.getByRole("button", { name: d.upload }).click();
  await page.getByRole("button", { name: d.validate }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: d.commit }).click();
  const problem = page.getByTestId("import-problem");
  await expect(problem).toContainText(m.outcomeUnknownTitle);
  await problem.getByRole("button", { name: m.retrySame }).click();
  await expect(page.getByText(`${d.committed}: 2`)).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  const listed = await page.request.get(`${ORG}/participants?q=IMP_${stamp}`);
  expect(((await listed.json()).data.items as unknown[]).length).toBe(2);
});

test("campaign link: a lost issue answer says the link cannot be shown again and never shows a new one", async ({ page }) => {
  const c = campaignMessages("en");
  const m = messages("en");
  await login(page, "en");
  const headers = () => ({ Origin: STAFF, "Idempotency-Key": randomUUID() });
  const stamp = randomUUID().slice(0, 6).toUpperCase();
  const department = await page.request.post(`${ORG}/departments`, { headers: headers(), data: { code: `REL${stamp}`, nameAr: "قسم" } });
  expect(department.status()).toBe(201);
  const departmentId = (await department.json()).data.id;
  for (const n of [1, 2]) {
    const person = await page.request.post(`${ORG}/participants`, {
      headers: headers(),
      data: { privateReference: `REL-${stamp}-${n}`, displayName: `P${n}`, departmentId },
    });
    expect(person.status()).toBe(201);
  }
  const family = (await (await page.request.get(`${STAFF}/api/v1/questionnaires/44000000-0000-4000-8000-000000000001`)).json()).data.family_key;
  const series = await page.request.post(`${ORG}/assessment-series`, { headers: headers(), data: { nameAr: `سلسلة ${stamp}`, purpose: "x", questionnaireFamilyId: family } });
  const round = await page.request.post(`${ORG}/assessments`, {
    headers: headers(),
    data: { seriesId: (await series.json()).data.id, label: `R${stamp}`, periodStart: "2026-06-01", questionnaireVersionId: "44000000-0000-4000-9000-000000000001", populationDefinition: { schemaVersion: 1 } },
  });
  const campaign = await page.request.post(`${ORG}/campaigns`, {
    headers: headers(),
    data: {
      roundId: (await round.json()).data.id,
      questionnaireVersionId: "44000000-0000-4000-9000-000000000001",
      target: { mode: "DEPARTMENT", departmentId },
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      timezone: "Asia/Riyadh",
    },
  });
  expect(campaign.status(), await campaign.text()).toBe(201);
  const created = (await campaign.json()).data;
  expect((await page.request.post(`${ORG}/campaigns/${created.id}/launch`, { headers: { ...headers(), "If-Match": `"${created.revision}"` }, data: {} })).status()).toBe(200);

  let drop = true;
  const keys: string[] = [];
  await page.route(/\/invitations\/[0-9a-f-]+\/issue$/, async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    if (drop) {
      drop = false;
      expect((await route.fetch()).status()).toBe(200);
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  await page.goto(`${STAFF}/organizations/${ids.orgA}/campaigns/${created.id}`);
  await page.getByRole("button", { name: c.issue, exact: true }).first().click();
  const problem = page.getByTestId("campaign-problem");
  await expect(problem).toContainText(m.outcomeUnknownTitle);
  await problem.getByRole("button", { name: m.retrySame }).click();
  await expect(page.getByText(c.linkLostAnswer)).toBeVisible();
  // No credential is shown, and the invitation is now issued (rotate offered).
  await expect(page.getByRole("textbox", { name: c.copy })).toHaveCount(0);
  await expect(page.getByRole("button", { name: c.rotate, exact: true })).toHaveCount(1);
  expect(keys).toEqual([keys[0], keys[0]]);
});