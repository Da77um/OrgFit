import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import {
  SURVEY,
  closeCampaign,
  launchCampaign,
  operator,
  overflow,
  publishJourneyInstrument,
  signIn,
  type JourneyCampaign,
  type JourneyInstrument,
} from "./journey-fixture";

// Phase 13: the respondent journey refined for phones, both languages, the
// keyboard and an unreliable network — driven through the real gateway with a
// real published instrument that carries every question type. Nothing is
// mocked except where a test deliberately breaks the network between the
// browser and the real server.

test.describe.configure({ mode: "serial" });

let instrument: JourneyInstrument;
let campaign: JourneyCampaign;
let closing: JourneyCampaign;
let staff: Page;
let staffContext: BrowserContext;

test.beforeAll(async ({ browser }) => {
  staffContext = await browser.newContext();
  staff = await staffContext.newPage();
  await signIn(staff);
  const stamp = Date.now().toString(36).toUpperCase();
  instrument = await publishJourneyInstrument(staff, stamp);
  campaign = await launchCampaign(staff, instrument, `${stamp}A`, 6);
  closing = await launchCampaign(staff, instrument, `${stamp}B`, 1);
});
test.afterAll(async () => {
  await staffContext.close();
});

// A page that accepts the browser's "leave with unsaved changes?" prompt, so a
// reload in a test behaves like a respondent who chose to leave.
async function surveyPage(context: BrowserContext) {
  const page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  return page;
}
const saveStatus = (page: Page) => page.getByTestId("save-status");
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const focusedTag = (page: Page) =>
  page.evaluate(() => document.activeElement?.tagName ?? "");

async function answerSectionOne(page: Page, years: string) {
  await page.getByRole("radio", { name: "4", exact: true }).check();
  await page.getByLabel(/كم سنة عملت في المنظمة؟|How many years/).fill(years);
}

