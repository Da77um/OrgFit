// Phase 14 — measured load against the blueprint's acceptance baseline (§15.4).
//
// Run: TEST_ADMIN_DATABASE_URL=… npx tsx tests/ops/load.ts
//
// Baseline to measure against (targets, not guarantees):
//   * organization directory of 100,000 participants;
//   * a campaign of 10,000 invitees on an instrument of 200 answer-bearing items;
//   * 200 concurrent respondent sessions;
//   * p95 page/API interaction < 2 s, durable final acceptance < 3 s (excluding
//     network), report generation < 2 min for the fixture.
//
// What is measured and how, stated plainly: every call goes through the REAL
// route handlers or gateway functions and the real PostgreSQL routines under
// the real runtime credentials, in this process, with the production pool size
// (10 connections per role). There is no HTTP server, TLS or network in the
// path, so figures are application + database latency on this one machine, not
// end-user latency. A single Node process drives both load and service, which
// understates what separate instances would do. The synthetic directory rows
// are inserted with an operator bulk statement; the campaign, links, sessions,
// drafts, submissions, processing, release and reports all use product code.
import { randomBytes, randomUUID } from "node:crypto";
import { cpus, totalmem, freemem, release, type } from "node:os";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { respondentFixture } from "../respondent-fixture";
import { withStaff } from "../../src/db";
import { directoryRoute } from "../../src/directory";
import { saveInstrument } from "../../src/instruments";
import { saveSeries, saveRound, saveCampaign, launchCampaign, campaignTransition, invitationAction, participation } from "../../src/campaigns";
import { campaignInput } from "../../src/campaign-input";
import { blankInstrument, newIdentity, newQuestion, tr, type Instrument } from "../../src/instrument-input";
import { exchange, instrument, draftCreate, draftSave, finalize } from "../../src/respondent";
import { processCampaign } from "../../src/processor";
import { releaseCampaign } from "../../src/publication";
import { resultsRoute } from "../../src/results";
import { requestReport } from "../../src/reports";
import { configureReport, reportPool, closeReportPool } from "../../src/report-db";
import { renderDueReports } from "../../src/report-worker";

const out: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  machine: { os: `${type()} ${release()}`, cpu: cpus()[0]?.model, cores: cpus().length, memoryGiB: +(totalmem() / 2 ** 30).toFixed(1), freeGiBAtStart: +(freemem() / 2 ** 30).toFixed(1) },
  node: process.version,
  postgres: "18.4 embedded, single local cluster, default configuration",
};
const stats = (ms: number[]) => {
  const s = [...ms].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  return { n: s.length, p50: +at(50).toFixed(1), p95: +at(95).toFixed(1), p99: +at(99).toFixed(1), max: +s[s.length - 1].toFixed(1) };
};
async function timed<T>(bucket: number[], fn: () => Promise<T>) {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    bucket.push(performance.now() - t0);
  }
}
const log = (k: string, v: unknown) => {
  out[k] = v;
  console.log(k, JSON.stringify(v));
};

const f = await respondentFixture(6);
Object.assign(process.env, {
  REPORT_ENCRYPTION_KEY: "e".repeat(64),
  REPORT_LOCAL_DIRECTORY: `work/load-reports-${randomUUID()}`,
});
configureReport(f.fixture.url("orgfit_report"));
const admin = await f.session("admin");
const org = f.orgA;

// ---- 1. directory of 100,000 --------------------------------------------------
const loadDept = randomUUID(),
  restDept = randomUUID();
await f.operator.query(
  "insert into core.department(id,organization_id,code,name_ar) values($1,$2,'LOAD10K','قسم الحمل'),($3,$2,'LOADREST','بقية المنظمة')",
  [loadDept, org, restDept],
);
{
  const t0 = performance.now();
  await f.operator.query(
    `insert into core.participant(id,organization_id,private_reference,display_name,department_id)
     select gen_random_uuid(),$1,'L-'||g,'مشارك تحميل '||g, case when g<=10000 then $2::uuid else $3::uuid end
       from generate_series(1,100000) g`,
    [org, loadDept, restDept],
  );
  await f.operator.query("analyze core.participant");
  log("directoryBulkInsertSeconds", +((performance.now() - t0) / 1000).toFixed(1));
}
const directoryGet = (route: string) =>
  withStaff(admin, async (tx, p) => {
    // The route matches on the path; the query string travels on the URL.
    const req = new Request("http://127.0.0.1:3000/api/v1/" + route);
    const r = await directoryRoute(req, route.split("?")[0], tx, p);
    if (!r || r.status !== 200) throw new Error(`directory ${route} ${r?.status}`);
    return r.json();
  });
{
  const firstPage: number[] = [],
    search: number[] = [],
    paging: number[] = [];
  for (let i = 0; i < 30; i++) await timed(firstPage, () => directoryGet(`organizations/${org}/participants?limit=100`));
  for (let i = 0; i < 30; i++) await timed(search, () => directoryGet(`organizations/${org}/participants?limit=50&q=L-9${i}`));
  let cursor: string | null = null;
  for (let i = 0; i < 30; i++) {
    const body = (await timed(paging, () =>
      directoryGet(`organizations/${org}/participants?limit=100${cursor ? `&cursor=${cursor}` : ""}`),
    )) as { data: { nextCursor: string | null } };
    cursor = body.data.nextCursor;
  }
  const total = await f.operator.query("select count(*)::int n from core.participant where organization_id=$1", [org]);
  log("directory", { participants: total.rows[0].n, firstPageMs: stats(firstPage), searchMs: stats(search), cursorPagingMs: stats(paging) });
}

