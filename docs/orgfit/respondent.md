# Respondent flow, encrypted drafts and anonymous intake (Phase 07)

Development scope. This module adds the public respondent journey, DF1 encrypted
drafts with a browser-held key, the IN1 sealed acceptance envelope, the atomic
acceptance transaction, and the closed-campaign privacy processor that writes the
finalized anonymous store.

**Read [the privacy guarantee](#what-this-does-and-does-not-guarantee) before
describing this module to anyone.** Nothing here is a proof of anonymity, and
nothing here is production readiness.

## What actually runs

| Component | Identity | What it can do |
|---|---|---|
| Staff application (`apps/staff`) | `orgfit_staff` | Everything from Phases 02–06. **No** privilege on schema `intake` at all — it cannot even name an intake object. Launch calls `core.register_campaign_key`, a definer routine, to record a campaign PUBLIC key. |
| Respondent gateway (`apps/respondent`) | `orgfit_gateway` | Exchange, status, refresh, instrument, draft create/save/read/start-over, review, finalize. **Zero table privileges**; every action is a session-scoped `SECURITY DEFINER` routine that resolves the invitation itself. |
| Privacy processor (`scripts/process-campaigns.ts`) | `orgfit_processor` on core **and** on the anonymous database | Freeze a batch, read the ciphertext it froze, commit the anonymous batch, clean up. Cannot read a participant, an invitation, a draft, or accept a submission. |
| Key custodian | `CAMPAIGN_KEY_CUSTODY_SECRET_KEY` | The only holder of campaign private keys. |

`src/gateway-db.ts` refuses to start a gateway whose environment contains a
staff, operator, processor, anonymous or custodian-secret credential.
`src/config.ts` refuses to start a staff process that holds any of the same.
`npm run check:boundaries` asserts the build traces match.

## Setup

```bash
npm run db:migrate
npm run db:migrate-anonymous
```

Migration `009_intake.sql` applies to the core database; `db/anonymous/001_anonymous.sql`
applies to a **separate** database through `ANONYMOUS_MIGRATION_DATABASE_URL`.
Apply `db/roles.sql` again first — it is idempotent and adds the four roles this
phase introduces (`orgfit_gateway`, `orgfit_processor`, `orgfit_anon_owner`,
`orgfit_anon_migrator`).

Generate one custodian key pair per environment:

```bash
node --import tsx -e "import('./src/key-custody').then(async m => console.log(await m.generateCustodianKeypair()))"
```

The **public** half goes to the staff application; the **secret** half goes to
the processor and nowhere else. See `.env.example` and `.env.operator.example`.

Run the processor after campaigns close, and the expiry janitor on a timer:

```bash
npm run privacy:process
npm run drafts:expire
```

## The respondent journey

Open `/s#<token>` on the survey origin. The client reads the token from the
fragment, POSTs it once, and removes it from the address bar and the history
entry with `replaceState` before doing anything else. The token never appears in
a URL path, a query string, a `Referer` header or a server log.

1. **Welcome and privacy notice.** The campaign's frozen notice is shown, *plus*
   the standing limits: a link holder can open the questionnaire on your behalf,
   the service cannot prove who used it, free text can identify you, and the
   protection is organizational and technical rather than mathematical.
2. **Fixed sections.** Every question type is rendered. There is no branching.
3. **Save and resume** (below).
4. **Review**, then an explicit **final confirmation** that states the submission
   cannot be changed, retrieved or deleted.
5. **Accepted.** Reopening the link shows the locked state and never the answers.

Arabic is the default with full RTL; English is a complete parallel catalog.
There is no third-party script, no analytics and no session replay.

## DF1 encrypted drafts

Primitive: **Web Crypto AES-256-GCM**, 256-bit key generated in the browser by
`crypto.getRandomValues`, a fresh random 96-bit nonce for every encryption, and
the standard 128-bit tag. No custom construction, no password derivation, and no
key derived from the invitation token.

* The plaintext is `{schemaVersion, versionId, answers, locale}` — no identity,
  no timing, no metadata.
* Additional authenticated data is `["OrgFit","DF1",handle,versionId,revision]`,
  so a ciphertext cannot be replayed onto another draft, another instrument
  version or an earlier revision without the tag check failing in the browser.
* The server stores opaque bytes, a 12-byte nonce, a revision and an expiry. It
  cannot verify the tag and cannot decrypt.
* The **private resume code** is `DF1.<handle>.<base64url key>`. It is an
  encoding, not encryption: the code itself is the secret. OrgFit staff hold no
  copy and cannot recover it. A lost code permits starting over, nothing else.

**An administrator's copy of the original invitation link is not enough to read
a saved draft.** They can open a valid session and fetch the ciphertext — that
is expected — and it stays ciphertext. The test suite asserts this against the
token itself, the stored token digest and the draft handle.

Same-device resume uses locally stored material under the survey origin, and the
screen says plainly that anyone using the same browser can reach it. Cross-device
resume needs the original link **and** the private code.

Concurrent saves use `expectedRevision`. A stale save is refused with a conflict
and the newer version is offered; nothing is silently overwritten. The save
status reports what the server actually acknowledged, never an optimistic guess.
Draft TTL is 30 days of idle time, renewed by an acknowledged write and capped at
closure + 7 days. These durations are development defaults pending P-004.

## IN1 acceptance

Primitive: **libsodium sealed box** (`crypto_box_seal`), used exactly as
documented. It provides recipient-only decryption and ciphertext integrity. It
deliberately does not authenticate a sender, because there is no sender identity
worth keeping; authorization is the validated session plus the narrow gateway
routine.

The plaintext envelope is identity-linked on purpose — that is what lets
acceptance be one local transaction — and every context field is stripped later:

```
{protocol:"IN1", envelopeId, organizationId, campaignId, invitationId,
 versionId, instrumentHash, reportGroupId, answers}
```

`POST /public/v1/finalize` accepts **only** an answers map. Organization,
campaign, questionnaire version, report group and any score are resolved
server-side from the session; a client cannot express them, let alone influence
them.

Order of operations in `intake.accept`:

1. Validate the complete payload against the frozen instrument **before** any
   lock or write, so an invalid submission can never consume the invitation.
2. Seal the envelope to the campaign's ACTIVE public key. No key, no acceptance:
   the request fails retryably with the link intact.
3. Lock **campaign, then invitation** — the same order every Phase 06 control
   operation uses, so closure and finalization can race safely.
4. Re-check session, token generation, invitation state, campaign state and the
   time boundary against `clock_timestamp()` under the lock.
5. Insert the envelope, mark the invitation `COMPLETED` and delete the draft in
   **one transaction** that must commit durably before success is returned.

A second attempt on an accepted invitation returns the same generic
`{"access":"ACCEPTED"}` without a response identifier, without a timestamp and
without comparing or replacing the stored payload. `UNIQUE(organization_id,
invitation_id)` on the inbox is what makes "exactly one immutable accepted
payload" a database fact.

## Closed-campaign privacy processing

At closure the processor freezes the accepted set under the campaign lock. The
count of `COMPLETED` invitations must equal the number of stored envelopes; a
disagreement raises `COUNT_MISMATCH` and nothing is decrypted. Freezing is
idempotent: a second call returns the same batch id, count and assigned set.

**Below the campaign threshold (five) nothing is decrypted at all.** The campaign
yields a suppression state, the intake is purged, and no anonymous row of any
kind is written.

For eligible campaigns the processor decrypts in memory, verifies each envelope's
context against the frozen manifest, drops every identity and transport field,
keeps only the approved department/other group, shuffles the whole set with a
cryptographic RNG, assigns fresh random response ids, scores each response with
the pinned engine, and commits responses, answers, scores and the
`processed_batch` marker in **one anonymous transaction**. A single unreadable or
inconsistent envelope blocks the entire batch; nobody's accepted input is
quietly dropped.

Recovery is marker-first. If the marker exists the output is committed and only
cleanup remains — a retry never appends. A marker whose count or manifest hash
disagrees with the frozen batch is an incident (`MARKER_MISMATCH`), not something
to overwrite. Only a proven marker authorizes deleting the intake, and only an
empty intake plus destroyed keys advances the batch to `CLEANED`. Counts that
disagree block release; they are never repaired by adjusting a count or by
marking anyone incomplete.

The anonymous database has no `UPDATE` or `DELETE` grant for the processor, so
committed content is immutable to the only credential that can reach it.

## What this does and does not guarantee

**It does provide, and the tests demonstrate:**

* no participant, invitation, token, digest, draft handle, envelope id, session,
  IP address, user agent, request id, correlation id, actor or submission
  timestamp in the finalized anonymous store — verified structurally (no such
  column exists) and by value (no anonymous identifier matches any live identity
  value);
* no staff role, including Super Admin, can read a draft, an envelope, a raw
  answer, a response identifier or a campaign key;
* an administrator holding the original invitation link cannot decrypt a saved
  draft;
* exactly one immutable accepted payload per invitation under 100-way
  concurrency, and safe retry after a lost success response;
* no partial or duplicated anonymous output across every crash boundary tested;
* campaigns below five accepted responses cannot release answer results.

**It does not provide, and must not be described as providing:**

* anonymity against the privacy processor. The processor decrypts every accepted
  answer for an eligible campaign. That is an explicit trust assumption.
* anonymity against an infrastructure operator who can read process memory, hold
  both databases and the custodian secret at once, observe the TLS terminator, or
  modify the survey page served to a respondent.
* cryptographic unlinkability. The shuffle reduces order and timing correlation;
  it is not a formally verified mix network.
* backup-safe crypto-erasure. The development custody adapter unlinks a sealed
  key file. A filesystem or database backup taken before destruction still holds
  the sealed key and the ciphertext, and whoever holds the custodian secret can
  open it. Real key destruction, provider recovery windows and WAL/replica
  behaviour are P-003 and P-004 and are unverified.
* protection against a respondent identifying themselves in free text, or against
  a forwarded link being used by someone else. The service cannot prove which
  human used a bearer link, and the notice says so.
* proof that five contributors makes a result non-identifying. Five is a floor.
  Disclosure control is Phase 08.

Named completion tracking is itself a disclosure of participation. That is a
product requirement, not an oversight.

## Key handling

| Key | Held by | Lifecycle |
|---|---|---|
| Draft key (AES-256-GCM) | The respondent's browser and their private resume code only | Never sent to any server. Destroyed on start-over or acceptance. Unrecoverable if lost. |
| Campaign key pair (X25519 sealed box) | Public half in `intake.campaign_key`; private half sealed to the custodian | One ACTIVE key per campaign, created inside the launch transaction. Moves to `DECRYPT_ONLY` at freeze, `DELETE_REQUESTED` at cleanup, `DESTROYED` when the custodian confirms. |
| Custodian key pair | Public half in the staff process; secret half in the processor only | Generated per environment. The staff process can seal to it and can never open what it sealed. |
| `INVITATION_DIGEST_KEY` | Staff and gateway processes | Unchanged from Phase 06. |

The development custody adapter (`src/key-custody.ts`) is a local stand-in for a
managed key service and says so in its own header. It is not an HSM and provides
no attestation. Selecting a real custodian is production input **P-003**.

## Tests

```bash
npm run test:respondent
npm run test:privacy
npx playwright test tests/browser/respondent.spec.ts
```

Both database suites create fresh synthetic databases on a dedicated loopback
cluster and never reset or drop an existing one. Fault injection uses named
boundaries inside the real processor rather than a mock, so the recovery path
exercised is the production one.

## Limitations carried forward

Retention values (30-day draft idle TTL, closure + 7 days, 24-hour link export)
are development defaults pending P-004. The instruments remain illustrative
pending P-006. Lock ordering is a correctness choice and its throughput is
unmeasured. No real-device, screen-reader or accessibility audit has been run.
Backup, restore and key-destruction behaviour is untested. Checkpoint C is the
blocking review that must run before any of this touches real respondent data.

## Phase 13 refinements

Nothing in this section changes a token, session, draft-key, envelope or single-use rule; each item changes only what the page does and says.

* **Truthful states.** Every request is limited to 20 s. A request with no HTTP answer is reported as not saved (or, for submission, *not confirmed* — resubmitting is safe because acceptance is idempotent). Save conflicts, a draft created first by another browser (`DRAFT_EXISTS`), an ended session, a campaign closed while answering and an already-accepted invitation each have their own sentence. An ended session disables save and submit and tells the respondent to reopen the original link; nothing is retried with a weaker check.
* **Session keep-alive.** While the respondent is answering, `POST /public/v1/session/refresh` renews the 30-minute idle window at most every five minutes. The 12-hour absolute limit is unchanged.
* **History.** Section moves push history entries holding a stage name and section index only. Back and Forward move between sections; after acceptance they do nothing. Leaving with unsaved changes shows the browser's prompt.
* **Focus and dialogs.** Each new screen scrolls to the top and focuses its heading. Confirmation dialogs focus Cancel, trap Tab, close on Escape and restore focus.
* **Answers.** Per-field rules come from `src/answer-rules.ts`, the same function the server uses. Number questions accept Arabic-Indic and Persian digits and the Arabic decimal separator; finalization sends canonical Latin digits. Hints state ranges before they are broken. Errors are linked with `aria-describedby`.
* **Language.** The switch is remembered in the survey locale cookie and never touches answers.
* **Phone layout.** `interactive-widget=resizes-content`; the sticky action bar goes back into the flow on short viewports (the keyboard-up strip); 44px targets under a coarse pointer; the review list wraps and keeps the page's direction.

Tested in Chromium at 320–1280 px with touch emulation (`tests/browser/journey.spec.ts`, `accessibility.spec.ts`). **Not** tested on a real iPhone or Android phone, not in WebKit or Firefox, and not with a screen reader.
