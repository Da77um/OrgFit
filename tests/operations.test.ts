import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { withStaff, readiness } from "../src/db";
import { participation, createLinkExport, linkExportKey, invitationAction } from "../src/campaigns";
import { exchange, instrument, finalize, rateLimit } from "../src/respondent";
import { processCampaign } from "../src/processor";
import { gatewayReadiness } from "../src/gateway-db";
import { rateDigest, windowStart } from "../src/rate-limit";
import {
  alertInputs,
  evaluateAlerts,
  markRestorePending,
  reapplyTombstones,
  readLedger,
  runRetention,
  shipTombstones,
  ALERT_THRESHOLDS,
  type AlertInputs,
} from "../src/operations";
import { migrate } from "../scripts/migrate";
import { setupDatabase } from "./database";
import { respondentFixture, failure, type Fixture } from "./respondent-fixture";
import type { Instrument } from "../src/instrument-input";

// Phase 14 operations suite: migrations, public rate limits, retention,
// tombstones, the restore replay and alert drills — against the real routines
// on a real PostgreSQL cluster. The timed physical backup/restore drill and the
// load measurements are separate harnesses under tests/ops/.

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
const headersFrom = (ip: string) => new Headers({ "x-forwarded-for": ip });
const fakeToken = () => randomBytes(32).toString("base64url");

test("O-1 fresh install and a populated upgrade from 016 apply 017 once, with stable checksums", async () => {
  const f = await setupDatabase("http://127.0.0.1:4010", true, "016_local_access.sql");
  const db = new pg.Client({ connectionString: f.url("orgfit_migrator") });
  await db.connect();
  try {
    await db.query("SET ROLE orgfit_core_owner");
    const before = await db.query("select count(*)::int n from core.organization");
    assert.equal(
      (await db.query("select to_regclass('ops.retention_policy') t")).rows[0].t,
      null,
      "017 is not applied yet",
    );
    const started = Date.now();
    await migrate(f.url("orgfit_migrator"));
    const upgradeMs = Date.now() - started;
    await migrate(f.url("orgfit_migrator")); // idempotent re-run
    const after = await db.query("select count(*)::int n from core.organization");
    assert.equal(after.rows[0].n, before.rows[0].n, "the upgrade keeps existing rows");
    const policy = await db.query("select count(*)::int n, count(*) filter (where approved)::int approved from ops.retention_policy");
    assert.deepEqual(policy.rows[0], { n: 16, approved: 0 });
    const ledger = await db.query("select count(*)::int n from public.orgfit_migrations where name='017_operations.sql'");
    assert.equal(ledger.rows[0].n, 1);
    console.log(`O-1 populated upgrade 016->017: ${upgradeMs} ms`);
  } finally {
    await db.end();
  }
});

