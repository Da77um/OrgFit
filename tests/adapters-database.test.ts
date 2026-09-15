import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { withStaff, readiness } from "../src/db";
import { ids } from "../scripts/seed";
import { visitRoute } from "../src/visits";
import { configureScanner, closeScannerPool, scannerPool } from "../src/scanner-db";
import { scanDueAttachments, ScanEngineUnavailable } from "../src/attachment-worker";
import { getAttachment } from "../src/attachment-storage";
import { clamdEngine, developmentHeuristicEngine, parseClamdAddress, type EngineResult, type MalwareEngine } from "../src/malware-engine";
import { exchange, instrument, finalize } from "../src/respondent";
import { processCampaign } from "../src/processor";
import { gatewayReadiness } from "../src/gateway-db";
import {
  alertInputs,
  eraseCampaignIntake,
  evaluateAlerts,
  markRestorePending,
  reapplyTombstones,
  readLedger,
  runRetention,
  shipTombstones,
  tombstoneDeliveryStatus,
} from "../src/operations";
import { limitPreSession, limitSession, staffRateDigest } from "../src/staff-rate-limit";
import { windowStart } from "../src/rate-limit";
import { secret } from "../src/security";
import { respondentFixture, failure, type Fixture } from "./respondent-fixture";
import { EICAR, startClamdDouble } from "./adapters/clamd-double";
import type { Instrument } from "../src/instrument-input";

// ---------------------------------------------------------------------------
// Post-Audit Repair Pass 4 — production-security adapters against a real
// PostgreSQL cluster, with synthetic data only.
//
//   AD-1  scanner: engine provenance, outage, timeout, threat, policy, grants
//         ([mocked-engine]: stub engines and the clamd protocol double; no real
//         antivirus engine is involved in this file)
//   AD-2  staff-side application rate limits and their alert
//   AD-3  tombstone shipping evidence, seal verification in the restore replay,
//         and the restore sequence defect PR4-001
//   AD-4  whole-campaign intake erasure for an approved restore incident
//   AD-5  key destruction evidence recorded by the processor
// ---------------------------------------------------------------------------

function answersFor(d: Instrument) {
  const answers: Record<string, string | string[]> = {};
  for (const q of d.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    if (q.type === "CHECKBOXES") answers[q.id] = [q.options[0].id];
    else if (q.type === "MATRIX") for (const r of q.rows) answers[r.id] = q.columns[0].id;
    else if (["MULTIPLE_CHOICE", "DROPDOWN", "YES_NO"].includes(q.type)) answers[q.id] = q.options[0].id;
    else if (q.type === "RATING_5") answers[q.id] = "3";
    else if (q.type === "RATING_10") answers[q.id] = "6";
    else if (q.type === "NUMBER") answers[q.id] = "4";
    else if (q.type === "DATE") answers[q.id] = "2026-06-15";
    else answers[q.id] = "نص";
  }
  return answers;
}

const pdfBytes = () => Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");

