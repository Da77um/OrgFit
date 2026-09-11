# Checkpoint C — PASS (implementation gate only)

2026-09-09. Scope: privacy and submission reliability after Phase 07. **PASS after repairing CC-001 and re-running every affected check.**

This clears Phase 08 to proceed **as development work**. It does **not** clear real respondent data, deployment, or any public anonymity claim. Those remain gated on the production prerequisites in the last section, which this checkpoint did not and could not test.

## What was inspected

The blueprint §§1.3, 4.1, 6.1–6.5 and 15, the Checkpoint C prompt, the Phase 06 and 07 handoffs, the accepted decisions (including D-017, D-018, D-026, D-027, D-029, D-030 and the new D-053–D-057), migrations 001–009, `db/anonymous/001_anonymous.sql`, `db/roles.sql`, the gateway and processor modules, the public route handler, the survey client, the key custody adapter, the observability configuration, and the existing test evidence. Earlier uncommitted work was preserved; no unrelated module was modified.

`tests/checkpoint-c.test.ts` is a new adversarial suite that does not reuse the Phase 07 assertions. Where Phase 07 asked "does the code do what it says", this suite starts from the attacker's side and reads privileges out of the PostgreSQL catalog rather than trusting the migration text.

**21 checks, 21 pass, 0 fail** (`npm run test:checkpoint-c`), on real PostgreSQL 18.4.

## Re-identification attempts — all failed

The suite builds a seven-person campaign in a **known submission order**, gives each respondent a unique marker answer, processes the campaign, and then tries to walk from a named participant to that person's finalized answers.

| Route attempted | Result |
|---|---|
| **Schema keys** | Every column of every anonymous table was enumerated from `information_schema` and every distinct value cast to text. Not one matched any participant id, invitation id, roster id, display reference, token digest, staff id, idempotency key, request digest, audit id, campaign key reference or raw invitation token. |
| **Reverse direction** | No anonymous response id exists anywhere on the identity side (`core.invitation`, `core.participant`, `core.campaign_roster`, `intake.processing_batch`). |
| **Tokens and hashes** | The token digest is not a column staff can select (no column grant) and appears nowhere in the anonymous store. |
| **Draft handles** | Drafts are deleted in the acceptance transaction; no handle survives into any anonymous row. |
| **Request identifiers** | No request, trace or correlation column exists in `intake` or `anonymous`. |
| **Row order** | The marker answers read back in physical (`ctid`) order do **not** reproduce submission order, and neither does ordering by response id. All seven markers survive exactly once. |
| **Precise timestamps** | The only time-typed column in the entire anonymous schema is `processed_batch.committed_at`, and there is exactly one such row per campaign, so it cannot separate individuals. `intake.submission_inbox` has no timestamp column at all. |
| **Generic audit columns** | `ops.audit_log` contains only staff actions. No action names a respondent event, no field name describes answer content, and no audit row targets a response. The completion transition writes no audit row, so no staff-visible per-person completion instant exists. |
| **Jobs and queues** | No job, queue, outbox, task or event table exists in this build. `access.staff_mutation` has no body/payload column and recorded no finalization operation. |
| **Errors** | Every failure provokable from the public surface was inspected including `code`, `message` and `stack`. None contained a token, invitation id, participant id or campaign id, and none contained SQL. |
| **Exports** | A real encrypted link export was created and decrypted. It contains invitation references and links, and no answer, ciphertext, typed value, score or draft handle. |

## Staff access — including Super Admin

`access.is_admin()` bypasses both the organization assignment and every capability check, so a SUPER_ADMIN is the strongest identity the product has. It was used for these attempts.

- Every staff-reachable projection of a processed campaign (participation lists, campaign detail) was serialized and searched. No response identifier, no `answers`, `ciphertext`, `typed_value`, `score`, `token_digest` or `handle`.
- Direct database attempts inside a live SUPER_ADMIN transaction against `intake.submission_inbox`, `intake.draft_blob`, `intake.campaign_key`, `intake.processing_batch`, `intake.batch_payload`, `intake.draft_read`, `intake.freeze_batch` and `core.invitation.token_digest` were **all denied**. None returned data.
- Completed invitations cannot be reopened: every draft route returns `ALREADY_ACCEPTED`, and no draft row remains to retrieve.

