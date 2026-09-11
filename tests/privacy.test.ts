import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import pg from "pg";
import { withStaff } from "../src/db";
import { participation } from "../src/campaigns";
import { exchange, instrument, finalize } from "../src/respondent";
import {
  processCampaign,
  reconcile,
  shuffle,
  type FaultPoint,
} from "../src/processor";
import type { Instrument } from "../src/instrument-input";
import { respondentFixture, failure, type Fixture } from "./respondent-fixture";

function completeAnswers(document: Instrument, seed: number) {
  const answers: Record<string, string | string[]> = {};
  for (const q of document.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    switch (q.type) {
      case "SHORT_TEXT":
      case "LONG_TEXT":
        answers[q.id] = `نص ${seed}`;
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
// Drive real acceptances through the real gateway for a whole campaign.
async function submitAll(
  links: { invitationId: string; token: string }[],
  count = links.length,
) {
  for (let i = 0; i < count; i++) {
    const opened = await exchange(links[i].token);
    assert.ok(opened.session);
    const document = (await instrument(opened.session)).document;
    await finalize(opened.session, { answers: completeAnswers(document, i) });
  }
}

test("PostgreSQL privacy processing: anonymous batch, faults and forbidden fields", async (t) => {
  const f: Fixture = await respondentFixture(7);
  const core = new pg.Pool({
    connectionString: f.fixture.url("orgfit_processor"),
    max: 4,
  });
  const anon = new pg.Pool({
    connectionString: f.fixture.anonymousUrl("orgfit_processor"),
    max: 4,
  });
  try {
    // ---------------------------------------------------------------------
    await t.test(
      "the processor credential can reach batches but not people, drafts or acceptance",
      async () => {
        for (const [statement, params] of [
          ["select * from core.participant", []],
          ["select * from core.invitation", []],
          ["select token_digest from core.invitation", []],
          ["select * from intake.draft_blob", []],
          ["select * from intake.submission_inbox", []],
          ["select intake.accept($1,$2,$3)", [null, null, null]],
          ["select intake.draft_read($1,$2)", [null, null]],
        ] as const) {
          const denial = await core
            .query(statement, [...params])
            .then(() => "ALLOWED")
            .catch((e: Error) => e.message);
          assert.match(
            denial,
            /permission denied/,
            `orgfit_processor must be denied: ${statement} (got ${denial})`,
          );
        }
        // And no staff, auth or gateway login may even connect to the
        // anonymous answer database.
        for (const role of ["orgfit_staff", "orgfit_auth", "orgfit_gateway"]) {
          const client = new pg.Client({
            connectionString: f.fixture.anonymousUrl(role),
          });
          await assert.rejects(client.connect(), /permission denied|not permitted/);
        }
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "a campaign below five accepted responses is purged without ever being decrypted",
      async () => {
        const { campaignId } = await f.launchedCampaign(f.people.slice(0, 4));
        const links = await f.issueLinks(campaignId);
        await submitAll(links);
        await f.closeCampaign(campaignId);
        const outcome = await processCampaign(core, anon, campaignId);
        assert.equal(outcome.state, "PURGED");
        assert.equal(outcome.acceptedCount, 4);

        // No anonymous row of any kind exists for this campaign.
        for (const table of [
          "anonymous_campaign_manifest",
          "anonymous_response",
          "anonymous_answer",
          "response_score",
          "processed_batch",
        ]) {
          const column = table === "anonymous_campaign_manifest" ? "id" : "campaign_id";
          const { rows } = await anon.query(
            `select count(*)::int n from anonymous.${table} where ${column}=$1`,
            [campaignId],
          );
          assert.equal(rows[0].n, 0, `${table} must stay empty below threshold`);
        }
        // The intake is gone and completion is untouched: nobody is marked
        // incomplete to compensate for a suppressed campaign.
        const intake = await f.operator.query(
          "select count(*)::int n from intake.submission_inbox where campaign_id=$1",
          [campaignId],
        );
        assert.equal(intake.rows[0].n, 0);
        const completed = await f.operator.query(
          "select count(*)::int n from core.invitation where campaign_id=$1 and status='COMPLETED'",
          [campaignId],
        );
        assert.equal(completed.rows[0].n, 4);
        // Release readiness reports the campaign as not releasable.
        const state = await reconcile(core, anon, campaignId);
        assert.equal(state.releasable, false);
        assert.equal(state.blocked, true);

        // Regression for CC-001 (found by Checkpoint C): a suppressed campaign
        // is the case the blueprint wants erased soonest, so its key register
        // must reach DESTROYED with recorded evidence — not sit at
        // DELETE_REQUESTED for ever because the purge path skipped the step
        // that records destruction.
        const keys = await f.operator.query<{
          state: string;
          destruction_evidence: string | null;
        }>(
          "select state, destruction_evidence from intake.campaign_key where campaign_id=$1",
          [campaignId],
        );
        assert.deepEqual(
          keys.rows.map((k) => k.state),
          ["DESTROYED"],
        );
        assert.match(String(keys.rows[0].destruction_evidence), /insufficient-data/);
        assert.equal(
          (
            await f.operator.query<{ state: string }>(
              "select state from intake.processing_batch where campaign_id=$1",
              [campaignId],
            )
          ).rows[0].state,
          "PURGED",
          "recording key destruction must not disturb the terminal batch state",
        );
      },
    );

    // ---------------------------------------------------------------------
    // The main eligible campaign, reused by the fault-injection subtests.
    const { campaignId } = await f.launchedCampaign(f.people);
    const links = await f.issueLinks(campaignId);
    await submitAll(links);
    await f.closeCampaign(campaignId);

    await t.test(
      "a failure before the anonymous commit leaves no visible output and is fully retried",
      async () => {
        for (const point of [
          "afterFreeze",
          "afterDecrypt",
          "duringAnonymousTransfer",
        ] as FaultPoint[]) {
          await assert.rejects(
            processCampaign(core, anon, campaignId, {
              fault: (p) => {
                if (p === point) throw new Error(`INJECTED_${point}`);
              },
            }),
            new RegExp(`INJECTED_${point}`),
          );
          // No marker, no partial responses, and the frozen input survives.
          const marker = await anon.query(
            "select count(*)::int n from anonymous.processed_batch where campaign_id=$1",
            [campaignId],
          );
          assert.equal(marker.rows[0].n, 0, `${point}: no marker may exist`);
          const responses = await anon.query(
            "select count(*)::int n from anonymous.anonymous_response where campaign_id=$1",
            [campaignId],
          );
          assert.equal(
            responses.rows[0].n,
            0,
            `${point}: a rolled-back transfer leaves no partial responses`,
          );
          const envelopes = await f.operator.query(
            "select count(*)::int n from intake.submission_inbox where campaign_id=$1",
            [campaignId],
          );
          assert.equal(
            envelopes.rows[0].n,
            7,
            `${point}: the frozen accepted set is untouched`,
          );
        }
      },
    );

    await t.test(
      "refreezing returns the same batch, count and assigned set after a crash",
      async () => {
        const first = await f.operator.query(
          "select id,accepted_count,encode(manifest_hash,'hex') h,lease_generation from intake.processing_batch where campaign_id=$1",
          [campaignId],
        );
        // Three crashed attempts above already took three leases.
        assert.equal(first.rows[0].accepted_count, 7);
        const again = await core.query<{ data: { batchId: string; acceptedCount: number; manifestHash: string; created: boolean } }>(
          "select intake.freeze_batch($1) as data",
          [campaignId],
        );
        assert.equal(again.rows[0].data.batchId, first.rows[0].id);
        assert.equal(again.rows[0].data.acceptedCount, 7);
        assert.equal(again.rows[0].data.manifestHash, first.rows[0].h);
        assert.equal(again.rows[0].data.created, false);
      },
    );

    await t.test(
      "a failure after the anonymous commit resumes from the marker and never appends",
      async () => {
        // Crash immediately after the anonymous transaction committed.
        await assert.rejects(
          processCampaign(core, anon, campaignId, {
            fault: (p) => {
              if (p === "afterAnonymousCommit") throw new Error("INJECTED_LOST_RESPONSE");
            },
          }),
          /INJECTED_LOST_RESPONSE/,
        );
        const committed = await anon.query(
          "select count(*)::int n from anonymous.anonymous_response where campaign_id=$1",
          [campaignId],
        );
        assert.equal(committed.rows[0].n, 7, "the output really did commit");
        // The retry must find the marker and skip decryption entirely rather
        // than writing a second copy.
        const resumed = await processCampaign(core, anon, campaignId);
        assert.equal(resumed.processedCount, 7);
        const after = await anon.query(
          "select count(*)::int n from anonymous.anonymous_response where campaign_id=$1",
          [campaignId],
        );
        assert.equal(after.rows[0].n, 7, "duplicate delivery must not append");
        const markers = await anon.query(
          "select count(*)::int n from anonymous.processed_batch where campaign_id=$1",
          [campaignId],
        );
        assert.equal(markers.rows[0].n, 1);
        assert.equal(resumed.state, "CLEANED");
      },
    );

    await t.test(
      "processing the same campaign again is idempotent and appends nothing",
      async () => {
        const repeat = await processCampaign(core, anon, campaignId);
        assert.equal(repeat.state, "CLEANED");
        const rows = await anon.query(
          "select count(*)::int n from anonymous.anonymous_response where campaign_id=$1",
          [campaignId],
        );
        assert.equal(rows.rows[0].n, 7);
      },
    );

    await t.test(
      "intake, drafts and campaign keys are gone after a proven commit",
      async () => {
        for (const [table, column] of [
          ["intake.submission_inbox", "campaign_id"],
          ["intake.draft_blob", "campaign_id"],
          ["intake.respondent_session", "campaign_id"],
        ] as const) {
          const { rows } = await f.operator.query(
            `select count(*)::int n from ${table} where ${column}=$1`,
            [campaignId],
          );
          assert.equal(rows[0].n, 0, `${table} must be empty after cleanup`);
        }
        const keys = await f.operator.query(
          "select state from intake.campaign_key where campaign_id=$1",
          [campaignId],
        );
        assert.deepEqual(
          keys.rows.map((r) => r.state),
          ["DESTROYED"],
        );
        // The sealed private key file for this campaign is gone from custody.
        const reference = (
          await f.operator.query(
            "select key_reference from intake.campaign_key where campaign_id=$1",
            [campaignId],
          )
        ).rows[0].key_reference as string;
        const files = await readdir(f.custodyDirectory);
        assert.ok(
          !files.includes(`${reference}.sealed`),
          "the campaign's sealed private key was destroyed",
        );
        // The batch keeps counts and status only; the key reference list is
        // emptied and no envelope-to-response map was ever written.
        const batch = await f.operator.query(
          "select state,accepted_count,processed_count,key_references from intake.processing_batch where campaign_id=$1",
          [campaignId],
        );
        assert.equal(batch.rows[0].state, "CLEANED");
        assert.equal(batch.rows[0].accepted_count, 7);
        assert.equal(batch.rows[0].processed_count, 7);
        assert.deepEqual(batch.rows[0].key_references, []);
      },
    );

    await t.test(
      "a failure after cleanup but before key destruction is recoverable, not a loss",
      async () => {
        // Fresh campaign so the boundary can be hit in isolation.
        const { campaignId: id } = await f.launchedCampaign(f.people);
        const fresh = await f.issueLinks(id);
        await submitAll(fresh);
        await f.closeCampaign(id);
        await assert.rejects(
          processCampaign(core, anon, id, {
            fault: (p) => {
              if (p === "afterIntakeCleanup") throw new Error("INJECTED_CLEANUP_CRASH");
            },
          }),
          /INJECTED_CLEANUP_CRASH/,
        );
        // Output committed, intake gone, but the batch has not reached CLEANED
        // and therefore cannot be released yet.
        const mid = await f.operator.query(
          "select state from intake.processing_batch where campaign_id=$1",
          [id],
        );
        assert.equal(mid.rows[0].state, "CLEANUP_PENDING");
        assert.equal((await reconcile(core, anon, id)).releasable, false);
        // Resuming finishes destruction and reaches CLEANED without decrypting
        // anything again — the envelopes are already gone.
        const done = await processCampaign(core, anon, id);
        assert.equal(done.state, "CLEANED");
        const rows = await anon.query(
          "select count(*)::int n from anonymous.anonymous_response where campaign_id=$1",
          [id],
        );
        assert.equal(rows.rows[0].n, 7);
        assert.equal((await reconcile(core, anon, id)).releasable, true);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "finalized anonymous rows contain no identity or transport field",
      async () => {
        // Structural check first: not one column in the entire anonymous schema
        // may be named after an identity or transport attribute.
        const { rows: columns } = await anon.query<{
          table_name: string;
          column_name: string;
        }>(
          `select table_name, column_name from information_schema.columns
            where table_schema='anonymous' order by table_name, column_name`,
        );
        const forbidden =
          /participant|invitation|token|digest|draft|handle|envelope|session|ip_|ip$|address|user_agent|useragent|request|trace|correlation|actor|submitted|received|accepted_at|client/i;
        for (const c of columns)
          assert.ok(
            !forbidden.test(c.column_name),
            `anonymous.${c.table_name}.${c.column_name} is a forbidden correlation field`,
          );
        // The only time column in the whole schema is the batch marker's
        // campaign-level commit instant.
        const times = columns.filter((c) =>
          /_at$|time|timestamp/i.test(c.column_name),
        );
        assert.deepEqual(
          times.map((c) => `${c.table_name}.${c.column_name}`),
          ["processed_batch.committed_at"],
        );

        // Value check: no anonymous identifier equals any live identity value.
        const identity = await f.operator.query<{ value: string }>(
          `select id::text value from core.participant
           union all select id::text from core.invitation
           union all select id::text from core.campaign_roster
           union all select encode(token_digest,'hex') from core.invitation where token_digest is not null`,
        );
        const known = new Set(identity.rows.map((r) => r.value));
        const responses = await anon.query<{ id: string }>(
          "select id::text from anonymous.anonymous_response",
        );
        assert.ok(responses.rows.length > 0);
        for (const r of responses.rows)
          assert.ok(!known.has(r.id), "a response id must be freshly random");

        // And the whole serialized payload of every answer row contains no
        // identity value either.
        const payload = await anon.query<{ blob: string }>(
          "select coalesce(string_agg(typed_value::text,'|'),'') blob from anonymous.anonymous_answer",
        );
        for (const value of known)
          assert.ok(
            !payload.rows[0].blob.includes(value),
            "no identity value may appear inside a stored answer",
          );
      },
    );

    await t.test(
      "responses carry only the coarse department group, never COMPANY",
      async () => {
        const groups = await anon.query<{ kind: string; n: number }>(
          `select g.kind, count(r.id)::int n from anonymous.anonymous_group g
             left join anonymous.anonymous_response r on r.report_group_id=g.id
            where g.campaign_id=$1 group by g.kind order by g.kind`,
          [campaignId],
        );
        const company = groups.rows.find((g) => g.kind === "COMPANY");
        assert.ok(company, "the company group exists for aggregation");
        assert.equal(
          company.n,
          0,
          "COMPANY is computed over the set, never assigned to a person",
        );
        assert.equal(
          groups.rows
            .filter((g) => g.kind !== "COMPANY")
            .reduce((n, g) => n + g.n, 0),
          7,
        );
        // The database refuses a COMPANY assignment even if code tried.
        const companyId = (
          await anon.query(
            "select id from anonymous.anonymous_group where campaign_id=$1 and kind='COMPANY'",
            [campaignId],
          )
        ).rows[0].id as string;
        await assert.rejects(
          anon.query(
            `insert into anonymous.anonymous_response(id,organization_id,campaign_id,questionnaire_version_id,report_group_id)
             values($1,$2,$3,(select questionnaire_version_id from anonymous.anonymous_campaign_manifest where id=$3),$4)`,
            [randomUUID(), f.orgA, campaignId, companyId],
          ),
          /COMPANY_GROUP_NOT_ASSIGNABLE/,
        );
      },
    );

    await t.test(
      "committed anonymous content is immutable to the only credential that can reach it",
      async () => {
        for (const statement of [
          "update anonymous.anonymous_response set validity='VALID'",
          "delete from anonymous.anonymous_answer",
          "update anonymous.processed_batch set response_count=1",
          "delete from anonymous.processed_batch",
        ]) {
          const denial = await anon
            .query(statement)
            .then(() => "ALLOWED")
            .catch((e: Error) => e.message);
          assert.match(denial, /permission denied/, statement);
        }
      },
    );

    await t.test("answers and scores survive the transformation intact", async () => {
      const answers = await anon.query<{ n: number }>(
        "select count(*)::int n from anonymous.anonymous_answer where campaign_id=$1",
        [campaignId],
      );
      assert.ok(answers.rows[0].n >= 7, "every response kept its answers");
      const scores = await anon.query<{ status: string; n: number }>(
        `select status, count(*)::int n from anonymous.response_score
          where campaign_id=$1 group by status`,
        [campaignId],
      );
      assert.ok(scores.rows.some((r) => r.status === "VALID" && r.n > 0));
      // Answers are keyed by the instrument's STABLE key, not its internal id.
      const keys = await anon.query<{ question_key: string }>(
        "select distinct question_key::text from anonymous.anonymous_answer where campaign_id=$1",
        [campaignId],
      );
      const internalIds = await f.operator.query<{ id: string }>(
        "select id::text from instrument.question where version_id=$1",
        [f.coverageVersionId],
      );
      const internal = new Set(internalIds.rows.map((r) => r.id));
      for (const k of keys.rows)
        assert.ok(
          !internal.has(k.question_key),
          "answers must be keyed by stable key, not internal question id",
        );
    });

    await t.test(
      "accepted and processed counts must agree before a release is possible",
      async () => {
        const state = await reconcile(core, anon, campaignId);
        assert.equal(state.acceptedCount, 7);
        assert.equal(state.processedCount, 7);
        assert.equal(state.anonymousCount, 7);
        assert.equal(state.countsAgree, true);
        assert.equal(state.releasable, true);
        assert.equal(state.blocked, false);

        // Simulate a divergence: an extra completion with no envelope behind
        // it. Freezing must refuse, and must never "fix" the disagreement by
        // adjusting a count or by marking anyone incomplete.
        const { campaignId: mismatch } = await f.launchedCampaign(f.people);
        const mismatchLinks = await f.issueLinks(mismatch);
        await submitAll(mismatchLinks, 6);
        // One more invitation flipped to COMPLETED with no envelope behind it.
        await f.operator.query(
          "update core.invitation set status='COMPLETED' where id=$1",
          [mismatchLinks[6].invitationId],
        );
        await f.closeCampaign(mismatch);
        assert.equal(
          await failure(() => processCampaign(core, anon, mismatch)),
          "COUNT_MISMATCH",
          "a campaign whose completion and envelope counts disagree must not be frozen",
        );
        const nothing = await anon.query(
          "select count(*)::int n from anonymous.processed_batch where campaign_id=$1",
          [mismatch],
        );
        assert.equal(nothing.rows[0].n, 0);
      },
    );

    await t.test(
      "staff see completion counts but no answer, score or response identifier",
      async () => {
        const view = (await withStaff(f.staff, (tx) =>
          participation(tx, f.orgA, campaignId),
        )) as { items: Record<string, unknown>[]; totals: Record<string, unknown> };
        assert.equal(view.totals.completed, 7);
        const serialized = JSON.stringify(view);
        const responseIds = await anon.query<{ id: string }>(
          "select id::text from anonymous.anonymous_response where campaign_id=$1",
          [campaignId],
        );
        for (const r of responseIds.rows)
          assert.ok(!serialized.includes(r.id));
        for (const field of ["answer", "score", "responseId", "ciphertext", "envelope"])
          assert.ok(
            !serialized.includes(field),
            `participation must not expose ${field}`,
          );
      },
    );

    await t.test("cross-organization isolation holds in the anonymous store", async () => {
      const { rows } = await anon.query(
        "select count(*)::int n from anonymous.anonymous_response where organization_id<>$1",
        [f.orgA],
      );
      assert.equal(rows[0].n, 0);
      // Every anonymous row's organization matches its manifest's organization.
      const orphans = await anon.query(
        `select count(*)::int n from anonymous.anonymous_response r
           left join anonymous.anonymous_campaign_manifest m
             on m.id=r.campaign_id and m.organization_id=r.organization_id
          where m.id is null`,
      );
      assert.equal(orphans.rows[0].n, 0);
    });

    await t.test("the shuffle is a real permutation over a cryptographic RNG", () => {
      const source = Array.from({ length: 200 }, (_, i) => i);
      const shuffled = shuffle([...source]);
      assert.deepEqual([...shuffled].sort((a, b) => a - b), source);
      assert.notDeepEqual(shuffled, source);
    });
  } finally {
    await core.end();
    await anon.end();
    await f.close();
  }
});
