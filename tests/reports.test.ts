import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import pg from "pg";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { withStaff } from "../src/db";
import { ids } from "../scripts/seed";
import { saveRound, saveCampaign, launchCampaign } from "../src/campaigns";
import { campaignInput } from "../src/campaign-input";
import { saveInstrument, getVersion } from "../src/instruments";
import {
  copyInstrument,
  definitionIssues,
  newRule,
  tr,
  type Instrument,
} from "../src/instrument-input";
import { exchange, instrument, finalize } from "../src/respondent";
import { processCampaign } from "../src/processor";
import { releaseCampaign } from "../src/publication";
import { resultsRoute } from "../src/results";
import { historyRoute } from "../src/history";
import { reportRoute, participationCsv } from "../src/reports";
import { recommendationActionRoute } from "../src/recommendations";
import { configureReport, reportPool, reportReadiness, closeReportPool, assertNoForeignCredentials } from "../src/report-db";
import { renderDueReports, claimReportJobs } from "../src/report-worker";
import { buildReportModel, type ReportSource } from "../src/report-model";
import { safeText } from "../src/report-xlsx";
import { reportHtml } from "../src/report-html";
import { respondentFixture, failure, wait, type Fixture } from "./respondent-fixture";

// ---------------------------------------------------------------------------
// Phase 11 against the real thing.
//
// Two real campaigns of one series are collected through the real gateway,
// processed by the real privacy processor and released by the real publication
// job. Reports are then requested through the real staff route, rendered by the
// real worker under the real orgfit_report credential, and the produced PDF and
// XLSX bytes are opened and inspected — not merely counted.
//
// The properties under test are the ones a report can get wrong in a way that
// matters: a number that disagrees with the dashboard, a withheld value that
// survives somewhere inside a workbook, an Arabic page that does not render or
// cannot be read back, a download that outlives its authorization.
// ---------------------------------------------------------------------------

const LONG_ARABIC_DEPARTMENT =
  "إدارة التطوير التنظيمي والتخطيط الاستراتيجي وتحسين تجربة الموظفين والاتصال الداخلي" +
  " ومتابعة مبادرات التحول المؤسسي في جميع الفروع والمواقع التشغيلية التابعة للمنظمة";
const INJECTION = '=HYPERLINK("http://attacker.invalid","انقر هنا")';

function answersFor(document: Instrument, seed: number) {
  const answers: Record<string, string | string[]> = {};
  for (const q of document.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    switch (q.type) {
      case "SHORT_TEXT":
      case "LONG_TEXT":
        answers[q.id] = `تعليق ${seed}`;
        break;
      case "RATING_5":
        answers[q.id] = String((seed % 5) + 1);
        break;
      case "RATING_10":
        answers[q.id] = String((seed % 10) + 1);
        break;
      case "NUMBER":
        answers[q.id] = String(seed % 10);
        break;
      case "DATE":
        answers[q.id] = "2026-06-15";
        break;
      case "CHECKBOXES":
        answers[q.id] = [q.options[seed % q.options.length].id];
        break;
      case "MATRIX":
        for (const row of q.rows)
          answers[row.id] = q.columns[seed % q.columns.length].id;
        break;
      default:
        answers[q.id] = q.options[seed % q.options.length].id;
    }
  }
  return answers;
}

type PdfReading = { pages: number; text: string };

async function readPdf(bytes: Buffer): Promise<PdfReading> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument(src: { data: Uint8Array }): {
      promise: Promise<{
        numPages: number;
        getPage(n: number): Promise<{
          getTextContent(): Promise<{ items: { str?: string }[] }>;
        }>;
      }>;
    };
  };
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  let text = "";
  for (let page = 1; page <= doc.numPages; page++) {
    const content = await (await doc.getPage(page)).getTextContent();
    text += content.items.map((i) => i.str ?? "").join("") + "\n";
  }
  return { pages: doc.numPages, text };
}

// A glyph the PDF cannot map back to a character extracts as U+0000. Counting
// them is how "the Arabic is selectable and searchable" becomes an assertion
// rather than a hope: a shaped Arabic page whose embedded subset has no reverse
// mapping renders correctly and copies as nothing.
const unmapped = (text: string) =>
  [...text].filter((character) => character.charCodeAt(0) === 0).length;

// What surrounded an unmappable glyph, so a failure names the character rather
// than only counting it.
const unmappedContext = (text: string) =>
  [...text]
    .map((character, index) =>
      character.charCodeAt(0) === 0
        ? JSON.stringify(text.slice(Math.max(0, index - 15), index + 15))
        : null,
    )
    .filter(Boolean)
    .join(" | ");

// How much Arabic script the PDF actually carries as TEXT. A page of Arabic
// drawn as an image, or one whose face failed to load, extracts as nothing.
const arabicGlyphs = (text: string) =>
  [...text].filter((c) => {
    const code = c.codePointAt(0) ?? 0;
    return (
      (code >= 0x0600 && code <= 0x06ff) || (code >= 0xfb50 && code <= 0xfefc)
    );
  }).length;

async function workbookParts(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const parts: Record<string, string> = {};
  for (const name of Object.keys(zip.files))
    if (!zip.files[name].dir)
      parts[name] = await zip.files[name].async("string");
  return parts;
}