## The administrator-with-the-link test

The specific scenario the blueprint calls out was reproduced end to end: a respondent saves a real draft containing a distinctive secret string, and an administrator who kept a copy of the original invitation link then tries to read it.

The administrator **can** open a valid session and fetch the ciphertext — that is expected and by design. What they cannot do is read it:

- The stored bytes contain neither the secret nor any readable JSON structure.
- Decryption was attempted with the raw invitation token (two encodings), the stored HMAC token digest, the draft handle bytes, the display reference, the invitation id, the participant id, and an all-zero key. **Every attempt failed the GCM tag check.**
- The campaign's own sealed-box private key, obtained from custody, also fails: the draft and intake cryptosystems are separate and the processor never sees drafts.

## Role separation as actually configured

Read from the catalog, not from comments:

- `orgfit_gateway` and `orgfit_processor` hold **zero table privileges** anywhere.
- `orgfit_staff` holds no privilege in schema `intake` and lacks `USAGE` on it, so it cannot even name an intake object.
- `PUBLIC` holds nothing in `core`, `intake`, `access`, `instrument` or `ops`.
- The gateway's executable surface is exactly: `session_invitation`, `gateway_instrument`, `finalization_context`, `draft_create`, `draft_save`, `draft_read`, `draft_start_over`, `accept`, `active_campaign_key`.
- The processor's executable surface is exactly: `freeze_batch`, `batch_payload`, `batch_state`, `batch_cleanup`, `keys_destroyed`.
- `orgfit_staff` can execute **nothing** in `intake` or `anonymous`.
- No `orgfit%` role is a superuser or has `BYPASSRLS`, and no runtime login inherits another role (`pg_auth_members` is empty for them).
- `orgfit_staff`, `orgfit_auth`, `orgfit_gateway` and `orgfit_migrator` are all refused **connection** to the anonymous database.

## Submission reliability — re-verified independently

| Scenario | Result |
|---|---|
| 100 concurrent finalizations of one invitation, each sending different answers | Exactly 1 `ACCEPTED`, 99 generic duplicates, 1 inbox row, 1 completion |
| Retry after an uncertain commit (three retries, different answers each time) | Generic acceptance every time; stored ciphertext byte-identical before and after |
| Closure racing with finalization | Either accepted-and-completed or refused-and-untouched; never a half state. Post-closure attempts refused with the link intact |
| Crash before the anonymous commit (after freeze, after decrypt, during transfer) | No marker, no partial responses, frozen input intact; full retry succeeds |
| Crash after the anonymous commit (lost acknowledgement) | Output committed; retry resolves from the marker and appends nothing |
| Duplicate batch delivery | Response count stays 7; exactly one marker row |
| Intake cleanup after already-committed output | Authorized by the marker, idempotent, reaches `CLEANED`, intake emptied |
| Accepted vs processed reconciliation | 7 / 7 / 7, not blocked |
| Count disagreement (a completion with no envelope, the restored-backup shape) | `COUNT_MISMATCH`; no batch frozen, nothing decrypted, no count adjusted, nobody marked incomplete |
| Campaign below five contributors | `PURGED` without decryption; zero anonymous rows; completion untouched; not releasable |
| Key material after a terminal batch | Every processed campaign's key row is `DESTROYED` and its sealed file is gone from custody |

## Defect found and repaired

