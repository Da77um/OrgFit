import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { withStaff } from "../src/db";
import { ids } from "../scripts/seed";
import { exchange, instrument, finalize } from "../src/respondent";
import { processCampaign } from "../src/processor";
import { releaseCampaign } from "../src/publication";
import { resultsRoute } from "../src/results";
import { historyRoute } from "../src/history";
import { reportRoute } from "../src/reports";
import { recommendationActionRoute } from "../src/recommendations";
import { revocationRoute } from "../src/revocation";
import { configureReport, reportPool, closeReportPool } from "../src/report-db";
import { renderDueReports, claimReportJobs, renderClaimedJob, purgeRevokedReports } from "../src/report-worker";
import { getReport, putReport } from "../src/report-storage";
import { digest, sessionDigest } from "../src/security";
import { markRestorePending, reapplyTombstones, shipTombstones } from "../src/operations";
import { operatorRevokeRelease } from "../scripts/revoke-release";
import type { Instrument } from "../src/instrument-input";
import { respondentFixture, failure, wait, type Fixture } from "./respondent-fixture";

// ---------------------------------------------------------------------------
// Post-Audit Repair Pass 3: withdrawing a published release (SEC-M5).
//
// Three real rounds of one series are collected through the gateway, processed
// by the privacy processor and released by the publication job. Reports are
// requested through the staff route and rendered by the worker under the
// orgfit_report credential. Then releases are withdrawn — through the staff
// route, through the operator command, concurrently, and while other
// transactions hold the rows — and every dependent surface is checked.
// ---------------------------------------------------------------------------

function answersFor(document: Instrument, seed: number) {
  const answers: Record<string, string | string[]> = {};
  for (const q of document.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    switch (q.type) {
      case "SHORT_TEXT":
      case "LONG_TEXT":
        answers[q.id] = `comment ${seed}`;
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
        for (const row of q.rows) answers[row.id] = q.columns[seed % q.columns.length].id;
        break;
      default:
        answers[q.id] = q.options[seed % q.options.length].id;
    }
  }
  return answers;
}

const settled = async (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true, () => true), wait(ms).then(() => false)]);

