// The shared browser fixture: one real campaign of one real organization,
// collected through the real gateway, processed by the real privacy processor
// and released by the real publication job. It registers no test of its own, so
// a spec can import it without inheriting another spec's assertions.
import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { ids } from "../../scripts/seed";
import { configureGateway } from "../../src/gateway-db";
import { setCustodianSecret } from "../../src/key-custody";
import { exchange, instrument, finalize } from "../../src/respondent";
import { processCampaign } from "../../src/processor";
import { releaseCampaign } from "../../src/publication";
import {
  newIdentity,
  newQuestion,
  tr,
  type Instrument,
} from "../../src/instrument-input";

// The Playwright harness owns 3000. scripts/showcase.ts brings the same product
// up on its own port pair for hand review and sets this variable.
export const STAFF = process.env.SHOWCASE_STAFF_ORIGIN ?? "http://127.0.0.1:3000";

// The published-results journey, driven end to end: a real campaign is
// collected through the real gateway, mixed by the real privacy processor,
// released by the real publication job, and then read in the browser by a staff
// member who has no other way to see a number.

function answers(document: Instrument, seed: number) {
  const out: Record<string, string | string[]> = {};
  for (const q of document.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    if (q.type === "RATING_5") out[q.id] = String((seed % 5) + 1);
    else if (q.type === "RATING_10") out[q.id] = String((seed % 10) + 1);
    else if (q.type === "NUMBER") out[q.id] = String(seed % 10);
    else if (q.type === "DATE") out[q.id] = "2026-06-15";
    else if (q.type === "SHORT_TEXT" || q.type === "LONG_TEXT")
      out[q.id] = `تعليق ${seed}`;
    else if (q.type === "CHECKBOXES")
      out[q.id] = [q.options[seed % q.options.length].id];
    else if (q.type === "MATRIX")
      for (const row of q.rows) out[row.id] = q.columns[seed % q.columns.length].id;
    else out[q.id] = q.options[seed % q.options.length].id;
  }
  return out;
}