| ID | Defect | Repair and verification |
|---|---|---|
| **CC-001** | The sub-five purge path unlinked the sealed campaign key file but never called `intake.keys_destroyed`, so the key register stayed at `DELETE_REQUESTED` for ever and no destruction evidence was recorded — for exactly the campaigns the blueprint wants erased soonest. An operator auditing key state would have seen an unresolved deletion request and could not distinguish it from a genuinely stalled destruction. | `src/processor.ts` now records destruction on the suppressed path, after the terminal `PURGED` transition so the batch state is preserved (`keys_destroyed` only advances a batch still in `CLEANUP_PENDING`). Regression test added to `tests/privacy.test.ts` asserting `DESTROYED`, the recorded evidence text, and that the batch is still `PURGED`. Checkpoint C re-run: 21/21. |

Two authoring errors in the checkpoint suite itself were also corrected: an allowlist that omitted `intake.accept` from the gateway's legitimate surface, and a campaign that was processed before being closed.

## Full regression evidence

Windows ARM64, Node 24.13.1, real PostgreSQL 18.4, Playwright Chromium. All re-run after the CC-001 repair.

| Check | Result |
|---|---|
| `test:checkpoint-c` | **21/21** |
| `test:respondent` | 24/24 |
| `test:privacy` | 17/17 (includes the CC-001 regression) |
| `test:campaigns` | 18/18 |
| `test:checkpoint-b` | 3/3 |
| `test`, `test:integration`, `test:directory`, `test:instruments`, `test:scoring`, `test:scoring-db` | 5 / 8 / 6 / 8 / 15 / 5 — all pass |
| `npx playwright test` | 23 passed (3.1m) |
| `typecheck`, `lint`, `build`, `check:boundaries`, `test:production` | Passed |
| `npm audit --audit-level=high` | 0 vulnerabilities |

## Infrastructure and key-custodian assumptions this checkpoint did NOT verify

Passing these tests is **not** proof against a malicious infrastructure operator. The following are assumptions, not results:

1. **The privacy processor is trusted.** It decrypts every accepted answer for an eligible campaign. Nothing here constrains what a compromised or dishonest processor could retain. Anonymity against the processor is not provided.
2. **The custodian secret is held only by the processor.** This is enforced by configuration and by two start-up guards (`src/config.ts`, `src/gateway-db.ts`), on one machine. No deployed network separation, host isolation or secret-management integration was tested.
3. **Key destruction is unverified.** The development custody adapter unlinks a sealed file. Provider recovery windows, wrapped copies, replicas and attestation do not exist. **No campaign may be described as crypto-erased.**
4. **Backups, WAL and replicas were not tested at all.** Every "the ciphertext is gone" statement in this document covers live rows only. A backup taken before cleanup still contains the intake ciphertext, and one taken before key destruction still contains the sealed key.
5. **Physical row order is randomised, not hidden.** The shuffle removes the correlation; it is not a mix network, and someone with direct database access is already outside the baseline.
6. **TLS termination, proxy logs, error trackers and host observability were not inspected in a deployed configuration.** The application itself emits no respondent payload and there is no queue, but a real deployment can add channels this checkpoint cannot see.
7. **No independent security or privacy review, no adversarial re-identification exercise by a third party, and no timing or traffic-correlation analysis.**
8. **No load or capacity measurement.** The 100-way test proves correctness under contention, not throughput. Batches larger than seven responses were not exercised.
9. **Named completion tracking discloses participation** by product requirement, and a respondent can identify themselves in free text. Neither is mitigated.
10. **Five contributors is a floor, not an anonymity guarantee.** Disclosure control is Phase 08 and is explicitly out of scope here.

## Verdict

**PASS** for the implementation gate. None of the four blocking conditions was found: there is no direct identity-to-answer link, no plaintext draft exposure, no duplicate or lost accepted submission, and no unimplemented trust boundary in the code under review.

**Production remains BLOCKED** on P-001 (owner acceptance of the precise threat model plus independent privacy/security review of the actual protocol and infrastructure), P-002 (provider, network separation, TLS), P-003 (named privacy-processor operator and key custodian with real destruction and recovery-window behaviour), P-004 (approved retention and measured restore), and P-008 (release evidence and explicit deployment authorization).

Phase 08 may proceed as development work. Real respondent data may not be collected under this evidence alone.