// ---- 2. a 200-item instrument ----------------------------------------------------
const doc: Instrument = blankInstrument();
doc.locales = ["ar", "en"];
doc.title = tr("استبانة الحمل", "Load questionnaire");
doc.privacyText = tr("إشعار تجريبي.", "Synthetic notice.");
const dimension = {
  ...newIdentity(),
  name: tr("البعد", "Dimension"),
  description: tr("وصف", "Description"),
  mode: "AVERAGE" as const,
  coverage: "0.5",
  direction: "HIGH_GOOD" as const,
  denominator: null,
  bands: [
    { ...newIdentity(), lower: "0", upper: "50", label: tr("منخفض", "Low"), severity: "HIGH" as const, semantic: "RISK" as const },
    { ...newIdentity(), lower: "50", upper: "100", label: tr("مرتفع", "High"), severity: "NONE" as const, semantic: "HEALTH" as const },
  ],
};
doc.dimensions = [dimension];
doc.sections = Array.from({ length: 10 }, (_, s) => ({
  ...newIdentity(),
  title: tr(`القسم ${s + 1}`, `Section ${s + 1}`),
  content: tr("", ""),
  questions: Array.from({ length: 20 }, (_, q) => {
    const item = newQuestion("RATING_5");
    item.prompt = tr(`البند ${s * 20 + q + 1}`, `Item ${s * 20 + q + 1}`);
    item.dimensionId = dimension.id;
    item.scoring = { enabled: true, reverse: false, weight: "1", mode: "VALUE" };
    return item;
  }),
}));
doc.overall = { enabled: true, direction: "HIGH_GOOD", inputs: [{ dimensionId: dimension.id, weight: "1", invert: false }], bands: dimension.bands.map((b) => ({ ...b, ...newIdentity() })) };
const draft = (await withStaff(admin, (tx) => saveInstrument(tx, { org, action: "CREATE", document: doc, idem: randomUUID() }))) as {
  id: string;
  questionnaire_id: string;
  revision: string;
};
const published = (await withStaff(admin, (tx) =>
  saveInstrument(tx, { org, qid: draft.questionnaire_id, vid: draft.id, revision: draft.revision, action: "PUBLISH", document: doc, idem: randomUUID() }),
)) as { id: string };
const family = (await f.operator.query("select family_key from instrument.questionnaire where id=$1", [draft.questionnaire_id])).rows[0].family_key;
const series = (await withStaff(admin, (tx) =>
  saveSeries(tx, org, null, null, { nameAr: "سلسلة الحمل", purpose: "قياس الأداء", questionnaireFamilyId: family }, randomUUID()),
)) as { id: string };

// ---- 3. a 10,000-invitee campaign ----------------------------------------------------
const round = (await withStaff(admin, (tx) =>
  saveRound(tx, org, null, null, { seriesId: series.id, label: "جولة الحمل", periodStart: "2026-05-01", questionnaireVersionId: published.id, populationDefinition: { schemaVersion: 1 } }, randomUUID()),
)) as { id: string };
const campaign = (await withStaff(admin, (tx) =>
  saveCampaign(tx, org, null, null, campaignInput.parse({
    roundId: round.id,
    questionnaireVersionId: published.id,
    target: { mode: "DEPARTMENT", departmentId: loadDept },
    startsAt: new Date(Date.now() - 1000).toISOString(),
    timezone: "Asia/Riyadh",
  }), randomUUID()),
)) as { id: string; revision: string };
{
  const t0 = performance.now();
  await withStaff(admin, (tx) => launchCampaign(tx, org, campaign.id, campaign.revision, randomUUID()));
  log("launch10kSeconds", +((performance.now() - t0) / 1000).toFixed(2));
}
{
  const t: number[] = [];
  for (let i = 0; i < 20; i++)
    await timed(t, () => withStaff(admin, (tx) => participation(tx, org, campaign.id)));
  const invited = await f.operator.query("select count(*)::int n from core.invitation where campaign_id=$1", [campaign.id]);
  log("participationList", { invitations: invited.rows[0].n, ms: stats(t) });
}