test("320px Arabic journey: keyboard, Arabic-Indic numerals, language switch, back button, resume and one submission", async ({
  browser,
}) => {
  // A phone: touch, a coarse pointer and the meta viewport honoured.
  const context = await browser.newContext({
    viewport: { width: 320, height: 640 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await surveyPage(context);
  const token = campaign.tokens[0];
  await page.goto(`${SURVEY}/s#${token}`);
  await expect(heading(page)).toBeVisible();
  expect(page.url()).toBe(`${SURVEY}/s`);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: "ابدأ الاستبانة" }).click();
  // A new screen starts at its heading, for sight and for a screen reader.
  await expect(heading(page)).toHaveText("البيئة");
  expect(await focusedTag(page)).toBe("H1");

  // Progress counts the seven required answer slots and not the content block.
  await expect(page.getByTestId("answered-count")).toHaveText("0 / 7");
  await expect(page.getByText("تمهيد: لا يُحتسب هذا المحتوى", { exact: false })).toBeVisible();

  // A long unbroken Arabic prompt wraps inside a 320px page.
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // ---- keyboard only: reach the rating scale and choose with the keyboard ---
  let reached = false;
  for (let i = 0; i < 12 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(
      () => (document.activeElement as HTMLInputElement | null)?.type === "radio",
    );
  }
  expect(reached).toBe(true);
  await page.keyboard.press("Space");
  const ring = await page.evaluate(() => {
    const option = (document.activeElement as HTMLElement).closest(".scale-option")!;
    const style = getComputedStyle(option);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });
  expect(ring).toBe("solid 3px");
  await expect(page.getByTestId("answered-count")).toHaveText("1 / 7");

  // ---- numerals: Arabic-Indic digits are an ordinary answer ----------------
  const years = page.getByLabel("كم سنة عملت في المنظمة؟");
  await expect(years).toHaveAttribute("inputmode", "numeric");
  await years.fill("٦١");
  await years.blur();
  const tooMany = page.getByText("القيمة أكبر من الحد الأعلى 60.");
  await expect(tooMany).toBeVisible();
  await expect(years).toHaveAttribute("aria-invalid", "true");
  const described = await years.getAttribute("aria-describedby");
  expect(described).toContain(await tooMany.getAttribute("id"));
  await years.fill("١٢");
  await expect(tooMany).toHaveCount(0);
  await expect(years).not.toHaveAttribute("aria-invalid", "true");

  // ---- switching language never touches an answer -------------------------
  await page.getByTestId("locale-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(heading(page)).toHaveText("Environment");
  await expect(page.getByLabel("How many years have you worked here?")).toHaveValue("١٢");
  await expect(page.getByRole("radio", { name: "1", exact: true })).toBeChecked();
  await page.getByTestId("locale-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(years).toHaveValue("١٢");

  // Every survey control on this screen is at least the preferred 44px target.
  const small = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        ".scale-option, .choice, .survey-actions button, .survey button:not(.button-quiet), .appbar button",
      ),
    )
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height < 43.5).length,
  );
  expect(small).toBe(0);

  // ---- save, reload, resume on the same device ----------------------------
  await page.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(saveStatus(page)).toHaveText("تم الحفظ");
  await page.reload();
  // The language chosen earlier survives the reload.
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await page.getByRole("button", { name: "استئناف إجاباتي المحفوظة" }).click();
  await expect(saveStatus(page)).toHaveText("تم الحفظ");
  await expect(years).toHaveValue("١٢");

  // ---- the browser's Back button walks sections, not away -----------------
  await page.getByRole("button", { name: "التالي" }).click();
  await expect(heading(page)).toHaveText("الممارسات");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.goBack();
  await expect(heading(page)).toHaveText("البيئة");
  await expect(years).toHaveValue("١٢");
  expect(page.url()).toBe(`${SURVEY}/s`);
  await page.goForward();
  await expect(heading(page)).toHaveText("الممارسات");

  // ---- the matrix stacks into one labelled group per row ------------------
  for (const row of ["وضوح الأهداف", "عدالة التقييم"]) {
    const group = page.getByRole("group", { name: row });
    await expect(group).toBeVisible();
    await expect(group.getByRole("radio")).toHaveCount(3);
    await group.getByRole("radio", { name: "جيد" }).check();
  }
  await expect(page.getByRole("group", { name: "قيّم ما يلي:" })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  // Checkbox bounds are stated before they are broken.
  await expect(page.getByText("اختر من 1 إلى 2.")).toBeVisible();
  await page.getByRole("checkbox", { name: "البريد" }).check();

  await page.getByRole("button", { name: "التالي" }).click();
  await expect(heading(page)).toHaveText("الختام");
  await page.getByLabel("نمط العمل").selectOption({ label: "عن بعد" });
  await page.getByRole("radio", { name: "نعم" }).check();
  await expect(page.getByTestId("answered-count")).toHaveText("7 / 7");

  await page.getByRole("button", { name: "مراجعة الإجابات" }).click();
  await expect(heading(page)).toHaveText("مراجعة الإجابات");
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // ---- the confirmation dialog behaves like a dialog -----------------------
  const submitButton = page.getByRole("button", { name: "إرسال نهائي" });
  await submitButton.click();
  const dialog = page.getByRole("dialog", { name: "تأكيد الإرسال النهائي" });
  await expect(dialog).toBeVisible();
  // Focus starts on the safe choice, and Tab cannot leave the dialog.
  await expect(dialog.getByRole("button", { name: "إلغاء" })).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]")),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(submitButton).toBeFocused();

  // The submitted payload carries canonical Latin digits.
  await submitButton.click();
  const finalize = page.waitForRequest((r) => r.url().endsWith("/public/v1/finalize"));
  await page.getByRole("button", { name: "تأكيد وإرسال" }).click();
  const payload = JSON.parse((await finalize).postData() ?? "{}");
  expect(payload.answers[instrument.q.number.id]).toBe("12");
  await expect(heading(page)).toHaveText("تم استلام إجاباتك");

  // Back after acceptance does not reopen the questionnaire.
  await page.goBack().catch(() => undefined);
  await expect(page.getByRole("button", { name: "إرسال نهائي" })).toHaveCount(0);

  // Reopening the link: the locked state, never the answers. (A fresh document:
  // a fragment-only navigation would not reload the page.)
  await page.goto("about:blank");
  await page.goto(`${SURVEY}/s#${token}`);
  await expect(heading(page)).toHaveText("تم استلام إجاباتك");
  await expect(page.getByLabel("نمط العمل")).toHaveCount(0);
  await context.close();
});