// A minimal scored instrument carrying one deterministic rule, published
// through the ordinary staff API so the release path sees real version content.
async function publishRuleInstrument(page: Page, stamp: string) {
  const headers = () => ({ Origin: STAFF, "Idempotency-Key": randomUUID() });
  const root = `${STAFF}/api/v1/organizations/${ids.orgA}/questionnaires`;
  const created = await page.request.post(root, {
    headers: headers(),
    data: { title: tr(`استبانة النتائج ${stamp}`, `Results instrument ${stamp}`) },
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
  d.privacyText = tr("إشعار خصوصية تجريبي.", "Synthetic privacy notice.");
  const bands = () => [
    {
      ...newIdentity(),
      lower: "0",
      upper: "50",
      label: tr("منخفض", "Low"),
      severity: "HIGH" as const,
      semantic: "RISK" as const,
    },
    {
      ...newIdentity(),
      lower: "50",
      upper: "100",
      label: tr("مرتفع", "High"),
      severity: "NONE" as const,
      semantic: "HEALTH" as const,
    },
  ];
  const dimension = {
    ...newIdentity(),
    name: tr("بيئة العمل", "Work environment"),
    description: tr("وصف", "Description"),
    mode: "AVERAGE" as const,
    coverage: "0.5",
    direction: "HIGH_GOOD" as const,
    denominator: null,
    bands: bands(),
  };
  d.dimensions = [dimension];
  const rating = newQuestion("RATING_5");
  rating.prompt = tr("أجد الدعم اللازم.", "I get the support I need.");
  rating.dimensionId = dimension.id;
  rating.scoring = { enabled: true, reverse: false, weight: "1", mode: "VALUE" };
  const text = newQuestion("LONG_TEXT");
  text.prompt = tr("ما الذي يمكن تحسينه؟", "What could improve?");
  text.required = false;
  d.sections = [
    {
      ...newIdentity(),
      title: tr("القسم", "Section"),
      content: tr("", ""),
      questions: [rating, text],
    },
  ];
  d.overall = {
    enabled: true,
    direction: "HIGH_GOOD",
    inputs: [{ dimensionId: dimension.id, weight: "1", invert: false }],
    bands: bands(),
  };
  d.recommendations = [
    {
      ...newIdentity(),
      target: { kind: "OVERALL" },
      groupScope: "COMPANY",
      condition: {
        mode: "ALL",
        clauses: [
          {
            mode: "ALL",
            comparisons: [
              {
                metric: { kind: "OVERALL" },
                operator: "GTE",
                value: "0",
                upper: null,
              },
            ],
          },
        ],
      },
      priority: 10,
      dedupKey: "support-review",
      exclusivityGroup: null,
      title: tr("مراجعة ممارسات الدعم", "Review support practices"),
      body: tr("النتيجة العامة {score} ضمن {band}.", "The overall score is {score}, within {band}."),
      action: tr("راجع توزيع الأعباء", "Review workload distribution"),
      rationale: tr("مبني على {metric}.", "Based on {metric}."),
      enabled: true,
    },
  ];
  const url = `${root}/${draft.questionnaire_id}/versions/${draft.id}`;
  const saved = await page.request.patch(url, {
    headers: { ...headers(), "If-Match": `"${draft.revision}"` },
    data: d,
  });
  expect(saved.status()).toBe(200);
  const revision = (await saved.json()).data.revision as string;
  const published = await page.request.post(`${url}/publish`, {
    headers: { ...headers(), "If-Match": `"${revision}"` },
    data: {},
  });
  expect(published.status()).toBe(200);
  return { id: draft.id, questionnaireId: draft.questionnaire_id };
}

export async function publishedRound(page: Page) {
  await page.goto(`${STAFF}/login`);
  await page.getByRole("link", { name: "المتابعة عبر موفر الهوية" }).click();
  await page.getByLabel("Identity").selectOption("admin");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${STAFF}/`);
  const headers = () => ({ Origin: STAFF, "Idempotency-Key": randomUUID() });
  const base = `${STAFF}/api/v1/organizations/${ids.orgA}`;
  const stamp = Date.now().toString(36).toUpperCase();

  // Two departments of six. Both clear the threshold, so the flat partition is
  // releasable and the department view has something to show.
  const departments: string[] = [];
  for (const [index, name] of [
    ["الهندسة", "RESA"],
    ["العمليات", "RESB"],
  ].entries()) {
    const created = await page.request.post(`${base}/departments`, {
      headers: headers(),
      data: { code: `${name[1]}${stamp}`, nameAr: name[0] },
    });
    expect(created.status()).toBe(201);
    departments[index] = (await created.json()).data.id as string;
  }
  const participantIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const person = await page.request.post(`${base}/participants`, {
      headers: headers(),
      data: {
        privateReference: `RES-${stamp}-${i}`,
        displayName: `مشارك ${i + 1}`,
        departmentId: departments[i % 2],
      },
    });
    expect(person.status()).toBe(201);
    participantIds.push((await person.json()).data.id as string);
  }
  // A published instrument with a scored dimension, an overall score, bands and
  // one deterministic recommendation rule. The illustrative template is too thin
  // to produce a metric, and the recommendations view must be exercised against
  // a real release rather than an empty one.
  const version = await publishRuleInstrument(page, stamp);
  const family = (
    await (
      await page.request.get(
        `${STAFF}/api/v1/organizations/${ids.orgA}/questionnaires/${version.questionnaireId}`,
        { headers: { Origin: STAFF } },
      )
    ).json()
  ).data.family_key as string;
  const seriesName = `سلسلة النتائج ${stamp}`;
  const series = await page.request.post(`${base}/assessment-series`, {
    headers: headers(),
    data: {
      // Stamped so that two specs sharing one database do not create two
      // series with the same name and make every link ambiguous.
      nameAr: seriesName,
      purpose: "عرض النتائج المنشورة",
      questionnaireFamilyId: family,
    },
  });
  expect(series.status()).toBe(201);
  const round = await page.request.post(`${base}/assessments`, {
    headers: headers(),
    data: {
      seriesId: (await series.json()).data.id,
      label: "جولة النتائج",
      periodStart: "2026-04-01",
      questionnaireVersionId: version.id,
      populationDefinition: { schemaVersion: 1 },
    },
  });
  expect(round.status()).toBe(201);
  const roundId = (await round.json()).data.id as string;
  const campaign = await page.request.post(`${base}/campaigns`, {
    headers: headers(),
    data: {
      roundId,
      questionnaireVersionId: version.id,
      target: { mode: "SELECTED", participantIds },
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      timezone: "Asia/Riyadh",
    },
  });
  expect(campaign.status()).toBe(201);
  const created = (await campaign.json()).data as { id: string; revision: string };
  expect(
    (
      await page.request.post(`${base}/campaigns/${created.id}/launch`, {
        headers: { ...headers(), "If-Match": `"${created.revision}"` },
        data: {},
      })
    ).status(),
  ).toBe(200);

  const list = await (
    await page.request.get(`${base}/campaigns/${created.id}/participation`, {
      headers: { Origin: STAFF },
    })
  ).json();
  const tokens: string[] = [];
  for (const item of list.data.items) {
    const issued = await page.request.post(
      `${base}/campaigns/${created.id}/invitations/${item.invitationId}/issue`,
      { headers: headers(), data: { expectedGeneration: item.generation } },
    );
    expect(issued.status()).toBe(200);
    tokens.push(((await issued.json()).data.url as string).split("#")[1]);
  }

  // Real acceptances through the gateway credential, then the real processor
  // and the real release job, each under its own identity.
  const fixture = JSON.parse(await readFile("work/e2e-fixture.json", "utf8"));
  // The gateway credential and the invitation digest key, exactly as the
  // respondent origin holds them. No staff credential is used to submit.
  process.env.INVITATION_DIGEST_KEY = fixture.invitationDigestKey;
  process.env.INVITATION_DIGEST_KEY_VERSION = fixture.invitationDigestKeyVersion;
  configureGateway(fixture.gateway);
  for (let i = 0; i < tokens.length; i++) {
    const opened = await exchange(tokens[i]);
    const document = (await instrument(opened.session!)).document;
    await finalize(opened.session!, { answers: answers(document, i) });
  }
  const operator = new pg.Client({ connectionString: fixture.migration });
  await operator.connect();
  await operator.query("SET ROLE orgfit_core_owner");
  const revision = (
    await operator.query("select revision from core.campaign where id=$1", [
      created.id,
    ])
  ).rows[0].revision as string;
  await operator.end();
  expect(
    (
      await page.request.post(`${base}/campaigns/${created.id}/close`, {
        headers: { ...headers(), "If-Match": `"${revision}"` },
        data: { reason: "اكتمال الجمع" },
      })
    ).status(),
  ).toBe(200);

  // The processor's own inputs: the custody store and the custodian key pair.
  // The secret half is handed over explicitly and never left in the environment.
  process.env.CAMPAIGN_KEY_CUSTODY_DIRECTORY = fixture.custodyDirectory;
  process.env.CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY = fixture.custodianPublicKey;
  setCustodianSecret(fixture.custodianSecretKey);
  const core = new pg.Pool({ connectionString: fixture.processor, max: 2 });
  const anon = new pg.Pool({ connectionString: fixture.anonymous, max: 2 });
  try {
    const processed = await processCampaign(core, anon, created.id);
    expect(processed.processedCount).toBe(12);
    const released = await releaseCampaign(core, anon, created.id);
    expect(released.state).toBe("PUBLISHED");
  } finally {
    await core.end();
    await anon.end();
    configureGateway(undefined);
    setCustodianSecret(undefined);
  }
  return { roundId, campaignId: created.id, seriesName };
}