test("Pass 4 adapters against a live database", async (t) => {
  const f: Fixture = await respondentFixture(6);
  const coreUrl = f.fixture.url("orgfit_migrator");
  const anonUrl = f.fixture.anonymousUrl("orgfit_anon_migrator");
  const processorCore = new pg.Pool({ connectionString: f.fixture.url("orgfit_processor"), max: 2 });
  const processorAnon = new pg.Pool({ connectionString: f.fixture.anonymousUrl("orgfit_processor"), max: 2 });
  Object.assign(process.env, {
    ATTACHMENT_LOCAL_DIRECTORY: await mkdtemp(join(tmpdir(), "orgfit-att-pass4-")),
    ATTACHMENT_ENCRYPTION_KEY: "c".repeat(64),
  });
  configureScanner(f.fixture.url("orgfit_scanner"));
  const org = f.orgA;
  const q = async <T>(sql: string, params: unknown[] = []) => (await f.operator.query(sql, params)).rows as T[];
  const post = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify(body),
  });
  const visit = (
    (await (await withStaff(f.staff, (tx) =>
      visitRoute(
        new Request(`http://127.0.0.1:3000/api/v1/organizations/${org}/visits`, post({
          relatedRoundId: null, assignedConsultantId: ids.staff, scheduledStart: "2026-09-20T07:00:00.000Z", scheduledEnd: "2026-09-20T12:00:00.000Z",
          timezone: "Asia/Riyadh", purpose: "زيارة تجريبية لاختبار الفحص", notes: null, findings: null, recommendations: null, followUpDate: null, amendmentReason: null,
        })),
        `organizations/${org}/visits`,
        tx,
      ),
    ))!.json()) as { data: { id: string } }
  ).data;
  async function upload(filename: string, declaredType: string, bytes: Buffer) {
    const started = ((await (await withStaff(f.staff, (tx) =>
      visitRoute(new Request(`http://127.0.0.1:3000/api/v1/organizations/${org}/visits/${visit.id}/attachments`, post({ filename, declaredType })), `organizations/${org}/visits/${visit.id}/attachments`, tx),
    ))!.json()) as { data: { id: string } }).data;
    const put = await withStaff(f.staff, (tx) =>
      visitRoute(
        new Request(`http://127.0.0.1:3000/api/v1/organizations/${org}/visits/${visit.id}/attachments/${started.id}/content`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array(bytes),
        }),
        `organizations/${org}/visits/${visit.id}/attachments/${started.id}/content`,
        tx,
      ),
    );
    assert.equal(put!.status, 202);
    return started.id;
  }
  const row = async (id: string) =>
    (await q<{ scan_status: string; scan_attempt: number; scan_engine: string | null; scan_engine_version: string | null; rejection_code: string | null }>(
      "select scan_status, scan_attempt, scan_engine, scan_engine_version, rejection_code from core.attachment where id=$1",
      [id],
    ))[0];
  // Clear any leftover quarantined rows between cases so each claim is ours.
  const settle = async () => q("update core.attachment set scan_status='EXPIRED' where scan_status in ('QUARANTINED','FAILED')");
  /** A stub with a fixed answer, standing in for a maintained engine. [mocked-engine] */
  const stub = (result: Partial<EngineResult> & { outcome: EngineResult["outcome"] }, probe: Awaited<ReturnType<MalwareEngine["probe"]>> = { available: true, version: "stub-signatures/1" }): MalwareEngine => ({
    name: "clamd",
    assurance: "maintained-engine",
    probe: async () => probe,
    scan: async () => ({ engine: "clamd", engineVersion: "stub-signatures/1", code: "SCAN_ENGINE_TIMEOUT", ...result }) as unknown as EngineResult,
  });

  async function submittedCampaign(people = f.people) {
    const { campaignId } = await f.launchedCampaign(people);
    const links = await f.issueLinks(campaignId);
    for (const link of links) {
      const s = await exchange(link.token);
      const d = (await instrument(s.session!)).document;
      await finalize(s.session!, { answers: answersFor(d) });
    }
    return campaignId;
  }

  try {
    // =====================================================================
    await t.test("AD-1 [mocked-engine] the scanner records engine provenance, keeps files quarantined through outages and timeouts, and never marks CLEAN without an engine verdict", async () => {
      // (a) A maintained-engine verdict: CLEAN with the engine's name and signature version.
      const clean = await upload("minutes.pdf", "application/pdf", pdfBytes());
      const [a] = await scanDueAttachments(scannerPool(), 10, stub({ outcome: "NO_THREAT_FOUND" }));
      assert.equal(a.state, "CLEAN");
      assert.deepEqual(await row(clean), { scan_status: "CLEAN", scan_attempt: 1, scan_engine: "clamd", scan_engine_version: "stub-signatures/1", rejection_code: null });

      // (b) The development heuristic's verdicts are labelled as such.
      const dev = await upload("dev.pdf", "application/pdf", pdfBytes());
      await scanDueAttachments(scannerPool(), 10, developmentHeuristicEngine());
      assert.equal((await row(dev)).scan_engine, "development-heuristic");

      // (c) Engine unreachable before the run: nothing is claimed, nothing changes.
      const waiting = await upload("waiting.pdf", "application/pdf", pdfBytes());
      for (let i = 0; i < 5; i++)
        await assert.rejects(scanDueAttachments(scannerPool(), 10, stub({ outcome: "NO_THREAT_FOUND" }, { available: false, code: "SCAN_ENGINE_UNREACHABLE" })), ScanEngineUnavailable);
      assert.deepEqual(await row(waiting), { scan_status: "QUARANTINED", scan_attempt: 0, scan_engine: null, scan_engine_version: null, rejection_code: null });

      // (d) Engine lost mid-run: the claim is released, five times over, and the
      // attempt budget of three is never spent.
      for (let i = 0; i < 5; i++) {
        const [o] = await scanDueAttachments(scannerPool(), 10, stub({ outcome: "UNAVAILABLE", code: "SCAN_ENGINE_UNREACHABLE" }));
        assert.equal(o.state, "QUARANTINED");
        assert.equal(o.engineCode, "SCAN_ENGINE_UNREACHABLE");
      }
      assert.equal((await row(waiting)).scan_status, "QUARANTINED");
      assert.equal((await row(waiting)).scan_attempt, 0);
      // …and the bytes are still there to be scanned when the engine returns.
      assert.deepEqual(await getAttachment(org, waiting), pdfBytes());
      await settle();

      // (e) A real adapter against a protocol double that accepts the file and
      // never answers: each run times out and spends an attempt; after three the
      // file is FAILED — not downloadable, never CLEAN.
      const double = await startClamdDouble("normal");
      try {
        const slow = await upload("slow.pdf", "application/pdf", pdfBytes());
        const engine = clamdEngine(parseClamdAddress(double.address), 400);
        double.setMode("hang");
        const states: string[] = [];
        for (let i = 0; i < 3; i++) {
          // VERSION is answered even in hang mode; INSTREAM is not.
          const [o] = await scanDueAttachments(scannerPool(), 10, engine);
          states.push(`${o.state}/${o.engineCode}`);
        }
        assert.deepEqual(states, ["QUARANTINED/SCAN_ENGINE_TIMEOUT", "QUARANTINED/SCAN_ENGINE_TIMEOUT", "FAILED/SCAN_ENGINE_TIMEOUT"]);
        assert.deepEqual(await row(slow), { scan_status: "FAILED", scan_attempt: 3, scan_engine: null, scan_engine_version: null, rejection_code: null });
        assert.deepEqual(await scanDueAttachments(scannerPool(), 10, engine), [], "a spent budget is not claimed again");

        // (f) The same adapter and double: EICAR is rejected with the engine recorded.
        double.setMode("normal");
        const eicar = await upload("sample.pdf", "application/pdf", Buffer.concat([pdfBytes(), Buffer.from(EICAR, "latin1")]));
        const [e] = await scanDueAttachments(scannerPool(), 10, engine);
        assert.equal(e.state, "REJECTED");
        assert.equal(e.rejectionCode, "MALWARE_SIGNATURE");
        const er = await row(eicar);
        assert.equal(er.scan_engine, "clamd");
        assert.match(er.scan_engine_version ?? "", /^ClamAV /);
        await assert.rejects(getAttachment(org, eicar), "rejected bytes are removed");

        // (g) An engine error reply is FAILED-and-retry, never CLEAN.
        double.setMode("size-limit");
        const odd = await upload("odd.pdf", "application/pdf", pdfBytes());
        const [g] = await scanDueAttachments(scannerPool(), 10, engine);
        assert.equal(g.state, "QUARANTINED");
        assert.equal(g.engineCode, "SCAN_ENGINE_NO_VERDICT");
        assert.equal((await row(odd)).scan_attempt, 1);
        await settle();
      } finally {
        await double.close();
      }

      // (h) The active-document policy through the whole path, even when the engine finds nothing.
      const js = await upload("report.pdf", "application/pdf", Buffer.from("%PDF-1.7\n1 0 obj<</Type/Catalog/OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1"));
      const [h] = await scanDueAttachments(scannerPool(), 10, stub({ outcome: "NO_THREAT_FOUND" }));
      assert.equal(h.state, "REJECTED");
      assert.equal((await row(js)).rejection_code, "DOCUMENT_ACTIVE_CONTENT");

      // (i) A type rejection while the engine could not answer still rejects — with no engine recorded.
      const renamed = await upload("chart.png", "image/png", Buffer.from("<html><script>1</script></html>"));
      const [i] = await scanDueAttachments(scannerPool(), 10, stub({ outcome: "TIMEOUT", code: "SCAN_ENGINE_TIMEOUT" }));
      assert.equal(i.state, "REJECTED");
      assert.deepEqual(await row(renamed), { scan_status: "REJECTED", scan_attempt: 1, scan_engine: null, scan_engine_version: null, rejection_code: "ACTIVE_CONTENT" });

      // (j) Grants: the scanner can no longer write a verdict without provenance,
      // and the provenance routine refuses CLEAN without an engine name.
      const pending = await upload("grant.pdf", "application/pdf", pdfBytes());
      await scannerPool().query("select core.claim_attachments(10)");
      await assert.rejects(
        scannerPool().query("select core.record_scan($1,'CLEAN','application/pdf',null,'1 day'::interval)", [pending]),
        /permission denied/,
      );
      await assert.rejects(
        scannerPool().query("select core.record_scan_result($1,'CLEAN','application/pdf',null,'1 day'::interval,null,null)", [pending]),
        /VALIDATION_FAILED/,
      );
      const [{ n }] = await q<{ n: string }>("select count(*)::text n from information_schema.table_privileges where grantee='orgfit_scanner'");
      assert.equal(n, "0", "the scanner still holds no table privilege");
      await assert.rejects(q("update core.attachment set scan_engine=null where id=$1", [clean]), /attachment_clean_engine/);
    });

    // =====================================================================
    await t.test("AD-2 staff-side application limits count per trusted address and per session, store no identifier, and raise an alert", async () => {
      const saved = { ...process.env };
      try {
        process.env.RATE_LIMIT_CLIENT_IP_HEADER = "x-forwarded-for";
        process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = "0";
        const from = (ip: string) => new Headers({ "x-forwarded-for": ip });
        for (let i = 0; i < 20; i++) await limitPreSession("auth/password", from("198.51.100.20"));
        const limited = await failure(() => limitPreSession("auth/password", from("198.51.100.20")));
        assert.equal(limited, "RATE_LIMITED");
        // Another address, and another endpoint for the same address, are unaffected.
        await limitPreSession("auth/password", from("198.51.100.21"));
        await limitPreSession("auth/start", from("198.51.100.20"));
        // A forged header with no trusted proxy configured counts nothing.
        delete process.env.RATE_LIMIT_CLIENT_IP_HEADER;
        const before = (await q<{ n: number }>("select count(*)::int n from access.staff_rate_limit"))[0].n;
        for (let i = 0; i < 40; i++) await limitPreSession("auth/password", from("198.51.100.20"));
        assert.equal((await q<{ n: number }>("select count(*)::int n from access.staff_rate_limit"))[0].n, before);
        // Malformed configuration fails closed.
        process.env.RATE_LIMIT_CLIENT_IP_HEADER = "x-forwarded-for";
        process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = "lots";
        assert.equal(await failure(() => limitPreSession("auth/start", from("198.51.100.30"))), "TEMPORARILY_UNAVAILABLE");
        process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = "0";

        // Per session.
        process.env.STAFF_RATE_LIMIT_API_PER_SESSION = "5";
        const token = secret();
        for (let i = 0; i < 5; i++) await limitSession(token);
        assert.equal(await failure(() => limitSession(token)), "RATE_LIMITED");
        await limitSession(secret());
        await limitSession("not-a-session"); // malformed: the session check refuses it, nothing counted

        // Stored rows: keyed digests bound to the window; no address, token or session digest.
        const rows = await q<{ k: string }>("select encode(key_digest,'hex') k from access.staff_rate_limit");
        const stored = rows.map((r) => r.k).join(" ");
        for (const needle of ["198.51.100.20", token]) assert.ok(!stored.includes(Buffer.from(needle).toString("hex")));
        assert.ok(!stored.includes(createHash("sha256").update(token).digest("hex")));
        assert.notEqual(
          staffRateDigest("password_ip", "198.51.100.20", windowStart()).toString("hex"),
          staffRateDigest("password_ip", "198.51.100.20", windowStart(Date.now() + 60_000)).toString("hex"),
        );
        // The auth credential may count but not read; the staff credential may do neither.
        for (const role of ["orgfit_auth", "orgfit_staff"]) {
          const c = new pg.Client({ connectionString: f.fixture.url(role) });
          await c.connect();
          await assert.rejects(c.query("select * from access.staff_rate_limit"), /permission denied/, role);
          if (role === "orgfit_staff")
            await assert.rejects(c.query("select access.staff_rate_hit('api_session',$1,$2,5,60)", [randomBytes(32), windowStart()]), /permission denied/);
          await c.end();
        }
        // The alert.
        const codes = evaluateAlerts(await alertInputs(coreUrl), { backupAgeHours: 1, freeDiskFraction: 0.5 }).map((a) => a.code);
        assert.ok(codes.includes("STAFF_SIGN_IN_ABUSE_SUSPECTED"), codes.join(","));
        assert.ok(codes.includes("STAFF_API_RATE_LIMITED"), codes.join(","));
        // Retention removes old windows.
        await q("update access.staff_rate_limit set window_start=clock_timestamp()-interval '1 hour'");
        await runRetention(coreUrl, anonUrl);
        assert.equal((await q<{ n: number }>("select count(*)::int n from access.staff_rate_limit"))[0].n, 0);
      } finally {
        process.env = saved;
      }
    });

    // =====================================================================
    const ledgerDir = await mkdtemp(join(tmpdir(), "orgfit-ledger-pass4-"));
    await t.test("AD-3 tombstone delivery: shipments are recorded and alerted, a tampered ledger keeps a restore closed, and a restored sequence can no longer strand tombstones (PR4-001)", async () => {
      // A deletion that needs a tombstone: an attachment deleted by retention.
      const doomed = await upload("doomed.pdf", "application/pdf", pdfBytes());
      await scanDueAttachments(scannerPool(), 10, developmentHeuristicEngine());
      await q("update core.attachment set scan_status='EXPIRED' where id=$1", [doomed]);
      // Unshipped and 20 minutes old: TOMBSTONE_SHIPPING_BEHIND.
      await q("update ops.deletion_tombstone set recorded_at=clock_timestamp()-interval '20 minutes'");
      let status = await tombstoneDeliveryStatus(coreUrl);
      assert.ok(status.unshipped >= 1);
      assert.ok(evaluateAlerts(await alertInputs(coreUrl), { backupAgeHours: 1, freeDiskFraction: 0.5 }).some((a) => a.code === "TOMBSTONE_SHIPPING_BEHIND"));
      const shipped = await shipTombstones(coreUrl, ledgerDir);
      assert.ok(shipped.shipped >= 1);
      status = await tombstoneDeliveryStatus(coreUrl);
      assert.equal(status.unshipped, 0);
      assert.equal(status.shippedThrough, shipped.cursor);
      assert.ok(!evaluateAlerts(await alertInputs(coreUrl), { backupAgeHours: 1, freeDiskFraction: 0.5 }).some((a) => a.code === "TOMBSTONE_SHIPPING_BEHIND"));
      const ledger = await readLedger(ledgerDir);
      assert.ok(ledger.some((x) => x.class === "ATTACHMENT" && x.subjectId === doomed));

      // PR4-001, reproduced. A restore returns the database to a point before
      // the last shipments: its tombstone rows and identity sequence go back.
      const cursor = shipped.cursor;
      const rewind = Math.max(0, cursor - 2);
      await q("delete from ops.deletion_tombstone where seq>$1", [rewind]);
      await q(`select setval(pg_get_serial_sequence('ops.deletion_tombstone','seq'), greatest($1,1), $2)`, [rewind, rewind > 0]);
      await markRestorePending(coreUrl);
      // Before the fix a new tombstone would take a number at or below the
      // cursor and never ship. Shipping now refuses instead of skipping it.
      const probeSeq = Number((await q<{ v: string }>("select nextval(pg_get_serial_sequence('ops.deletion_tombstone','seq'))::text v"))[0].v);
      assert.ok(probeSeq <= cursor, `the restored sequence (${probeSeq}) is behind the ledger (${cursor})`);
      await q(`select setval(pg_get_serial_sequence('ops.deletion_tombstone','seq'), greatest($1,1), $2)`, [rewind, rewind > 0]);
      assert.equal(await failure(() => shipTombstones(coreUrl, ledgerDir)), "TOMBSTONE_SEQUENCE_BEHIND_LEDGER");

      // A tampered ledger: the replay refuses and the environment stays closed.
      const file = join(ledgerDir, "tombstones.jsonl");
      const original = await readFile(file, "utf8");
      await writeFile(file, original.replace(doomed, randomUUID()));
      assert.equal(await failure(() => reapplyTombstones(coreUrl, anonUrl, ledgerDir)), "TOMBSTONE_LEDGER_INTEGRITY_FAILED");
      await assert.rejects(readiness(), /Unready/);
      await assert.rejects(gatewayReadiness(), /Unready/);
      await writeFile(file, original);

      // The verified replay advances the sequence first, so a deletion made
      // afterwards ships under a number past everything the ledger holds.
      const report = await reapplyTombstones(coreUrl, anonUrl, ledgerDir);
      assert.equal(report.opened, true);
      const second = await upload("later.pdf", "application/pdf", pdfBytes());
      await scanDueAttachments(scannerPool(), 10, developmentHeuristicEngine());
      await q("update core.attachment set scan_status='EXPIRED' where id=$1", [second]);
      const [{ seq }] = await q<{ seq: string }>("select seq::text from ops.deletion_tombstone where subject_id=$1", [second]);
      assert.ok(Number(seq) > cursor, `new tombstone ${seq} is past the ledger cursor ${cursor}`);
      await shipTombstones(coreUrl, ledgerDir);
      assert.ok((await readLedger(ledgerDir)).some((x) => x.subjectId === second), "the post-restore deletion reached the ledger");
      // The routine never moves the sequence backwards.
      await q("select ops.advance_tombstone_sequence(1)");
      assert.ok(Number((await q<{ v: string }>("select last_value::text v from ops.deletion_tombstone_seq_seq"))[0].v) >= Number(seq));
    });

    // =====================================================================
    await t.test("AD-4 intake erasure: only for the reported restore incident, only with an approver, reference and count; audited, immutable, retry-safe, tombstone kept", async () => {
      const lost = await submittedCampaign();
      const bystander = await submittedCampaign(f.people.slice(0, 5));
      await f.closeCampaign(lost);
      await f.closeCampaign(bystander);
      const counts = async (cid: string) =>
        (await q<{ inbox: number; invitations: number }>(
          "select (select count(*)::int from intake.submission_inbox where campaign_id=$1) inbox, (select count(*)::int from core.invitation where campaign_id=$1) invitations",
          [cid],
        ))[0];
      const anon = new pg.Client({ connectionString: anonUrl });
      await anon.connect();
      await anon.query("SET ROLE orgfit_anon_owner");
      const anonCount = async () => (await anon.query("select count(*)::int n from anonymous.anonymous_response")).rows[0].n as number;
      const anonBefore = await anonCount();
      const input = {
        organizationId: org,
        campaignId: lost,
        approverEmail: "admin@example.invalid",
        incidentReference: "INC-2026-0915-SYNTHETIC",
        reason: "Synthetic restore incident: owner decided to erase unrecoverable intake.",
        expectedEnvelopes: f.people.length,
      };
      try {
        // Not an incident yet: the ledger does not say this campaign's intake was ever erased.
        assert.equal(await failure(() => eraseCampaignIntake(coreUrl, anonUrl, ledgerDir, input)), "NOT_A_RESTORE_INCIDENT");
        // The ledger says it was (the restore brought the envelopes back); the replay reports the incident.
        await q("select ops.tombstone('CAMPAIGN_INTAKE',$1,$2)", [org, lost]);
        await shipTombstones(coreUrl, ledgerDir);
        await markRestorePending(coreUrl);
        const report = await reapplyTombstones(coreUrl, anonUrl, ledgerDir);
        assert.deepEqual(report.incidents, [{ campaignId: lost, reason: "ANONYMOUS_OUTPUT_MISSING_FOR_ERASED_INTAKE" }]);
        assert.equal(report.opened, false);

        // Negative paths: nothing changes.
        assert.equal(await failure(() => eraseCampaignIntake(coreUrl, anonUrl, ledgerDir, { ...input, approverEmail: "staff@example.invalid" })), "APPROVER_REQUIRED");
        assert.equal(await failure(() => eraseCampaignIntake(coreUrl, anonUrl, ledgerDir, { ...input, approverEmail: "disabled@example.invalid" })), "APPROVER_REQUIRED");
        assert.equal(await failure(() => eraseCampaignIntake(coreUrl, anonUrl, ledgerDir, { ...input, expectedEnvelopes: 5 })), "CONFIRMATION_MISMATCH");
        assert.equal(await failure(() => eraseCampaignIntake(coreUrl, anonUrl, ledgerDir, { ...input, reason: "short" })), "VALIDATION_FAILED");
        assert.equal(await failure(() => eraseCampaignIntake(coreUrl, anonUrl, ledgerDir, { ...input, incidentReference: " " })), "VALIDATION_FAILED");
        assert.equal(await failure(() => eraseCampaignIntake(coreUrl, anonUrl, ledgerDir, { ...input, campaignId: bystander })), "NOT_A_RESTORE_INCIDENT");
        await q("select ops.set_restore_state('NORMAL')");
        assert.equal(await failure(() => eraseCampaignIntake(coreUrl, anonUrl, ledgerDir, input)), "RESTORE_INCIDENT_REQUIRED");
        await markRestorePending(coreUrl);
        // An open campaign is refused by the routine itself, whatever the caller checked.
        const { campaignId: open } = await f.launchedCampaign(f.people.slice(0, 1));
        assert.equal(
          await failure(() => f.operator.query("select ops.erase_campaign_intake($1,$2,'admin@example.invalid','INC-X','A synthetic reason text',0)", [org, open])),
          "STATE_CONFLICT",
        );
        // No application credential can call it.
        for (const role of ["orgfit_staff", "orgfit_auth", "orgfit_processor", "orgfit_gateway", "orgfit_scanner", "orgfit_report"]) {
          const c = new pg.Client({ connectionString: f.fixture.url(role) });
          await c.connect();
          await assert.rejects(c.query("select ops.erase_campaign_intake($1,$2,'admin@example.invalid','INC-X','A synthetic reason text',6)", [org, lost]), /permission denied/, role);
          await c.end();
        }
        assert.equal((await counts(lost)).inbox, f.people.length, "nothing erased by any refused attempt");

        // The approved erasure.
        const invitationsBefore = (await counts(lost)).invitations;
        const done = await eraseCampaignIntake(coreUrl, anonUrl, ledgerDir, input);
        assert.equal(done.replayed, false);
        assert.equal(done.envelopesErased, f.people.length);
        assert.deepEqual(await counts(lost), { inbox: 0, invitations: invitationsBefore }, "envelopes gone; completion records kept");
        assert.equal((await counts(bystander)).inbox, 5, "another campaign's intake is untouched");
        assert.equal(await anonCount(), anonBefore, "nothing anonymous is touched");
        const [audit] = await q<{ actor_id: string; action: string; field_names: string[] }>(
          "select actor_id, action, field_names from ops.audit_log where target_id=$1 and action='INTAKE_ERASED'",
          [lost],
        );
        assert.deepEqual(audit, { actor_id: ids.admin, action: "INTAKE_ERASED", field_names: ["campaign"] });
        assert.equal((await q<{ n: number }>("select count(*)::int n from ops.deletion_tombstone where class='CAMPAIGN_INTAKE' and subject_id=$1", [lost]))[0].n, 1);
        // The record is immutable, for the operator too.
        for (const statement of ["update ops.intake_erasure set reason='changed reason text here'", "delete from ops.intake_erasure", "truncate ops.intake_erasure"])
          await assert.rejects(q(statement), /INTAKE_ERASURE_IMMUTABLE/, statement);
        // A retried command returns the same record and erases nothing further.
        const again = await eraseCampaignIntake(coreUrl, anonUrl, ledgerDir, input);
        assert.equal(again.replayed, true);
        assert.equal(again.id, done.id);
        assert.equal((await q<{ n: number }>("select count(*)::int n from ops.audit_log where target_id=$1 and action='INTAKE_ERASED'", [lost]))[0].n, 1);
        // With the incident resolved, the replay opens the environment.
        const reopened = await reapplyTombstones(coreUrl, anonUrl, ledgerDir);
        assert.deepEqual(reopened.incidents, []);
        assert.equal(reopened.opened, true);
        await readiness();
        // The tombstone ships, so a later restore erases the intake again automatically.
        await shipTombstones(coreUrl, ledgerDir);
        assert.ok((await readLedger(ledgerDir)).some((x) => x.class === "CAMPAIGN_INTAKE" && x.subjectId === lost));
      } finally {
        await anon.end();
        await q("select ops.set_restore_state('NORMAL')");
      }
    });

    // =====================================================================
    await t.test("AD-5 the processor records the custody provider's own destruction evidence, which never claims crypto-erasure", async () => {
      const campaignId = await submittedCampaign();
      await f.closeCampaign(campaignId);
      const processed = await processCampaign(processorCore, processorAnon, campaignId);
      assert.equal(processed.processedCount, f.people.length);
      const keys = await q<{ state: string; destruction_evidence: string }>(
        "select state, destruction_evidence from intake.campaign_key where campaign_id=$1",
        [campaignId],
      );
      assert.ok(keys.length >= 1);
      for (const k of keys) {
        assert.equal(k.state, "DESTROYED");
        assert.match(k.destruction_evidence, /^development-file custody: sealed key file unlinked; not crypto-erasure/);
      }
    });
  } finally {
    await closeScannerPool();
    await processorCore.end();
    await processorAnon.end();
    await f.close();
  }
});
