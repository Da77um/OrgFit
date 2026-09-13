import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import pg from "pg";
import { withStaff } from "../src/db";
import { participation, campaignDetail, createLinkExport, linkExportKey } from "../src/campaigns";
import { getExport } from "../src/link-storage";
import { exchange, status, instrument, finalize, draftRead, draftCreate } from "../src/respondent";
import {
  CIPHER_VERSION,
  decryptDraft,
  encryptDraft,
  importDraftKey,
  newDraftKeyBytes,
  newHandle,
} from "../src/draft-format";
import { processCampaign, reconcile, type FaultPoint } from "../src/processor";
import { openCampaignKey } from "../src/key-custody";
import type { Instrument } from "../src/instrument-input";
import { respondentFixture, failure, type Fixture } from "./respondent-fixture";

// ---------------------------------------------------------------------------
// CHECKPOINT C — blocking privacy and submission-reliability gate.
//
// This suite is deliberately adversarial and independent of the Phase 07 tests.
// Where Phase 07 asserted "the code does what it says", this suite starts from
// the attacker's side: it enumerates the privileges the database ACTUALLY
// grants, then tries to walk from a named participant to that person's
// finalized answers by every route the blueprint names — schema keys, token
// digests, draft handles, request identifiers, row order, timestamps, audit
// columns, jobs, errors and exports.
//
// It does not re-use the Phase 07 assertions. Where it re-runs concurrency and
// crash boundaries, it does so because the checkpoint requires independent
// confirmation, and it checks different invariants than the phase suite did.
// ---------------------------------------------------------------------------

// A marker value unique to each respondent, carried in a NUMBER answer. If any
// correlation channel survives, this is what lets the test detect it: knowing
// the marker tells you which person answered.
const MARKER_QUESTION = (d: Instrument) =>
  d.sections.flatMap((s) => s.questions).find((q) => q.type === "NUMBER")!;

function answersFor(d: Instrument, marker: number) {
  const answers: Record<string, string | string[]> = {};
  for (const q of d.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    switch (q.type) {
      case "SHORT_TEXT":
      case "LONG_TEXT":
        answers[q.id] = "إجابة";
        break;
      case "RATING_5":
        answers[q.id] = "3";
        break;
      case "RATING_10":
        answers[q.id] = "6";
        break;
      case "NUMBER":
        answers[q.id] = String(marker); // the identifying marker
        break;
      case "DATE":
        answers[q.id] = "2026-06-15";
        break;
      case "CHECKBOXES":
        answers[q.id] = [q.options[0].id];
        break;
      case "MATRIX":
        for (const row of q.rows) answers[row.id] = q.columns[0].id;
        break;
      default:
        answers[q.id] = q.options[0].id;
    }
  }
  return answers;
}