test("O-8 migration 018 changes when row security is evaluated, never what any caller can see", async () => {
  const issuer = "http://127.0.0.1:4010";
  const f = await setupDatabase(issuer, true, "017_operations.sql");
  const op = new pg.Client({ connectionString: f.url("orgfit_migrator") });
  const auth = new pg.Client({ connectionString: f.url("orgfit_auth") });
  await Promise.all([op.connect(), auth.connect()]);
  try {
    await op.query("SET ROLE orgfit_core_owner");
    const orgs = (await op.query("select id from core.organization order by id")).rows.map((r) => r.id as string);
    const [orgA, orgB] = orgs;
    for (const org of [orgA, orgB])
      for (let i = 0; i < 3; i++) {
        const dept = randomUUID();
        await op.query("insert into core.department(id,organization_id,code,name_ar) values($1,$2,$3,'قسم')", [dept, org, `D${i}${org.slice(-4)}`]);
        await op.query(
          "insert into core.participant(id,organization_id,private_reference,display_name,department_id) select gen_random_uuid(),$1,'P-'||g||'-'||$3,'مشارك',$2 from generate_series(1,5) g",
          [org, dept, i],
        );
      }
    // An unassigned member holding every capability, and the seeded member
    // assigned to one organization, given the directory capability.
    const unassigned = randomUUID();
    await op.query(
      "insert into access.staff_user(id,issuer,provider_subject,email,display_name,role,status) values($1,$2,'unassigned-o8','o8@example.invalid','غير مسند','STAFF','ACTIVE')",
      [unassigned, issuer],
    );
    const member = (await op.query("select staff_user_id from access.organization_access limit 1")).rows[0].staff_user_id as string;
    for (const who of [member, unassigned])
      for (const cap of ["directory.manage", "campaigns.manage", "participation.read", "participation.export"])
        await op.query("insert into access.staff_capability(staff_user_id,capability) values($1,$2) on conflict do nothing", [who, cap]);
    const subjects = (await op.query("select id, provider_subject from access.staff_user where status='ACTIVE'")).rows as { id: string; provider_subject: string }[];
    const subjectOf = (id: string) => subjects.find((x) => x.id === id)!.provider_subject;
    const admin = (await op.query("select id from access.staff_user where role='SUPER_ADMIN' and status='ACTIVE' limit 1")).rows[0].id as string;
    const tokens: Record<string, string | null> = { none: null };
    for (const [name, id] of [["admin", admin], ["member", member], ["unassigned", unassigned]] as const) {
      const token = randomBytes(32).toString("base64url");
      await auth.query("select access.issue_session($1,$2,$3)", [issuer, subjectOf(id), createHash("sha256").update(token).digest()]);
      tokens[name] = token;
    }
    const tables = ["core.organization", "core.department", "core.participant", "core.directory_import", "core.invitation", "core.campaign_roster", "ops.private_export"];
    const visible = async () => {
      const out: Record<string, Record<string, string>> = {};
      const c = new pg.Client({ connectionString: f.url("orgfit_staff") });
      await c.connect();
      try {
        for (const [name, token] of Object.entries(tokens)) {
          out[name] = {};
          for (const table of tables) {
            await c.query("BEGIN");
            if (token)
              await c.query("select set_config('orgfit.session_digest',$1,true)", [createHash("sha256").update(token).digest("hex")]);
            const col = table === "core.organization" ? "id" : "organization_id";
            const r = await c.query(`select coalesce(string_agg(${col}::text||':'||n,',' order by ${col}),'') v from (select ${col}, count(*) n from ${table} group by ${col}) x`);
            await c.query("COMMIT");
            out[name][table] = r.rows[0].v;
          }
        }
      } finally {
        await c.end();
      }
      return out;
    };
    const before = await visible();
    await migrate(f.url("orgfit_migrator"));
    const after = await visible();
    assert.deepEqual(after, before);
    // And the comparison is not vacuous: the three callers see different things.
    assert.ok(before.admin["core.participant"].includes(orgA) && before.admin["core.participant"].includes(orgB));
    assert.ok(before.member["core.participant"].length > 0 && !before.member["core.participant"].includes(orgB));
    assert.equal(before.unassigned["core.participant"], "");
    assert.equal(before.none["core.organization"], "");
  } finally {
    await op.end();
    await auth.end();
  }
});

