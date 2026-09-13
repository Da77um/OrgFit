import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  tr,
  type Instrument,
} from "../src/instrument-input";
import { exchange, instrument, finalize } from "../src/respondent";
import { processCampaign } from "../src/processor";
import { releaseCampaign } from "../src/publication";
import { scoreInstrument, ENGINE_VERSION } from "../src/scoring";
import { N } from "../src/score-number";
import { resultsRoute } from "../src/results";
import { historyRoute } from "../src/history";
import { reportRoute } from "../src/reports";
import { configureReport, reportPool, closeReportPool } from "../src/report-db";
import { renderDueReports } from "../src/report-worker";
import { buildReportModel, type ReportSource, type ReportModel } from "../src/report-model";
import { reportHtml } from "../src/report-html";
import { respondentFixture, failure, wait, type Fixture } from "./respondent-fixture";

// ---------------------------------------------------------------------------
// CHECKPOINT E — blocking history and report consistency gate.
//
// Adversarial and independent of the Phase 10 and Phase 11 suites. Those asked
// "does the comparison apply its rules" and "does the renderer produce a file".
// This one starts from the reader's side and asks what a person holding the
// PUBLISHED ARTIFACTS can work out, and whether the four surfaces — dashboard,
// history, PDF and workbook — ever disagree about one disclosed fact.
//
// The prompt's five cases are built as one real series so that the trend must
// survive a mid-series break rather than merely end at one:
//
//   R1  V1   12 contributors, departments A and B          comparable baseline
//   R2  V1   13 contributors (A gains one), B renamed      comparable, +1 person
//   R3  V2   13 contributors, an item re-specified         INCOMPATIBLE
//   R4  V3   12 contributors, B dropped and D added        translation-only,
//                                                          department reorganization
//   R6  V1   14 contributors (B gains one)                 comparable, +2 from R1
//   R5  V1    4 contributors                               SPARSE, never released
//
// V3 also carries deliberately long Arabic labels, so the long-Arabic report is
// the reorganization report rather than a sixth campaign.
// ---------------------------------------------------------------------------

const LONG_AR =
  "إدارة التطوير التنظيمي والتخطيط الاستراتيجي وتحسين تجربة الموظفين والاتصال الداخلي" +
  " ومتابعة مبادرات التحول المؤسسي في جميع الفروع والمواقع التشغيلية التابعة للمنظمة";

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
  for (let page = 1; page <= doc.numPages; page++)
    text +=
      (await (await doc.getPage(page)).getTextContent()).items
        .map((i) => i.str ?? "")
        .join("") + "\n";
  return { pages: doc.numPages, text };
}
const unmapped = (text: string) =>
  [...text].filter((c) => c.charCodeAt(0) === 0).length;
const arabicGlyphs = (text: string) =>
  [...text].filter((c) => {
    const code = c.codePointAt(0) ?? 0;
    return (code >= 0x0600 && code <= 0x06ff) || (code >= 0xfb50 && code <= 0xfefc);
  }).length;

async function workbookParts(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const parts: Record<string, string> = {};
  for (const name of Object.keys(zip.files))
    if (!zip.files[name].dir) parts[name] = await zip.files[name].async("string");
  return parts;
}