test("Checkpoint C: privacy and submission reliability gate", async (t) => {
  const f: Fixture = await respondentFixture(7);
  const core = new pg.Pool({
    connectionString: f.fixture.url("orgfit_processor"),
    max: 4,
  });
  const anon = new pg.Pool({
    connectionString: f.fixture.anonymousUrl("orgfit_processor"),
    max: 4,
  });
  // A SUPER_ADMIN session. access.is_admin() bypasses both the organization
  // assignment and every capability check, so this is the strongest staff
  // identity the product has.
  const superAdmin = await f.session("admin");

  // Build one fully processed campaign whose submission order is known.
  const { campaignId } = await f.launchedCampaign(f.people);
  const links = await f.issueLinks(campaignId);
  const submissionOrder: { invitationId: string; marker: number }[] = [];
  let coverage: Instrument | null = null;
  for (let i = 0; i < links.length; i++) {
    const opened = await exchange(links[i].token);
    const document = (await instrument(opened.session!)).document;
    coverage ??= document;
    await finalize(opened.session!, { answers: answersFor(document, i) });
    submissionOrder.push({ invitationId: links[i].invitationId, marker: i });
  }
  await f.closeCampaign(campaignId);
  const markerKey = MARKER_QUESTION(coverage!).key;

  try {
    // =====================================================================
    // 1. Role separation as the database actually grants it, not as the
    //    migrations claim. Enumerated from the catalog.
    // =====================================================================
    await t.test(
      "actual catalog privileges match the intended separation exactly",
      async () => {
        const operator = f.operator;
        // Every table privilege held by every login role in the core database.
        const { rows: tablePrivs } = await operator.query<{
          grantee: string;
          table_schema: string;
          table_name: string;
          privilege_type: string;
        }>(
          `SELECT grantee, table_schema, table_name, privilege_type
             FROM information_schema.table_privileges
            WHERE grantee IN ('orgfit_staff','orgfit_auth','orgfit_gateway','orgfit_processor','PUBLIC')
            ORDER BY grantee, table_schema, table_name, privilege_type`,
        );
        // The gateway and the processor must hold NO table privilege at all,
        // anywhere. This is the property the whole design rests on.
        for (const role of ["orgfit_gateway", "orgfit_processor"])
          assert.deepEqual(
            tablePrivs.filter((p) => p.grantee === role),
            [],
            `${role} must hold zero table privileges`,
          );
        // No staff privilege anywhere in schema intake.
        assert.deepEqual(
          tablePrivs.filter(
            (p) => p.grantee === "orgfit_staff" && p.table_schema === "intake",
          ),
          [],
          "orgfit_staff must hold no privilege in schema intake",
        );
        // PUBLIC must hold nothing in core, intake, access, instrument or ops.
        assert.deepEqual(
          tablePrivs.filter(
            (p) =>
              p.grantee === "PUBLIC" &&
              ["core", "intake", "access", "instrument", "ops"].includes(
                p.table_schema,
              ),
          ),
          [],
          "PUBLIC must hold no privilege in any application schema",
        );
        // Schema USAGE: staff must not be able to name an intake object.
        const { rows: usage } = await operator.query<{ has: boolean }>(
          `SELECT has_schema_privilege('orgfit_staff','intake','USAGE') AS has`,
        );
        assert.equal(usage[0].has, false, "orgfit_staff must lack USAGE on intake");

        // Column privileges: staff must never reach a token digest or key.
        const { rows: cols } = await operator.query<{
          table_name: string;
          column_name: string;
        }>(
          `SELECT table_name, column_name FROM information_schema.column_privileges
            WHERE grantee='orgfit_staff' AND table_schema='core' AND table_name='invitation'`,
        );
        const granted = new Set(cols.map((c) => c.column_name));
        for (const forbidden of ["token_digest", "digest_key_version"])
          assert.ok(
            !granted.has(forbidden),
            `orgfit_staff must not hold a column grant on ${forbidden}`,
          );

        // Executable routines, enumerated from pg_proc rather than trusted.
        const { rows: routines } = await operator.query<{
          role: string;
          signature: string;
        }>(
          `SELECT r.rolname AS role, n.nspname||'.'||p.proname AS signature
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             CROSS JOIN pg_roles r
            WHERE r.rolname IN ('orgfit_gateway','orgfit_processor','orgfit_staff')
              AND n.nspname IN ('intake','anonymous')
              AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
            ORDER BY 1,2`,
        );
        const forRole = (role: string) =>
          routines.filter((r) => r.role === role).map((r) => r.signature).sort();
        assert.deepEqual(
          forRole("orgfit_gateway"),
          [
            "intake.accept",
            "intake.active_campaign_key",
            "intake.draft_create",
            "intake.draft_read",
            "intake.draft_save",
            "intake.draft_start_over",
            "intake.finalization_context",
            "intake.gateway_instrument",
            // Phase 14, changed deliberately and recorded in phase-status.md:
            // gateway_instrument_ref resolves the session exactly as
            // gateway_instrument does and returns only the version id, hash
            // and the campaign's frozen notice fields; rate_hit increments a
            // counter keyed by an HMAC and returns only allowed/retryAfter. It
            // reads no invitation, draft, envelope or answer.
            "intake.gateway_instrument_ref",
            "intake.rate_hit",
            "intake.session_invitation",
          ],
          "the gateway's executable intake surface must be exactly the session-scoped routines plus the Phase 14 counter",
        );
        assert.deepEqual(
          forRole("orgfit_processor"),
          [
            "intake.batch_cleanup",
            "intake.batch_payload",
            "intake.batch_state",
            "intake.freeze_batch",
            "intake.keys_destroyed",
          ],
          "the processor's executable intake surface must be exactly the batch routines",
        );
        assert.deepEqual(
          forRole("orgfit_staff"),
          [],
          "orgfit_staff must be able to execute nothing in intake or anonymous",
        );

        // No role may bypass row security or be a superuser.
        const { rows: attrs } = await operator.query<{
          rolname: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>(
          `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
            WHERE rolname LIKE 'orgfit%' ORDER BY rolname`,
        );
        for (const r of attrs) {
          assert.equal(r.rolsuper, false, `${r.rolname} must not be a superuser`);
          assert.equal(
            r.rolbypassrls,
            false,
            `${r.rolname} must not bypass row security`,
          );
        }
        // Role membership: the gateway and processor must not inherit staff,
        // owner or executor rights through a grant chain.
        const { rows: members } = await operator.query<{
          member: string;
          role: string;
        }>(
          `SELECT m.rolname AS member, r.rolname AS role
             FROM pg_auth_members a
             JOIN pg_roles m ON m.oid=a.member
             JOIN pg_roles r ON r.oid=a.roleid
            WHERE m.rolname IN ('orgfit_gateway','orgfit_processor','orgfit_staff','orgfit_auth')`,
        );
        assert.deepEqual(members, [], "no runtime login may inherit another role");
      },
    );

    // =====================================================================
    // 2. Connection-level separation for the anonymous database.
    // =====================================================================
    await t.test(
      "only the processor and its migrator can connect to the anonymous database",
      async () => {
        for (const role of [
          "orgfit_staff",
          "orgfit_auth",
          "orgfit_gateway",
          "orgfit_migrator",
        ]) {
          const client = new pg.Client({
            connectionString: f.fixture.anonymousUrl(role),
          });
          await assert.rejects(
            client.connect(),
            /permission denied|not permitted/,
            `${role} must not connect to the anonymous database`,
          );
        }
      },
    );

    // =====================================================================
    // 3. Process the campaign, then attempt re-identification.
    // =====================================================================
    await t.test("the campaign processes and reconciles cleanly", async () => {
      const outcome = await processCampaign(core, anon, campaignId);
      assert.equal(outcome.state, "CLEANED");
      assert.equal(outcome.acceptedCount, 7);
      assert.equal(outcome.processedCount, 7);
      const state = await reconcile(core, anon, campaignId);
      assert.equal(state.releasable, true);
      assert.equal(state.blocked, false);
    });

    await t.test(
      "no value anywhere in the anonymous store appears in the identity store",
      async () => {
        // Everything the identity side knows that could name a person or a
        // request. Drafts and envelopes are gone by now, so their identifiers
        // are collected from what remains plus what the test itself observed.
        const identity = new Set<string>();
        const { rows: idRows } = await f.operator.query<{ v: string }>(
          `SELECT id::text v FROM core.participant
           UNION ALL SELECT id::text FROM core.invitation
           UNION ALL SELECT id::text FROM core.campaign_roster
           UNION ALL SELECT participant_id::text FROM core.campaign_roster
           UNION ALL SELECT invitation_id::text FROM core.campaign_roster
           UNION ALL SELECT display_reference FROM core.invitation
           UNION ALL SELECT encode(token_digest,'hex') FROM core.invitation WHERE token_digest IS NOT NULL
           UNION ALL SELECT id::text FROM access.staff_user
           UNION ALL SELECT idempotency_key::text FROM access.staff_mutation
           UNION ALL SELECT encode(request_digest,'hex') FROM access.staff_mutation
           UNION ALL SELECT id::text FROM ops.audit_log
           UNION ALL SELECT key_reference FROM intake.campaign_key`,
        );
        for (const r of idRows) identity.add(r.v);
        for (const l of links) identity.add(l.token);
        assert.ok(identity.size > 20, "the identity side has values to test against");

        // Every scalar in every anonymous table, of every type.
        const { rows: columns } = await anon.query<{
          table_name: string;
          column_name: string;
        }>(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema='anonymous' ORDER BY table_name, column_name`,
        );
        const found: string[] = [];
        for (const c of columns) {
          const { rows } = await anon.query<{ v: string | null }>(
            `SELECT DISTINCT ${c.column_name}::text AS v FROM anonymous.${c.table_name}`,
          );
          for (const r of rows)
            if (r.v !== null && identity.has(r.v))
              found.push(`${c.table_name}.${c.column_name}=${r.v}`);
        }
        assert.deepEqual(
          found,
          [],
          "no identity value may appear in any anonymous column",
        );

        // And the reverse direction: no anonymous response id leaks back.
        const { rows: responses } = await anon.query<{ id: string }>(
          "SELECT id::text FROM anonymous.anonymous_response",
        );
        const responseIds = responses.map((r) => r.id);
        assert.equal(responseIds.length, 7);
        for (const id of responseIds) {
          const { rows } = await f.operator.query<{ n: number }>(
            `SELECT (SELECT count(*) FROM core.invitation WHERE id::text=$1)
                  + (SELECT count(*) FROM core.participant WHERE id::text=$1)
                  + (SELECT count(*) FROM core.campaign_roster WHERE id::text=$1)
                  + (SELECT count(*) FROM intake.processing_batch WHERE id::text=$1) AS n`,
            [id],
          );
          assert.equal(
            Number(rows[0].n),
            0,
            "a response id must exist nowhere on the identity side",
          );
        }
      },
    );

    await t.test(
      "row order in the anonymous store does not reproduce submission order",
      async () => {
        // The strongest remaining correlation channel: if rows were inserted in
        // arrival order, physical order alone would re-identify everyone. The
        // marker answer makes that directly measurable.
        const { rows } = await anon.query<{ marker: string }>(
          `SELECT a.typed_value->>'value' AS marker
             FROM anonymous.anonymous_response r
             JOIN anonymous.anonymous_answer a
               ON a.response_id=r.id AND a.question_key=$1
            WHERE r.campaign_id=$2
            ORDER BY r.ctid`,
          [markerKey, campaignId],
        );
        assert.equal(rows.length, 7, "every response kept its marker answer");
        const physical = rows.map((r) => Number(r.marker));
        const submitted = submissionOrder.map((s) => s.marker);
        assert.deepEqual(
          [...physical].sort((a, b) => a - b),
          submitted,
          "every submitted marker survived exactly once",
        );
        assert.notDeepEqual(
          physical,
          submitted,
          "physical row order must not equal submission order",
        );
        // Ordering by the response identifier must also be uninformative.
        const byId = await anon.query<{ marker: string }>(
          `SELECT a.typed_value->>'value' AS marker
             FROM anonymous.anonymous_response r
             JOIN anonymous.anonymous_answer a
               ON a.response_id=r.id AND a.question_key=$1
            WHERE r.campaign_id=$2 ORDER BY r.id`,
          [markerKey, campaignId],
        );
        assert.notDeepEqual(
          byId.rows.map((r) => Number(r.marker)),
          submitted,
          "ordering by response id must not equal submission order",
        );
      },
    );

    await t.test(
      "no timestamp in the anonymous store can separate one respondent from another",
      async () => {
        const { rows } = await anon.query<{
          table_name: string;
          column_name: string;
          data_type: string;
        }>(
          `SELECT table_name, column_name, data_type FROM information_schema.columns
            WHERE table_schema='anonymous'
              AND data_type IN ('timestamp with time zone','timestamp without time zone','date','time without time zone')
            ORDER BY table_name, column_name`,
        );
        assert.deepEqual(
          rows.map((r) => `${r.table_name}.${r.column_name}`),
          ["processed_batch.committed_at"],
          "the only time value in the anonymous store is the campaign-level batch commit",
        );
        // One batch row per campaign, so it cannot distinguish an individual.
        const { rows: markers } = await anon.query<{ n: number }>(
          "SELECT count(*)::int n FROM anonymous.processed_batch WHERE campaign_id=$1",
          [campaignId],
        );
        assert.equal(markers[0].n, 1);
      },
    );

    // =====================================================================
    // 4. Staff, including Super Admin, attempt to reach answers and drafts.
    // =====================================================================
    await t.test(
      "Super Admin cannot retrieve a raw answer, a response identifier or a draft",
      async () => {
        // A SUPER_ADMIN bypasses every organization and capability check, so
        // whatever it cannot reach, no staff role can.
        const profile = await withStaff(superAdmin, async (_tx, p) => p);
        assert.equal(profile.role, "SUPER_ADMIN");

        // Every staff-reachable projection of this campaign, searched for
        // anything resembling an answer.
        const view = (await withStaff(superAdmin, (tx) =>
          participation(tx, f.orgA, campaignId),
        )) as { items: unknown[]; totals: Record<string, unknown> };
        const detail = await withStaff(superAdmin, (tx) =>
          campaignDetail(tx, f.orgA, campaignId),
        );
        const serialized = JSON.stringify(view) + JSON.stringify(detail);
        const { rows: responses } = await anon.query<{ id: string }>(
          "SELECT id::text FROM anonymous.anonymous_response WHERE campaign_id=$1",
          [campaignId],
        );
        for (const r of responses)
          assert.ok(
            !serialized.includes(r.id),
            "no staff projection may contain a response identifier",
          );
        for (const field of [
          "answers",
          "ciphertext",
          "typed_value",
          "score",
          "token_digest",
          "handle",
        ])
          assert.ok(
            !serialized.includes(field),
            `no staff projection may contain ${field}`,
          );
        assert.equal(view.totals.completed, 7);

        // Direct database attempts as the staff credential the application
        // actually uses, with a live SUPER_ADMIN transaction context.
        for (const statement of [
          "select * from intake.submission_inbox",
          "select * from intake.draft_blob",
          "select * from intake.campaign_key",
          "select * from intake.processing_batch",
          "select intake.batch_payload($1,$2)",
          "select intake.draft_read($1,$2)",
          "select intake.freeze_batch($1)",
          "select token_digest from core.invitation",
        ]) {
          const denial = await withStaff(superAdmin, async (tx) => {
            try {
              await (
                await import("kysely")
              ).sql.raw(statement).execute(tx);
              return "ALLOWED";
            } catch (e) {
              return (e as Error).message;
            }
          }).catch((e: Error) => e.message);
          assert.match(
            denial,
            /permission denied|does not exist|syntax|parameter/i,
            `Super Admin must be denied: ${statement} (got ${denial})`,
          );
          assert.notEqual(denial, "ALLOWED");
        }
      },
    );

    await t.test(
      "an administrator holding the original invitation cannot read a saved draft",
      async () => {
        // A live campaign, a real respondent draft, and an administrator who
        // kept a copy of the link. Opening a session is expected to work; the
        // question is whether anything they can obtain decrypts the content.
        const { campaignId: live } = await f.launchedCampaign([f.people[0]]);
        const liveLinks = await f.issueLinks(live);
        const respondent = await exchange(liveLinks[0].token);
        const document = (await instrument(respondent.session!)).document;
        const secret = "سر المشارك الذي يجب ألا يظهر";
        const answers = answersFor(document, 4);
        const textQuestion = document.sections
          .flatMap((s) => s.questions)
          .find((q) => q.type === "SHORT_TEXT")!;
        answers[textQuestion.id] = secret;
        const rawKey = newDraftKeyBytes();
        const handle = newHandle();
        const key = await importDraftKey(rawKey);
        const sealed = await encryptDraft(key, handle, 1, {
          schemaVersion: 1,
          versionId: (await instrument(respondent.session!)).versionId,
          answers,
          locale: "ar",
        });
        await draftCreate(respondent.session!, {
          handle,
          cipherVersion: CIPHER_VERSION,
          ...sealed,
          expectedRevision: 0,
        });

        // The administrator's position: the original link, plus everything a
        // SUPER_ADMIN can read from the application, plus operator-level reads
        // of the stored row (which is already beyond the staff boundary).
        const adminSession = await exchange(liveLinks[0].token);
        assert.ok(adminSession.session, "the link still opens a session");
        const cipher = (await draftRead(adminSession.session!, { handle })) as {
          nonce: string;
          ciphertext: string;
          revision: number;
        };
        // The ciphertext contains no plaintext at all.
        const raw = Buffer.from(cipher.ciphertext, "base64").toString("latin1");
        assert.ok(!raw.includes(secret), "the stored draft is not plaintext");
        assert.ok(!raw.includes("answers"), "the stored draft is not readable JSON");

        // Every key the administrator could plausibly derive.
        const stored = await f.operator.query<{
          token_digest: Buffer;
          display_reference: string;
        }>(
          "select token_digest, display_reference from core.invitation where id=$1",
          [liveLinks[0].invitationId],
        );
        const versionId = (await instrument(adminSession.session!)).versionId;
        const candidates: Uint8Array[] = [
          Buffer.concat([Buffer.from(liveLinks[0].token, "utf8")], 32),
          Buffer.from(liveLinks[0].token, "base64url").subarray(0, 32),
          stored.rows[0].token_digest,
          Buffer.concat([Buffer.from(handle.replace(/-/g, ""), "hex")], 32),
          Buffer.concat([Buffer.from(stored.rows[0].display_reference, "utf8")], 32),
          Buffer.concat([Buffer.from(liveLinks[0].invitationId.replace(/-/g, ""), "hex")], 32),
          Buffer.concat([Buffer.from(f.people[0].replace(/-/g, ""), "hex")], 32),
          Buffer.alloc(32),
        ];
        for (const candidate of candidates)
          await assert.rejects(
            decryptDraft(
              await importDraftKey(new Uint8Array(candidate)),
              handle,
              versionId,
              cipher.revision,
              cipher.nonce,
              cipher.ciphertext,
            ),
            "no value obtainable from the link or the server decrypts the draft",
          );

        // The campaign's own sealed-box key does not open a draft either: the
        // two cryptosystems are separate and the processor never sees drafts.
        const keyReference = (
          await f.operator.query(
            "select key_reference from intake.campaign_key where campaign_id=$1",
            [live],
          )
        ).rows[0].key_reference as string;
        const campaignKeys = await openCampaignKey(keyReference);
        await assert.rejects(
          decryptDraft(
            await importDraftKey(campaignKeys.privateKey),
            handle,
            versionId,
            cipher.revision,
            cipher.nonce,
            cipher.ciphertext,
          ),
          "the campaign key does not decrypt a respondent draft",
        );
      },
    );

    await t.test(
      "completed answers cannot be reopened, edited or retrieved through resume",
      async () => {
        const session = await exchange(links[0].token);
        assert.equal(session.context.access, "ACCEPTED");
        assert.equal((await status(session.session!)).access, "ACCEPTED");
        // Every draft route refuses an accepted invitation.
        assert.equal(
          await failure(() => draftRead(session.session!, { handle: randomUUID() })),
          "ALREADY_ACCEPTED",
        );
        assert.equal(
          await failure(() =>
            draftCreate(session.session!, {
              handle: randomUUID(),
              cipherVersion: CIPHER_VERSION,
              nonce: "AAAAAAAAAAAAAAAA",
              ciphertext: "AAAAAAAAAAAAAAAAAAAAAAA=",
              expectedRevision: 0,
            }),
          ),
          "ALREADY_ACCEPTED",
        );
        // And there is no draft left to retrieve in any case.
        const { rows } = await f.operator.query(
          "select count(*)::int n from intake.draft_blob where campaign_id=$1",
          [campaignId],
        );
        assert.equal(rows[0].n, 0);
      },
    );

    // =====================================================================
    // 5. Audit, jobs, errors and exports.
    // =====================================================================
    await t.test(
      "the audit log records staff actions and never a submission or an answer",
      async () => {
        const { rows } = await f.operator.query<{
          action: string;
          target_id: string;
          field_names: string[];
        }>(
          "select action, target_id::text, field_names from ops.audit_log order by occurred_at",
        );
        assert.ok(rows.length > 0, "staff actions were audited");
        // No audit action names a respondent event.
        for (const r of rows) {
          assert.ok(
            !/SUBMIT|ANSWER|RESPONSE|DRAFT|COMPLET/i.test(r.action),
            `audit action ${r.action} must not describe a respondent event`,
          );
          for (const field of r.field_names)
            assert.ok(
              !/answer|response|draft|ciphertext|score/i.test(field),
              `audit field ${field} must not describe answer content`,
            );
        }
        // No audit row points at an anonymous response or an inbox envelope.
        const targets = new Set(rows.map((r) => r.target_id));
        const { rows: responses } = await anon.query<{ id: string }>(
          "select id::text from anonymous.anonymous_response",
        );
        for (const r of responses)
          assert.ok(!targets.has(r.id), "no audit row targets a response");
        // The invitation completion transition produced no audit row at all,
        // so there is no staff-visible per-person completion timestamp.
        assert.equal(
          rows.filter((r) => /INVITATION_COMPLETED|SUBMISSION/i.test(r.action)).length,
          0,
        );
      },
    );

    await t.test(
      "no job, queue or outbox table exists that could carry a respondent payload",
      async () => {
        const { rows } = await f.operator.query<{ full: string }>(
          `select table_schema||'.'||table_name full from information_schema.tables
            where table_schema not in ('pg_catalog','information_schema')
              and (table_name ~* 'job|queue|outbox|task|event' )
            order by 1`,
        );
        // Until Phase 11 there was no queue at all, and this asserted exactly
        // that. Phase 11 introduced one — ops.report_job, which renders already
        // published aggregates — so "no queue exists" no longer states the
        // property it was protecting. The property is asserted directly instead,
        // against WHATEVER queue tables exist: none may be reachable from the
        // respondent side, none may have a column shaped like a respondent body,
        // and nothing any of them actually holds may be a value from the
        // anonymous store.
        assert.deepEqual(
          rows.map((r) => r.full),
          ["ops.report_job"],
          "an unexpected queue table appeared; prove it cannot carry a payload",
        );

        // Every scalar the anonymous store holds, in text form.
        const anonymousValues = new Set<string>();
        const { rows: anonColumns } = await anon.query<{
          table_name: string;
          column_name: string;
        }>(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema='anonymous' ORDER BY table_name, column_name`,
        );
        for (const c of anonColumns) {
          const { rows: values } = await anon.query<{ v: string | null }>(
            `SELECT DISTINCT ${c.column_name}::text AS v FROM anonymous.${c.table_name}`,
          );
          for (const value of values)
            if (value.v !== null && value.v.length > 8) anonymousValues.add(value.v);
        }
        assert.ok(anonymousValues.size > 5, "the anonymous store has values to test against");

        for (const table of rows) {
          const [schema, name] = table.full.split(".");
          // No runtime credential may reach it directly at all; every writer and
          // reader goes through a fixed-search-path routine.
          const { rows: grants } = await f.operator.query<{ grantee: string }>(
            `select distinct grantee from information_schema.table_privileges
              where table_schema=$1 and table_name=$2
                and grantee in ('PUBLIC','orgfit_gateway','orgfit_staff','orgfit_report',
                                'orgfit_processor','orgfit_auth')`,
            [schema, name],
          );
          assert.deepEqual(
            grants.map((g) => g.grantee),
            [],
            `${table.full} is directly reachable by a runtime credential`,
          );
          // No column is shaped like a respondent body or a link.
          const { rows: cols } = await f.operator.query<{ column_name: string }>(
            `select column_name from information_schema.columns
              where table_schema=$1 and table_name=$2`,
            [schema, name],
          );
          for (const c of cols)
            assert.ok(
              !/answer|draft|envelope|respondent|submission|payload|body|token|cipher/i.test(
                c.column_name,
              ),
              `${table.full}.${c.column_name} must not store a respondent body`,
            );
          // And nothing it holds right now is a value from the anonymous store.
          const { rows: content } = await f.operator.query<{ v: string }>(
            `select to_jsonb(t)::text v from ${schema}.${name} t`,
          );
          for (const row of content)
            for (const value of anonymousValues)
              assert.equal(
                row.v.includes(value),
                false,
                `${table.full} carries an anonymous value`,
              );
        }
        // The one generic idempotency store must not hold respondent bodies.
        const { rows: mutation } = await f.operator.query<{
          column_name: string;
        }>(
          `select column_name from information_schema.columns
            where table_schema='access' and table_name='staff_mutation'`,
        );
        for (const c of mutation)
          assert.ok(
            !/body|payload|answer|response|content/i.test(c.column_name),
            `access.staff_mutation.${c.column_name} must not store a body`,
          );
        // And no finalization ever wrote to it.
        const { rows: ops } = await f.operator.query<{ operation: string }>(
          "select distinct operation from access.staff_mutation",
        );
        for (const o of ops)
          assert.ok(
            !/final|submit|accept|answer/i.test(o.operation),
            `staff_mutation must not record ${o.operation}`,
          );
      },
    );

    await t.test(
      "database errors provoked from the public surface leak no payload",
      async () => {
        const session = await exchange(links[1].token);
        // links[1] is completed, so this is a state error carrying context.
        const attempts: (() => Promise<unknown>)[] = [
          () => finalize(session.session!, { answers: { [randomUUID()]: "x" } }),
          () => draftRead(session.session!, { handle: randomUUID() }),
          () => status("not-a-session"),
        ];
        for (const attempt of attempts) {
          const error = await attempt().then(
            () => null,
            (e: Error & { code?: string }) => e,
          );
          if (!error) continue;
          const text = `${error.code ?? ""} ${error.message} ${error.stack ?? ""}`;
          for (const secretValue of [
            links[1].token,
            links[1].invitationId,
            f.people[1],
            campaignId,
          ])
            assert.ok(
              !text.includes(secretValue),
              "no error surface may contain an identity or credential value",
            );
          assert.ok(
            !/select |insert |update |delete |from core\.|from intake\./i.test(text),
            "no error surface may contain SQL",
          );
        }
      },
    );

    await t.test(
      "a manual link export contains links and never an answer or a draft",
      async () => {
        const { campaignId: exportCampaign } = await f.launchedCampaign([
          f.people[2],
          f.people[3],
        ]);
        const list = (await withStaff(superAdmin, (tx) =>
          participation(tx, f.orgA, exportCampaign),
        )) as { items: { invitationId: string; generation: number }[] };
        const created = (await withStaff(superAdmin, (tx) =>
          createLinkExport(
            tx,
            f.orgA,
            exportCampaign,
            {
              invitationIds: list.items.map((i) => i.invitationId),
              expectedGenerations: list.items.map((i) => i.generation),
              confirmRotation: false,
            },
            randomUUID(),
          ),
        )) as { exportId: string };
        await withStaff(superAdmin, (tx) =>
          linkExportKey(tx, f.orgA, created.exportId),
        );
        const bytes = await getExport(f.orgA, created.exportId);
        const text = bytes.toString("utf8");
        assert.ok(text.includes("INV-"), "the export contains its links");
        for (const forbidden of [
          "answer",
          "ciphertext",
          "typed_value",
          "score",
          "handle",
        ])
          assert.ok(
            !text.toLowerCase().includes(forbidden),
            `a link export must not contain ${forbidden}`,
          );
      },
    );

    // =====================================================================
    // 6. Submission reliability, re-verified independently.
    // =====================================================================
    await t.test(
      "100 concurrent finalizations yield one accepted payload and one completion",
      async () => {
        const { campaignId: race } = await f.launchedCampaign([f.people[4]]);
        const raceLinks = await f.issueLinks(race);
        const primer = await exchange(raceLinks[0].token);
        const document = (await instrument(primer.session!)).document;
        // Every attempt sends DIFFERENT answers, so a second write would be
        // detectable as a changed payload rather than merely a second row.
        const sessions = await Promise.all(
          Array.from({ length: 100 }, () => exchange(raceLinks[0].token)),
        );
        const outcomes = await Promise.all(
          sessions.map((s, i) =>
            finalize(s.session!, { answers: answersFor(document, i % 10) })
              .then(() => "ACCEPTED")
              .catch((e: Error) => e.message),
          ),
        );
        assert.equal(
          outcomes.filter((o) => o === "ACCEPTED").length,
          1,
          "exactly one attempt may write",
        );
        assert.equal(
          outcomes.filter((o) => o === "ALREADY_ACCEPTED").length,
          99,
          "every other attempt is a generic duplicate",
        );
        const { rows } = await f.operator.query<{
          envelopes: number;
          completed: number;
        }>(
          `select (select count(*)::int from intake.submission_inbox where invitation_id=$1) envelopes,
                  (select count(*)::int from core.invitation where id=$1 and status='COMPLETED') completed`,
          [raceLinks[0].invitationId],
        );
        assert.equal(rows[0].envelopes, 1);
        assert.equal(rows[0].completed, 1);
      },
    );

    await t.test(
      "retry after an uncertain commit never replaces the accepted payload",
      async () => {
        const { campaignId: retry } = await f.launchedCampaign([f.people[5]]);
        const retryLinks = await f.issueLinks(retry);
        const session = await exchange(retryLinks[0].token);
        const document = (await instrument(session.session!)).document;
        await finalize(session.session!, { answers: answersFor(document, 1) });
        const before = (
          await f.operator.query<{ c: Buffer }>(
            "select ciphertext c from intake.submission_inbox where invitation_id=$1",
            [retryLinks[0].invitationId],
          )
        ).rows[0].c;
        // The client never saw the success and retries with other answers.
        for (let i = 0; i < 3; i++)
          assert.equal(
            await failure(() =>
              finalize(session.session!, { answers: answersFor(document, 9 - i) }),
            ),
            "ALREADY_ACCEPTED",
          );
        const after = (
          await f.operator.query<{ c: Buffer }>(
            "select ciphertext c from intake.submission_inbox where invitation_id=$1",
            [retryLinks[0].invitationId],
          )
        ).rows[0].c;
        assert.ok(before.equals(after), "the first payload is immutable");
      },
    );

    await t.test(
      "closure racing with finalization leaves no half-accepted submission",
      async () => {
        const { campaignId: raceClose } = await f.launchedCampaign([
          f.people[6],
          f.people[0],
        ]);
        const closeLinks = await f.issueLinks(raceClose);
        const session = await exchange(closeLinks[0].token);
        const document = (await instrument(session.session!)).document;
        const [submitted] = await Promise.allSettled([
          finalize(session.session!, { answers: answersFor(document, 2) }),
          f.closeCampaign(raceClose),
        ]);
        const { rows } = await f.operator.query<{
          status: string;
          envelopes: number;
        }>(
          `select i.status, (select count(*)::int from intake.submission_inbox e where e.invitation_id=i.id) envelopes
             from core.invitation i where i.id=$1`,
          [closeLinks[0].invitationId],
        );
        if (submitted.status === "fulfilled") {
          assert.equal(rows[0].status, "COMPLETED");
          assert.equal(rows[0].envelopes, 1);
        } else {
          assert.equal(rows[0].status, "READY");
          assert.equal(rows[0].envelopes, 0);
        }
        // The campaign is closed either way and accepts nothing further.
        const late = await exchange(closeLinks[1].token);
        assert.equal(late.context.access, "CLOSED");
        assert.equal(
          await failure(() =>
            finalize(late.session!, { answers: answersFor(document, 3) }),
          ),
          "COLLECTION_UNAVAILABLE",
        );
      },
    );

    await t.test(
      "every crash boundary is recoverable without duplicating or losing output",
      async () => {
        const { campaignId: faulty } = await f.launchedCampaign(f.people);
        const faultLinks = await f.issueLinks(faulty);
        for (let i = 0; i < faultLinks.length; i++) {
          const s = await exchange(faultLinks[i].token);
          const d = (await instrument(s.session!)).document;
          await finalize(s.session!, { answers: answersFor(d, i) });
        }
        await f.closeCampaign(faulty);

        // Before the anonymous commit: nothing visible, input intact.
        for (const point of [
          "afterFreeze",
          "afterDecrypt",
          "duringAnonymousTransfer",
        ] as FaultPoint[]) {
          await assert.rejects(
            processCampaign(core, anon, faulty, {
              fault: (p) => {
                if (p === point) throw new Error(`FAULT_${point}`);
              },
            }),
            new RegExp(`FAULT_${point}`),
          );
          const marker = await anon.query(
            "select count(*)::int n from anonymous.processed_batch where campaign_id=$1",
            [faulty],
          );
          assert.equal(marker.rows[0].n, 0, `${point}: no marker`);
          const partial = await anon.query(
            "select count(*)::int n from anonymous.anonymous_response where campaign_id=$1",
            [faulty],
          );
          assert.equal(partial.rows[0].n, 0, `${point}: no partial output`);
          const input = await f.operator.query(
            "select count(*)::int n from intake.submission_inbox where campaign_id=$1",
            [faulty],
          );
          assert.equal(input.rows[0].n, 7, `${point}: frozen input intact`);
        }

        // After the anonymous commit, before the core state advanced: the
        // marker is authoritative and a retry must not append.
        await assert.rejects(
          processCampaign(core, anon, faulty, {
            fault: (p) => {
              if (p === "afterAnonymousCommit") throw new Error("FAULT_LOST_ACK");
            },
          }),
          /FAULT_LOST_ACK/,
        );
        assert.equal(
          (
            await anon.query(
              "select count(*)::int n from anonymous.anonymous_response where campaign_id=$1",
              [faulty],
            )
          ).rows[0].n,
          7,
        );
        // Duplicate delivery: a second full attempt appends nothing.
        const resumed = await processCampaign(core, anon, faulty);
        assert.equal(resumed.processedCount, 7);
        assert.equal(
          (
            await anon.query(
              "select count(*)::int n from anonymous.anonymous_response where campaign_id=$1",
              [faulty],
            )
          ).rows[0].n,
          7,
          "duplicate batch delivery must not append",
        );
        assert.equal(
          (
            await anon.query(
              "select count(*)::int n from anonymous.processed_batch where campaign_id=$1",
              [faulty],
            )
          ).rows[0].n,
          1,
        );
        // Intake cleanup after already-committed output is authorized and
        // idempotent.
        const again = await processCampaign(core, anon, faulty);
        assert.equal(again.state, "CLEANED");
        assert.equal(
          (
            await f.operator.query(
              "select count(*)::int n from intake.submission_inbox where campaign_id=$1",
              [faulty],
            )
          ).rows[0].n,
          0,
        );
        const final = await reconcile(core, anon, faulty);
        assert.equal(final.acceptedCount, 7);
        assert.equal(final.processedCount, 7);
        assert.equal(final.anonymousCount, 7);
        assert.equal(final.blocked, false);
      },
    );

    await t.test(
      "a campaign below five contributors yields a suppression state and no answers",
      async () => {
        const { campaignId: small } = await f.launchedCampaign(f.people.slice(0, 4));
        const smallLinks = await f.issueLinks(small);
        for (let i = 0; i < smallLinks.length; i++) {
          const s = await exchange(smallLinks[i].token);
          const d = (await instrument(s.session!)).document;
          await finalize(s.session!, { answers: answersFor(d, i) });
        }
        await f.closeCampaign(small);
        const outcome = await processCampaign(core, anon, small);
        assert.equal(outcome.state, "PURGED");
        // Nothing was decrypted: the marker answers exist nowhere.
        const { rows } = await anon.query<{ n: number }>(
          "select count(*)::int n from anonymous.anonymous_answer where campaign_id=$1",
          [small],
        );
        assert.equal(rows[0].n, 0);
        const readiness = await reconcile(core, anon, small);
        assert.equal(readiness.releasable, false);
        assert.equal(readiness.blocked, true);
        // Completion is untouched: nobody is marked incomplete to compensate.
        assert.equal(
          (
            await f.operator.query(
              "select count(*)::int n from core.invitation where campaign_id=$1 and status='COMPLETED'",
              [small],
            )
          ).rows[0].n,
          4,
        );
      },
    );

    await t.test(
      "a count disagreement blocks the batch and repairs nothing by itself",
      async () => {
        const { campaignId: skew } = await f.launchedCampaign(f.people);
        const skewLinks = await f.issueLinks(skew);
        for (let i = 0; i < 6; i++) {
          const s = await exchange(skewLinks[i].token);
          const d = (await instrument(s.session!)).document;
          await finalize(s.session!, { answers: answersFor(d, i) });
        }
        // A completion with no envelope behind it — a restored-backup shape.
        await f.operator.query(
          "update core.invitation set status='COMPLETED' where id=$1",
          [skewLinks[6].invitationId],
        );
        await f.closeCampaign(skew);
        assert.equal(
          await failure(() => processCampaign(core, anon, skew)),
          "COUNT_MISMATCH",
        );
        assert.equal(
          (
            await f.operator.query(
              "select count(*)::int n from intake.processing_batch where campaign_id=$1",
              [skew],
            )
          ).rows[0].n,
          0,
          "no batch is frozen while the counts disagree",
        );
        // Nothing was adjusted: the seventh invitation is still COMPLETED.
        assert.equal(
          (
            await f.operator.query(
              "select status from core.invitation where id=$1",
              [skewLinks[6].invitationId],
            )
          ).rows[0].status,
          "COMPLETED",
          "the reconciliation must not mark anyone incomplete",
        );
      },
    );

    await t.test(
      "campaign key material is destroyed and the custody store is empty for processed campaigns",
      async () => {
        const { rows } = await f.operator.query<{
          campaign_id: string;
          state: string;
          key_reference: string;
        }>(
          `select k.campaign_id::text, k.state, k.key_reference
             from intake.campaign_key k
             join intake.processing_batch b on b.campaign_id=k.campaign_id
            where b.state in ('CLEANED','PURGED')`,
        );
        assert.ok(rows.length >= 2, "several campaigns reached a terminal batch state");
        const files = new Set(await readdir(f.custodyDirectory));
        for (const r of rows) {
          assert.equal(r.state, "DESTROYED", `${r.campaign_id} key must be DESTROYED`);
          assert.ok(
            !files.has(`${r.key_reference}.sealed`),
            "the sealed private key file is gone",
          );
        }
      },
    );
  } finally {
    await core.end();
    await anon.end();
    await f.close();
  }
});
