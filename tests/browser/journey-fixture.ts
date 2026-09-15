// The Phase 13 journey fixture: one published instrument that carries every
// question type the respondent can meet, in both languages, with a content
// block, a very long unbroken Arabic prompt and bounded numeric and date rules;
// and campaigns launched on it through the ordinary staff API, each with its
// own manually issued links. It registers no test of its own.
import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { ids } from "../../scripts/seed";
import {
  newIdentity,
  newQuestion,
  tr,
  type Instrument,
  type Question,
} from "../../src/instrument-input";

// The harness ports, overridable like published-round.ts (defaults unchanged).
export const STAFF = `http://127.0.0.1:${process.env.E2E_STAFF_PORT ?? 3000}`;
export const SURVEY = `http://localhost:${process.env.E2E_RESPONDENT_PORT ?? 3001}`;

export async function signIn(page: Page) {
  await page.goto(`${STAFF}/login`);
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${STAFF}/workspace`);
}

const labelled = (q: Question, ar: string, en: string) => {
  q.prompt = tr(ar, en);
  return q;
};
const options = (q: Question, pairs: [string, string][]) => {
  q.options = pairs.map(([ar, en], n) => ({
    ...newIdentity(),
    label: tr(ar, en),
    score: String(n),
  }));
  return q;
};

// A single Arabic "word" longer than a 320px line, as a pasted identifier or a
// run-on phrase would be. It must wrap, not widen the page.
export const LONG_ARABIC =
  "هذاسؤالطويلجدابدونمسافاتلاختبارالتفافالنصالعربيعلىالشاشاتالضيقةجدا";

export type JourneyInstrument = {
  versionId: string;
  questionnaireId: string;
  document: Instrument;
  q: Record<
    | "rating"
    | "number"
    | "shortText"
    | "matrix"
    | "checkboxes"
    | "date"
    | "longText"
    | "dropdown"
    | "yesNo",
    Question
  >;
  requiredSlots: number;
};

export async function publishJourneyInstrument(
  page: Page,
  stamp: string,
): Promise<JourneyInstrument> {
  const headers = () => ({ Origin: STAFF, "Idempotency-Key": randomUUID() });
  const root = `${STAFF}/api/v1/organizations/${ids.orgA}/questionnaires`;
  const created = await page.request.post(root, {
    headers: headers(),
    data: { title: tr(`استبانة الرحلة ${stamp}`, `Journey instrument ${stamp}`) },
  });
  expect(created.status()).toBe(201);
  const draft = (await created.json()).data as {
    id: string;
    questionnaire_id: string;
    revision: string;
    document: Instrument;
  };
  const d = draft.document;
  d.locales = ["ar", "en"];
  d.privacyText = tr("إشعار خصوصية تجريبي للرحلة.", "Synthetic journey privacy notice.");

  const intro = labelled(
    newQuestion("CONTENT"),
    "تمهيد: لا يُحتسب هذا المحتوى ضمن الأسئلة.",
    "Introduction: this content is not a question.",
  );
  const rating = labelled(newQuestion("RATING_5"), "أجد الدعم اللازم في عملي.", "I get the support I need.");
  const number = labelled(newQuestion("NUMBER"), "كم سنة عملت في المنظمة؟", "How many years have you worked here?");
  number.validation = { min: "0", max: "60", precision: 0 };
  const shortText = labelled(
    newQuestion("SHORT_TEXT"),
    `${LONG_ARABIC} ما الكلمة التي تصف فريقك؟`,
    "Which word describes your team?",
  );
  shortText.required = false;
  const matrix = labelled(newQuestion("MATRIX"), "قيّم ما يلي:", "Rate the following:");
  matrix.rows = [
    { ...newIdentity(), label: tr("وضوح الأهداف", "Clear goals"), weight: "1" },
    { ...newIdentity(), label: tr("عدالة التقييم", "Fair appraisal"), weight: "1" },
  ];
  matrix.columns = [
    ["ضعيف", "Weak"],
    ["مقبول", "Fair"],
    ["جيد", "Good"],
  ].map(([ar, en], n) => ({ ...newIdentity(), label: tr(ar, en), score: String(n) }));
  const checkboxes = options(
    labelled(newQuestion("CHECKBOXES"), "ما قنوات التواصل التي تستخدمها؟", "Which channels do you use?"),
    [
      ["البريد", "Email"],
      ["الاجتماعات", "Meetings"],
      ["الرسائل", "Messages"],
    ],
  );
  checkboxes.validation = { minSelections: 1, maxSelections: 2 };
  const date = labelled(newQuestion("DATE"), "متى بدأت مشروعك الأخير؟", "When did your last project start?");
  date.required = false;
  date.validation = { minDate: "2020-01-01", maxDate: "2026-12-31" };
  const longText = labelled(newQuestion("LONG_TEXT"), "ما الذي يمكن تحسينه؟", "What could improve?");
  longText.required = false;
  const dropdown = options(
    labelled(newQuestion("DROPDOWN"), "نمط العمل", "Work pattern"),
    [
      ["حضوري", "On site"],
      ["عن بعد", "Remote"],
    ],
  );
  const yesNo = labelled(newQuestion("YES_NO"), "هل توصي بالعمل هنا؟", "Would you recommend working here?");

  d.sections = [
    { ...newIdentity(), title: tr("البيئة", "Environment"), content: tr(), questions: [intro, rating, number, shortText] },
    { ...newIdentity(), title: tr("الممارسات", "Practices"), content: tr(), questions: [matrix, checkboxes, date] },
    { ...newIdentity(), title: tr("الختام", "Closing"), content: tr(), questions: [longText, dropdown, yesNo] },
  ];
  const url = `${root}/${draft.questionnaire_id}/versions/${draft.id}`;
  const saved = await page.request.patch(url, {
    headers: { ...headers(), "If-Match": `"${draft.revision}"` },
    data: d,
  });
  expect(saved.status(), await saved.text()).toBe(200);
  const revision = (await saved.json()).data.revision as string;
  const published = await page.request.post(`${url}/publish`, {
    headers: { ...headers(), "If-Match": `"${revision}"` },
    data: {},
  });
  expect(published.status(), await published.text()).toBe(200);
  return {
    versionId: draft.id,
    questionnaireId: draft.questionnaire_id,
    document: d,
    q: { rating, number, shortText, matrix, checkboxes, date, longText, dropdown, yesNo },
    // rating + number + two matrix rows + checkboxes + dropdown + yes/no.
    requiredSlots: 7,
  };
}

export type JourneyCampaign = {
  campaignId: string;
  tokens: string[];
  invitationIds: string[];
};

export async function launchCampaign(
  page: Page,
  instrument: JourneyInstrument,
  stamp: string,
  people: number,
): Promise<JourneyCampaign> {
  const headers = () => ({ Origin: STAFF, "Idempotency-Key": randomUUID() });
  const base = `${STAFF}/api/v1/organizations/${ids.orgA}`;
  const department = await page.request.post(`${base}/departments`, {
    headers: headers(),
    data: { code: `J${stamp}`.slice(0, 20), nameAr: `قسم الرحلة ${stamp}` },
  });
  expect(department.status()).toBe(201);
  const departmentId = (await department.json()).data.id as string;
  const participantIds: string[] = [];
  for (let i = 0; i < people; i++) {
    const person = await page.request.post(`${base}/participants`, {
      headers: headers(),
      data: {
        privateReference: `J-${stamp}-${i}`,
        displayName: `مشارك الرحلة ${i + 1}`,
        departmentId,
      },
    });
    expect(person.status()).toBe(201);
    participantIds.push((await person.json()).data.id as string);
  }
  const family = (
    await (
      await page.request.get(
        `${base}/questionnaires/${instrument.questionnaireId}`,
        { headers: { Origin: STAFF } },
      )
    ).json()
  ).data.family_key as string;
  const series = await page.request.post(`${base}/assessment-series`, {
    headers: headers(),
    data: { nameAr: `سلسلة الرحلة ${stamp}`, purpose: "رحلة المشارك", questionnaireFamilyId: family },
  });
  expect(series.status()).toBe(201);
  const round = await page.request.post(`${base}/assessments`, {
    headers: headers(),
    data: {
      seriesId: (await series.json()).data.id,
      label: `جولة الرحلة ${stamp}`,
      periodStart: "2026-05-01",
      questionnaireVersionId: instrument.versionId,
      populationDefinition: { schemaVersion: 1 },
    },
  });
  expect(round.status()).toBe(201);
  const campaign = await page.request.post(`${base}/campaigns`, {
    headers: headers(),
    data: {
      roundId: (await round.json()).data.id,
      questionnaireVersionId: instrument.versionId,
      target: { mode: "SELECTED", participantIds },
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      timezone: "Asia/Riyadh",
    },
  });
  expect(campaign.status(), await campaign.text()).toBe(201);
  const created = (await campaign.json()).data as { id: string; revision: string };
  const launched = await page.request.post(`${base}/campaigns/${created.id}/launch`, {
    headers: { ...headers(), "If-Match": `"${created.revision}"` },
    data: {},
  });
  expect(launched.status()).toBe(200);
  const list = await (
    await page.request.get(`${base}/campaigns/${created.id}/participation`, {
      headers: { Origin: STAFF },
    })
  ).json();
  const tokens: string[] = [];
  const invitationIds: string[] = [];
  for (const item of list.data.items) {
    const issued = await page.request.post(
      `${base}/campaigns/${created.id}/invitations/${item.invitationId}/issue`,
      { headers: headers(), data: { expectedGeneration: item.generation } },
    );
    expect(issued.status()).toBe(200);
    tokens.push(((await issued.json()).data.url as string).split("#")[1]);
    invitationIds.push(item.invitationId);
  }
  return { campaignId: created.id, tokens, invitationIds };
}

export async function operator() {
  const fixture = JSON.parse(await readFile("work/e2e-fixture.json", "utf8"));
  const client = new pg.Client({ connectionString: fixture.migration });
  await client.connect();
  await client.query("SET ROLE orgfit_core_owner");
  return client;
}

export async function closeCampaign(page: Page, campaignId: string) {
  const db = await operator();
  const revision = (
    await db.query("select revision from core.campaign where id=$1", [campaignId])
  ).rows[0].revision as string;
  await db.end();
  const closed = await page.request.post(
    `${STAFF}/api/v1/organizations/${ids.orgA}/campaigns/${campaignId}/close`,
    {
      headers: { Origin: STAFF, "Idempotency-Key": randomUUID(), "If-Match": `"${revision}"` },
      data: { reason: "إغلاق أثناء التعبئة" },
    },
  );
  expect(closed.status(), await closed.text()).toBe(200);
}

/** Horizontal overflow of the document in CSS pixels. When there is any, the
 *  elements reaching past the viewport are logged so the failure names them. */
export async function overflow(page: Page) {
  const report = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const excess = document.documentElement.scrollWidth - width;
    const offenders = excess
      ? Array.from(document.querySelectorAll("body *"))
          .map((e) => {
            let depth = 0;
            for (let p = e.parentElement; p; p = p.parentElement) depth++;
            return { e, r: e.getBoundingClientRect(), depth };
          })
          // Wider than the viewport, deepest first: the element that forces
          // the width, not every ancestor that inherits it.
          .filter(({ r }) => {
            // Document coordinates, so a horizontally scrolled page (negative
            // scrollX under RTL) does not make every element look misplaced.
            const left = r.left + window.scrollX;
            return r.width > 0 && (left < -1 || left + r.width > width + 1);
          })
          .sort((x, y) => y.depth - x.depth)
          .slice(0, 6)
          .map(({ e, r }) => `${e.tagName}.${String(e.className)} [${Math.round(r.left)},${Math.round(r.right)}]`)
      : [];
    // Content spilling out of a box it does not widen (a long word, an
    // intrinsic control width) shows as scrollWidth beyond clientWidth.
    const spills = excess
      ? Array.from(document.querySelectorAll<HTMLElement>("body *"))
          .filter((e) => e.clientWidth && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible")
          .slice(-6)
          .map((e) => `${e.tagName}.${String(e.className)} ${e.clientWidth}<${e.scrollWidth}`)
      : [];
    return { excess, offenders: [...offenders, ...spills] };
  });
  if (report.excess > 0) console.log("overflow:", report.excess, report.offenders);
  return report.excess;
}
