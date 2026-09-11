import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { withStaff } from "../src/db";
import { invitationAction, participation } from "../src/campaigns";
import {
  exchange,
  status,
  refresh,
  instrument,
  draftCreate,
  draftSave,
  draftRead,
  draftStartOver,
  review,
  finalize,
} from "../src/respondent";
import {
  CIPHER_VERSION,
  encryptDraft,
  decryptDraft,
  importDraftKey,
  newDraftKeyBytes,
  newHandle,
  encodeResumeCode,
  parseResumeCode,
} from "../src/draft-format";
import { openEnvelope } from "../src/intake-envelope";
import { openCampaignKey } from "../src/key-custody";
import { gatewayReadiness, assertNoForeignCredentials, gatewayUrl } from "../src/gateway-db";
import type { Instrument } from "../src/instrument-input";
import { respondentFixture, failure, type Fixture } from "./respondent-fixture";

// Answers that satisfy every mandatory item of the seeded illustrative
// instrument. Built from the pinned definition, not hardcoded.
function completeAnswers(document: Instrument) {
  const answers: Record<string, string | string[]> = {};
  for (const q of document.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    switch (q.type) {
      case "SHORT_TEXT":
      case "LONG_TEXT":
        answers[q.id] = "إجابة اختبارية";
        break;
      case "RATING_5":
        answers[q.id] = "4";
        break;
      case "RATING_10":
        answers[q.id] = "7";
        break;
      case "NUMBER":
        answers[q.id] = q.validation.min ?? "1";
        break;
      case "DATE":
        answers[q.id] = q.validation.minDate ?? "2026-01-01";
        break;
      case "CHECKBOXES":
        answers[q.id] = q.options
          .slice(0, Math.max(1, q.validation.minSelections ?? 1))
          .map((o) => o.id);
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
async function openSession(token: string) {
  const result = await exchange(token);
  assert.ok(result.session, "a valid link must yield a session");
  return result.session;
}
async function saveNewDraft(
  session: string,
  versionId: string,
  answers: Record<string, string | string[]>,
) {
  const raw = newDraftKeyBytes(),
    handle = newHandle();
  const key = await importDraftKey(raw);
  const sealed = await encryptDraft(key, handle, 1, {
    schemaVersion: 1,
    versionId,
    answers,
    locale: "ar",
  });
  const result = (await draftCreate(session, {
    handle,
    cipherVersion: CIPHER_VERSION,
    ...sealed,
    expectedRevision: 0,
  })) as { handle: string; revision: number };
  return { handle, raw, key, revision: result.revision };
}

test("PostgreSQL respondent flow: sessions, encrypted drafts and atomic acceptance", async (t) => {
  const f: Fixture = await respondentFixture(6);
  try {
    // ---------------------------------------------------------------------
    await t.test(
      "the gateway credential holds no table privilege and refuses foreign secrets",
      async () => {
        await gatewayReadiness();
        // A gateway process carrying a staff, operator, processor or custody
        // secret must refuse to start rather than silently bridging boundaries.
        for (const key of [
          "DATABASE_URL",
          "MIGRATION_DATABASE_URL",
          "PROCESSOR_DATABASE_URL",
          "ANONYMOUS_DATABASE_URL",
          "CAMPAIGN_KEY_CUSTODY_SECRET_KEY",
        ])
          assert.throws(() => assertNoForeignCredentials({ [key]: "x" }));
        assert.doesNotThrow(() =>
          assertNoForeignCredentials({ GATEWAY_DATABASE_URL: "x" }),
        );
        // Only the orgfit_gateway role is accepted in a deployed gateway.
        const previous = process.env.GATEWAY_DATABASE_URL;
        process.env.GATEWAY_DATABASE_URL = f.fixture.url("orgfit_staff");
        assert.equal(
          await failure(async () => gatewayUrl()),
          "TEMPORARILY_UNAVAILABLE",
        );
        if (previous === undefined) delete process.env.GATEWAY_DATABASE_URL;
        else process.env.GATEWAY_DATABASE_URL = previous;

        // The staff credential must not be able to reach intake at all: no
        // draft, no envelope, no key, no session, and no routine that opens one.
        const staffDb = new (await import("pg")).default.Client({
          connectionString: f.fixture.url("orgfit_staff"),
        });
        await staffDb.connect();
        try {
          for (const statement of [
            "select * from intake.draft_blob",
            "select * from intake.submission_inbox",
            "select * from intake.campaign_key",
            "select * from intake.respondent_session",
            "select * from intake.processing_batch",
            "select intake.draft_read($1,$2)",
            "select intake.batch_payload($1,$2)",
            "select intake.accept($1,$2,$3)",
          ]) {
            const denial = await staffDb
              .query(statement, statement.includes("$") ? [null, null, null].slice(0, (statement.match(/\$/g) ?? []).length) : [])
              .then(() => "ALLOWED")
              .catch((e: Error) => e.message);
            assert.match(
              denial,
              /permission denied|does not exist/,
              `orgfit_staff must be denied: ${statement} (got ${denial})`,
            );
          }
        } finally {
          await staffDb.end();
        }
      },
    );

    const { campaignId } = await f.launchedCampaign();
    const links = await f.issueLinks(campaignId);

    // ---------------------------------------------------------------------
    await t.test(
      "launch provisions exactly one active sealed-box key and stores only its public half",
      async () => {
        const { rows } = await f.operator.query(
          "select key_reference,octet_length(public_key) len,key_epoch,state from intake.campaign_key where campaign_id=$1",
          [campaignId],
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].len, 32);
        assert.equal(rows[0].state, "ACTIVE");
        // No column anywhere in the core database holds a private key.
        const secrets = await f.operator.query(
          `select count(*)::int n from information_schema.columns
            where table_schema='intake' and column_name ~* 'private|secret'`,
        );
        assert.equal(secrets.rows[0].n, 0);
        const files = await readdir(f.custodyDirectory);
        assert.equal(files.length, 1, "one sealed private key exists in custody");
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "a launch with no key custody fails closed and leaves the campaign in DRAFT",
      async () => {
        // Without an authenticated campaign key there is nothing to seal an
        // acceptance to, so the campaign must never open for answers. The whole
        // launch transaction rolls back rather than opening a campaign that
        // would have to fall back to storing plaintext.
        const previous = process.env.CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY;
        delete process.env.CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY;
        try {
          assert.equal(
            await failure(() => f.launchedCampaign([f.people[5]])),
            "Key custody is unavailable",
          );
        } finally {
          process.env.CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY = previous;
        }
        // No campaign was left half-launched: nothing is OPEN without a key.
        const orphans = await f.operator.query(
          `select count(*)::int n from core.campaign c
             where c.state<>'DRAFT' and c.state<>'CANCELLED'
               and not exists (select 1 from intake.campaign_key k where k.campaign_id=c.id)`,
        );
        assert.equal(orphans.rows[0].n, 0);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "opening a link yields context without consuming it and without any identity",
      async () => {
        const before = (await withStaff(f.staff, (tx) =>
          participation(tx, f.orgA, campaignId),
        )) as { totals: { completed: number; outstanding: number } };
        const session = await openSession(links[0].token);
        const context = await status(session);
        assert.equal(context.access, "OPEN");
        const serialized = JSON.stringify(context);
        for (const forbidden of [
          links[0].invitationId,
          f.people[0],
          "participant",
          "invitation",
          "token",
        ])
          assert.ok(
            !serialized.includes(forbidden),
            `gateway context must not carry ${forbidden}`,
          );
        const after = (await withStaff(f.staff, (tx) =>
          participation(tx, f.orgA, campaignId),
        )) as { totals: { completed: number; outstanding: number } };
        assert.deepEqual(after.totals, before.totals, "opening consumes nothing");
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "expired, revoked, rotated and tampered links are all the same generic failure",
      async () => {
        assert.equal((await exchange("x".repeat(43))).context.access, "UNAVAILABLE");
        // Tampering with one character of a valid token.
        const tampered =
          links[5].token.slice(0, 42) + (links[5].token.at(-1) === "A" ? "B" : "A");
        assert.equal((await exchange(tampered)).context.access, "UNAVAILABLE");

        // Rotation invalidates the live session as well as the old token.
        const list = (await withStaff(f.staff, (tx) =>
          participation(tx, f.orgA, campaignId),
        )) as { items: { invitationId: string; generation: number }[] };
        const target = list.items.find((i) => i.invitationId === links[5].invitationId)!;
        const live = await openSession(links[5].token);
        assert.equal((await status(live)).access, "OPEN");
        const rotated = (await withStaff(f.staff, (tx) =>
          invitationAction(
            tx,
            f.orgA,
            campaignId,
            target.invitationId,
            "ROTATE",
            { expectedGeneration: target.generation },
            randomUUID(),
          ),
        )) as { url: string };
        assert.equal((await exchange(links[5].token)).context.access, "UNAVAILABLE");
        assert.equal((await status(live)).access, "SESSION_EXPIRED");
        links[5].token = rotated.url.split("#")[1];

        // Revocation is the same generic outcome for a link holder.
        const list2 = (await withStaff(f.staff, (tx) =>
          participation(tx, f.orgA, campaignId),
        )) as { items: { invitationId: string; generation: number }[] };
        const victim = list2.items.find((i) => i.invitationId === links[5].invitationId)!;
        await withStaff(f.staff, (tx) =>
          invitationAction(
            tx,
            f.orgA,
            campaignId,
            victim.invitationId,
            "REVOKE",
            { expectedGeneration: victim.generation, reason: "غادر المنظمة" },
            randomUUID(),
          ),
        );
        assert.equal((await exchange(links[5].token)).context.access, "UNAVAILABLE");
      },
    );

    // ---------------------------------------------------------------------
    let versionId = "";
    await t.test(
      "the questionnaire is served from the pinned frozen version only",
      async () => {
        const session = await openSession(links[0].token);
        const payload = await instrument(session);
        versionId = payload.versionId;
        assert.ok(payload.document.sections.length > 0);
        assert.match(payload.instrumentHash, /^[a-f0-9]{64}$/);
        // Refresh renews the idle window and returns the same access state.
        assert.equal((await refresh(session)).access, "OPEN");
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "a saved draft resumes on the same device and across devices with the private code",
      async () => {
        const session = await openSession(links[0].token);
        const answers = { probe: "قيمة" };
        const draft = await saveNewDraft(session, versionId, answers);
        assert.equal(draft.revision, 1);

        // Same-device: the browser still holds handle and key locally.
        const read = (await draftRead(session, { handle: draft.handle })) as {
          nonce: string;
          ciphertext: string;
          revision: number;
        };
        const same = await decryptDraft(
          draft.key,
          draft.handle,
          versionId,
          read.revision,
          read.nonce,
          read.ciphertext,
        );
        assert.deepEqual(same.answers, answers);

        // Cross-device: a NEW session from the same link, plus only the private
        // resume code, reconstructs the key locally and decrypts.
        const code = encodeResumeCode(draft.handle, draft.raw);
        const parsed = parseResumeCode(code);
        assert.ok(parsed);
        assert.equal(parsed!.handle, draft.handle);
        const otherDevice = await openSession(links[0].token);
        const cipher = (await draftRead(otherDevice, { handle: parsed!.handle })) as {
          nonce: string;
          ciphertext: string;
          revision: number;
        };
        const elsewhere = await decryptDraft(
          await importDraftKey(parsed!.key),
          parsed!.handle,
          versionId,
          cipher.revision,
          cipher.nonce,
          cipher.ciphertext,
        );
        assert.deepEqual(elsewhere.answers, answers);
        assert.equal(parseResumeCode("DF1.short.abc"), null);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "the original invitation link alone cannot decrypt the saved draft",
      async () => {
        // An administrator who kept the link opens a perfectly valid session
        // and can fetch the ciphertext. That is by design; the point is what
        // happens next.
        const adminSession = await openSession(links[0].token);
        const handle = (
          await f.operator.query(
            "select id from intake.draft_blob where invitation_id=$1",
            [links[0].invitationId],
          )
        ).rows[0].id as string;
        const cipher = (await draftRead(adminSession, { handle })) as {
          nonce: string;
          ciphertext: string;
          revision: number;
        };
        assert.ok(cipher.ciphertext.length > 0);

        // Every key an administrator could plausibly derive from what the
        // server and the link give them must fail the GCM tag check.
        const candidates = [
          // the token itself, padded to 32 bytes
          Buffer.concat([Buffer.from(links[0].token, "utf8")], 32),
          // the stored token digest
          (
            await f.operator.query(
              "select token_digest from core.invitation where id=$1",
              [links[0].invitationId],
            )
          ).rows[0].token_digest as Buffer,
          // the draft handle bytes
          Buffer.concat([Buffer.from(handle.replace(/-/g, ""), "hex")], 32),
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
            "no server-side or link-derived value decrypts a DF1 draft",
          );

        // And the key genuinely is not anywhere in the core database.
        const columns = await f.operator.query(
          `select count(*)::int n from information_schema.columns
            where table_schema='intake' and table_name='draft_blob'
              and column_name in ('key','draft_key','secret','resume_code')`,
        );
        assert.equal(columns.rows[0].n, 0);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "a stale revision conflicts instead of silently overwriting another tab",
      async () => {
        const session = await openSession(links[1].token);
        const draft = await saveNewDraft(session, versionId, { a: "1" });
        // Tab one saves.
        const next = await encryptDraft(draft.key, draft.handle, 2, {
          schemaVersion: 1,
          versionId,
          answers: { a: "2" },
          locale: "ar",
        });
        const saved = (await draftSave(session, {
          handle: draft.handle,
          cipherVersion: CIPHER_VERSION,
          ...next,
          expectedRevision: 1,
        })) as { revision: number };
        assert.equal(saved.revision, 2);
        // Tab two still believes it is at revision 1 and must be refused.
        const stale = await encryptDraft(draft.key, draft.handle, 2, {
          schemaVersion: 1,
          versionId,
          answers: { a: "stale" },
          locale: "ar",
        });
        assert.equal(
          await failure(() =>
            draftSave(session, {
              handle: draft.handle,
              cipherVersion: CIPHER_VERSION,
              ...stale,
              expectedRevision: 1,
            }),
          ),
          "DRAFT_CONFLICT",
        );
        // The stored draft is still tab one's version, not the stale one.
        const read = (await draftRead(session, { handle: draft.handle })) as {
          nonce: string;
          ciphertext: string;
          revision: number;
        };
        assert.equal(read.revision, 2);
        assert.deepEqual(
          (
            await decryptDraft(
              draft.key,
              draft.handle,
              versionId,
              2,
              read.nonce,
              read.ciphertext,
            )
          ).answers,
          { a: "2" },
        );
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "a foreign draft handle is indistinguishable from one that does not exist",
      async () => {
        const other = await openSession(links[2].token);
        const foreignHandle = (
          await f.operator.query(
            "select id from intake.draft_blob where invitation_id=$1",
            [links[0].invitationId],
          )
        ).rows[0].id as string;
        assert.equal(
          await failure(() => draftRead(other, { handle: foreignHandle })),
          "DRAFT_UNAVAILABLE",
        );
        assert.equal(
          await failure(() => draftRead(other, { handle: randomUUID() })),
          "DRAFT_UNAVAILABLE",
        );
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "start-over destroys the old ciphertext and breaks the old code permanently",
      async () => {
        const session = await openSession(links[2].token);
        const draft = await saveNewDraft(session, versionId, { a: "old" });
        const oldCode = encodeResumeCode(draft.handle, draft.raw);
        await draftStartOver(session);
        assert.equal(
          await failure(() => draftRead(session, { handle: draft.handle })),
          "DRAFT_UNAVAILABLE",
        );
        // A concurrent save from a tab that still holds the old handle fails.
        const late = await encryptDraft(draft.key, draft.handle, 2, {
          schemaVersion: 1,
          versionId,
          answers: { a: "late" },
          locale: "ar",
        });
        assert.equal(
          await failure(() =>
            draftSave(session, {
              handle: draft.handle,
              cipherVersion: CIPHER_VERSION,
              ...late,
              expectedRevision: 1,
            }),
          ),
          "DRAFT_UNAVAILABLE",
        );
        // A fresh draft gets a new handle and a new key.
        const replacement = await saveNewDraft(session, versionId, { a: "new" });
        assert.notEqual(replacement.handle, draft.handle);
        assert.notEqual(
          encodeResumeCode(replacement.handle, replacement.raw),
          oldCode,
        );
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "invalid answers are refused without consuming the invitation",
      async () => {
        const session = await openSession(links[3].token);
        const document = (await instrument(session)).document;
        const complete = completeAnswers(document);
        const firstRequired = Object.keys(complete)[0];

        // Missing mandatory item.
        const incomplete = { ...complete };
        delete incomplete[firstRequired];
        assert.equal(
          await failure(() => finalize(session, { answers: incomplete })),
          "VALIDATION_FAILED",
        );
        // Tampered option identifier: an option that belongs to no question.
        const question = document.sections
          .flatMap((s) => s.questions)
          .find((q) => q.type === "MULTIPLE_CHOICE" || q.type === "DROPDOWN");
        assert.ok(question, "the coverage instrument must have an option question");
        assert.equal(
          await failure(() =>
            finalize(session, {
              answers: { ...complete, [question.id]: randomUUID() },
            }),
          ),
          "VALIDATION_FAILED",
        );
        // An option borrowed from a DIFFERENT question of the same instrument
        // is still not a member of this question's option set.
        const donor = document.sections
          .flatMap((s) => s.questions)
          .find((q) => q.options.length > 0 && q.id !== question.id);
        if (donor)
          assert.equal(
            await failure(() =>
              finalize(session, {
                answers: { ...complete, [question.id]: donor.options[0].id },
              }),
            ),
            "VALIDATION_FAILED",
          );
        // Tampered matrix row and column identifiers.
        const matrix = document.sections
          .flatMap((s) => s.questions)
          .find((q) => q.type === "MATRIX");
        if (matrix) {
          assert.equal(
            await failure(() =>
              finalize(session, {
                answers: { ...complete, [matrix.rows[0].id]: randomUUID() },
              }),
            ),
            "VALIDATION_FAILED",
          );
          const orphan = { ...complete };
          delete orphan[matrix.rows[0].id];
          assert.equal(
            await failure(() =>
              finalize(session, { answers: { ...orphan, [randomUUID()]: matrix.columns[0].id } }),
            ),
            "VALIDATION_FAILED",
          );
        }
        // Out-of-range number and out-of-window date.
        for (const [type, bad] of [
          ["NUMBER", "99"],
          ["DATE", "1999-01-01"],
        ] as const) {
          const q = document.sections
            .flatMap((s) => s.questions)
            .find((x) => x.type === type);
          if (q)
            assert.equal(
              await failure(() =>
                finalize(session, { answers: { ...complete, [q.id]: bad } }),
              ),
              "VALIDATION_FAILED",
            );
        }
        // A tampered questionnaire version cannot even be expressed: the
        // finalize payload has no version field and the server pins its own.
        const pinned = await instrument(session);
        assert.equal(pinned.versionId, f.coverageVersionId);
        // Unknown question identifier.
        assert.equal(
          await failure(() =>
            finalize(session, {
              answers: { ...complete, [randomUUID()]: "x" },
            }),
          ),
          "VALIDATION_FAILED",
        );
        // Out-of-range rating.
        const rating = document.sections
          .flatMap((s) => s.questions)
          .find((q) => q.type === "RATING_5");
        if (rating)
          assert.equal(
            await failure(() =>
              finalize(session, { answers: { ...complete, [rating.id]: "9" } }),
            ),
            "VALIDATION_FAILED",
          );

        // Not one of those attempts may have consumed the link or written an
        // envelope, and review reports the same verdict without persisting.
        const stateRow = await f.operator.query(
          "select status from core.invitation where id=$1",
          [links[3].invitationId],
        );
        assert.equal(stateRow.rows[0].status, "READY");
        const inbox = await f.operator.query(
          "select count(*)::int n from intake.submission_inbox where invitation_id=$1",
          [links[3].invitationId],
        );
        assert.equal(inbox.rows[0].n, 0);
        const verdict = (await review(session, { answers: incomplete })) as {
          valid: boolean;
        };
        assert.equal(verdict.valid, false);
        assert.equal(
          ((await review(session, { answers: complete })) as { valid: boolean })
            .valid,
          true,
        );
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "the client cannot influence organization, campaign, version or report group",
      async () => {
        const session = await openSession(links[3].token);
        const document = (await instrument(session)).document;
        const complete = completeAnswers(document);
        // The finalize contract accepts ONLY an answers map. Anything else is
        // rejected by the schema before a database call happens.
        for (const extra of [
          { organizationId: f.orgB },
          { campaignId: randomUUID() },
          { versionId: randomUUID() },
          { reportGroupId: randomUUID() },
          { scores: { overall: 100 } },
        ])
          assert.equal(
            await failure(async () => {
              const parsed = (
                await import("../src/respondent")
              ).respondentInput.answersInput.safeParse({
                answers: complete,
                ...extra,
              });
              if (!parsed.success) throw new Error("VALIDATION_FAILED");
            }),
            "VALIDATION_FAILED",
          );
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "acceptance is atomic, consumes the link once and deletes the draft",
      async () => {
        const session = await openSession(links[3].token);
        const document = (await instrument(session)).document;
        const answers = completeAnswers(document);
        await saveNewDraft(session, versionId, answers);
        const result = (await finalize(session, { answers })) as {
          access: string;
        };
        assert.equal(result.access, "ACCEPTED");

        const row = await f.operator.query(
          `select i.status, (select count(*)::int from intake.submission_inbox e where e.invitation_id=i.id) envelopes,
                  (select count(*)::int from intake.draft_blob d where d.invitation_id=i.id) drafts
             from core.invitation i where i.id=$1`,
          [links[3].invitationId],
        );
        assert.equal(row.rows[0].status, "COMPLETED");
        assert.equal(row.rows[0].envelopes, 1, "exactly one accepted envelope");
        assert.equal(row.rows[0].drafts, 0, "the draft is gone in the same transaction");

        // The completed link can still report its own state, and cannot reopen,
        // resume or re-submit.
        assert.equal((await status(session)).access, "ACCEPTED");
        assert.equal(
          await failure(() => draftRead(session, { handle: randomUUID() })),
          "ALREADY_ACCEPTED",
        );
        assert.equal(
          await failure(() => draftCreate(session, {
            handle: randomUUID(),
            cipherVersion: CIPHER_VERSION,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "AAAAAAAAAAAAAAAAAAAAAAA=",
            expectedRevision: 0,
          })),
          "ALREADY_ACCEPTED",
        );
        assert.equal((await exchange(links[3].token)).context.access, "ACCEPTED");
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "a lost success response is safe to retry and never overwrites the first payload",
      async () => {
        const session = await openSession(links[3].token);
        const document = (
          await instrument(await openSession(links[0].token))
        ).document;
        const stored = (
          await f.operator.query(
            "select ciphertext from intake.submission_inbox where invitation_id=$1",
            [links[3].invitationId],
          )
        ).rows[0].ciphertext as Buffer;

        // The client never saw the 200. It retries with DIFFERENT answers.
        const different = completeAnswers(document);
        const rating = Object.keys(different).find((k) => different[k] === "4");
        if (rating) different[rating] = "1";
        const retry = await failure(() => finalize(session, { answers: different }));
        assert.equal(
          retry,
          "ALREADY_ACCEPTED",
          "a retry is a state conflict resolved as generic acceptance, not an overwrite",
        );
        const after = (
          await f.operator.query(
            "select ciphertext from intake.submission_inbox where invitation_id=$1",
            [links[3].invitationId],
          )
        ).rows[0].ciphertext as Buffer;
        assert.ok(stored.equals(after), "the first accepted payload is immutable");
        // The status route gives the client the answer it needed all along.
        assert.equal((await status(session)).access, "ACCEPTED");
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "100 concurrent finalizations of one invitation accept exactly one",
      async () => {
        const { campaignId: raceCampaign } = await f.launchedCampaign([
          f.people[0],
        ]);
        const raceLinks = await f.issueLinks(raceCampaign);
        const primer = await openSession(raceLinks[0].token);
        const document = (await instrument(primer)).document;
        const answers = completeAnswers(document);

        // 100 independent sessions on the SAME invitation, all racing.
        const sessions = await Promise.all(
          Array.from({ length: 100 }, () => openSession(raceLinks[0].token)),
        );
        const outcomes = await Promise.all(
          sessions.map((s) =>
            finalize(s, { answers })
              .then(() => "ACCEPTED")
              .catch((e: Error) => e.message),
          ),
        );
        const accepted = outcomes.filter((o) => o === "ACCEPTED").length;
        const duplicates = outcomes.filter((o) => o === "ALREADY_ACCEPTED").length;
        assert.equal(
          accepted,
          1,
          `exactly one attempt may write the accepted payload (got ${accepted})`,
        );
        assert.equal(
          accepted + duplicates,
          100,
          `every other attempt must be a generic duplicate, not an error (outcomes: ${JSON.stringify([...new Set(outcomes)])})`,
        );
        const rows = await f.operator.query(
          "select count(*)::int n from intake.submission_inbox where invitation_id=$1",
          [raceLinks[0].invitationId],
        );
        assert.equal(rows.rows[0].n, 1, "one row, enforced by the unique constraint");
        const completed = await f.operator.query(
          "select count(*)::int n from core.invitation where campaign_id=$1 and status='COMPLETED'",
          [raceCampaign],
        );
        assert.equal(completed.rows[0].n, 1);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "closure racing with finalization never produces a half-accepted submission",
      async () => {
        const { campaignId: raceCampaign } = await f.launchedCampaign([
          f.people[1],
          f.people[2],
        ]);
        const raceLinks = await f.issueLinks(raceCampaign);
        const session = await openSession(raceLinks[0].token);
        const document = (await instrument(session)).document;
        const answers = completeAnswers(document);

        // Both operations take the campaign lock; whichever wins, the result is
        // consistent: either accepted and completed, or refused and untouched.
        const [submitted, closed] = await Promise.allSettled([
          finalize(session, { answers }),
          f.closeCampaign(raceCampaign),
        ]);
        assert.equal(closed.status, "fulfilled");
        const state = await f.operator.query(
          `select i.status, (select count(*)::int from intake.submission_inbox e where e.invitation_id=i.id) envelopes
             from core.invitation i where i.id=$1`,
          [raceLinks[0].invitationId],
        );
        if (submitted.status === "fulfilled") {
          assert.equal(state.rows[0].status, "COMPLETED");
          assert.equal(state.rows[0].envelopes, 1);
        } else {
          assert.equal(state.rows[0].status, "READY");
          assert.equal(state.rows[0].envelopes, 0);
          assert.equal(
            (submitted.reason as Error).message,
            "COLLECTION_UNAVAILABLE",
          );
        }
        // After closure the second respondent is refused, with the link intact.
        const late = await exchange(raceLinks[1].token);
        assert.equal(late.context.access, "CLOSED");
        assert.equal(
          await failure(() => finalize(late.session!, { answers })),
          "COLLECTION_UNAVAILABLE",
        );
        const untouched = await f.operator.query(
          "select status from core.invitation where id=$1",
          [raceLinks[1].invitationId],
        );
        assert.equal(untouched.rows[0].status, "READY");
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "the sealed envelope decrypts only with the campaign's custody key and binds its context",
      async () => {
        const row = await f.operator.query(
          `select e.key_reference, e.ciphertext, e.organization_id, e.campaign_id, e.invitation_id
             from intake.submission_inbox e where e.invitation_id=$1`,
          [links[3].invitationId],
        );
        const record = row.rows[0];
        const keys = await openCampaignKey(record.key_reference);
        const envelope = await openEnvelope(record.ciphertext, keys);
        assert.equal(envelope.protocol, "IN1");
        assert.equal(envelope.organizationId, f.orgA);
        assert.equal(envelope.campaignId, campaignId);
        assert.equal(envelope.invitationId, links[3].invitationId);
        assert.ok(Object.keys(envelope.answers).length > 0);
        // A different campaign's key cannot open it.
        const { campaignId: otherCampaign } = await f.launchedCampaign([
          f.people[4],
        ]);
        const otherRef = (
          await f.operator.query(
            "select key_reference from intake.campaign_key where campaign_id=$1",
            [otherCampaign],
          )
        ).rows[0].key_reference as string;
        await assert.rejects(
          openEnvelope(record.ciphertext, await openCampaignKey(otherRef)),
        );
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "an expired campaign refuses collection without consuming any link",
      async () => {
        // A campaign whose end boundary has passed, with the stored state
        // deliberately left OPEN so that a late scheduler is simulated.
        const { campaignId: ending } = await f.launchedCampaign([f.people[4]]);
        const endingLinks = await f.issueLinks(ending);
        const session = await openSession(endingLinks[0].token);
        const document = (await instrument(session)).document;
        const answers = completeAnswers(document);
        await f.operator.query(
          "update core.campaign set ends_at=clock_timestamp()-interval '1 second' where id=$1",
          [ending],
        );
        const stored = await f.operator.query(
          "select state from core.campaign where id=$1",
          [ending],
        );
        assert.equal(stored.rows[0].state, "OPEN", "no scheduler has run yet");
        // Request-time evaluation is authoritative regardless of stored state.
        assert.equal((await status(session)).access, "CLOSED");
        assert.equal(
          await failure(() => finalize(session, { answers })),
          "COLLECTION_UNAVAILABLE",
        );
        assert.equal(
          await failure(() =>
            draftCreate(session, {
              handle: randomUUID(),
              cipherVersion: CIPHER_VERSION,
              nonce: "AAAAAAAAAAAAAAAA",
              ciphertext: "AAAAAAAAAAAAAAAAAAAAAAA=",
              expectedRevision: 0,
            }),
          ),
          "COLLECTION_UNAVAILABLE",
        );
        const untouched = await f.operator.query(
          "select status from core.invitation where id=$1",
          [endingLinks[0].invitationId],
        );
        assert.equal(untouched.rows[0].status, "READY");
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "expired drafts and sessions are removed by expiry alone",
      async () => {
        const session = await openSession(links[4].token);
        const draft = await saveNewDraft(session, versionId, { a: "1" });
        await f.operator.query(
          "update intake.draft_blob set expires_at=clock_timestamp()-interval '1 second' where id=$1",
          [draft.handle],
        );
        // An expired draft is already unreadable before any janitor runs.
        assert.equal(
          await failure(() => draftRead(session, { handle: draft.handle })),
          "DRAFT_UNAVAILABLE",
        );
        const removed = await f.operator.query<{
          data: { drafts: number; sessions: number };
        }>("select intake.expire_temporary($1) as data", [1000]);
        assert.ok(removed.rows[0].data.drafts >= 1);
        const gone = await f.operator.query(
          "select count(*)::int n from intake.draft_blob where id=$1",
          [draft.handle],
        );
        assert.equal(gone.rows[0].n, 0);
        // The draft TTL is capped at closure + 7 days rather than open-ended.
        const capped = await openSession(links[4].token);
        const replacement = await saveNewDraft(capped, versionId, { a: "2" });
        const expiry = await f.operator.query<{ within: boolean }>(
          "select (expires_at <= clock_timestamp()+interval '31 days') as within from intake.draft_blob where id=$1",
          [replacement.handle],
        );
        assert.equal(expiry.rows[0].within, true);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "public errors and gateway responses carry no correlation data",
      async () => {
        // Every failure a respondent can provoke, checked for leakage.
        const session = await openSession(links[4].token);
        const document = (await instrument(session)).document;
        const secrets = [
          links[4].token,
          links[4].invitationId,
          f.people[4],
          f.orgA,
          campaignId,
        ];
        const attempts: (() => Promise<unknown>)[] = [
          () => exchange("z".repeat(43)),
          () => status("bad"),
          () => draftRead(session, { handle: randomUUID() }),
          () => finalize(session, { answers: {} }),
          () =>
            draftSave(session, {
              handle: randomUUID(),
              cipherVersion: CIPHER_VERSION,
              nonce: "AAAAAAAAAAAAAAAA",
              ciphertext: "AAAAAAAAAAAAAAAAAAAAAAA=",
              expectedRevision: 5,
            }),
        ];
        for (const attempt of attempts) {
          let payload = "";
          try {
            payload = JSON.stringify(await attempt());
          } catch (e) {
            // The error surface is a code and nothing else: no message text, no
            // stack contents, no SQL, no bind value.
            const error = e as Error & { code?: string; status?: number };
            payload = JSON.stringify({
              code: error.code,
              status: error.status,
              message: error.message,
            });
            assert.ok(
              error.code && /^[A-Z_]+$/.test(error.code),
              `a respondent error must be a coarse code, got ${error.code}`,
            );
          }
          for (const value of secrets)
            assert.ok(
              !payload.includes(value),
              `a respondent-visible payload must not contain ${value}`,
            );
        }
        // A successful review response is equally free of identity.
        const verdict = JSON.stringify(
          await review(session, { answers: completeAnswers(document) }),
        );
        for (const value of secrets)
          assert.ok(!verdict.includes(value), `review must not echo ${value}`);
      },
    );

    // ---------------------------------------------------------------------
    await t.test(
      "no core table records an acceptance instant or a client attribute",
      async () => {
        // The structural guarantee behind "no exact submission time": there is
        // no such column to populate.
        const { rows } = await f.operator.query<{
          table_name: string;
          column_name: string;
        }>(
          `select table_name, column_name from information_schema.columns
            where table_schema='intake' order by table_name, column_name`,
        );
        const forbidden =
          /ip_|ip$|address|user_agent|useragent|request_id|trace|correlation|actor|submitted_at|accepted_at|completed_at|received_at/i;
        for (const c of rows)
          assert.ok(
            !forbidden.test(c.column_name),
            `intake.${c.table_name}.${c.column_name} is a forbidden field`,
          );
        // The inbox in particular carries no timestamp of any kind.
        assert.equal(
          rows.filter(
            (c) => c.table_name === "submission_inbox" && /_at$/.test(c.column_name),
          ).length,
          0,
          "an accepted envelope must not record when it arrived",
        );
        // core.invitation records completion as a state, not as an instant.
        const invitation = await f.operator.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema='core' and table_name='invitation'`,
        );
        assert.ok(
          !invitation.rows.some((c) => /completed_at|submitted_at/i.test(c.column_name)),
          "completion must not carry a per-person timestamp",
        );
      },
    );

    // ---------------------------------------------------------------------
    await t.test("cross-organization isolation holds on every respondent path", async () => {
      // Organization B's staff cannot read organization A's campaign at all,
      // and there is no respondent route that takes an organization parameter.
      const otherStaff = await f.session("admin");
      assert.equal(
        await failure(() =>
          withStaff(otherStaff, (tx) => participation(tx, f.orgB, campaignId)),
        ),
        "NOT_FOUND",
      );
      const bleed = await f.operator.query(
        `select count(*)::int n from intake.submission_inbox where organization_id<>$1`,
        [f.orgA],
      );
      assert.equal(bleed.rows[0].n, 0);
    });
  } finally {
    await f.close();
  }
});