test("multi-tab conflict, an existing draft from another browser and English private-code resume", async ({
  browser,
}) => {
  const token = campaign.tokens[1];
  const context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const first = await surveyPage(context);
  await first.goto(`${SURVEY}/s#${token}`);
  await first.getByRole("button", { name: "ابدأ الاستبانة" }).click();
  await answerSectionOne(first, "3");
  await first.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(saveStatus(first)).toHaveText("تم الحفظ");
  const code = (await first.getByTestId("resume-code").textContent())!.trim();
  // A mixed-direction secret is isolated left to right on an Arabic page.
  await expect(first.getByTestId("resume-code")).toHaveAttribute("dir", "ltr");

  // A second tab of the same browser resumes and saves a newer revision.
  const second = await surveyPage(context);
  await second.goto(`${SURVEY}/s#${token}`);
  await second.getByRole("button", { name: "استئناف إجاباتي المحفوظة" }).click();
  await second.getByLabel("كم سنة عملت في المنظمة؟").fill("٧");
  await second.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(saveStatus(second)).toHaveText("تم الحفظ");

  // The first tab's stale save is refused and says why; nothing is overwritten.
  await first.getByLabel("كم سنة عملت في المنظمة؟").fill("9");
  await first.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(saveStatus(first)).toHaveText("تعارض في الحفظ");
  await expect(first.getByText("حُفظت نسخة أحدث من هذه المسودة", { exact: false })).toBeVisible();
  await first.getByRole("button", { name: "تحميل النسخة الأحدث" }).click();
  await expect(saveStatus(first)).toHaveText("تم الحفظ");
  await expect(first.getByLabel("كم سنة عملت في المنظمة؟")).toHaveValue("٧");

  // A different browser that starts fresh finds a draft it cannot see.
  const elsewhere = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const third = await surveyPage(elsewhere);
  await third.goto(`${SURVEY}/s#${token}`);
  await third.getByRole("button", { name: "ابدأ الاستبانة" }).click();
  await answerSectionOne(third, "1");
  await third.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(third.getByText("توجد مسودة محفوظة لهذا الرابط", { exact: false })).toBeVisible();
  await expect(saveStatus(third)).not.toHaveText("تم الحفظ");
  // This browser holds no key for it, so the private code is offered.
  await third.getByRole("button", { name: "تحميل النسخة الأحدث" }).click();
  await third.getByTestId("resume-code-input").fill(code);
  await third.getByRole("button", { name: "استئناف", exact: true }).click();
  await expect(saveStatus(third)).toHaveText("تم الحفظ");
  await expect(third.getByLabel("كم سنة عملت في المنظمة؟")).toHaveValue("٧");
  await elsewhere.close();

  // Second device, in English, with only the link and the private code.
  const device = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const phone = await surveyPage(device);
  await phone.goto(`${SURVEY}/s#${token}`);
  await phone.getByTestId("locale-toggle").click();
  await phone.getByRole("button", { name: "Resume on another device" }).click();
  await phone.getByTestId("resume-code-input").fill(` ${code} `);
  await phone.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(saveStatus(phone)).toHaveText("Saved");
  await expect(heading(phone)).toHaveText("Environment");
  await expect(phone.getByLabel("How many years have you worked here?")).toHaveValue("٧");
  expect(await overflow(phone)).toBeLessThanOrEqual(0);
  await device.close();
  await context.close();
});