test("Phase 14 operations against a live campaign", async (t) => {
  const f: Fixture = await respondentFixture(6);
  const coreUrl = f.fixture.url("orgfit_migrator");
  const anonUrl = f.fixture.anonymousUrl("orgfit_anon_migrator");
  const processorCore = new pg.Pool({ connectionString: f.fixture.url("orgfit_processor"), max: 2 });
  const processorAnon = new pg.Pool({ connectionString: f.fixture.anonymousUrl("orgfit_processor"), max: 2 });
  const ledgerDir = await mkdtemp(join(tmpdir(), "orgfit-ledger-"));
  process.env.DATABASE_URL = f.fixture.url("orgfit_staff");
  process.env.ATTACHMENT_LOCAL_DIRECTORY = await mkdtemp(join(tmpdir(), "orgfit-att-"));
  process.env.ATTACHMENT_ENCRYPTION_KEY = "c".repeat(64);
  const superAdmin = await f.session("admin");

  async function submittedCampaign(people = f.people) {
    const { campaignId } = await f.launchedCampaign(people);
    const links = await f.issueLinks(campaignId);
    for (const link of links) {
      const s = await exchange(link.token);
      const d = (await instrument(s.session!)).document;
      await finalize(s.session!, { answers: answersFor(d) });
    }
    return { campaignId, links };
  }

  try {
    // =====================================================================
    await t.test("O-2 rate limits bound retries without consuming an invitation, and tolerate a shared NAT", async () => {
      process.env.RATE_LIMIT_CLIENT_IP_HEADER = "x-forwarded-for";
      const { campaignId } = await f.launchedCampaign(f.people.slice(0, 1));
      const [link] = await f.issueLinks(campaignId);

      // Per token: ten exchanges in a window pass, the eleventh is limited.
      for (let i = 0; i < 10; i++)
        await rateLimit("exchange", headersFrom(`198.51.100.${i}`), { token: link.token });
      assert.equal(
        await failure(() => rateLimit("exchange", headersFrom("198.51.100.99"), { token: link.token })),
        "RATE_LIMITED",
      );
      // The limit changed nothing about the invitation: it is still READY and
      // the link still opens a session.
      const inv = await f.operator.query("select status, token_generation from core.invitation where id=$1", [link.invitationId]);
      assert.equal(inv.rows[0].status, "READY");
      const opened = await exchange(link.token);
      assert.equal((opened.context as { access: string }).access, "OPEN");

      // One office NAT: 250 different respondents' links opened within a
      // minute from one address are all allowed at the default IP limit.
      for (let i = 0; i < 250; i++)
        await rateLimit("exchange", headersFrom("203.0.113.7"), { token: fakeToken() });
      // …and a flood from that address is bounded.
      let limited = 0;
      for (let i = 0; i < 60; i++)
        if ((await failure(() => rateLimit("exchange", headersFrom("203.0.113.7"), { token: fakeToken() }))) === "RATE_LIMITED")
          limited++;
      assert.ok(limited >= 9, `a flood is limited (${limited})`);

      // Per session: 30 draft writes and 5 final attempts per window.
      const session = fakeToken();
      for (let i = 0; i < 30; i++) await rateLimit("draft", new Headers(), { session });
      assert.equal(await failure(() => rateLimit("draft", new Headers(), { session })), "RATE_LIMITED");
      const other = fakeToken();
      for (let i = 0; i < 5; i++) await rateLimit("final", new Headers(), { session: other });
      assert.equal(await failure(() => rateLimit("final", new Headers(), { session: other })), "RATE_LIMITED");

      // Without a trusted proxy header configured, a client-supplied address is
      // ignored rather than trusted.
      delete process.env.RATE_LIMIT_CLIENT_IP_HEADER;
      for (let i = 0; i < 400; i++)
        await rateLimit("exchange", headersFrom("203.0.113.7"), { token: fakeToken() });

      // What is stored: keyed digests only, bound to the window. No address,
      // token or session value appears in any row, and one client's key differs
      // between windows.
      const rows = await f.operator.query("select bucket, encode(key_digest,'hex') k from intake.rate_limit");
      const stored = rows.rows.map((r) => r.k).join(" ");
      for (const needle of ["203.0.113.7", link.token, session])
        assert.ok(!stored.includes(Buffer.from(needle).toString("hex")));
      assert.ok(!stored.includes(createHash("sha256").update(session).digest("hex")));
      const now = Date.now();
      assert.notEqual(
        rateDigest("draft_session", "x", windowStart(now)).toString("hex"),
        rateDigest("draft_session", "x", windowStart(now + 60_000)).toString("hex"),
      );
      assert.deepEqual(Object.keys(rows.rows[0]).sort(), ["bucket", "k"]);
      const columns = await f.operator.query(
        "select column_name from information_schema.columns where table_schema='intake' and table_name='rate_limit' order by 1",
      );
      assert.deepEqual(columns.rows.map((r) => r.column_name), ["bucket", "hits", "key_digest", "window_start"]);
      // The gateway credential can count but cannot read the table.
      const gateway = new pg.Client({ connectionString: f.fixture.url("orgfit_gateway") });
      await gateway.connect();
      await assert.rejects(gateway.query("select * from intake.rate_limit"), /permission denied/);
      // The two routines Phase 14 added to the gateway's surface return only
      // what they are documented to return (Checkpoint C lists them).
      const hitResult = await gateway.query(
        "select intake.rate_hit('draft_session',$1,$2,30,60) r",
        [randomBytes(32), windowStart()],
      );
      assert.deepEqual(Object.keys(hitResult.rows[0].r).sort(), ["allowed", "retryAfter"]);
      const refResult = await gateway.query("select intake.gateway_instrument_ref($1) r", [
        createHash("sha256").update(opened.session!).digest(),
      ]);
      assert.deepEqual(Object.keys(refResult.rows[0].r).sort(), ["endsAt", "instrumentHash", "locales", "notice", "versionId"]);
      await gateway.end();
    });

    // =====================================================================
    await t.test("O-3 retention purges by policy, anonymous answers go whole-campaign, and every class is recorded", async () => {
      // A processed, eligible campaign.
      const { campaignId } = await submittedCampaign();
      await f.closeCampaign(campaignId);
      const processed = await processCampaign(processorCore, processorAnon, campaignId);
      assert.equal(processed.processedCount, f.people.length);

      // Backdate what each class retires.
      await f.operator.query(
        "insert into ops.audit_log(actor_id,action,target_id,field_names,occurred_at) values($1,'LOGOUT',$1,'{}',clock_timestamp()-interval '400 days')",
        ["00000000-0000-4000-8000-000000000001"],
      );
      await f.operator.query(
        "insert into intake.rate_limit(bucket,key_digest,window_start,hits) values('draft_session',$1,clock_timestamp()-interval '1 hour',3)",
        [randomBytes(32)],
      );
      const anonOwner = new pg.Client({ connectionString: anonUrl });
      await anonOwner.connect();
      await anonOwner.query("SET ROLE orgfit_anon_owner");
      await anonOwner.query(
        "update anonymous.processed_batch set committed_at=clock_timestamp()-interval '400 days' where campaign_id=$1",
        [campaignId],
      );
      const beforeAnon = await anonOwner.query("select count(*)::int n from anonymous.anonymous_response where campaign_id=$1", [campaignId]);
      assert.equal(beforeAnon.rows[0].n, f.people.length);

      const result = await runRetention(coreUrl, anonUrl);
      assert.ok(result.audit_log >= 1, "old audit record removed");
      assert.ok(result.rate_limit_window >= 1, "old rate window removed");
      assert.equal(result.anonymous_campaigns, 1);
      const afterAnon = await anonOwner.query(
        "select (select count(*)::int from anonymous.anonymous_response where campaign_id=$1) responses, (select count(*)::int from anonymous.anonymous_answer where campaign_id=$1) answers, (select count(*)::int from anonymous.processed_batch where campaign_id=$1) markers",
        [campaignId],
      );
      await anonOwner.end();
      assert.deepEqual(afterAnon.rows[0], { responses: 0, answers: 0, markers: 0 });

      // Tombstones: the campaign's intake was cleaned, its key destroyed and
      // its anonymous set purged — three campaign-level records, no person.
      const stones = await f.operator.query(
        "select class from ops.deletion_tombstone where subject_id=$1 order by class",
        [campaignId],
      );
      assert.deepEqual(stones.rows.map((r) => r.class), ["ANONYMOUS_CAMPAIGN", "CAMPAIGN_INTAKE", "CAMPAIGN_KEY"]);
      const runs = await f.operator.query("select distinct class from ops.retention_run");
      assert.ok(runs.rows.length >= 10, "each class records its run");
      // No retention class is silently approved.
      const approved = await f.operator.query("select count(*)::int n from ops.retention_policy where approved");
      assert.equal(approved.rows[0].n, 0);
    });

    // =====================================================================
    let exportId = "";
    await t.test("O-4 an expired export is tombstoned, shipped once, and the ledger names objects only", async () => {
      const { campaignId } = await f.launchedCampaign(f.people.slice(0, 2));
      const list = (await withStaff(superAdmin, (tx) => participation(tx, f.orgA, campaignId))) as {
        items: { invitationId: string; generation: number }[];
      };
      const created = (await withStaff(superAdmin, (tx) =>
        createLinkExport(
          tx,
          f.orgA,
          campaignId,
          {
            invitationIds: list.items.map((i) => i.invitationId),
            expectedGenerations: list.items.map((i) => i.generation),
            confirmRotation: false,
          },
          randomUUID(),
        ),
      )) as { exportId: string };
      exportId = created.exportId;
      await f.operator.query("update ops.private_export set expires_at=clock_timestamp()-interval '1 minute' where id=$1", [exportId]);
      await runRetention(coreUrl, anonUrl);
      assert.equal(
        (await f.operator.query("select state from ops.private_export where id=$1", [exportId])).rows[0].state,
        "EXPIRED",
      );
      const first = await shipTombstones(coreUrl, ledgerDir);
      const second = await shipTombstones(coreUrl, ledgerDir);
      assert.ok(first.shipped >= 4);
      assert.equal(second.shipped, 0, "shipping is idempotent");
      const ledger = await readLedger(ledgerDir);
      assert.ok(ledger.some((x) => x.class === "PRIVATE_EXPORT" && x.subjectId === exportId));
      const raw = await readFile(join(ledgerDir, "tombstones.jsonl"), "utf8");
      for (const line of raw.trim().split("\n"))
        assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ["class", "organizationId", "recordedAt", "seq", "subjectId"]);
      for (const forbidden of ["answer", "token", "participant", "invitation", "ciphertext"])
        assert.ok(!raw.includes(forbidden), forbidden);
    });

    // =====================================================================
    await t.test("O-5 a restored environment stays closed until the ledger is replayed; an unrecoverable payload keeps it closed", async () => {
      // Simulate the restored state of the export: the backup predates expiry.
      await f.operator.query("update ops.private_export set state='READY', expires_at=clock_timestamp()+interval '1 hour' where id=$1", [exportId]);
      await markRestorePending(coreUrl);
      await assert.rejects(readiness(), /Unready/);
      // The respondent gateway is closed by the same gate.
      await assert.rejects(gatewayReadiness(), /Unready/);

      // A campaign whose intake the ledger says was erased, but whose anonymous
      // output this "restored" store does not hold: a real data incident.
      const { campaignId: lost } = await submittedCampaign();
      await f.operator.query("select ops.tombstone('CAMPAIGN_INTAKE',$1,$2)", [f.orgA, lost]);
      await shipTombstones(coreUrl, ledgerDir);

      const report = await reapplyTombstones(coreUrl, anonUrl, ledgerDir);
      assert.equal(report.applied.PRIVATE_EXPORT, 1, "the revived export is expired again");
      assert.equal(
        await failure(() => withStaff(superAdmin, (tx) => linkExportKey(tx, f.orgA, exportId))),
        "NOT_FOUND",
      );
      assert.deepEqual(report.incidents, [{ campaignId: lost, reason: "ANONYMOUS_OUTPUT_MISSING_FOR_ERASED_INTAKE" }]);
      assert.equal(report.opened, false);
      // The envelopes are kept for the humans deciding what happened.
      const inbox = await f.operator.query("select count(*)::int n from intake.submission_inbox where campaign_id=$1", [lost]);
      assert.equal(inbox.rows[0].n, f.people.length);
      await assert.rejects(readiness(), /Unready/);

      const decided = await reapplyTombstones(coreUrl, anonUrl, ledgerDir, { openDespiteIncidents: true });
      assert.equal(decided.opened, true);
      await readiness();
      await gatewayReadiness();
    });

    // =====================================================================
    await t.test("O-6 alert drills: every condition raises its alert, and a healthy system raises none of the critical ones", async () => {
      const healthy: AlertInputs = {
        restoreState: "NORMAL",
        countMismatch: 0,
        blockedReleases: 0,
        closedUnprocessedOverdue: 0,
        insufficientIntakeOverdue: 0,
        reportQueueOldestSeconds: 0,
        reportFailedLastDay: 0,
        attachmentQuarantineOldestSeconds: 0,
        rateLimitedLastWindow: 0,
        lastRetentionRun: new Date().toISOString(),
        unapprovedRetentionClasses: 0,
      };
      const host: { backupAgeHours: number | null; freeDiskFraction: number | null } = { backupAgeHours: 1, freeDiskFraction: 0.5 };
      assert.deepEqual(evaluateAlerts(healthy, host), []);
      const drills: [Partial<AlertInputs> | null, Partial<typeof host> | null, string][] = [
        [{ restoreState: "REAPPLY_PENDING" }, null, "RESTORE_REAPPLY_PENDING"],
        [{ countMismatch: 1 }, null, "INTAKE_PROCESSED_COUNT_MISMATCH"],
        [{ blockedReleases: 1 }, null, "PUBLICATION_BLOCKED"],
        [{ closedUnprocessedOverdue: 1 }, null, "CLOSED_CAMPAIGN_UNPROCESSED"],
        [{ insufficientIntakeOverdue: 1 }, null, "INSUFFICIENT_INTAKE_RETENTION_OVERDUE"],
        [{ reportQueueOldestSeconds: ALERT_THRESHOLDS.reportQueueSeconds + 1 }, null, "REPORT_QUEUE_BACKLOG"],
        [{ reportFailedLastDay: 2 }, null, "EXPORT_FAILURES"],
        [{ attachmentQuarantineOldestSeconds: ALERT_THRESHOLDS.attachmentQuarantineSeconds + 1 }, null, "SCAN_BACKLOG"],
        [{ rateLimitedLastWindow: 12 }, null, "TOKEN_ABUSE_SUSPECTED"],
        [{ lastRetentionRun: null }, null, "RETENTION_NOT_RUNNING"],
        [{ unapprovedRetentionClasses: 16 }, null, "RETENTION_POLICY_UNAPPROVED"],
        [null, { backupAgeHours: null }, "BACKUP_STALE_OR_MISSING"],
        [null, { backupAgeHours: 30 }, "BACKUP_STALE_OR_MISSING"],
        [null, { freeDiskFraction: 0.05 }, "LOW_DISK"],
      ];
      for (const [input, h, code] of drills) {
        const alerts = evaluateAlerts({ ...healthy, ...(input ?? {}) }, { ...host, ...(h ?? {}) });
        assert.deepEqual(alerts.map((a) => a.code), [code], code);
      }

      // The same conditions produced for real in the database.
      const { campaignId: stuck } = await submittedCampaign(f.people.slice(0, 5));
      await f.closeCampaign(stuck);
      await f.operator.query("update core.campaign set closed_at=clock_timestamp()-interval '2 days' where id=$1", [stuck]).catch(() => undefined);
      await f.operator.query("update core.campaign set release_state='BLOCKED' where id=$1", [stuck]).catch(() => undefined);
      for (let i = 0; i < 12; i++) await rateLimit("final", new Headers(), { session: "Z".repeat(43) }).catch(() => undefined);
      await markRestorePending(coreUrl);
      const live = await alertInputs(coreUrl);
      const codes = evaluateAlerts(live, host).map((a) => a.code);
      for (const code of ["RESTORE_REAPPLY_PENDING", "TOKEN_ABUSE_SUSPECTED", "RETENTION_POLICY_UNAPPROVED", "CLOSED_CAMPAIGN_UNPROCESSED"])
        assert.ok(codes.includes(code), `${code} in ${codes.join(",")}`);
      assert.equal(live.unapprovedRetentionClasses, 16);
      await f.operator.query("select ops.set_restore_state('NORMAL')");
      // Alert inputs carry counts, ages and states only.
      assert.ok(Object.values(live).every((v) => v === null || typeof v === "number" || typeof v === "string"));
      assert.ok(!JSON.stringify(live).includes(stuck));
    });
    // =====================================================================
    await t.test("O-7 digest-key rotation keeps outstanding links working through a window, then retires them", async () => {
      const { campaignId } = await f.launchedCampaign(f.people.slice(0, 2));
      const [oldLink] = await f.issueLinks(campaignId);
      const oldKey = process.env.INVITATION_DIGEST_KEY!;
      const newKey = "f".repeat(64);
      try {
        process.env.INVITATION_DIGEST_KEY = newKey;
        process.env.INVITATION_DIGEST_KEY_VERSION = "rotated-v2";
        // Without the previous key, an old link no longer opens.
        delete process.env.INVITATION_DIGEST_KEY_PREVIOUS;
        assert.equal(((await exchange(oldLink.token)).context as { access: string }).access, "UNAVAILABLE");
        // During the rotation window it does.
        process.env.INVITATION_DIGEST_KEY_PREVIOUS = oldKey;
        assert.equal(((await exchange(oldLink.token)).context as { access: string }).access, "OPEN");
        // A link issued after rotation carries the new key's version.
        const list = (await withStaff(superAdmin, (tx) => participation(tx, f.orgA, campaignId))) as {
          items: { invitationId: string; generation: number; issued: boolean }[];
        };
        const fresh = list.items.find((i) => i.invitationId !== oldLink.invitationId)!;
        const issued = (await withStaff(superAdmin, (tx) =>
          invitationAction(tx, f.orgA, campaignId, fresh.invitationId, "ROTATE", { expectedGeneration: fresh.generation, reason: "تدوير المفتاح" }, randomUUID()),
        )) as { url: string };
        const reissued = { token: issued.url.split("#")[1] };
        const version = await f.operator.query("select digest_key_version v from core.invitation where id=$1", [fresh.invitationId]);
        assert.equal(version.rows[0].v, "rotated-v2");
        // Closing the window retires old links and keeps new ones.
        delete process.env.INVITATION_DIGEST_KEY_PREVIOUS;
        assert.equal(((await exchange(reissued.token)).context as { access: string }).access, "OPEN");
        assert.equal(((await exchange(oldLink.token)).context as { access: string }).access, "UNAVAILABLE");
      } finally {
        process.env.INVITATION_DIGEST_KEY = oldKey;
        process.env.INVITATION_DIGEST_KEY_VERSION = "test-v1";
        delete process.env.INVITATION_DIGEST_KEY_PREVIOUS;
      }
    });
  } finally {
    await processorCore.end();
    await processorAnon.end();
    await f.close();
  }
});