test("Checkpoint E: history and report consistency gate", async (t) => {
  const f: Fixture = await respondentFixture(12);
  Object.assign(process.env, {
    REPORT_ENCRYPTION_KEY: "e".repeat(64),
    REPORT_LOCAL_DIRECTORY: `work/reports-e-${randomUUID()}`,
    PARTICIPATION_EXPORT_ENCRYPTION_KEY: "f".repeat(64),
    PARTICIPATION_EXPORT_LOCAL_DIRECTORY: `work/participation-e-${randomUUID()}`,
  });
  delete process.env.REPORT_DATABASE_URL;
  configureReport(f.fixture.url("orgfit_report"));

  const core = new pg.Pool({ connectionString: f.fixture.url("orgfit_processor"), max: 4 });
  const anon = new pg.Pool({ connectionString: f.fixture.anonymousUrl("orgfit_processor"), max: 4 });
  t.after(async () => {
    await closeReportPool();
    configureReport(undefined);
    await core.end();
    await anon.end();
    await f.close();
  });

  const staff = f.staff;
  const route = async (
    handler: typeof reportRoute,
    target: string,
    init?: RequestInit,
    token = staff,
  ) => {
    const [path] = target.split("?");
    const request = new Request(`http://127.0.0.1:3000/api/v1/${target}`, init);
    return withStaff(token, (tx) => handler(request, path, tx));
  };
  const call = async (
    handler: typeof reportRoute,
    target: string,
    init?: RequestInit,
    token = staff,
  ) => {
    const res = await route(handler, target, init, token);
    assert.ok(res, `${target} is not a route`);
    return { status: res.status, data: (await res.json()).data };
  };
  const bytesOf = async (target: string, token = staff) => {
    const res = await route(reportRoute, target, undefined, token);
    assert.ok(res);
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  };
  const deny = (
    handler: typeof reportRoute,
    target: string,
    init?: RequestInit,
    token = staff,
  ) =>
    failure(async () => {
      const res = await route(handler, target, init, token);
      if (!res) throw new Error("NO_ROUTE");
      return res;
    });
  const post = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify(body),
  });

  // ---- instrument versions -------------------------------------------------
  const questionnaireId = (
    await f.operator.query(
      "select questionnaire_id from instrument.questionnaire_version where id=$1",
      [f.coverageVersionId],
    )
  ).rows[0].questionnaire_id as string;

  async function newVersion(patch: (d: Instrument) => void) {
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
    patch(document);
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

  const V1 = f.coverageVersionId;
  // A RE-SPECIFIED item: the same question now scores in reverse. Nothing
  // translated changed, so only a fingerprint can tell these two apart.
  const V2 = await newVersion((d) => {
    const q = d.sections
      .flatMap((s) => s.questions)
      .find((x) => x.type === "RATING_5")!;
    q.scoring = { ...q.scoring, reverse: true };
  });
  // A TRANSLATION-ONLY revision carrying deliberately long Arabic labels.
  const V3 = await newVersion((d) => {
    d.dimensions[0].name = tr(`${LONG_AR} — البُعد`, "Dimension");
    d.dimensions[0].description = tr(LONG_AR, "Description");
    for (const q of d.sections.flatMap((s) => s.questions))
      q.prompt = tr(`${LONG_AR} — ${q.prompt.ar}`, q.prompt.en ?? "");
  });

  // ---- people --------------------------------------------------------------
  const deptA = f.people.filter((_, i) => i % 2 === 0);
  const thirteenth = randomUUID();
  await f.operator.query(
    "insert into core.participant(id,organization_id,private_reference,display_name,department_id) values($1,$2,'E-13','مشارك ثالث عشر',$3)",
    [thirteenth, f.orgA, f.departmentA],
  );
  const fourteenth = randomUUID();
  await f.operator.query(
    "insert into core.participant(id,organization_id,private_reference,display_name,department_id) values($1,$2,'E-14','مشارك رابع عشر',$3)",
    [fourteenth, f.orgA, f.departmentB],
  );
  const departmentD = randomUUID();
  await f.operator.query(
    "insert into core.department(id,organization_id,code,name_ar) values($1,$2,'EDPT',$3)",
    [departmentD, f.orgA, LONG_AR],
  );
  const deptD: string[] = [];
  for (let i = 0; i < 6; i++) {
    const id = randomUUID();
    deptD.push(id);
    await f.operator.query(
      "insert into core.participant(id,organization_id,private_reference,display_name,department_id) values($1,$2,$3,$4,$5)",
      [id, f.orgA, `E-D${i}`, `مشارك د ${i + 1}`, departmentD],
    );
  }
  const sparse: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = randomUUID();
    sparse.push(id);
    await f.operator.query(
      "insert into core.participant(id,organization_id,private_reference,display_name,department_id) values($1,$2,$3,$4,$5)",
      [id, f.orgA, `E-S${i}`, `مشارك قليل ${i + 1}`, f.departmentA],
    );
  }

  // ---- rounds --------------------------------------------------------------
  type Round = { roundId: string; campaignId: string; snapshotId: string | null; state: string };
  const documents: Instrument[] = [];
  async function releasedRound(
    versionId: string,
    periodStart: string,
    people: string[],
    label: string,
  ): Promise<Round> {
    const round = (await withStaff(staff, (tx) =>
      saveRound(
        tx,
        f.orgA,
        null,
        null,
        {
          seriesId: f.seriesId,
          label,
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
    // Seed i for link i, in every round. Two rounds of the same version and the
    // same seeds therefore share an answer multiset exactly — which is the
    // stable population an adversary would assume, and the worst case.
    for (let i = 0; i < links.length; i++) {
      const opened = await exchange(links[i].token);
      const document = (await instrument(opened.session!)).document;
      if (versionId === V1 && documents.length <= i) documents[i] = document;
      await finalize(opened.session!, { answers: answersFor(document, i) });
    }
    await f.closeCampaign(campaign.id);
    await processCampaign(core, anon, campaign.id);
    const outcome = await releaseCampaign(core, anon, campaign.id);
    return {
      roundId: round.id,
      campaignId: campaign.id,
      snapshotId: outcome.snapshotId,
      state: outcome.state,
    };
  }

  const R1 = await releasedRound(V1, "2026-01-01", f.people, "جولة يناير");
  assert.equal(R1.state, "PUBLISHED");

  // The department reorganization begins here: B is renamed BEFORE R2 launches,
  // so the two rounds freeze different labels for the same department.
  await f.operator.query("update core.department set name_ar=$2 where id=$1", [
    f.departmentB,
    `${LONG_AR} — العمليات`,
  ]);
  const R2 = await releasedRound(V1, "2026-04-01", [...f.people, thirteenth], "جولة أبريل");
  assert.equal(R2.state, "PUBLISHED");

  const R3 = await releasedRound(V2, "2026-07-01", [...f.people, thirteenth], "جولة يوليو");
  assert.equal(R3.state, "PUBLISHED");

  const R4 = await releasedRound(V3, "2026-10-01", [...deptA, ...deptD], "جولة أكتوبر");
  assert.equal(R4.state, "PUBLISHED");

  // The same population as R2 plus one more person: R1→R6 differs by two
  // contributors and R2→R6 by one, so the chain isolates each newcomer.
  const R6 = await releasedRound(
    V1,
    "2026-11-01",
    [...f.people, thirteenth, fourteenth],
    "جولة نوفمبر",
  );
  assert.equal(R6.state, "PUBLISHED");

  const R5 = await releasedRound(V1, "2027-01-01", sparse, "جولة قليلة");
  assert.equal(R5.state, "INSUFFICIENT_DATA");
  assert.equal(R5.snapshotId, null);

  // ---- helpers over the four surfaces --------------------------------------
  const dashboard = async (roundId: string, view = "overview") => {
    const path = `organizations/${f.orgA}/assessments/${roundId}/results${view === "overview" ? "" : `/${view}`}`;
    const res = await withStaff(staff, (tx) =>
      resultsRoute(new Request(`http://127.0.0.1:3000/api/v1/${path}`), path, tx),
    );
    assert.ok(res);
    return (await res.json()).data as {
      companyGroupKey: string;
      contributorCount?: number;
      generatedAt?: string;
      versions?: Record<string, string>;
      period?: Record<string, string | null>;
      metrics: { key: string; kind: string; label: { ar: string }; direction: string | null }[];
      groups: { key: string; kind: string; label: { ar: string } }[];
      cells: {
        groupKey: string;
        metricKey: string;
        status: string;
        reasonCode: string | null;
        value: string | null;
        contributorCount: number | null;
        band: { label: { ar: string } } | null;
      }[];
    };
  };
  const history = async () =>
    (
      await call(historyRoute, `organizations/${f.orgA}/history/${f.seriesId}`)
    ).data as {
      rounds: { roundId: string; label: string; releaseState: string | null; periodStart: string }[];
      trends: {
        metricKey: string;
        points: {
          roundId: string;
          value: string | null;
          status: string;
          reasonCode: string | null;
          contributorCount: number | null;
        }[];
      }[];
    };
  const requestReport = async (body: Record<string, unknown>) =>
    (await call(reportRoute, `organizations/${f.orgA}/reports`, post(body))).data as {
      id: string;
    };
  const renderedModel = async (jobId: string): Promise<ReportModel> => {
    const { rows } = await f.operator.query("select source from ops.report_job where id=$1", [
      jobId,
    ]);
    return buildReportModel(rows[0].source as ReportSource);
  };

  // ---- reviewed comparisons ------------------------------------------------
  const proposalFor = async (left: string, right: string) =>
    (
      await call(
        historyRoute,
        `organizations/${f.orgA}/comparisons/proposal?left=${left}&right=${right}`,
      )
    ).data as {
      identicalVersion: boolean;
      suggestion: string;
      pairs: { leftKey: string; rightKey: string; equivalent: boolean }[];
    };
  const saveComparison = async (
    left: string,
    right: string,
    classification: string,
    mapping: { leftKey: string; rightKey: string }[],
  ) =>
    (
      await call(
        historyRoute,
        `organizations/${f.orgA}/comparisons`,
        post({
          leftRoundId: left,
          rightRoundId: right,
          classification,
          mapping,
          rationale: "مراجعة نقطة تفتيش هاء.",
        }),
      )
    ).data as { id: string };

  const p12 = await proposalFor(R1.roundId, R2.roundId);
  const C12 = (
    await saveComparison(
      R1.roundId,
      R2.roundId,
      "IDENTICAL",
      p12.pairs.filter((p) => p.equivalent).map((p) => ({ leftKey: p.leftKey, rightKey: p.rightKey })),
    )
  ).id;
  const p14 = await proposalFor(R1.roundId, R4.roundId);
  const C14 = (
    await saveComparison(
      R1.roundId,
      R4.roundId,
      "REVIEWED_EQUIVALENT",
      p14.pairs.filter((p) => p.equivalent).map((p) => ({ leftKey: p.leftKey, rightKey: p.rightKey })),
    )
  ).id;

  // ---- the artifacts under inspection --------------------------------------
  const jobs = {
    comparablePdf: await requestReport({
      roundId: R2.roundId,
      format: "PDF",
      locale: "ar",
      comparisonId: C12,
    }),
    reorganizationPdf: await requestReport({
      roundId: R4.roundId,
      format: "PDF",
      locale: "ar",
      comparisonId: C14,
    }),
    reorganizationXlsx: await requestReport({
      roundId: R4.roundId,
      format: "XLSX",
      locale: "ar",
      comparisonId: C14,
    }),
    incompatibleXlsx: await requestReport({
      roundId: R3.roundId,
      format: "XLSX",
      locale: "en",
      comparisonId: null,
    }),
  };
  const outcomes = await renderDueReports(reportPool(), 10);
  for (const outcome of outcomes)
    assert.equal(
      outcome.state,
      "READY",
      `${outcome.jobId} ${outcome.failureCode ?? ""} ${outcome.note ?? ""}`,
    );

  // =========================================================================
  // E-1 — the flagged risk: two releases differing by ONE contributor.
  // =========================================================================
  await t.test(
    "E-1 differencing: a single added contributor's own score is recoverable",
    async () => {
      const overallOf = async (round: { roundId: string }) => {
        const d = await dashboard(round.roundId);
        const key = d.metrics.find((m) => m.kind === "OVERALL")!.key;
        const cell = d.cells.find(
          (c) => c.metricKey === key && c.groupKey === d.companyGroupKey,
        )!;
        assert.equal(cell.status, "AVAILABLE");
        // The count is what makes the arithmetic possible, and it is published
        // beside the mean by design — a released mean discloses its sum.
        assert.ok(cell.contributorCount !== null);
        return { mean: N(cell.value!), n: cell.contributorCount! };
      };
      const one = await overallOf(R1),
        two = await overallOf(R2),
        six = await overallOf(R6);
      assert.deepEqual([one.n, two.n, six.n], [12, 13, 14]);

      // Independently: the two newcomers answered with seeds 12 and 13.
      const pin = { engineVersion: ENGINE_VERSION, configVersion: "checkpoint-e" };
      const trueScore = (seed: number) =>
        N(
          scoreInstrument(documents[0], answersFor(documents[0], seed), pin).overall!
            .normalized!.toFixed(6),
        );
      const thirteenthScore = trueScore(12),
        fourteenthScore = trueScore(13);

      // The subtraction any reader can perform with two results pages open. The
      // only thing standing between it and the exact value is the release's own
      // one-decimal rounding, whose worst case is amplified by both counts.
      const recover = (
        a: { mean: ReturnType<typeof N>; n: number },
        b: { mean: ReturnType<typeof N>; n: number },
      ) => ({
        sum: b.mean.mul(N(String(b.n))).sub(a.mean.mul(N(String(a.n)))),
        bound: (a.n + b.n) * 0.05,
        added: b.n - a.n,
      });
      const cases = [
        { label: "R1→R2 (+1)", got: recover(one, two), truth: thirteenthScore },
        { label: "R2→R6 (+1)", got: recover(two, six), truth: fourteenthScore },
        {
          label: "R1→R6 (+2)",
          got: recover(one, six),
          truth: thirteenthScore.add(fourteenthScore),
        },
      ];
      const observed: string[] = [];
      for (const c of cases) {
        const gap = Math.abs(Number(c.got.sum.sub(c.truth).format(6)));
        observed.push(
          `${c.label}: recovered ${c.got.sum.format(2)} vs true ${c.truth.format(2)}, gap ${gap.toFixed(2)} of a permitted ${c.got.bound.toFixed(2)}`,
        );
        // THE FINDING, stated as a measurement rather than as a pass or a fail:
        // the published means and counts of two overlapping releases determine
        // the added contributors' own scores to within the rounding bound. On a
        // 0–100 scale that is an interval of about ±1.3 points for one person.
        assert.ok(
          gap <= c.got.bound,
          `${c.label} did not recover: gap ${gap} > bound ${c.got.bound}`,
        );
      }
      // Two added people are recovered as a sum, and the intermediate release
      // then separates them: a series of releases isolates each newcomer.
      const chained = cases[0].got.sum.add(cases[1].got.sum);
      assert.ok(
        Math.abs(Number(chained.sub(cases[2].got.sum).format(6))) <=
          cases[0].got.bound + cases[1].got.bound + cases[2].got.bound,
      );

      // Worse, and this part IS created by the comparison surface rather than
      // inherited from two dashboards: a single comparison ROW carries every
      // term of the equation — both values and both contributor counts — for a
      // DEPARTMENT, where the counts are smaller and the recovery is tighter.
      const comparison = (
        await call(historyRoute, `organizations/${f.orgA}/comparisons/${C12}`)
      ).data as {
        cells: {
          metricKey: string;
          groupKey: string;
          status: string;
          left: { value: string | null; contributorCount: number | null } | null;
          right: { value: string | null; contributorCount: number | null } | null;
        }[];
      };
      const april = await dashboard(R2.roundId);
      const overallKey = april.metrics.find((m) => m.kind === "OVERALL")!.key;
      const departmentRows = comparison.cells.filter(
        (c) =>
          c.metricKey === overallKey &&
          c.groupKey !== april.companyGroupKey &&
          c.status === "COMPARABLE" &&
          c.left?.contributorCount !== c.right?.contributorCount,
      );
      // The department that gained the thirteenth person is exactly one row.
      assert.equal(departmentRows.length, 1, "the grown department is one row");
      const row = departmentRows[0];
      const isolated = N(row.right!.value!)
        .mul(N(String(row.right!.contributorCount!)))
        .sub(N(row.left!.value!).mul(N(String(row.left!.contributorCount!))));
      const departmentBound =
        (row.left!.contributorCount! + row.right!.contributorCount!) * 0.05;
      const departmentGap = Math.abs(
        Number(isolated.sub(thirteenthScore).format(6)),
      );
      observed.push(
        `department row (${row.left!.contributorCount}→${row.right!.contributorCount}): recovered ${isolated.format(2)} vs true ${thirteenthScore.format(2)}, gap ${departmentGap.toFixed(2)} of a permitted ${departmentBound.toFixed(2)}`,
      );
      assert.ok(
        departmentGap <= departmentBound,
        `department recovery failed: ${departmentGap} > ${departmentBound}`,
      );
      // Smaller groups mean a tighter interval, so the department row is the
      // sharper channel, not the safer one.
      assert.ok(departmentBound < cases[0].got.bound);

      // Nothing in the product prevents this, and the comparison feature is not
      // what enables it: two independent results pages are enough. The owner
      // accepted it rather than restricting what a round may publish (P-009),
      // so what is REQUIRED is that the product says the actual thing, where
      // the reader is, and only when the reader is in the sharp case.
      process.stdout.write(`    E-1 recovery: ${observed.join(" | ")}\n`);

      const model = await renderedModel(jobs.comparablePdf.id);

      // The standing limitation states the consequence rather than hedging it.
      const differencing = model.limitations.find((line) =>
        line.includes("طرح نتائج جولتين"),
      );
      assert.ok(differencing, "the differencing limitation is printed");
      assert.ok(
        differencing.includes("نتيجته الفردية"),
        "the limitation names the consequence: an individual result is derivable",
      );

      // And the comparison itself declares the sharp case where it applies.
      assert.ok(
        model.comparison!.caveats.some((c) => c.includes("اختلف عدد المساهمين")),
        "the changed-population caveat is printed",
      );
      assert.ok(
        model.comparison!.caveats.some((c) => c.includes("النتيجة الفردية لمن انضم")),
        "the small-population-change caveat is printed",
      );

      // The staff screen the consultant actually reads carries the same code.
      const onScreen = (
        await call(historyRoute, `organizations/${f.orgA}/comparisons/${C12}`)
      ).data as { populationCaveats: string[] };
      assert.ok(onScreen.populationCaveats.includes("POPULATION_CHANGE_SMALL"));
    },
  );

  // =========================================================================
  // E-2 — the comparison adds no channel the two dashboards did not have.
  // =========================================================================
  await t.test(
    "E-2 a comparison publishes no cell, count or partition beyond its two releases",
    async () => {
      const comparison = (
        await call(historyRoute, `organizations/${f.orgA}/comparisons/${C12}`)
      ).data as {
        left: { contributorCount: number; threshold: number };
        right: { contributorCount: number; threshold: number };
        cells: {
          status: string;
          left: { status: string; value: string | null; contributorCount: number | null } | null;
          right: { status: string; value: string | null; contributorCount: number | null } | null;
          pointChange: string | null;
        }[];
      };
      const published = new Set<string>();
      for (const round of [R1, R2]) {
        const data = await dashboard(round.roundId);
        const departments = await dashboard(round.roundId, "departments");
        for (const cell of [...data.cells, ...departments.cells])
          if (cell.value !== null) published.add(`${cell.metricKey}=${cell.value}`);
      }
      for (const cell of comparison.cells) {
        for (const side of [cell.left, cell.right])
          if (side && side.value !== null)
            assert.ok(
              [...published].some((p) => p.endsWith(`=${side.value}`)),
              `${side.value} is not a value either dashboard published`,
            );
        // A withheld side carries nothing at all, and never a difference.
        for (const side of [cell.left, cell.right])
          if (side && side.status !== "AVAILABLE") {
            assert.equal(side.value, null);
            assert.equal(side.contributorCount, null);
          }
        if (cell.status !== "COMPARABLE") assert.equal(cell.pointChange, null);
      }
    },
  );

  // =========================================================================
  // E-3 — incompatible data cannot appear as a valid trend or a delta.
  // =========================================================================
  await t.test(
    "E-3 an incompatible round breaks the trend, and no review can make it a delta",
    async () => {
      const series = await history();
      const overall = series.trends.find((t) =>
        t.points.every((p) => p.roundId !== undefined),
      )!;
      const point = (roundId: string) =>
        overall.points.find((p) => p.roundId === roundId)!;

      // R1, R2 and R4 share a measurement; R3 does not, and R5 was never
      // released. The break sits in the MIDDLE of the series and the trend
      // resumes after it — a break is not the end of a history.
      assert.equal(point(R1.roundId).status, "COMPARABLE");
      assert.equal(point(R2.roundId).status, "COMPARABLE");
      assert.equal(point(R3.roundId).status, "NOT_COMPARABLE");
      assert.equal(point(R3.roundId).reasonCode, "MEASUREMENT_CHANGED");
      assert.equal(point(R3.roundId).value, null);
      assert.equal(point(R3.roundId).contributorCount, null);
      assert.equal(point(R4.roundId).status, "COMPARABLE");
      assert.equal(point(R5.roundId).status, "GAP");
      assert.equal(point(R5.roundId).value, null);

      // The re-specified version cannot be declared identical, and its mapped
      // pairs cannot be accepted as equivalent.
      const proposal = await proposalFor(R1.roundId, R3.roundId);
      assert.equal(proposal.identicalVersion, false);
      const scored = proposal.pairs.filter((p) => p.equivalent);
      assert.match(
        await deny(
          historyRoute,
          `organizations/${f.orgA}/comparisons`,
          post({
            leftRoundId: R1.roundId,
            rightRoundId: R3.roundId,
            classification: "IDENTICAL",
            mapping: scored.map((p) => ({ leftKey: p.leftKey, rightKey: p.rightKey })),
            rationale: "محاولة إعلان تطابق",
          }),
        ),
        /VALIDATION_FAILED/,
      );
      // Even a REVIEWED_EQUIVALENT claim over the re-specified metric is refused
      // by the pinned definitions rather than trusted.
      const dimension = proposal.pairs.find((p) => p.leftKey.startsWith("dimension:"))!;
      assert.equal(dimension.equivalent, false);
      assert.match(
        await deny(
          historyRoute,
          `organizations/${f.orgA}/comparisons`,
          post({
            leftRoundId: R1.roundId,
            rightRoundId: R3.roundId,
            classification: "REVIEWED_EQUIVALENT",
            mapping: [{ leftKey: dimension.leftKey, rightKey: dimension.rightKey }],
            rationale: "محاولة إعلان تكافؤ",
          }),
        ),
        /MEASUREMENT_NOT_EQUIVALENT/,
      );

      // And the incompatible round's own report shows the break rather than a line.
      const model = await renderedModel(jobs.incompatibleXlsx.id);
      const trend = model.history.find((h) => h.points.length >= 4)!;
      const broken = trend.points.filter((p) => p.status === "NOT_COMPARABLE");
      assert.ok(broken.length >= 1);
      for (const p of broken) {
        assert.equal(p.value, null);
        assert.equal(p.numeric, null);
        assert.ok(p.reasonText.length > 0);
      }
      assert.equal(model.comparison, null);
    },
  );

  // =========================================================================
  // E-4 — department reorganization.
  // =========================================================================
  await t.test(
    "E-4 a reorganization pairs by lineage, keeps historic labels and declares what it cannot compare",
    async () => {
      const comparison = (
        await call(historyRoute, `organizations/${f.orgA}/comparisons/${C14}`)
      ).data as {
        populationCaveats: string[];
        left: { groups: { key: string; kind: string; label: { ar: string } }[] };
        right: { groups: { key: string; kind: string; label: { ar: string } }[] };
        groupMappings: { leftGroupKey: string; rightGroupKey: string; kind: string }[];
        cells: { groupLabel: { ar: string }; status: string }[];
      };
      // B has no counterpart in R4 and D has none in R1, and both are declared.
      assert.ok(comparison.populationCaveats.includes("GROUPS_ADDED"));
      assert.ok(comparison.populationCaveats.includes("GROUPS_REMOVED"));
      // Both rounds have twelve contributors, so the declared longitudinal
      // limit does not apply and is not raised. A caveat printed on every
      // comparison would declare nothing.
      assert.equal(
        comparison.populationCaveats.includes("POPULATION_CHANGE_SMALL"),
        false,
      );
      assert.equal(
        comparison.populationCaveats.includes("CONTRIBUTORS_CHANGED"),
        false,
      );
      // The department that survives is paired exactly once, by lineage.
      const departmentPairs = comparison.groupMappings.filter((g) => g.kind === "DEPARTMENT");
      assert.equal(departmentPairs.length, 1);

      // R1 kept the name department B had in January; R2 kept the renamed one.
      // The rename did not travel backwards into an already published release.
      const january = await dashboard(R1.roundId, "departments");
      const april = await dashboard(R2.roundId, "departments");
      const labels = (d: typeof january) =>
        d.groups.filter((g) => g.kind === "DEPARTMENT").map((g) => g.label.ar);
      assert.ok(labels(january).includes("العمليات"));
      assert.ok(labels(april).some((l) => l.startsWith(LONG_AR.slice(0, 30))));
      assert.equal(labels(january).some((l) => l.startsWith(LONG_AR.slice(0, 30))), false);
    },
  );

  // =========================================================================
  // E-5 — a sparse campaign is a refusal, not an empty report.
  // =========================================================================
  await t.test("E-5 a below-threshold campaign yields no results and no report", async () => {
    assert.match(
      await deny(resultsRoute, `organizations/${f.orgA}/assessments/${R5.roundId}/results`),
      /RESULTS_NOT_READY/,
    );
    assert.match(
      await deny(
        reportRoute,
        `organizations/${f.orgA}/reports`,
        post({ roundId: R5.roundId, format: "PDF", locale: "ar", comparisonId: null }),
      ),
      /STATE_CONFLICT/,
    );
    // No snapshot exists to compare against either.
    assert.match(
      await deny(
        historyRoute,
        `organizations/${f.orgA}/comparisons`,
        post({
          leftRoundId: R1.roundId,
          rightRoundId: R5.roundId,
          classification: "NOT_COMPARABLE",
          mapping: [],
          rationale: "جولة دون الحد الأدنى",
        }),
      ),
      /STATE_CONFLICT/,
    );
    // And nothing about those four people is stored as an aggregate anywhere.
    const { rows } = await f.operator.query(
      "select count(*)::int n from publication.result_snapshot where campaign_id=$1",
      [R5.campaignId],
    );
    assert.equal(rows[0].n, 0);
  });

  // =========================================================================
  // E-6 — the four surfaces agree, fact for fact.
  // =========================================================================
  await t.test(
    "E-6 dashboard, history, PDF and workbook agree on values, bands, dates, versions and statuses",
    async () => {
      const overview = await dashboard(R4.roundId);
      const departments = await dashboard(R4.roundId, "departments");
      const model = await renderedModel(jobs.reorganizationXlsx.id);
      const xlsx = await bytesOf(
        `organizations/${f.orgA}/reports/${jobs.reorganizationXlsx.id}/download`,
      );
      await mkdir("work", { recursive: true });
      await writeFile("work/checkpoint-e-reorganization.xlsx", xlsx.bytes);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(xlsx.bytes as unknown as ArrayBuffer);

      // Versions and dates.
      assert.equal(model.manifest.find((x) => x.label.includes("محرك"))?.value, overview.versions!.scoring);
      const generated = model.identity.find((x) => x.label === "تاريخ إصدار النتائج")!.value;
      // Compared as instants in UTC, as both surfaces now display them. The
      // earlier string slice took the server's local date and failed for runs
      // between 21:00 and 24:00 UTC, which is how the dashboard defect was found.
      assert.ok(generated.startsWith(new Date(String(overview.generatedAt)).toISOString().slice(0, 10)));

      // Overall and dimensions: value, band and status, three ways.
      const workbookRows = new Map<string, { value: unknown; band: unknown; status: unknown }>();
      book.worksheets[1].eachRow((row, index) => {
        if (index === 1) return;
        workbookRows.set(String(row.getCell(1).value), {
          value: row.getCell(2).value,
          band: row.getCell(3).value,
          status: row.getCell(7).value,
        });
      });
      let compared = 0;
      for (const metric of overview.metrics.filter((m) => m.kind !== "QUESTION")) {
        const cell = overview.cells.find(
          (c) => c.metricKey === metric.key && c.groupKey === overview.companyGroupKey,
        )!;
        const row = [model.overall, ...model.dimensions].find(
          (r) => r?.metricKey === metric.key,
        )!;
        const inBook = workbookRows.get(metric.label.ar)!;
        assert.equal(row.label, metric.label.ar);
        assert.equal(row.direction, metric.direction);
        if (cell.status === "AVAILABLE") {
          assert.equal(row.value, cell.value);
          assert.equal(inBook.value, Number(cell.value));
          assert.equal(row.band, cell.band!.label.ar);
          assert.equal(inBook.band, cell.band!.label.ar);
          compared++;
        } else {
          assert.equal(row.value, null);
          assert.equal(inBook.value ?? null, null);
          assert.equal(inBook.band ?? "", "");
        }
        assert.equal(row.statusLabel, inBook.status);
      }
      assert.ok(compared >= 2);

      // Departments: every dashboard cell has exactly one model row with the
      // same status, and a withheld one carries no number in either.
      for (const cell of departments.cells) {
        const row = model.departments.rows.find(
          (r) => r.groupKey === cell.groupKey && r.metricKey === cell.metricKey,
        );
        if (!row) continue;
        assert.equal(row.value, cell.status === "AVAILABLE" ? cell.value : null);
        assert.equal(row.contributorCount, cell.contributorCount);
        if (cell.status !== "AVAILABLE") assert.equal(row.gapNumeric, null);
      }

      // History: the report's trend points are the history endpoint's points.
      const series = await history();
      for (const trend of model.history) {
        const source = series.trends.find((x) => x.metricKey === trend.metricKey);
        if (!source) continue;
        assert.equal(trend.points.length, source.points.length);
        for (let i = 0; i < trend.points.length; i++)
          assert.equal(trend.points[i].value, source.points[i].status === "COMPARABLE" ? source.points[i].value : null);
      }
    },
  );

  // =========================================================================
  // E-7 — workbook internals.
  // =========================================================================
  await t.test("E-7 no workbook part hides a value", async () => {
    for (const job of [jobs.reorganizationXlsx, jobs.incompatibleXlsx]) {
      const xlsx = await bytesOf(`organizations/${f.orgA}/reports/${job.id}/download`);
      const parts = await workbookParts(xlsx.bytes);
      const names = Object.keys(parts);
      for (const forbidden of [
        "chart",
        "pivotcache",
        "pivottable",
        "externallink",
        "embeddings",
        "comments",
        "vbaproject",
      ])
        assert.deepEqual(
          names.filter((n) => n.toLowerCase().includes(forbidden)),
          [],
          `${forbidden} in ${job.id}`,
        );
      for (const [name, xml] of Object.entries(parts))
        if (name.endsWith(".xml")) assert.equal(/<f[ >]/.test(xml), false, `formula in ${name}`);
      const workbook = parts["xl/workbook.xml"] ?? "";
      assert.equal(/state="(hidden|veryHidden)"/.test(workbook), false);
      assert.equal(/<definedNames>/.test(workbook), false);

      // No participant name and no invitation reference anywhere in the file.
      const whole = Object.values(parts).join("\n");
      for (let i = 1; i <= 12; i++)
        assert.equal(whole.includes(`مشارك ${i}`), false, `participant ${i}`);
      assert.equal(whole.includes("INV-"), false);
      assert.equal(whole.includes("مشارك ثالث عشر"), false);
    }
  });

  // =========================================================================
  // E-8 — the long Arabic report is readable, paged and copyable.
  // =========================================================================
  await t.test("E-8 the long Arabic report renders, paginates and reads back", async () => {
    const pdf = await bytesOf(
      `organizations/${f.orgA}/reports/${jobs.reorganizationPdf.id}/download`,
    );
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    await writeFile("work/checkpoint-e-long-arabic.pdf", pdf.bytes);
    const reading = await readPdf(pdf.bytes);
    assert.ok(reading.pages >= 4, `pages=${reading.pages}`);
    assert.equal(unmapped(reading.text), 0, "every glyph maps back to a character");
    assert.ok(arabicGlyphs(reading.text) > 4000, `arabic=${arabicGlyphs(reading.text)}`);

    // CE-002 regression. The chart is drawn in a geometric (LTR) coordinate
    // space even in an Arabic report, and no label may exceed the width reserved
    // for it — an over-long label used to be painted over by the opaque track
    // and read as a short one, which mislabels a bar.
    const model = await renderedModel(jobs.reorganizationPdf.id);
    const svg = reportHtml(model, "");
    assert.ok(svg.includes('direction="ltr"'), "the chart is drawn geometrically");
    const chartLabels = [...svg.matchAll(/class="c-label">([^<]*)</g)].map((m) => m[1]);
    assert.ok(chartLabels.length >= 2);
    for (const label of chartLabels)
      assert.ok(label.length <= 26, `chart label overflows: ${label}`);
    // The long dimension name is present in the chart as a visibly truncated
    // label, and in full in the table beneath it.
    assert.ok(chartLabels.some((l) => l.endsWith("…")), "a long label is truncated visibly");
    assert.ok(
      svg.includes(model.dimensions[0].label),
      "the full label is still printed in the table",
    );

    const comparable = await bytesOf(
      `organizations/${f.orgA}/reports/${jobs.comparablePdf.id}/download`,
    );
    await writeFile("work/checkpoint-e-comparable.pdf", comparable.bytes);
    const second = await readPdf(comparable.bytes);
    assert.ok(second.pages >= 3);
    assert.equal(unmapped(second.text), 0);
    // Neither report carries a name.
    for (const text of [reading.text, second.text])
      for (let i = 1; i <= 12; i++) assert.equal(text.includes(`مشارك ${i}`), false);
  });

  // =========================================================================
  // E-9 — historic edits cannot change an already published result.
  // =========================================================================
  await t.test("E-9 directory and round edits cannot rewrite a published release", async () => {
    const before = await dashboard(R1.roundId, "departments");
    const modelBefore = await renderedModel(jobs.comparablePdf.id);
    const hashBefore = (
      await f.operator.query("select encode(content_hash,'hex') h from publication.result_snapshot where id=$1", [
        R1.snapshotId,
      ])
    ).rows[0].h as string;

    // Rename both departments again, archive one, and move a participant.
    await f.operator.query("update core.department set name_ar='قسم أعيدت تسميته' where id=$1", [
      f.departmentA,
    ]);
    await f.operator.query("update core.department set status='ARCHIVED' where id=$1", [
      f.departmentB,
    ]);
    await f.operator.query("update core.participant set department_id=$2 where id=$1", [
      f.people[0],
      departmentD,
    ]);

    const after = await dashboard(R1.roundId, "departments");
    assert.deepEqual(
      after.groups.map((g) => g.label.ar).sort(),
      before.groups.map((g) => g.label.ar).sort(),
      "a published group label changed",
    );
    assert.deepEqual(after.cells, before.cells, "a published cell changed");
    assert.equal(
      (
        await f.operator.query(
          "select encode(content_hash,'hex') h from publication.result_snapshot where id=$1",
          [R1.snapshotId],
        )
      ).rows[0].h,
      hashBefore,
    );
    // The frozen report source is unchanged, so a re-render prints the same
    // document — the artifact does not drift with the directory.
    assert.deepEqual(await renderedModel(jobs.comparablePdf.id), modelBefore);

    // A published round cannot be edited at all, so its period cannot be moved
    // to reorder the trend or change which round is the compatibility baseline.
    const revision = (
      await f.operator.query("select revision from core.assessment_round where id=$1", [
        R1.roundId,
      ])
    ).rows[0].revision as string;
    assert.match(
      await failure(() =>
        withStaff(staff, (tx) =>
          saveRound(
            tx,
            f.orgA,
            R1.roundId,
            revision,
            {
              seriesId: f.seriesId,
              label: "جولة أعيدت تسميتها",
              periodStart: "2027-06-01",
              questionnaireVersionId: V1,
              populationDefinition: { schemaVersion: 1 },
            },
            randomUUID(),
          ),
        ),
      ),
      /STATE_CONFLICT/,
    );

    // The frozen report groups are not staff-writable, so the lineage a
    // comparison pairs on cannot be repointed after the fact.
    const { rows: grants } = await f.operator.query(
      `select privilege_type from information_schema.table_privileges
        where table_schema='core' and table_name='report_group' and grantee='orgfit_staff'`,
    );
    assert.deepEqual(
      grants.map((g) => g.privilege_type).sort(),
      ["SELECT"],
      "staff may write a frozen report group",
    );
  });

  // =========================================================================
  // E-10 — downloads: unauthorized, expired, revoked after generation.
  // =========================================================================
  await t.test("E-10 an artifact outlives neither its expiry nor its authorization", async () => {
    // Another organization's staff, by either path.
    const otherStaff = randomUUID();
    await f.operator.query(
      "insert into access.staff_user(id,issuer,provider_subject,email,display_name,role,status) values($1,$2,'e-other','e-other@example.invalid','موظف ب','STAFF','ACTIVE')",
      [otherStaff, process.env.OIDC_ISSUER],
    );
    await f.operator.query("insert into access.organization_access values($1,$2)", [
      otherStaff,
      ids.orgB,
    ]);
    for (const capability of ["results.read", "reports.manage"])
      await f.operator.query(
        "insert into access.staff_capability(staff_user_id,capability) values($1,$2)",
        [otherStaff, capability],
      );
    const other = await f.session("e-other");
    assert.match(
      await deny(
        reportRoute,
        `organizations/${f.orgA}/reports/${jobs.comparablePdf.id}/download`,
        undefined,
        other,
      ),
      /NOT_FOUND/,
    );
    assert.match(
      await deny(
        reportRoute,
        `organizations/${ids.orgB}/reports/${jobs.comparablePdf.id}/download`,
        undefined,
        other,
      ),
      /NOT_FOUND/,
    );

    // Expiry: a short-lived artifact stops downloading and is then retired.
    const short = await requestReport({
      roundId: R1.roundId,
      format: "XLSX",
      locale: "ar",
      comparisonId: null,
    });
    const db = reportPool();
    await db.query("select publication.claim_report_jobs(10)");
    await db.query(
      "select publication.complete_report_job($1,$2,$3,$4,$5,$6::interval)",
      [
        short.id,
        `reports/${f.orgA}/${short.id}.bin`,
        50,
        Buffer.alloc(32),
        1,
        "1 second",
      ],
    );
    await wait(1300);
    assert.match(
      await deny(reportRoute, `organizations/${f.orgA}/reports/${short.id}/download`),
      /IMPORT_EXPIRED/,
    );
    const expired = await db.query<{ data: { id: string }[] }>(
      "select publication.expire_report_jobs(100) as data",
    );
    assert.ok(expired.rows[0].data.some((row) => row.id === short.id));
    assert.match(
      await deny(reportRoute, `organizations/${f.orgA}/reports/${short.id}/download`),
      /NOT_FOUND/,
    );
    await renderDueReports(db, 10);

    // Capability revoked after generation: the READY artifact stops being
    // reachable, and the download is decided now rather than at request time.
    await f.operator.query(
      "delete from access.staff_capability where staff_user_id=$1 and capability='reports.manage'",
      [ids.staff],
    );
    const reduced = await f.session("staff");
    assert.match(
      await deny(
        reportRoute,
        `organizations/${f.orgA}/reports/${jobs.comparablePdf.id}/download`,
        undefined,
        reduced,
      ),
      /FORBIDDEN/,
    );
    await f.operator.query(
      "insert into access.staff_capability(staff_user_id,capability) values($1,'reports.manage')",
      [ids.staff],
    );
    const restored = await f.session("staff");
    assert.equal(
      (
        await bytesOf(
          `organizations/${f.orgA}/reports/${jobs.comparablePdf.id}/download`,
          restored,
        )
      ).status,
      200,
    );

    // A release revoked after rendering stops its artifacts, including the
    // comparison report that cites it.
    await f.operator.query(
      "update publication.result_snapshot set state='REVOKED', revoked_reason='نقطة تفتيش هاء' where id=$1",
      [R4.snapshotId],
    );
    for (const job of [jobs.reorganizationPdf, jobs.reorganizationXlsx])
      assert.match(
        await deny(
          reportRoute,
          `organizations/${f.orgA}/reports/${job.id}/download`,
          undefined,
          restored,
        ),
        /RESULTS_UNAVAILABLE/,
      );
    // …and the revoked round leaves the trend as a gap rather than a value.
    const series = (await withStaff(restored, (tx) =>
      historyRoute(
        new Request(`http://127.0.0.1:3000/api/v1/organizations/${f.orgA}/history/${f.seriesId}`),
        `organizations/${f.orgA}/history/${f.seriesId}`,
        tx,
      ),
    ))!;
    const data = (await series.json()).data as {
      trends: { points: { roundId: string; value: string | null; status: string }[] }[];
    };
    for (const trend of data.trends) {
      const point = trend.points.find((p) => p.roundId === R4.roundId)!;
      assert.equal(point.status, "GAP");
      assert.equal(point.value, null);
    }
  });
});