test("offline, slow and lost responses are reported truthfully, and a retried submission is accepted once", async ({
  browser,
}) => {
  const token = campaign.tokens[2];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await surveyPage(context);
  await page.goto(`${SURVEY}/s#${token}`);
  await page.getByRole("button", { name: "ابدأ الاستبانة" }).click();
  await answerSectionOne(page, "5");

  // ---- disconnected --------------------------------------------------------
  await context.setOffline(true);
  await expect(page.getByText("أنت غير متصل بالإنترنت", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(saveStatus(page)).toHaveText("لم يُحفظ لأن الاتصال مقطوع.");
  await context.setOffline(false);
  await expect(page.getByText("أنت غير متصل بالإنترنت", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(saveStatus(page)).toHaveText("تم الحفظ");

  // ---- slow: no answer within the request limit is "not saved" -------------
  await page.route("**/public/v1/draft", async (route) => {
    await new Promise((r) => setTimeout(r, 23_000));
    await route.continue().catch(() => undefined);
  });
  await page.getByLabel("كم سنة عملت في المنظمة؟").fill("6");
  await page.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(saveStatus(page)).toHaveText("جارٍ الحفظ…");
  await expect(saveStatus(page)).toHaveText("لم يُحفظ. حاول مرة أخرى.", { timeout: 25_000 });
  await page.unroute("**/public/v1/draft");

  // Complete the rest.
  await page.getByRole("button", { name: "التالي" }).click();
  for (const row of ["وضوح الأهداف", "عدالة التقييم"])
    await page.getByRole("group", { name: row }).getByRole("radio", { name: "مقبول" }).check();
  await page.getByRole("checkbox", { name: "الرسائل" }).check();
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByLabel("نمط العمل").selectOption({ label: "حضوري" });
  await page.getByRole("radio", { name: "لا" }).check();
  await page.getByRole("button", { name: "مراجعة الإجابات" }).click();

  // ---- the success response is lost after the server committed -------------
  await page.route("**/public/v1/finalize", async (route) => {
    await route.fetch();
    await route.abort("connectionreset");
  });
  await page.getByRole("button", { name: "إرسال نهائي" }).click();
  await page.getByRole("button", { name: "تأكيد وإرسال" }).click();
  await expect(page.getByText("تعذر التأكد من وصول إجاباتك", { exact: false })).toBeVisible();
  await expect(heading(page)).toHaveText("مراجعة الإجابات");
  await page.unroute("**/public/v1/finalize");

  // The retry finds the first acceptance standing and does not add a second.
  await page.getByRole("button", { name: "إرسال نهائي" }).click();
  await page.getByRole("button", { name: "تأكيد وإرسال" }).click();
  await expect(heading(page)).toHaveText("تم استلام إجاباتك");
  const db = await operator();
  const counts = await db.query(
    `select i.status,
            (select count(*)::int from intake.submission_inbox e where e.invitation_id=i.id) envelopes,
            (select count(*)::int from intake.draft_blob d where d.invitation_id=i.id) drafts
       from core.invitation i where i.id=$1`,
    [campaign.invitationIds[2]],
  );
  await db.end();
  expect(counts.rows[0]).toEqual({ status: "COMPLETED", envelopes: 1, drafts: 0 });
  await context.close();
});

test("an expired session and a campaign closing mid-answer are stated, and nothing is claimed saved", async ({
  browser,
}) => {
  // ---- expired session ------------------------------------------------------
  const token = campaign.tokens[3];
  const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const page = await surveyPage(context);
  await page.goto(`${SURVEY}/s#${token}`);
  await page.getByRole("button", { name: "ابدأ الاستبانة" }).click();
  await answerSectionOne(page, "4");
  await page.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(saveStatus(page)).toHaveText("تم الحفظ");
  // The session cookie is gone, as after the idle or absolute limit.
  const survivors = (await context.cookies()).filter((c) => c.name !== "orgfit-survey");
  await context.clearCookies();
  await context.addCookies(survivors);
  await page.getByLabel("كم سنة عملت في المنظمة؟").fill("8");
  await page.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "انتهت الجلسة" })).toBeVisible();
  await expect(saveStatus(page)).not.toHaveText("تم الحفظ");
  await expect(page.getByRole("button", { name: "حفظ ومتابعة لاحقًا" })).toBeDisabled();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  // Following the instruction works: the original link, then the saved answers.
  await page.goto("about:blank");
  await page.goto(`${SURVEY}/s#${token}`);
  await page.getByRole("button", { name: "استئناف إجاباتي المحفوظة" }).click();
  await expect(saveStatus(page)).toHaveText("تم الحفظ");
  await expect(page.getByLabel("كم سنة عملت في المنظمة؟")).toHaveValue("4");
  await context.close();

  // ---- the campaign closes while the respondent is answering --------------
  const closingContext = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const respondent = await surveyPage(closingContext);
  await respondent.goto(`${SURVEY}/s#${closing.tokens[0]}`);
  await respondent.getByRole("button", { name: "ابدأ الاستبانة" }).click();
  await answerSectionOne(respondent, "2");
  await closeCampaign(staff, closing.campaignId);
  await respondent.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(
    respondent.getByText("أُغلقت هذه الاستبانة أثناء تعبئتك لها", { exact: false }),
  ).toBeVisible();
  await expect(respondent.getByLabel("كم سنة عملت في المنظمة؟")).toHaveCount(0);
  await closingContext.close();
});

test("the virtual keyboard strip and 200% zoom keep the focused field visible and the page unscrolled sideways", async ({
  browser,
}) => {
  const token = campaign.tokens[4];
  // 320 × 280 is a phone in portrait with the keyboard up.
  const context = await browser.newContext({ viewport: { width: 320, height: 280 } });
  const page = await surveyPage(context);
  await page.goto(`${SURVEY}/s#${token}`);
  await page.getByRole("button", { name: "ابدأ الاستبانة" }).click();
  const field = page.getByLabel("كم سنة عملت في المنظمة؟");
  await field.focus();
  const bar = page.locator(".survey .survey-actions").last();
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe("static");
  const box = (await field.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(280);
  // Typing and then tapping Save must not move the button out from under the
  // finger: the bar's position does not depend on focus.
  await field.fill("٣");
  await page.getByRole("button", { name: "حفظ ومتابعة لاحقًا" }).click();
  await expect(saveStatus(page)).toHaveText("تم الحفظ");
  // With the keyboard down the bar is sticky again, and still clear of the field.
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
  await field.focus();
  const after = (await field.boundingBox())!;
  const barBox = (await bar.boundingBox())!;
  expect(after.y + after.height).toBeLessThanOrEqual(barBox.y);

  // 200% zoom of a 1280px window is a 640px CSS viewport; 400% is 320px.
  for (const width of [640, 320]) {
    await page.setViewportSize({ width, height: 720 });
    expect(await overflow(page), `width ${width}`).toBeLessThanOrEqual(0);
  }
  await context.close();
});