test("PostgreSQL Phase 11: report jobs, PDF and XLSX artifacts", async (t) => {
  const f: Fixture = await respondentFixture(12);
  Object.assign(process.env, {
    REPORT_ENCRYPTION_KEY: "c".repeat(64),
    REPORT_LOCAL_DIRECTORY: `work/reports-${randomUUID()}`,
    PARTICIPATION_EXPORT_ENCRYPTION_KEY: "d".repeat(64),
    PARTICIPATION_EXPORT_LOCAL_DIRECTORY: `work/participation-exports-${randomUUID()}`,
  });
  delete process.env.REPORT_DATABASE_URL;
  configureReport(f.fixture.url("orgfit_report"));

  const core = new pg.Pool({ connectionString: f.fixture.url("orgfit_processor"), max: 4 });
  const anon = new pg.Pool({ connectionString: f.fixture.anonymousUrl("orgfit_processor"), max: 4 });

  // Registered before anything can fail: an aborted setup must still close its
  // pools, or the runner reports the failure and then never exits to print it.
  t.after(async () => {
    await closeReportPool();
    await core.end();
    await anon.end();
    await f.close();
  });

  // The shared fixture grants reports.manage before it issues its own session,
  // so this suite drives the same staff identity every fixture helper uses. A
  // capability change bumps the auth epoch and revokes live sessions by design,
  // which one subtest below exercises deliberately.
  let staff = f.staff;

  // A second staff member, scoped to the other organization only.
  const otherStaff = randomUUID();
  await f.operator.query(
    "insert into access.staff_user(id,issuer,provider_subject,email,display_name,role,status) values($1,$2,'other','other@example.invalid','موظف منظمة ب','STAFF','ACTIVE')",
    [otherStaff, process.env.OIDC_ISSUER],
  );
  await f.operator.query("insert into access.organization_access values($1,$2)", [
    otherStaff,
    ids.orgB,
  ]);
  for (const capability of ["results.read", "reports.manage", "participation.export"])
    await f.operator.query(
      "insert into access.staff_capability(staff_user_id,capability) values($1,$2)",
      [otherStaff, capability],
    );
  const otherToken = await f.session("other");

  const route = (
    handler: typeof reportRoute,
    target: string,
    init: RequestInit | undefined,
    token: string,
  ) => {
    const [path] = target.split("?");
    const request = new Request(`http://127.0.0.1:3000/api/v1/${target}`, init);
    return withStaff(token, (tx) => handler(request, path, tx));
  };
  const call = async (
    target: string,
    init?: RequestInit,
    token = staff,
    handler = reportRoute,
  ) => {
    const res = await route(handler, target, init, token);
    assert.ok(res, `${target} is not a route`);
    return { status: res.status, data: (await res.json()).data };
  };
  const bytesOf = async (target: string, token = staff) => {
    const res = await route(reportRoute, target, undefined, token);
    assert.ok(res);
    return {
      status: res.status,
      headers: res.headers,
      bytes: Buffer.from(await res.arrayBuffer()),
    };
  };
  const deny = (target: string, init?: RequestInit, token = staff, handler = reportRoute) =>
    failure(async () => {
      const res = await route(handler, target, init, token);
      if (!res) throw new Error("NO_ROUTE");
      return res;
    });
  const post = (body: unknown) => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(body),
  });

  // A published version of the coverage questionnaire carrying one deterministic
  // rule that always fires on a published overall score, so the report has a
  // real computed finding to print beside real consultant commentary.
  async function publishVersionWithRule() {
    const questionnaireId = (
      await f.operator.query(
        "select questionnaire_id from instrument.questionnaire_version where id=$1",
        [f.coverageVersionId],
      )
    ).rows[0].questionnaire_id as string;
    const source = await withStaff(staff, (tx) =>
      getVersion(tx, f.orgA, questionnaireId, f.coverageVersionId),
    );
    const draft = (await withStaff(staff, (tx) =>
      saveInstrument(tx, {
        org: f.orgA,
        qid: questionnaireId,
        revision: source.revision,
        action: "NEW_VERSION",
        sourceId: f.coverageVersionId,
        document: copyInstrument(source.document),
        idem: randomUUID(),
      }),
    )) as { id: string; questionnaire_id: string; revision: string; document: Instrument };
    const document = draft.document;
    const rule = newRule({ kind: "OVERALL" });
    rule.condition.clauses[0].comparisons[0] = {
      metric: { kind: "OVERALL" },
      operator: "GTE",
      value: "0",
      upper: null,
    };
    rule.dedupKey = "overall-review";
    rule.title = tr("مراجعة النتيجة العامة", "Review the overall score");
    rule.body = tr(
      "بلغت النتيجة العامة {score} ضمن تصنيف {band}، ويوصى بمراجعة الأبعاد المنشورة لتحديد أولويات التحسين خلال الدورة القادمة.",
      "The overall score is {score} in the {band} band; review the published dimensions to set improvement priorities for the next cycle.",
    );
    rule.action = tr(
      "اعقد جلسة مراجعة مع قادة الأقسام لمناقشة النتائج المنشورة فقط.",
      "Hold a review session with department leads about published results only.",
    );
    rule.rationale = tr(
      "قاعدة حتمية مطبقة على {metric} لمجموعة {group}.",
      "A deterministic rule applied to {metric} for {group}.",
    );
    document.recommendations = [rule];
    assert.deepEqual(definitionIssues(document), []);
    const saved = (await withStaff(staff, (tx) =>
      saveInstrument(tx, {
        org: f.orgA,
        qid: draft.questionnaire_id,
        vid: draft.id,
        revision: draft.revision,
        action: "SAVE",
        document,
        idem: randomUUID(),
      }),
    )) as { id: string; revision: string; document: Instrument };
    const published = (await withStaff(staff, (tx) =>
      saveInstrument(tx, {
        org: f.orgA,
        qid: draft.questionnaire_id,
        vid: saved.id,
        revision: saved.revision,
        action: "PUBLISH",
        document: saved.document,
        idem: randomUUID(),
      }),
    )) as { id: string };
    return published.id;
  }

  async function releasedRound(
    versionId: string,
    periodStart: string,
    seed: number,
    people: string[],
  ) {
    const round = (await withStaff(staff, (tx) =>
      saveRound(
        tx,
        f.orgA,
        null,
        null,
        {
          seriesId: f.seriesId,
          label: `جولة ${periodStart}`,
          periodStart,
          questionnaireVersionId: versionId,
          populationDefinition: { schemaVersion: 1 },
        },
        randomUUID(),
      ),
    )) as { id: string };
    const campaign = (await withStaff(staff, (tx) =>
      saveCampaign(
        tx,
        f.orgA,
        null,
        null,
        campaignInput.parse({
          roundId: round.id,
          questionnaireVersionId: versionId,
          target: { mode: "SELECTED", participantIds: people },
          startsAt: new Date(Date.now() - 1000).toISOString(),
          timezone: "Asia/Riyadh",
        }),
        randomUUID(),
      ),
    )) as { id: string; revision: string };
    await withStaff(staff, (tx) =>
      launchCampaign(tx, f.orgA, campaign.id, campaign.revision, randomUUID()),
    );
    const links = await f.issueLinks(campaign.id);
    for (let i = 0; i < links.length; i++) {
      const opened = await exchange(links[i].token);
      const document = (await instrument(opened.session!)).document;
      await finalize(opened.session!, { answers: answersFor(document, i + seed) });
    }
    await f.closeCampaign(campaign.id);
    await processCampaign(core, anon, campaign.id);
    const outcome = await releaseCampaign(core, anon, campaign.id);
    assert.equal(outcome.state, "PUBLISHED");
    return { roundId: round.id, campaignId: campaign.id, snapshotId: outcome.snapshotId! };
  }

  const versionId = await publishVersionWithRule();

  // A long Arabic department name, applied before the second round is launched
  // so that round's frozen report groups carry it into every table.
  await f.operator.query("update core.department set name_ar=$2 where id=$1", [
    f.departmentB,
    LONG_ARABIC_DEPARTMENT,
  ]);

  const first = await releasedRound(versionId, "2026-01-01", 0, f.people);

  // A third department with two people only. Its cells cannot be released, and
  // the complementary rule withholds the whole department partition of the
  // second round with it.
  const departmentC = randomUUID();
  await f.operator.query(
    "insert into core.department(id,organization_id,code,name_ar) values($1,$2,'FIN','الشؤون المالية')",
    [departmentC, f.orgA],
  );
  const sparsePeople: string[] = [];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    sparsePeople.push(id);
    await f.operator.query(
      "insert into core.participant(id,organization_id,private_reference,display_name,department_id) values($1,$2,$3,$4,$5)",
      [id, f.orgA, `C-${i + 1}`, `مشارك مالية ${i + 1}`, departmentC],
    );
  }
  const second = await releasedRound(versionId, "2026-07-01", 3, [
    ...f.people,
    ...sparsePeople,
  ]);

  // A reviewed comparison of the two rounds. Same pinned version, so the claim
  // is IDENTICAL and needs no equivalence judgement beyond that fact.
  const proposal = await withStaff(staff, (tx) =>
    historyRoute(
      new Request(
        `http://127.0.0.1:3000/api/v1/organizations/${f.orgA}/comparisons/proposal?left=${first.roundId}&right=${second.roundId}`,
      ),
      `organizations/${f.orgA}/comparisons/proposal`,
      tx,
    ),
  );
  const proposalData = (await proposal!.json()).data as {
    pairs: { leftKey: string; rightKey: string; equivalent: boolean }[];
  };
  const comparisonResponse = await withStaff(staff, (tx) =>
    historyRoute(
      new Request(`http://127.0.0.1:3000/api/v1/organizations/${f.orgA}/comparisons`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
        body: JSON.stringify({
          leftRoundId: first.roundId,
          rightRoundId: second.roundId,
          classification: "IDENTICAL",
          mapping: proposalData.pairs
            .filter((p) => p.equivalent)
            .map((p) => ({ leftKey: p.leftKey, rightKey: p.rightKey })),
          rationale: "الإصدار نفسه في الجولتين، والمقارنة مباشرة.",
        }),
      }),
      `organizations/${f.orgA}/comparisons`,
      tx,
    ),
  );
  const comparisonId = ((await comparisonResponse!.json()).data as { id: string }).id;

  // A consultant opinion attached to the computed finding of the second round.
  const instanceId = (
    await f.operator.query(
      "select id from publication.recommendation_instance where snapshot_id=$1 order by priority limit 1",
      [second.snapshotId],
    )
  ).rows[0]?.id as string | undefined;
  assert.ok(instanceId, "the deterministic rule produced a recommendation");
  const CONSULTANT_NOTE =
    "ملاحظة استشارية: النتيجة مطمئنة إجمالًا، غير أن فجوة أحد الأقسام تستحق جلسة متابعة ميدانية قبل الجولة القادمة.";
  // The consultant opinion is recorded through the real staff route, so what a
  // report prints as commentary is exactly what a consultant saved.
  const commentaryResponse = await withStaff(staff, (tx) =>
    recommendationActionRoute(
      new Request(
        `http://127.0.0.1:3000/api/v1/organizations/${f.orgA}/recommendation-actions/${instanceId}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify({
            status: "IN_PROGRESS",
            ownerStaffId: null,
            dueDate: "2026-09-30",
            staffNotes: CONSULTANT_NOTE,
            resolution: null,
          }),
        },
      ),
      `organizations/${f.orgA}/recommendation-actions/${instanceId}`,
      tx,
    ),
  );
  assert.equal(commentaryResponse!.status, 200);

  // The exact document the renderer was handed, read back from the frozen job
  // source and projected through the same pure model both renderers consume.
  const renderedModel = async (jobId: string) => {
    const { rows } = await f.operator.query(
      "select source from ops.report_job where id=$1",
      [jobId],
    );
    return buildReportModel(rows[0].source as ReportSource);
  };

  const request = (body: Record<string, unknown>) =>
    call(`organizations/${f.orgA}/reports`, post(body));

  const jobs: Record<string, string> = {};

  await t.test("a report is requested, queued and rendered by the worker", async () => {
    const requests = [
      { key: "pdf-ar", roundId: second.roundId, format: "PDF", locale: "ar", comparisonId },
      { key: "pdf-en", roundId: second.roundId, format: "PDF", locale: "en", comparisonId },
      { key: "xlsx-ar", roundId: second.roundId, format: "XLSX", locale: "ar", comparisonId },
      { key: "xlsx-en", roundId: first.roundId, format: "XLSX", locale: "en", comparisonId: null },
      { key: "pdf-first", roundId: first.roundId, format: "PDF", locale: "ar", comparisonId: null },
    ];
    for (const { key, ...body } of requests) {
      const created = await request(body);
      assert.equal(created.status, 202);
      assert.equal(created.data.state, "QUEUED");
      jobs[key] = created.data.id;
    }
    const outcomes = await renderDueReports(reportPool(), 10);
    assert.equal(outcomes.length, requests.length);
    for (const outcome of outcomes) {
      assert.equal(outcome.state, "READY", `${outcome.jobId} ${outcome.failureCode ?? ""} ${outcome.note ?? ""}`);
      assert.ok(outcome.byteCount! > 1000);
      // A report that reached for anything over the network is a report that
      // leaked a reference to it. Zero is the only acceptable count.
      if (outcome.format === "PDF") {
        assert.equal(outcome.networkAttempts, 0);
        assert.ok(outcome.pageCount! >= 1);
      }
    }
    const listed = await call(`organizations/${f.orgA}/reports?roundId=${second.roundId}`);
    assert.equal(listed.data.items.length, 3);
    for (const item of listed.data.items) assert.equal(item.state, "READY");
    // The list never hands out a storage key.
    assert.equal(JSON.stringify(listed.data).includes("reports/"), false);
  });

  await t.test("the PDF renders Arabic that is shaped, paged and readable back", async () => {
    const arabic = await bytesOf(`organizations/${f.orgA}/reports/${jobs["pdf-ar"]}/download`);
    assert.equal(arabic.status, 200);
    assert.equal(arabic.headers.get("content-type"), "application/pdf");
    assert.match(
      arabic.headers.get("content-disposition") ?? "",
      /^attachment; filename="orgfit-report-ar-[0-9a-f-]{36}\.pdf"$/,
    );
    assert.equal(arabic.headers.get("cache-control"), "no-store");
    assert.equal(arabic.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    await mkdir("work", { recursive: true });
    await writeFile("work/report-ar.pdf", arabic.bytes);

    const reading = await readPdf(arabic.bytes);
    // A report of this size is inherently multi-page; a single page would mean
    // content was lost rather than that it was concise.
    assert.ok(reading.pages >= 3, `pages=${reading.pages}`);
    // EVERY glyph maps back to a real character. This is what decides whether
    // Arabic in the file is selectable and searchable at all: a shaped page
    // whose embedded subset has no reverse mapping looks perfect and copies as
    // nothing. It is also why the Arabic face is Cairo (D-078).
    assert.equal(
      unmapped(reading.text),
      0,
      `unmappable glyphs: ${unmappedContext(reading.text)}`,
    );
    // The Arabic is present as text rather than as a picture, and in quantity.
    assert.ok(
      arabicGlyphs(reading.text) > 2000,
      `arabic glyphs=${arabicGlyphs(reading.text)}`,
    );
    // Latin identifiers extract exactly.
    assert.ok(reading.text.includes(String(second.snapshotId).slice(0, 8)));

    const english = await bytesOf(`organizations/${f.orgA}/reports/${jobs["pdf-en"]}/download`);
    await writeFile("work/report-en.pdf", english.bytes);
    const englishReading = await readPdf(english.bytes);
    assert.ok(englishReading.pages >= 3);
    for (const word of ["Organization", "Participation", "Methodology", "Recommendations"])
      assert.ok(englishReading.text.includes(word), `missing ${word}`);

    // A short report is still a complete report rather than a truncated one.
    const shortReport = await bytesOf(
      `organizations/${f.orgA}/reports/${jobs["pdf-first"]}/download`,
    );
    await writeFile("work/report-first-ar.pdf", shortReport.bytes);
    const shortReading = await readPdf(shortReport.bytes);
    assert.ok(shortReading.pages >= 2);
    assert.equal(
      unmapped(shortReading.text),
      0,
      `unmappable glyphs: ${unmappedContext(shortReading.text)}`,
    );
    assert.ok(arabicGlyphs(shortReading.text) > 1000);
  });

  await t.test("dashboard, PDF and workbook agree on every released value", async () => {
    const dashboard = async (view: string, roundId: string) => {
      const res = await withStaff(staff, (tx) =>
        resultsRoute(
          new Request(
            `http://127.0.0.1:3000/api/v1/organizations/${f.orgA}/assessments/${roundId}/results/${view}`,
          ),
          `organizations/${f.orgA}/assessments/${roundId}/results/${view}`,
          tx,
        ),
      );
      return (await res!.json()).data as {
        cells: { groupKey: string; metricKey: string; status: string; value: string | null }[];
        companyGroupKey: string;
      };
    };
    const overview = await dashboard("overview", second.roundId);
    const departments = await dashboard("departments", second.roundId);

    const xlsx = await bytesOf(`organizations/${f.orgA}/reports/${jobs["xlsx-ar"]}/download`);
    assert.equal(
      xlsx.headers.get("content-type"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    await writeFile("work/report-ar.xlsx", xlsx.bytes);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(xlsx.bytes as unknown as ArrayBuffer);

    const dimensionSheet = book.worksheets[1];
    const workbookValues = new Map<string, number | null>();
    dimensionSheet.eachRow((row, index) => {
      if (index === 1) return;
      const value = row.getCell(2).value;
      workbookValues.set(String(row.getCell(1).value), typeof value === "number" ? value : null);
    });

    const pdfText = (await readPdf(
      (await bytesOf(`organizations/${f.orgA}/reports/${jobs["pdf-ar"]}/download`)).bytes,
    )).text;

    let compared = 0;
    for (const cell of overview.cells) {
      const metric = (overview as unknown as { metrics: { key: string; label: { ar: string } }[] })
        .metrics.find((x) => x.key === cell.metricKey)!;
      const label = metric.label.ar;
      if (cell.status === "AVAILABLE" && cell.value !== null) {
        // Typed as a number in the workbook, and numerically identical to what
        // the dashboard published.
        assert.equal(workbookValues.get(label), Number(cell.value), label);
        assert.ok(pdfText.includes(cell.value), `${label} ${cell.value} missing from the PDF`);
        compared++;
      } else {
        // A withheld metric has an EMPTY value cell — not a zero, not a dash.
        assert.equal(workbookValues.get(label) ?? null, null, label);
      }
    }
    assert.ok(compared >= 2, "at least the overall score and one dimension were compared");

    // Department cells of this round are withheld as a whole partition, and the
    // workbook must say so rather than leave a bare empty column.
    const departmentSheet = book.worksheets[2];
    let departmentRows = 0;
    departmentSheet.eachRow((row, index) => {
      if (index === 1) return;
      departmentRows++;
      const value = row.getCell(3).value;
      const status = String(row.getCell(7).value ?? "");
      if (typeof value === "number") assert.equal(status, "منشورة");
      else assert.ok(status.length > 0, "a withheld department cell states its status");
    });
    assert.ok(departmentRows > 0);
    assert.ok(
      departments.cells.some((c) => c.status !== "AVAILABLE"),
      "the sparse third department withheld the partition",
    );
  });

  await t.test("nothing withheld survives anywhere inside the workbook", async () => {
    const xlsx = await bytesOf(`organizations/${f.orgA}/reports/${jobs["xlsx-ar"]}/download`);
    const parts = await workbookParts(xlsx.bytes);
    const names = Object.keys(parts);
    // No chart, no cached chart series, no pivot cache, no external link and no
    // embedded object: none of the places a value could hide is ever created.
    for (const forbidden of ["chart", "pivotCache", "pivotTable", "externalLink", "embeddings"])
      assert.deepEqual(
        names.filter((n) => n.toLowerCase().includes(forbidden.toLowerCase())),
        [],
        forbidden,
      );
    // No formula anywhere, so no cached formula result either.
    for (const [name, xml] of Object.entries(parts))
      if (name.endsWith(".xml"))
        assert.equal(/<f[ >]/.test(xml), false, `formula in ${name}`);
    // No hidden or very hidden sheet.
    assert.equal(/state="(hidden|veryHidden)"/.test(parts["xl/workbook.xml"] ?? ""), false);
    assert.equal(/<definedNames>/.test(parts["xl/workbook.xml"] ?? ""), false);
    // No comment or note part carrying a stray value.
    assert.deepEqual(names.filter((n) => n.includes("comments")), []);

    // And the database refuses a frozen source that carries one, whatever the
    // application believed it was projecting.
    const forged = {
      context: {
        history: { trends: [] },
        cells: [
          {
            groupKey: "g",
            metricKey: "m",
            status: "SUPPRESSED",
            reasonCode: "COMPLEMENTARY",
            value: "71.4",
            contributorCount: 3,
          },
        ],
      },
    };
    const leak = await f.operator.query("select publication.withheld_leak($1) as leak", [
      JSON.stringify(forged),
    ]);
    assert.equal(leak.rows[0].leak, true);
    const refusal = await failure(() =>
      f.operator.query("select publication.check_report_input($1,$2)", [
        f.orgA,
        JSON.stringify(forged),
      ]),
    );
    assert.match(refusal, /REPORT_WITHHELD_VALUE/);

    // A trend point that quotes a number the release never published is refused
    // even though every cell in it looks well formed.
    const invented = {
      context: {
        history: {
          trends: [
            {
              metricKey: "overall",
              points: [{ roundId: second.roundId, value: "99.9", status: "COMPARABLE" }],
            },
          ],
        },
      },
    };
    const mismatch = await failure(() =>
      f.operator.query("select publication.check_report_input($1,$2)", [
        f.orgA,
        JSON.stringify(invented),
      ]),
    );
    assert.match(mismatch, /REPORT_VALUE_MISMATCH/);
  });

  await t.test("the model itself refuses to carry a withheld number", () => {
    // Defence in depth: even handed a source whose cell was tampered with after
    // the database check, the document model reads a value only inside the
    // AVAILABLE branch.
    const source = {
      schemaVersion: 1,
      locale: "ar",
      format: "PDF",
      requestedAt: new Date().toISOString(),
      organization: { id: f.orgA, code: "A", nameAr: "منظمة", nameEn: null, timezone: "Asia/Riyadh" },
      series: { id: f.seriesId, nameAr: "سلسلة", nameEn: null, purpose: "غرض" },
      round: { id: second.roundId, label: "جولة", periodStart: "2026-07-01", periodEnd: null, state: "PUBLISHED", versionId, compatibilityGroup: null },
      campaign: { id: second.campaignId, timezone: "Asia/Riyadh", startsAt: "", endsAt: null, closedAt: null, threshold: 5, locales: ["ar"], releaseState: "PUBLISHED" },
      participation: { invited: 14, completed: 14, revoked: 0, outstanding: 0, eligible: 14, rate: "1.0000" },
      snapshot: {
        id: second.snapshotId,
        campaignId: second.campaignId,
        roundId: second.roundId,
        releaseRevision: 1,
        threshold: 5,
        contributorCount: 14,
        generatedAt: new Date().toISOString(),
        period: {},
        manifest: {},
        contentHash: "0".repeat(64),
        reviewReference: "test",
        versions: {},
        groups: [{ key: "00000000-0000-4000-8000-000000000010", kind: "COMPANY", label: { ar: "الشركة", en: "Company" }, order: 0 }],
        metrics: [
          {
            key: "overall",
            kind: "OVERALL",
            label: { ar: "النتيجة العامة", en: "Overall" },
            description: { ar: "", en: "" },
            direction: "HIGH_GOOD",
            unit: "SCORE_0_100",
            order: 0,
            bands: [],
          },
        ],
        cells: [
          {
            groupKey: "00000000-0000-4000-8000-000000000010",
            metricKey: "overall",
            status: "SUPPRESSED",
            reasonCode: "HOMOGENEOUS",
            contributorCount: 9,
            value: "88.8",
            coverage: "1",
            distribution: null,
            band: null,
          },
        ],
      },
      recommendations: [],
      context: {},
    } as unknown as ReportSource;
    const model = buildReportModel(source);
    assert.equal(model.overall!.value, null);
    assert.equal(model.overall!.numeric, null);
    assert.equal(model.overall!.contributorCount, null);
    assert.equal(JSON.stringify(model).includes("88.8"), false);
    assert.ok(model.summary[0].includes("لم تُنشر"));
  });

  await t.test("spreadsheet formula injection is neutralized", async () => {
    assert.equal(safeText(INJECTION), `'${INJECTION}`);
    assert.equal(safeText("-3 نقاط"), "'-3 نقاط");
    assert.equal(safeText("النتيجة العامة"), "النتيجة العامة");

    // Through the real path: an organization renamed to a formula reaches the
    // workbook as inert text, and the workbook still contains no formula part.
    await f.operator.query("update core.organization set name_ar=$2 where id=$1", [
      f.orgA,
      INJECTION,
    ]);
    const created = await request({
      roundId: first.roundId,
      format: "XLSX",
      locale: "ar",
      comparisonId: null,
    });
    await renderDueReports(reportPool(), 5);
    const xlsx = await bytesOf(`organizations/${f.orgA}/reports/${created.data.id}/download`);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(xlsx.bytes as unknown as ArrayBuffer);
    const summary = book.worksheets[0];
    let found = false;
    summary.eachRow((row) => {
      const value = String(row.getCell(2).value ?? "");
      if (value.includes("HYPERLINK")) {
        found = true;
        assert.ok(value.startsWith("'"), "the formula character is neutralized");
      }
    });
    assert.ok(found, "the injected organization name reached the workbook");
    const parts = await workbookParts(xlsx.bytes);
    for (const [name, xml] of Object.entries(parts))
      if (name.endsWith(".xml"))
        assert.equal(/<f[ >]/.test(xml), false, `formula in ${name}`);
    await f.operator.query("update core.organization set name_ar=$2 where id=$1", [
      f.orgA,
      "منظمة تجريبية أ",
    ]);
  });

  await t.test("the Arabic workbook is right to left and typed", async () => {
    const xlsx = await bytesOf(`organizations/${f.orgA}/reports/${jobs["xlsx-ar"]}/download`);
    const parts = await workbookParts(xlsx.bytes);
    const sheets = Object.keys(parts).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    assert.equal(sheets.length, 7);
    for (const name of sheets)
      assert.match(parts[name], /rightToLeft="1"/, `${name} is not RTL`);

    const english = await bytesOf(`organizations/${f.orgA}/reports/${jobs["xlsx-en"]}/download`);
    const englishParts = await workbookParts(english.bytes);
    for (const name of Object.keys(englishParts).filter((n) =>
      /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
    ))
      assert.equal(/rightToLeft="1"/.test(englishParts[name]), false);
  });

  await t.test("consultant commentary is labelled and never merged into a finding", async () => {
    const xlsx = await bytesOf(`organizations/${f.orgA}/reports/${jobs["xlsx-ar"]}/download`);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(xlsx.bytes as unknown as ArrayBuffer);
    const sheet = book.worksheets[4];
    const headers = sheet.getRow(1).values as unknown[];
    assert.ok(
      headers.filter((h) => String(h ?? "").includes("تعليق الاستشاري")).length >= 4,
      "commentary has its own labelled columns",
    );
    let noteCell: string | null = null,
      findingText = "";
    sheet.eachRow((row, index) => {
      if (index <= 2) return;
      findingText += String(row.getCell(5).value ?? "");
      const note = String(row.getCell(14).value ?? "");
      if (note.includes("ملاحظة استشارية")) noteCell = note;
    });
    assert.ok(noteCell, "the consultant note reached its own column");
    assert.equal(findingText.includes("ملاحظة استشارية"), false);

    // Arabic extracts from a PDF as a visually ordered glyph stream, so phrase
    // matching there tests the extractor rather than the document. The content
    // of the rendered file is asserted where it is exact: the frozen source the
    // renderer was handed, projected through the same model it printed, and the
    // HTML that model produces.
    const model = await renderedModel(jobs["pdf-ar"]);
    const finding = model.recommendations[0];
    assert.ok(finding.commentary, "the commentary reached the document");
    assert.equal(finding.commentary.notes, CONSULTANT_NOTE);
    assert.equal(finding.commentary.statusLabel, "قيد التنفيذ");
    for (const computed of [finding.title, finding.body, finding.action, finding.rationale])
      assert.equal(computed.includes("ملاحظة استشارية"), false);
    const html = reportHtml(model, "");
    // The page labels it and disclaims it, in that order, before the note.
    const label = html.indexOf("تعليق الاستشاري"),
      disclaimer = html.indexOf("رأي بشري"),
      note = html.indexOf("ملاحظة استشارية");
    assert.ok(label > 0 && disclaimer > label && note > disclaimer);
  });

  await t.test("history and the reviewed comparison travel into the report", async () => {
    const model = await renderedModel(jobs["pdf-ar"]);
    // Two released rounds, one connected trend, and every plotted point equal
    // to the value its own release published.
    assert.ok(model.history.length >= 1);
    const overall = model.history.find((trend) => trend.points.length === 2);
    assert.ok(overall, "the trend spans both rounds");
    assert.equal(overall.points.filter((point) => point.numeric !== null).length, 2);
    assert.ok(model.comparison, "the reviewed comparison reached the document");
    assert.equal(model.comparison.classificationLabel, "الإصدار نفسه");
    assert.ok(model.comparison.rows.length > 0);
    // A changed population is declared rather than smoothed over.
    assert.ok(
      model.comparison.caveats.some((c) => c.includes("اختلف عدد المساهمين")),
      "the contributor-count caveat is printed",
    );
    // Every comparable row's endpoints are the two releases' own numbers.
    for (const row of model.comparison.rows)
      if (row.pointNumeric !== null)
        assert.ok(
          Math.abs(row.laterNumeric! - row.earlierNumeric! - row.pointNumeric) < 0.05,
          `${row.label} ${row.earlier} -> ${row.later} = ${row.pointChange}`,
        );
    assert.ok(reportHtml(model, "").includes("المقارنة بين جولتين"));

    // A report without a comparison says so instead of leaving the reader to
    // guess whether one was omitted or was empty.
    const plain = await renderedModel(jobs["pdf-first"]);
    assert.equal(plain.comparison, null);
    assert.ok(reportHtml(plain, "").includes("لم تُطلب مقارنة"));

    // A comparison belonging to another series or organization is refused.
    const refused = await deny(
      `organizations/${f.orgB}/reports`,
      post({ roundId: second.roundId, format: "XLSX", locale: "ar", comparisonId }),
      otherToken,
    );
    assert.match(refused, /NOT_FOUND/);
  });

  await t.test("named participation lists stay a separate file and a separate right", async () => {
    const created = await call(
      `organizations/${f.orgA}/participation-exports`,
      post({ campaignId: second.campaignId }),
    );
    assert.equal(created.status, 201);
    assert.equal(created.data.itemCount, 14);
    const download = await bytesOf(
      `organizations/${f.orgA}/participation-exports/${created.data.exportId}/download`,
    );
    const csv = download.bytes.toString("utf8");
    assert.equal(download.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.ok(csv.includes("مشارك 1"), "the named list carries names");
    // …and nothing else. No response identifier, no score, no result.
    for (const forbidden of ["responseId", "response_id", "score", "snapshot", "metric"])
      assert.equal(csv.includes(forbidden), false, forbidden);
    assert.equal(csv.includes(String(second.snapshotId)), false);

    // The assessment report is the mirror image: it carries no name.
    const xlsx = await bytesOf(`organizations/${f.orgA}/reports/${jobs["xlsx-ar"]}/download`);
    const parts = await workbookParts(xlsx.bytes);
    const whole = Object.values(parts).join("\n");
    for (let i = 1; i <= 12; i++)
      assert.equal(whole.includes(`مشارك ${i}`), false, `participant ${i}`);
    assert.equal(whole.includes("INV-"), false, "no invitation reference");
    const pdfText = (
      await readPdf(
        (await bytesOf(`organizations/${f.orgA}/reports/${jobs["pdf-ar"]}/download`)).bytes,
      )
    ).text.normalize("NFKC");
    for (let i = 1; i <= 12; i++)
      assert.equal(pdfText.includes(`مشارك ${i}`), false, `participant ${i} in the PDF`);

    // The two artifacts live in different prefixes under different keys.
    assert.ok(
      (
        await f.operator.query(
          "select storage_key from ops.private_export where id=$1",
          [created.data.exportId],
        )
      ).rows[0].storage_key.startsWith("participation-exports/"),
    );
    assert.ok(
      (
        await f.operator.query("select storage_key from ops.report_job where id=$1", [
          jobs["xlsx-ar"],
        ])
      ).rows[0].storage_key.startsWith("reports/"),
    );

    // Neither capability substitutes for the other.
    const noExport = randomUUID();
    await f.operator.query(
      "insert into access.staff_user(id,issuer,provider_subject,email,display_name,role,status) values($1,$2,'reporter','reporter@example.invalid','مُعد التقارير','STAFF','ACTIVE')",
      [noExport, process.env.OIDC_ISSUER],
    );
    await f.operator.query("insert into access.organization_access values($1,$2)", [
      noExport,
      f.orgA,
    ]);
    for (const capability of ["results.read", "reports.manage"])
      await f.operator.query(
        "insert into access.staff_capability(staff_user_id,capability) values($1,$2)",
        [noExport, capability],
      );
    const reporter = await f.session("reporter");
    assert.match(
      await deny(
        `organizations/${f.orgA}/participation-exports`,
        post({ campaignId: second.campaignId }),
        reporter,
      ),
      /FORBIDDEN/,
    );
    assert.equal((await call(`organizations/${f.orgA}/reports`, undefined, reporter)).status, 200);
  });

  await t.test("the renderer credential cannot read a person, an answer or a table", async () => {
    await reportReadiness();
    const worker = new pg.Client({ connectionString: f.fixture.url("orgfit_report") });
    await worker.connect();
    try {
      for (const statement of [
        "select * from core.participant limit 1",
        "select * from core.invitation limit 1",
        "select * from ops.report_job limit 1",
        "select * from publication.aggregate_cell limit 1",
        "select * from publication.result_snapshot limit 1",
        "select * from intake.respondent_session limit 1",
        "select * from instrument.questionnaire_version limit 1",
        "select * from access.staff_user limit 1",
        "select publication.snapshot($1::uuid)",
        "select core.participation_export_rows($1::uuid,$1::uuid)",
      ]) {
        const denied = await failure(() =>
          worker.query(statement, statement.includes("$1") ? [f.orgA] : []),
        );
        assert.notEqual(denied, "NO_ERROR", statement);
      }
      const priv = await worker.query(
        "select count(*)::int as n from information_schema.table_privileges where grantee='orgfit_report'",
      );
      assert.equal(priv.rows[0].n, 0);
    } finally {
      await worker.end();
    }
    // And it holds no CONNECT on the anonymous answer database at all.
    const anonUrl = new URL(f.fixture.anonymousUrl("orgfit_report"));
    const refused = await failure(async () => {
      const client = new pg.Client({ connectionString: anonUrl.href });
      await client.connect();
      await client.end();
    });
    assert.notEqual(refused, "NO_ERROR");

    // A renderer process that somehow holds a staff, processor or private-file
    // credential refuses to start rather than running with it.
    for (const key of [
      "DATABASE_URL",
      "PROCESSOR_DATABASE_URL",
      "IMPORT_ENCRYPTION_KEY",
      "PARTICIPATION_EXPORT_ENCRYPTION_KEY",
      "CAMPAIGN_KEY_CUSTODY_SECRET_KEY",
    ])
      assert.equal(
        await failure(async () => assertNoForeignCredentials({ [key]: "x" })),
        "TEMPORARILY_UNAVAILABLE",
        key,
      );
    assert.equal(await failure(async () => assertNoForeignCredentials({})), "NO_ERROR");
  });

  await t.test("a failed job retries idempotently and never doubles an artifact", async () => {
    const created = await request({
      roundId: first.roundId,
      format: "XLSX",
      locale: "en",
      comparisonId: null,
    });
    const jobId = created.data.id as string;
    const db = reportPool();
    // First attempt fails somewhere in the middle.
    const claimed = await claimReportJobs(db, 10);
    assert.ok(claimed.some((j) => j.id === jobId));
    const failedState = await db.query<{ state: string }>(
      "select publication.fail_report_job($1,'RENDER_FAILED') as state",
      [jobId],
    );
    assert.equal(failedState.rows[0].state, "QUEUED");
    // Any other job this claim swept up is released the same way, so the retry
    // below sees a queue in a known state.
    for (const job of claimed)
      if (job.id !== jobId)
        await db.query("select publication.fail_report_job($1,'RENDER_FAILED')", [job.id]);

    const retried = await renderDueReports(db, 10);
    const outcome = retried.find((o) => o.jobId === jobId)!;
    assert.equal(outcome.state, "READY");
    const row = await f.operator.query(
      "select attempt, state, content_hash, storage_key from ops.report_job where id=$1",
      [jobId],
    );
    assert.equal(row.rows[0].state, "READY");
    assert.equal(row.rows[0].attempt, 2);

    // A duplicated delivery of an already finished job keeps the bytes staff may
    // already hold, and says so.
    const again = await db.query<{ state: string }>(
      "select publication.complete_report_job($1,$2,$3,$4,$5,$6::interval) as state",
      [jobId, "reports/forged", 10, createHash("sha256").update("x").digest(), 1, "1 hour"],
    );
    assert.equal(again.rows[0].state, "REUSED");
    const unchanged = await f.operator.query(
      "select content_hash, storage_key from ops.report_job where id=$1",
      [jobId],
    );
    assert.deepEqual(unchanged.rows[0], row.rows[0] && {
      content_hash: row.rows[0].content_hash,
      storage_key: row.rows[0].storage_key,
    });

    // A job exhausted of attempts becomes FAILED rather than looping forever.
    const doomed = await request({
      roundId: first.roundId,
      format: "XLSX",
      locale: "ar",
      comparisonId: null,
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await db.query("select publication.claim_report_jobs(10)");
      await db.query("select publication.fail_report_job($1,'RENDER_FAILED')", [
        doomed.data.id,
      ]);
    }
    const dead = await f.operator.query("select state, failure_code from ops.report_job where id=$1", [
      doomed.data.id,
    ]);
    assert.equal(dead.rows[0].state, "FAILED");
    assert.equal(dead.rows[0].failure_code, "RENDER_FAILED");
    assert.match(
      await deny(`organizations/${f.orgA}/reports/${doomed.data.id}/download`),
      /NOT_FOUND/,
    );
    // Everything else the sweeps above touched is put back to work.
    await renderDueReports(db, 10);
  });

  await t.test("a download expires, and expiry retires the artifact", async () => {
    const created = await request({
      roundId: first.roundId,
      format: "XLSX",
      locale: "en",
      comparisonId: null,
    });
    const jobId = created.data.id as string;
    const db = reportPool();
    await db.query("select publication.claim_report_jobs(10)");
    await db.query(
      "select publication.complete_report_job($1,$2,$3,$4,$5,$6::interval)",
      [jobId, `reports/${f.orgA}/${jobId}.bin`, 20, createHash("sha256").update("y").digest(), 1, "1 second"],
    );
    assert.equal((await call(`organizations/${f.orgA}/reports`)).status, 200);
    await wait(1300);
    assert.match(
      await deny(`organizations/${f.orgA}/reports/${jobId}/download`),
      /IMPORT_EXPIRED/,
    );
    const expired = await db.query<{ data: { id: string }[] }>(
      "select publication.expire_report_jobs(100) as data",
    );
    assert.ok(expired.rows[0].data.some((row) => row.id === jobId));
    assert.match(await deny(`organizations/${f.orgA}/reports/${jobId}/download`), /NOT_FOUND/);
    // Anything else the claim swept up is released back to the queue.
    await renderDueReports(db, 10);
  });

  await t.test("access is decided at download time, not at request time", async () => {
    // Another organization's staff can neither list, request nor download.
    assert.match(
      await deny(`organizations/${f.orgA}/reports`, undefined, otherToken),
      /NOT_FOUND/,
    );
    assert.match(
      await deny(
        `organizations/${f.orgA}/reports/${jobs["xlsx-ar"]}/download`,
        undefined,
        otherToken,
      ),
      /NOT_FOUND/,
    );
    // Nor by naming their own organization and someone else's job.
    assert.match(
      await deny(
        `organizations/${f.orgB}/reports/${jobs["xlsx-ar"]}/download`,
        undefined,
        otherToken,
      ),
      /NOT_FOUND/,
    );

    // A staff member who loses the capability after the job was created loses
    // the download with it, even though the artifact is still READY.
    await f.operator.query(
      "delete from access.staff_capability where staff_user_id=$1 and capability='reports.manage'",
      [ids.staff],
    );
    const reduced = await f.session("staff");
    assert.match(
      await deny(
        `organizations/${f.orgA}/reports/${jobs["xlsx-ar"]}/download`,
        undefined,
        reduced,
      ),
      /FORBIDDEN/,
    );
    await f.operator.query(
      "insert into access.staff_capability(staff_user_id,capability) values($1,'reports.manage')",
      [ids.staff],
    );
    staff = await f.session("staff");
    assert.equal(
      (await bytesOf(`organizations/${f.orgA}/reports/${jobs["xlsx-ar"]}/download`)).status,
      200,
    );
  });

  await t.test("only a published release is reportable, and a revoked one stops", async () => {
    // An unreleased round has no report to request.
    const draftRound = (await withStaff(staff, (tx) =>
      saveRound(
        tx,
        f.orgA,
        null,
        null,
        {
          seriesId: f.seriesId,
          label: "جولة غير منشورة",
          periodStart: "2027-01-01",
          questionnaireVersionId: versionId,
          populationDefinition: { schemaVersion: 1 },
        },
        randomUUID(),
      ),
    )) as { id: string };
    assert.match(
      await deny(
        `organizations/${f.orgA}/reports`,
        post({ roundId: draftRound.id, format: "PDF", locale: "ar", comparisonId: null }),
      ),
      /NOT_FOUND/,
    );

    // A release revoked after an artifact was rendered stops being downloadable
    // even though the bytes still exist.
    await f.operator.query(
      "update publication.result_snapshot set state='REVOKED', revoked_reason='اختبار السحب' where id=$1",
      [second.snapshotId],
    );
    assert.match(
      await deny(`organizations/${f.orgA}/reports/${jobs["pdf-ar"]}/download`),
      /RESULTS_UNAVAILABLE/,
    );
  });

  await t.test("participation CSV neutralizes formulas and carries no result", () => {
    const csv = participationCsv([
      {
        displayReference: "INV-0000000000000001",
        displayName: INJECTION,
        privateReference: "A-1",
        department: "الهندسة",
        departmentCode: "ENG",
        status: "COMPLETED",
        issued: true,
      },
    ]);
    // The CSV doubles its own quotes, so the neutralized cell is the injected
    // text with a leading apostrophe and escaped quoting around it.
    assert.ok(csv.includes(String.raw`"'=HYPERLINK(""http://attacker.invalid""`));
    assert.equal(csv.includes("score"), false);
  });

});