// ---- 4. 200 concurrent respondent sessions ---------------------------------------------
const list = (await withStaff(admin, (tx) => participation(tx, org, campaign.id))) as {
  items: { invitationId: string; generation: number }[];
};
const tokens: string[] = [];
for (const item of list.items.slice(0, 200)) {
  const issued = (await withStaff(admin, (tx) =>
    invitationAction(tx, org, campaign.id, item.invitationId, "ISSUE", { expectedGeneration: item.generation }, randomUUID()),
  )) as { url: string };
  tokens.push(issued.url.split("#")[1]);
}
const lat = { exchange: [] as number[], instrument: [] as number[], draftCreate: [] as number[], draftSave: [] as number[], finalize: [] as number[] };
let errors = 0;
const errorCodes: Record<string, number> = {};
const ciphertext = randomBytes(6000).toString("base64");
const concurrencyStarted = performance.now();
await Promise.all(
  tokens.map(async (token, i) => {
    try {
      const opened = await timed(lat.exchange, () => exchange(token));
      const session = opened.session!;
      const d = (await timed(lat.instrument, () => instrument(session))).document;
      const handle = randomUUID();
      await timed(lat.draftCreate, () => draftCreate(session, { handle, cipherVersion: "DF1", nonce: randomBytes(12).toString("base64"), ciphertext, expectedRevision: 0 }));
      await timed(lat.draftSave, () => draftSave(session, { handle, cipherVersion: "DF1", nonce: randomBytes(12).toString("base64"), ciphertext, expectedRevision: 1 }));
      const answers: Record<string, string> = {};
      for (const q of d.sections.flatMap((s) => s.questions)) answers[q.id] = String((i % 5) + 1);
      await timed(lat.finalize, () => finalize(session, { answers }));
    } catch (e) {
      errors++;
      const code = `${(e as { code?: string }).code ?? (e as Error).message}`;
      errorCodes[code] = (errorCodes[code] ?? 0) + 1;
    }
  }),
);
log("concurrentRespondents", {
  sessions: tokens.length,
  wallSeconds: +((performance.now() - concurrencyStarted) / 1000).toFixed(1),
  errors,
  errorCodes,
  exchangeMs: stats(lat.exchange),
  instrumentMs: stats(lat.instrument),
  draftCreateMs: stats(lat.draftCreate),
  draftSaveMs: stats(lat.draftSave),
  finalAcceptanceMs: stats(lat.finalize),
});
const accepted = await f.operator.query("select count(*)::int n from intake.submission_inbox where campaign_id=$1", [campaign.id]);
const completed = await f.operator.query("select count(*)::int n from core.invitation where campaign_id=$1 and status='COMPLETED'", [campaign.id]);
log("countReconciliation", { envelopes: accepted.rows[0].n, completedInvitations: completed.rows[0].n, agree: accepted.rows[0].n === completed.rows[0].n });

// ---- 5. closure, processing, release ----------------------------------------------------
const revision = (await f.operator.query("select revision from core.campaign where id=$1", [campaign.id])).rows[0].revision;
await withStaff(admin, (tx) => campaignTransition(tx, org, campaign.id, revision, "CLOSE", { reason: "نهاية اختبار الحمل" }, randomUUID()));
const core = new pg.Pool({ connectionString: f.fixture.url("orgfit_processor"), max: 4 });
const anon = new pg.Pool({ connectionString: f.fixture.anonymousUrl("orgfit_processor"), max: 4 });
{
  let t0 = performance.now();
  const processed = await processCampaign(core, anon, campaign.id);
  const processSeconds = (performance.now() - t0) / 1000;
  t0 = performance.now();
  const released = await releaseCampaign(core, anon, campaign.id);
  log("processing", { envelopes: processed.acceptedCount, processed: processed.processedCount, processSeconds: +processSeconds.toFixed(1), releaseState: released.state, releaseSeconds: +((performance.now() - t0) / 1000).toFixed(1) });
}
await core.end();
await anon.end();

// ---- 6. results reads ---------------------------------------------------------------------
{
  const views: Record<string, number[]> = { overview: [], departments: [], questions: [], recommendations: [] };
  for (const view of Object.keys(views))
    for (let i = 0; i < 20; i++)
      await timed(views[view], () =>
        withStaff(admin, async (tx) => {
          const route = `organizations/${org}/assessments/${round.id}/results${view === "overview" ? "" : `/${view}`}`;
          const r = await resultsRoute(new Request("http://127.0.0.1:3000/api/v1/" + route), route, tx);
          if (!r || r.status !== 200) throw new Error(`results ${view} ${r?.status}`);
          return r.text();
        }),
      );
  log("resultsReadsMs", Object.fromEntries(Object.entries(views).map(([k, v]) => [k, stats(v)])));
}

// ---- 7. report generation ------------------------------------------------------------------
{
  const rendered: Record<string, number> = {};
  for (const [format, locale] of [["PDF", "ar"], ["XLSX", "en"]] as const) {
    await withStaff(admin, (tx) => requestReport(tx, org, { roundId: round.id, format, locale, comparisonId: null }, randomUUID()));
    const t0 = performance.now();
    const outcomes = await renderDueReports(reportPool(), 1);
    if (outcomes[0]?.state !== "READY") throw new Error(`report ${format} ${outcomes[0]?.state}`);
    rendered[`${format}_${locale}_seconds`] = +((performance.now() - t0) / 1000).toFixed(1);
  }
  log("reportGeneration", rendered);
}
await closeReportPool();
await f.close();

out.finishedAt = new Date().toISOString();
out.freeGiBAtEnd = +(freemem() / 2 ** 30).toFixed(1);
await writeFile("work/p14-load.json", JSON.stringify(out, null, 2));
console.log("done");