test("PostgreSQL Post-Audit Repair Pass 3: release revocation", async (t) => {
  const f: Fixture = await respondentFixture(12);
  Object.assign(process.env, {
    REPORT_ENCRYPTION_KEY: "c".repeat(64),
    REPORT_LOCAL_DIRECTORY: `work/reports-${randomUUID()}`,
  });
  delete process.env.REPORT_DATABASE_URL;
  configureReport(f.fixture.url("orgfit_report"));
  const core = new pg.Pool({ connectionString: f.fixture.url("orgfit_processor"), max: 4 });
  const anon = new pg.Pool({ connectionString: f.fixture.anonymousUrl("orgfit_processor"), max: 4 });
  const raw: pg.Client[] = [];
  t.after(async () => {
    for (const c of raw) await c.end().catch(() => {});
    await closeReportPool();
    await core.end();
    await anon.end();
    await f.close();
  });

  const staff = f.staff;
  const admin = await f.session("admin");
  const org = f.orgA;

  // A raw staff connection whose transaction the test controls, to hold locks
  // exactly where a real concurrent request would.
  async function staffClient(token: string) {
    const c = new pg.Client({ connectionString: f.fixture.url("orgfit_staff") });
    await c.connect();
    raw.push(c);
    await c.query("BEGIN");
    await c.query("select set_config('orgfit.session_digest',$1,true)", [sessionDigest(token)]);
    return c;
  }

  const route = (handler: typeof reportRoute, target: string, init: RequestInit | undefined, token: string) => {
    const [path] = target.split("?");
    return withStaff(token, (tx) => handler(new Request(`http://127.0.0.1:3000/api/v1/${target}`, init), path, tx));
  };
  const call = async (handler: typeof reportRoute, target: string, init?: RequestInit, token = staff) => {
    const res = await route(handler, target, init, token);
    assert.ok(res, `${target} is not a route`);
    return { status: res.status, data: (await res.json()).data };
  };
  const deny = (handler: typeof reportRoute, target: string, init?: RequestInit, token = staff) =>
    failure(async () => {
      const res = await route(handler, target, init, token);
      if (!res) throw new Error("NO_ROUTE");
      return res;
    });
  const post = (body: unknown, key = randomUUID(), method = "POST") => ({
    method,
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });

  async function releasedRound(seed: number) {
    const { roundId, campaignId } = await f.launchedCampaign();
    const links = await f.issueLinks(campaignId);
    for (let i = 0; i < links.length; i++) {
      const opened = await exchange(links[i].token);
      const document = (await instrument(opened.session!)).document;
      await finalize(opened.session!, { answers: answersFor(document, i + seed) });
    }
    await f.closeCampaign(campaignId);
    await processCampaign(core, anon, campaignId);
    const outcome = await releaseCampaign(core, anon, campaignId);
    assert.equal(outcome.state, "PUBLISHED");
    const hash = (await f.operator.query("select encode(content_hash,'hex') h from publication.result_snapshot where id=$1", [outcome.snapshotId])).rows[0].h as string;
    return { roundId, campaignId, snapshotId: outcome.snapshotId!, fingerprint: hash.slice(0, 8) };
  }
  const R1 = await releasedRound(0);
  const R2 = await releasedRound(3);
  const R3 = await releasedRound(5);

  // A reviewed comparison R1 → R2.
  const proposal = await call(historyRoute, `organizations/${org}/comparisons/proposal?left=${R1.roundId}&right=${R2.roundId}`);
  const comparison = await call(
    historyRoute,
    `organizations/${org}/comparisons`,
    post({
      leftRoundId: R1.roundId,
      rightRoundId: R2.roundId,
      classification: "IDENTICAL",
      mapping: (proposal.data as { pairs: { leftKey: string; rightKey: string; equivalent: boolean }[] }).pairs
        .filter((p) => p.equivalent)
        .map((p) => ({ leftKey: p.leftKey, rightKey: p.rightKey })),
      rationale: "same version in both rounds",
    }),
  );
  assert.equal(comparison.status, 201);
  const comparisonId = (comparison.data as { id: string }).id;

  const requestXlsx = async (roundId: string, withComparison = false, token = staff) =>
    call(reportRoute, `organizations/${org}/reports`, post({ roundId, format: "XLSX", locale: "en", comparisonId: withComparison ? comparisonId : null }), token);
  const jobState = async (id: string) =>
    (await f.operator.query("select state, storage_key from ops.report_job where id=$1", [id])).rows[0] as { state: string; storage_key: string | null };
  const deps = async (id: string) =>
    (await f.operator.query("select snapshot_id from ops.report_job_dependency where job_id=$1 order by snapshot_id", [id])).rows.map((r) => r.snapshot_id as string).sort();

  // ---- reports that depend on R1 in three different ways --------------------------
  const J1 = ((await requestXlsx(R1.roundId)).data as { id: string }).id; // its own release
  const J2c = ((await requestXlsx(R2.roundId, true)).data as { id: string }).id; // cites R1 through the comparison
  const J2t = ((await requestXlsx(R2.roundId)).data as { id: string }).id; // quotes R1 in its trend
  const rendered = await renderDueReports(reportPool(), 10);
  assert.deepEqual(rendered.map((r) => r.state), ["READY", "READY", "READY"], JSON.stringify(rendered));
  const J1q = ((await requestXlsx(R1.roundId)).data as { id: string }).id; // still queued when R1 is withdrawn

  await t.test("RV-1 every report job records every release it depends on", async () => {
    // A report's trend is the whole series, so every report quotes the released
    // company values of every released round — earlier and later ones.
    const all = [R1.snapshotId, R2.snapshotId, R3.snapshotId].sort();
    assert.deepEqual(await deps(J1), all, "the R1 report quotes R2 and R3 in its trend");
    assert.deepEqual(await deps(J2c), all);
    assert.deepEqual(await deps(J2t), all, "the R2 report quotes R1's released value in its trend");
    const download = await route(reportRoute, `organizations/${org}/reports/${J1}/download`, undefined, staff);
    assert.equal(download!.status, 200);
  });

  await t.test("RV-2 authorization: Super Admin only, organization-bound, confirmed by fingerprint", async () => {
    const body = { snapshotId: R1.snapshotId, reasonCode: "PRIVACY_INCIDENT", reason: "a small department is identifiable", incidentReference: "INC-2026-001", confirmation: R1.fingerprint };
    // Ordinary staff holding results.read and reports.manage: refused inside the routine.
    assert.equal(await deny(revocationRoute, `organizations/${org}/assessments/${R1.roundId}/release/revocation`, post(body)), "FORBIDDEN");
    // The round addressed through another organization does not exist there.
    assert.equal(await deny(revocationRoute, `organizations/${f.orgB}/assessments/${R1.roundId}/release/revocation`, post(body), admin), "NOT_FOUND");
    // A stale or mistyped fingerprint, or another release's identifier, is refused.
    assert.equal(await deny(revocationRoute, `organizations/${org}/assessments/${R1.roundId}/release/revocation`, post({ ...body, confirmation: R2.fingerprint }), admin), "CONFIRMATION_MISMATCH");
    assert.equal(await deny(revocationRoute, `organizations/${org}/assessments/${R1.roundId}/release/revocation`, post({ ...body, snapshotId: R2.snapshotId }), admin), "CONFIRMATION_MISMATCH");
    assert.equal(await deny(revocationRoute, `organizations/${org}/assessments/${R1.roundId}/release/revocation`, post({ ...body, reason: "short" }), admin), "VALIDATION_FAILED");
    // The operator command needs an active Super Admin as approver.
    await assert.rejects(
      operatorRevokeRelease(f.fixture.url("orgfit_migrator"), { organizationId: org, campaignId: R1.campaignId, approverEmail: "staff@example.invalid", reasonCode: "PRIVACY_INCIDENT", reason: body.reason, incidentReference: "INC", confirmation: R1.fingerprint }),
      /APPROVER_REQUIRED/,
    );
    await assert.rejects(
      operatorRevokeRelease(f.fixture.url("orgfit_migrator"), { organizationId: f.orgB, campaignId: R1.campaignId, approverEmail: "admin@example.invalid", reasonCode: "PRIVACY_INCIDENT", reason: body.reason, incidentReference: "INC", confirmation: R1.fingerprint }),
      /STATE_CONFLICT/,
    );
    // Nothing above changed anything.
    assert.equal((await f.operator.query("select state from publication.result_snapshot where id=$1", [R1.snapshotId])).rows[0].state, "PUBLISHED");
    const status = await call(revocationRoute, `organizations/${org}/assessments/${R1.roundId}/release`, undefined, staff);
    assert.equal((status.data as { canRevoke: boolean }).canRevoke, false, "ordinary staff are not offered revocation");
    const adminStatus = await call(revocationRoute, `organizations/${org}/assessments/${R1.roundId}/release`, undefined, admin);
    assert.equal((adminStatus.data as { canRevoke: boolean; fingerprint: string }).canRevoke, true);
    assert.equal((adminStatus.data as { fingerprint: string }).fingerprint, R1.fingerprint);
  });

  const instanceR1 = (await f.operator.query("select id from publication.recommendation_instance where snapshot_id=$1 order by priority limit 1", [R1.snapshotId])).rows[0]?.id as string;
  const cellsBefore = (await f.operator.query("select count(*)::int n from publication.aggregate_cell where snapshot_id=$1", [R1.snapshotId])).rows[0].n as number;

  let revocationId = "";
  const firstKey = randomUUID();
  const decision = { snapshotId: R1.snapshotId, reasonCode: "PRIVACY_INCIDENT", reason: "a small department is identifiable", incidentReference: "INC-2026-001", confirmation: R1.fingerprint.toUpperCase() };

  await t.test("RV-3 a Super Admin withdraws R1 through the staff route", async () => {
    const res = await call(revocationRoute, `organizations/${org}/assessments/${R1.roundId}/release/revocation`, post(decision, firstKey), admin);
    assert.equal(res.status, 201);
    const data = res.data as { id: string; replayed: boolean; reportsRevoked: number; downloadsBefore: number };
    revocationId = data.id;
    assert.equal(data.replayed, false);
    assert.equal(data.reportsRevoked, 4, "J1, J1q, J2c and J2t");
    assert.equal(data.downloadsBefore, 1, "the one download before revocation is counted, not recalled");
    const audit = await f.operator.query("select actor_id, target_id, field_names from ops.audit_log where action='RELEASE_REVOKED'");
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].actor_id, ids.admin);
    assert.equal(audit.rows[0].target_id, R1.snapshotId);
    assert.deepEqual(audit.rows[0].field_names, ["release", "report"]);
  });

  await t.test("RV-4 revocation is retry-safe and a different decision does not overwrite it", async () => {
    const replay = await call(revocationRoute, `organizations/${org}/assessments/${R1.roundId}/release/revocation`, post(decision, firstKey), admin);
    assert.equal(replay.status, 200);
    assert.equal((replay.data as { id: string; replayed: boolean }).id, revocationId);
    const sameDecision = await call(revocationRoute, `organizations/${org}/assessments/${R1.roundId}/release/revocation`, post(decision), admin);
    assert.equal(sameDecision.status, 200, "the same decision under a new key lands on the same record");
    assert.equal((sameDecision.data as { id: string }).id, revocationId);
    assert.equal(
      await deny(revocationRoute, `organizations/${org}/assessments/${R1.roundId}/release/revocation`, post({ ...decision, reasonCode: "CORRECTNESS_ERROR" }), admin),
      "RELEASE_ALREADY_REVOKED",
    );
    await assert.rejects(
      operatorRevokeRelease(f.fixture.url("orgfit_migrator"), { organizationId: org, campaignId: R1.campaignId, approverEmail: "admin@example.invalid", reasonCode: "DATA_INTEGRITY", reason: "another reason entirely", incidentReference: "INC-X", confirmation: R1.fingerprint }),
      /RELEASE_ALREADY_REVOKED/,
    );
    assert.equal((await f.operator.query("select count(*)::int n from publication.release_revocation")).rows[0].n, 1);
    assert.equal((await f.operator.query("select count(*)::int n from ops.audit_log where action='RELEASE_REVOKED'")).rows[0].n, 1);
  });

  await t.test("RV-5 the withdrawn release is refused everywhere it could surface", async () => {
    for (const view of ["", "/departments", "/questions", "/recommendations"])
      assert.equal(await deny(resultsRoute, `organizations/${org}/assessments/${R1.roundId}/results${view}`), "RESULTS_UNAVAILABLE", view);
    // History: the round stays listed as withdrawn, with no numbers and no trend point.
    const history = await call(historyRoute, `organizations/${org}/history/${f.seriesId}`);
    const series = history.data as { rounds: { roundId: string; releaseState: string; snapshotId: string | null }[]; trends: { points: { roundId: string; value: string | null }[] }[] };
    const r1 = series.rounds.find((r) => r.roundId === R1.roundId)!;
    assert.equal(r1.releaseState, "REVOKED");
    assert.equal(r1.snapshotId, null);
    for (const trend of series.trends)
      for (const p of trend.points.filter((x) => x.roundId === R1.roundId)) assert.equal(p.value, null);
    // Comparisons: listed as unavailable; opening it is refused.
    const list = await call(historyRoute, `organizations/${org}/comparisons?seriesId=${f.seriesId}`);
    assert.equal((list.data as { items: { id: string; available: boolean }[] }).items.find((c) => c.id === comparisonId)!.available, false);
    assert.equal(await deny(historyRoute, `organizations/${org}/comparisons/${comparisonId}`), "RESULTS_UNAVAILABLE");
    // Recommendations: no follow-up can be written against a withdrawn finding.
    assert.ok(instanceR1);
    assert.equal(
      await deny(recommendationActionRoute, `organizations/${org}/recommendation-actions/${instanceR1}`, post({ status: "OPEN", ownerStaffId: null, dueDate: null, staffNotes: "x", resolution: null }, randomUUID(), "PATCH")),
      "RESULTS_UNAVAILABLE",
    );
    // Reports: every dependent job is REVOKED, downloads say so, new requests are refused.
    for (const id of [J1, J1q, J2c, J2t]) assert.equal((await jobState(id)).state, "REVOKED", id);
    for (const id of [J1, J2c, J2t])
      assert.equal(await deny(reportRoute, `organizations/${org}/reports/${id}/download`), "RESULTS_UNAVAILABLE", id);
    assert.equal(await deny(reportRoute, `organizations/${org}/reports`, post({ roundId: R1.roundId, format: "XLSX", locale: "en", comparisonId: null })), "STATE_CONFLICT");
    assert.equal(await deny(reportRoute, `organizations/${org}/reports`, post({ roundId: R2.roundId, format: "XLSX", locale: "en", comparisonId })), "RESULTS_UNAVAILABLE");
    // The queued job is never drawn.
    assert.deepEqual(await claimReportJobs(reportPool(), 10), []);
    // A later report of the series still works: the trend has a gap, not R1's value.
    const later = ((await requestXlsx(R2.roundId)).data as { id: string }).id;
    assert.deepEqual(await deps(later), [R2.snapshotId, R3.snapshotId].sort());
    // The processor cannot republish it.
    await assert.rejects(releaseCampaign(core, anon, R1.campaignId), /RELEASE_REVOKED/);
    assert.equal((await f.operator.query("select release_state from core.campaign where id=$1", [R1.campaignId])).rows[0].release_state, "REVOKED");
    assert.deepEqual((await core.query("select publication.due_campaigns('RELEASE',50) d")).rows[0].d.includes(R1.campaignId), false);
    // Readers are told what happened; only a Super Admin reads the reason.
    const staffView = (await call(revocationRoute, `organizations/${org}/assessments/${R1.roundId}/release`)).data as { revocation: Record<string, unknown> };
    assert.equal(staffView.revocation.reasonCode, "PRIVACY_INCIDENT");
    assert.equal(staffView.revocation.downloadsBefore, 1);
    assert.equal("reason" in staffView.revocation, false);
    assert.equal("incidentReference" in staffView.revocation, false);
    const adminView = (await call(revocationRoute, `organizations/${org}/assessments/${R1.roundId}/release`, undefined, admin)).data as { canRevoke: boolean; revocation: Record<string, unknown> };
    assert.equal(adminView.revocation.reason, decision.reason);
    assert.equal(adminView.canRevoke, false);
  });

  await t.test("RV-6 historical evidence is preserved and immutable; bytes are purged by the report worker", async () => {
    assert.equal((await f.operator.query("select count(*)::int n from publication.aggregate_cell where snapshot_id=$1", [R1.snapshotId])).rows[0].n, cellsBefore);
    assert.equal((await f.operator.query("select count(*)::int n from ops.report_job where id=any($1) and source is not null", [[J1, J2c, J2t]])).rows[0].n, 3, "frozen sources kept");
    await assert.rejects(f.operator.query("update publication.release_revocation set reason='rewritten reason text' where id=$1", [revocationId]), /PUBLICATION_IMMUTABLE/);
    await assert.rejects(f.operator.query("delete from publication.release_revocation where id=$1", [revocationId]), /PUBLICATION_IMMUTABLE/);
    await assert.rejects(f.operator.query("update core.campaign set release_state='PUBLISHED' where id=$1", [R1.campaignId]), /RELEASE_REVOKED/);
    await assert.rejects(f.operator.query("update publication.result_snapshot set state='PUBLISHED', revoked_reason=null where id=$1", [R1.snapshotId]), /PUBLICATION_IMMUTABLE/);
    // Three READY artifacts had bytes; the queued one never did.
    for (const id of [J1, J2c, J2t]) assert.ok(await getReport(org, id).then(() => true));
    assert.equal(await purgeRevokedReports(reportPool()), 3);
    for (const id of [J1, J2c, J2t]) await assert.rejects(getReport(org, id));
    assert.equal(await purgeRevokedReports(reportPool()), 0, "idempotent");
    // The renderer holds no table privilege even with the new routines.
    assert.equal((await f.operator.query("select count(*)::int n from information_schema.table_privileges where grantee='orgfit_report'")).rows[0].n, 0);
  });

  // ---- R2: a download in flight while revocations race each other -----------------
  await t.test("RV-7 a download authorized first completes; concurrent revocations land on one record; later downloads are refused", async () => {
    const J2 = ((await requestXlsx(R2.roundId)).data as { id: string }).id;
    const drawn = await renderDueReports(reportPool(), 10);
    assert.ok(drawn.some((r) => r.jobId === J2 && r.state === "READY"), JSON.stringify(drawn));
    // Transaction D authorizes the download and has not committed yet (the
    // staff route reads the bytes inside the same transaction).
    const D = await staffClient(staff);
    const authorized = await D.query("select core.report_download($1,$2) as data", [org, J2]);
    assert.equal(authorized.rows[0].data.format, "XLSX");
    const body = { snapshotId: R2.snapshotId, reasonCode: "CORRECTNESS_ERROR", reason: "scoring configuration was wrong", incidentReference: "INC-2026-002", confirmation: R2.fingerprint };
    const url = `organizations/${org}/assessments/${R2.roundId}/release/revocation`;
    // Three Super Admin requests at once: two with the same decision under
    // different idempotency keys, one with a different decision.
    const attempt = async (payload: typeof body) => {
      try {
        const res = await route(revocationRoute, url, post(payload), admin);
        return String(res!.status);
      } catch (e) {
        return (e as Error).message;
      }
    };
    const same = [attempt(body), attempt(body)];
    const different = attempt({ ...body, reasonCode: "DATA_INTEGRITY" });
    assert.equal(await settled(same[0], 800), false, "revocation waits for the authorized download");
    const bytes = await getReport(org, J2);
    assert.ok(bytes.length > 0, "the in-flight download reads its bytes");
    await D.query("COMMIT");
    const sameOutcomes = (await Promise.all(same)).sort();
    const differentOutcome = await different;
    // Exactly one request creates the record. If a same-decision request won,
    // the other lands on it (200) and the different decision conflicts; if the
    // different decision won, both same-decision requests conflict. Nothing is
    // ever overwritten.
    const wonBySame = sameOutcomes.join() === "200,201" && differentOutcome === "RELEASE_ALREADY_REVOKED";
    const wonByDifferent = differentOutcome === "201" && sameOutcomes.join() === "RELEASE_ALREADY_REVOKED,RELEASE_ALREADY_REVOKED";
    assert.ok(wonBySame || wonByDifferent, `same ${sameOutcomes} different ${differentOutcome}`);
    assert.equal((await f.operator.query("select count(*)::int n from publication.release_revocation where snapshot_id=$1", [R2.snapshotId])).rows[0].n, 1);
    assert.equal(await deny(reportRoute, `organizations/${org}/reports/${J2}/download`), "RESULTS_UNAVAILABLE");
    const record = (await f.operator.query("select downloads_before from publication.release_revocation where snapshot_id=$1", [R2.snapshotId])).rows[0];
    // The R1 report downloaded in RV-1 printed R2's trend value too, so it
    // counts; so does the download that won this race.
    assert.equal(record.downloads_before, 2, "every earlier download that carried R2's values is counted");
    // J2 and the later R2 report from RV-5 had bytes.
    assert.equal(await purgeRevokedReports(reportPool()), 2);
  });

  // ---- R3: revocation holding its locks while reports are requested and drawn ----
  await t.test("RV-8 a report requested while a revocation is uncommitted is refused; running jobs cannot publish", async () => {
    // Two jobs claimed by a worker before the revocation: one will try to
    // complete with bytes already written, the other will try to read its source.
    const Ja = ((await requestXlsx(R3.roundId)).data as { id: string }).id;
    const Jb = ((await requestXlsx(R3.roundId)).data as { id: string }).id;
    const claimed = await claimReportJobs(reportPool(), 10);
    assert.deepEqual(claimed.map((j) => j.id).sort(), [Ja, Jb].sort());
    const A = await staffClient(admin);
    const key = randomUUID();
    const body = { snapshotId: R3.snapshotId, reasonCode: "OWNER_DECISION", reason: "owner withdrew this round", incidentReference: "DEC-2026-003", confirmation: R3.fingerprint };
    const revoked = await A.query("select publication.revoke_release($1,$2,$3,$4,$5) as data", [
      org, R3.campaignId, JSON.stringify(body), key, digest(JSON.stringify({ org, campaignId: R3.campaignId, body })),
    ]);
    assert.equal(revoked.rows[0].data.reportsRevoked, 2);
    const pending = failure(() => requestXlsx(R3.roundId));
    assert.equal(await settled(pending, 800), false, "the new request waits for the uncommitted revocation");
    const before = (await f.operator.query("select count(*)::int n from ops.report_job where round_id=$1", [R3.roundId])).rows[0].n;
    await A.query("COMMIT");
    assert.equal(await pending, "RESULTS_UNAVAILABLE");
    assert.equal((await f.operator.query("select count(*)::int n from ops.report_job where round_id=$1", [R3.roundId])).rows[0].n, before, "no job row survived");
    // Ja: bytes written, completion arrives after the revocation.
    const storage = await putReport(org, Ja, Buffer.from("synthetic bytes"));
    const completed = await reportPool().query("select publication.complete_report_job($1,$2,$3,$4,null,'1 hour'::interval) state", [Ja, storage, 15, createHash("sha256").update("x").digest()]);
    assert.equal(completed.rows[0].state, "REVOKED");
    assert.equal((await jobState(Ja)).storage_key, null);
    // Jb: the worker's own loop meets the revocation and removes its bytes.
    const outcome = await renderClaimedJob(reportPool(), claimed.find((j) => j.id === Jb)!, null);
    assert.equal(outcome.state, "REVOKED");
    assert.equal((await jobState(Jb)).state, "REVOKED");
    assert.equal(await purgeRevokedReports(reportPool()), 2, "both possibly-written artifacts are purged");
    await assert.rejects(getReport(org, Ja));
  });

  let R5Round = "";
  await t.test("RV-9 a download that starts while a revocation is uncommitted is refused after it commits", async () => {
    // The reverse order of RV-7: the revocation holds its locks first.
    const R4 = await releasedRound(7);
    const J4 = ((await requestXlsx(R4.roundId)).data as { id: string }).id;
    assert.ok((await renderDueReports(reportPool(), 10)).some((r) => r.jobId === J4 && r.state === "READY"));
    const A = await staffClient(admin);
    const body = { snapshotId: R4.snapshotId, reasonCode: "DATA_INTEGRITY", reason: "restored from the wrong batch", incidentReference: "INC-2026-004", confirmation: R4.fingerprint };
    await A.query("select publication.revoke_release($1,$2,$3,$4,$5)", [org, R4.campaignId, JSON.stringify(body), randomUUID(), digest("rv9")]);
    const download = deny(reportRoute, `organizations/${org}/reports/${J4}/download`);
    assert.equal(await settled(download, 800), false, "the download waits for the uncommitted revocation");
    await A.query("COMMIT");
    assert.equal(await download, "RESULTS_UNAVAILABLE");
    // A rolled-back revocation leaves nothing behind.
    const R5 = await releasedRound(9);
    const B = await staffClient(admin);
    await B.query("select publication.revoke_release($1,$2,$3,$4,$5)", [org, R5.campaignId, JSON.stringify({ ...body, snapshotId: R5.snapshotId, confirmation: R5.fingerprint }), randomUUID(), digest("rv9b")]);
    await B.query("ROLLBACK");
    assert.equal((await call(resultsRoute, `organizations/${org}/assessments/${R5.roundId}/results`)).status, 200);
    R5Round = R5.roundId;
  });

  await t.test("RV-11 (PR3-001) a job abandoned by a crashed renderer is requeued, never blocks the queue, and fails after its attempts", async () => {
    const claim = async () =>
      (await reportPool().query("select publication.claim_report_jobs(10, interval '1 second') as data")).rows[0].data as { id: string; attempt: number }[];
    const J = ((await requestXlsx(R5Round)).data as { id: string }).id;
    assert.deepEqual((await claim()).map((j) => j.id), [J], "claimed, then the worker dies");
    await wait(1200);
    const K = ((await requestXlsx(R5Round)).data as { id: string }).id;
    // Before the repair this call raised REPORT_IMMUTABLE and claimed nothing.
    let taken = await claim();
    assert.deepEqual(taken.map((j) => `${j.id}:${j.attempt}`).sort(), [`${J}:2`, `${K}:1`].sort());
    await wait(1200);
    taken = await claim();
    assert.deepEqual(taken.map((j) => `${j.id}:${j.attempt}`).sort(), [`${J}:3`, `${K}:2`].sort());
    await wait(1200);
    taken = await claim();
    assert.deepEqual(taken.map((j) => `${j.id}:${j.attempt}`), [`${K}:3`], "J used its three attempts");
    const failed = (await f.operator.query("select state, failure_code from ops.report_job where id=$1", [J])).rows[0];
    assert.deepEqual(failed, { state: "FAILED", failure_code: "LEASE_EXPIRED" });
  });

  await t.test("RV-10 a restore to a backup older than the revocation re-applies it before opening", async () => {
    const coreUrl = f.fixture.url("orgfit_migrator");
    const anonUrl = f.fixture.anonymousUrl("orgfit_anon_migrator");
    const ledger = await mkdtemp(join(tmpdir(), "orgfit-rv10-"));
    const shipped = await shipTombstones(coreUrl, ledger);
    assert.ok(shipped.shipped >= 1);
    // Logical stand-in for a physical restore to just before R1's revocation:
    // the owner role rewinds exactly the rows the revocation wrote, with user
    // triggers disabled inside one transaction. (The physical restore drill
    // itself is tests/ops/rollback-drill.ts and was not extended here.)
    const owner = new pg.Client({ connectionString: coreUrl });
    await owner.connect();
    raw.push(owner);
    await owner.query("SET ROLE orgfit_core_owner");
    await owner.query("BEGIN");
    for (const table of ["publication.result_snapshot", "core.campaign", "publication.release_revocation", "ops.report_job"])
      await owner.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await owner.query("update publication.result_snapshot set state='PUBLISHED', revoked_reason=null where id=$1", [R1.snapshotId]);
    await owner.query("update core.campaign set release_state='PUBLISHED' where id=$1", [R1.campaignId]);
    await owner.query("delete from publication.release_revocation where snapshot_id=$1", [R1.snapshotId]);
    await owner.query("update ops.report_job set state='QUEUED', attempt=0 where id=$1", [J1q]);
    await owner.query("delete from ops.deletion_tombstone where class='RELEASE_REVOCATION' and subject_id=$1", [R1.snapshotId]);
    for (const table of ["publication.result_snapshot", "core.campaign", "publication.release_revocation", "ops.report_job"])
      await owner.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await owner.query("COMMIT");
    assert.equal((await call(resultsRoute, `organizations/${org}/assessments/${R1.roundId}/results`)).status, 200, "the simulated restore republished R1");

    await markRestorePending(coreUrl);
    const replay = await reapplyTombstones(coreUrl, anonUrl, ledger);
    assert.equal(replay.applied.RELEASE_REVOCATION, 1);
    assert.equal(replay.opened, true);
    assert.equal(await deny(resultsRoute, `organizations/${org}/assessments/${R1.roundId}/results`), "RESULTS_UNAVAILABLE");
    assert.equal((await jobState(J1q)).state, "REVOKED");
    const record = (await f.operator.query("select channel, revoked_by, reason_code from publication.release_revocation where snapshot_id=$1", [R1.snapshotId])).rows[0];
    assert.deepEqual(record, { channel: "RESTORE_REPLAY", revoked_by: null, reason_code: "RESTORE_REPLAY" });
    // Replaying again changes nothing.
    await markRestorePending(coreUrl);
    assert.equal((await reapplyTombstones(coreUrl, anonUrl, ledger)).applied.RELEASE_REVOCATION, 0);
  });
});
