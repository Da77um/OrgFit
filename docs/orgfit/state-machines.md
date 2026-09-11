# OrgFit state and transaction contracts

2026-09-08 · Phase 01 design only

All transitions are server-authorized, persisted and atomic with their stated side effects. Undefined transitions return 409 STATE_CONFLICT without mutation. Staff writes require expected revision; retries use safe resource receipts. Public finalization uses invitation uniqueness/status, never staff mutation receipts. Archive is a visibility/lifecycle flag, not permission to accept more answers.

## 1. Instruments and directory

| From → to / operation | Guard | Atomic effect |
|---|---|---|
| Instrument DRAFT → DRAFT edit | instruments.manage, authorized scope, expected version revision | Lock version before children; validate local shape, update and increment revision. Reordering has unique final positions (deferred constraint or temporary positions within transaction). |
| DRAFT → PUBLISHED | Same authority; full Arabic content, offered English complete, >=1 answer question, valid types/keys/weights/bounds/bands/rules, no skip logic | Freeze all descendants, canonical hash and published_at; publish pinned rule set; one version content immutable thereafter. |
| PUBLISHED → RETIRED | Same authority, expected revision | Disable new use, preserve content and existing campaign access. Metadata-only transition. |
| Clone published/retired → new DRAFT | Source global or own org accessible | New version/lineage ID; stable keys copied where semantics preserved but not deemed equivalent automatically. |
| Delete DRAFT | No campaign/historic reference | Explicit child-first deletion; no published deletion endpoint. |
| Organization/department/participant ACTIVE → ARCHIVED | Authorized directory operation (organization create/archive Super Admin), expected revision | Preserve IDs and historic snapshots. Directory moves never update a frozen roster. Explicit governed erasure is separate. |
| Import UPLOADED → VALIDATING → VALIDATED | directory.manage, scanned/validated source and field map | Dry run mutates import job only, no directory rows. |
| VALIDATED → COMMITTED | Expected validation revision and source hash, reviewed valid rows, idempotency | Lock organization import boundary, revalidate uniqueness/departments, commit exactly the reviewed valid set and counts once. New conflicts reject commit for revised preview; no silent partial result. |
| Import → FAILED/EXPIRED | Safe error or TTL | Delete temporary source when expired; keep safe operational receipt. |

## 2. Campaign and round

Campaign creation requires start instant and timezone; end is nullable and if set must exceed start. DRAFT can edit targeting/timing/version. Launch freezes deduplicated active membership, private attributes, public group labels, version/hash, notice/locales and privacy threshold. Department target resolves actual members once. Exactly one campaign per round, one invitation per participant/campaign. Launch creates unissued READY invitations; issuance/rotation is separate. At launch, round DRAFT becomes COLLECTING whether campaign SCHEDULED or OPEN.

| Transition | Guard and side effects |
|---|---|
| DRAFT → SCHEDULED | launch authorized, database clock <starts; all launch checks pass. |
| DRAFT → OPEN | launch authorized, starts<=clock and (end null or clock<end); past-ended launch rejected. |
| SCHEDULED → OPEN | Scheduler or public request-time normalization under campaign lock sees starts<=clock<end (or no end). No staff actor required for clock transition. |
| OPEN → CLOSED | Manual authorized close with reason, or database clock>=end; lock campaign. Set terminal closed_at and queue reconciliation. Manual close linearizes when campaign lock is acquired and current state checked. |
| SCHEDULED → CLOSED | Catch-up only when clock>=end: materialize missed OPEN then CLOSED in the same lock transaction; accept nothing. Collection period remains scheduled start/end, not scheduler processing time. |
| DRAFT/SCHEDULED/OPEN → CANCELLED | campaigns.manage and reason. Terminal. If previously accepted data exists, completion remains true, no results are released; encrypted input is purged within cancelled retention without decryption for results. |
| Set/extend/remove end before closure | campaigns.manage, expected revision; under campaign lock existing end is either null or still in future; new end null or greater than both starts and current database clock. Thus it cannot cut into already accepted collection or reopen expired access. |
| CLOSED/CANCELLED → anything accepting | Always denied, including scheduler lag, restore and admin request. New collection uses a new round. |

Request-time normalization is authoritative; a stale stored OPEN never overrides an elapsed end. Failed invalid finalization may roll back normalization along with its transaction, but access still denies using clock checks; next scheduler/request persists it. Manual close records actual boundary; scheduled closure uses configured end for collection period and sanitized later operational processing time separately.

Round COLLECTING → PROCESSING at closure; PROCESSING → PUBLISHED only on approved snapshot release, or → INSUFFICIENT_DATA if accepted count<5. An eligible unscored-only instrument may publish a safe snapshot whose metrics are UNSCORED; never invent a score. DRAFT/COLLECTING → CANCELLED accompanies campaign cancellation. PUBLISHED/INSUFFICIENT_DATA/CANCELLED may become ARCHIVED visibility; preserve prior terminal outcome. No path back to COLLECTING. Failed processing leaves round PROCESSING with safe release FAILED state, not fabricated completion.

Administrative round updates follow the global ordering in data-model: existing campaign before round, never round then existing campaign. Launch may first take its directory organization boundary, but no acceptance/closure operation later acquires that boundary. This avoids launch/close deadlocks when both update round state. No service takes a version mutation lock after taking campaign; retirement does not revoke an already launched instrument.

## 3. Invitation, public access and draft

READY → COMPLETED only in accept transaction; READY → REVOKED only by authorized unused-invitation revocation. COMPLETED and REVOKED are terminal. Rotation stays READY, increments generation and admin revision, invalidates all older sessions and replaces digest. Completed tokens cannot be rotated/revoked to remove an answer. Issuance generation 0→1 only once; no stored plaintext retrieval.

Status precedence with a valid current token/session: COMPLETED → ACCEPTED even after closure; REVOKED/invalid generation → generic UNAVAILABLE; otherwise derive NOT_YET_OPEN, OPEN, CLOSED or UNAVAILABLE for cancelled. No profile, participant name or score returned. Expired session requires exchange of a current link; invalid session never reveals completion. Token/session revocation is independent of whether an invitation was previously viewed.

Draft ABSENT → SAVED includes first ciphertext and handle in one transaction. SAVED → SAVED requires same handle and expected revision, increments revision. SAVED → DELETED occurs at acceptance, explicit confirmed start-over, expiry or terminal retention cleanup. Lock order for mutations: campaign, invitation, draft; then recheck current session/generation/READY/open. Saving/resume allowed only while collection open; a retained closed draft is inaccessible. Stale save returns 409 DRAFT_CONFLICT; old handle after start-over returns generic draft unavailable. Multi-tab user resolves conflict explicitly. An old save can never recreate a draft after finalization.

Draft expiry is minimum(last acknowledged write+30 days, terminal collection time+7 days if terminal); no renewal from polling/reads. Public response includes expiresAt. These are development defaults pending retention approval. Resume with a code restores ciphertext only with current invitation session; decryption stays in the browser. Missing/lost code permits a confirmed start-over while open, never retrieval with original link alone.

## 4. Finalization linearization and closure race

Use PostgreSQL READ COMMITTED. Initial conservative lock choice: campaign FOR UPDATE, then invitation FOR UPDATE, then draft if present. This serializes finalization within one campaign; no lock upgrades or shared/exclusive ambiguity. It is a correctness-first development choice; capacity targets must be measured before relaxing it. All close/cancel/end-date/rotation/revoke/save operations follow the same campaign-first order. Fail on bounded lock timeout with retryable 503; no partial completion. [PostgreSQL lock semantics](https://www.postgresql.org/docs/18/explicit-locking.html) supports these conflicts; performance has not been tested.

1. Bound/parse request, authenticate current session. Read frozen public definition for preliminary validation; no durable answer logging or plaintext queue. The definitive version/state validation happens under locks.
2. Begin transaction, lock campaign, normalize schedule using actual database clock, lock invitation; revalidate session expiry/generation and organization binding. If already COMPLETED, return generic accepted after transaction without comparing request body to original. No answer IDs.
3. Validate all answers against frozen definition, resolve group from frozen roster, encrypt for active campaign key. Do not wait on an external key-management RPC inside a DB lock; verify authenticated public key cache before entry, fail closed if unavailable/stale.
4. Immediately before acceptance writes, sample `clock_timestamp()` into a local variable; require starts<=sample, no end or sample<end, state OPEN, invitation READY. This final check is the acceptance linearization point; do not use transaction-start `now()` after waiting on locks. [PostgreSQL date/time documentation](https://www.postgresql.org/docs/18/functions-datetime.html) distinguishes actual clock from transaction time.
5. Insert unique encrypted inbox, set COMPLETED, delete draft and commit durably before responding 200 ACCEPTED. No per-person acceptance time is stored. A transaction that passes the last time check before end may commit just after end; accepted collection is defined by that check, not response receipt. A transaction still waiting or validating at end fails its final check. Closure waits for the lock and includes any such committed accepted envelope in the frozen batch.

If close acquires campaign lock first, finalization subsequently denies. If acceptance acquires it first and passes the last clock check, closure waits and counts it. Rollback erases both inbox and completion changes; connection loss with uncertain commit is resolved by current status/retry. No completing an invitation separately, no final payload replace, no compensation resetting READY. If infrastructure loses a committed payload after failover/restore, report an incident and block results; an RPO target is not permission to silently discard acceptance.

## 5. Processing and publication

| State change | Guard / effect |
|---|---|
| No batch → FROZEN | CLOSED campaign lock; count COMPLETED and inbox agree; stable batch ID + manifest/count and assignment written once. CANCELLED has purge-only batch path. |
| FROZEN → INSUFFICIENT | Accepted count<5; no decryption/results, suppression state only; purge by deadline. |
| FROZEN → PROCESSING | >=5, lease acquired with generation fencing; decrypt full set in restricted memory. |
| PROCESSING → OUTPUT_COMMITTED | Anonymous transaction atomically stores whole set and UNIQUE campaign/batch marker with matching count/hash. |
| OUTPUT_COMMITTED → CLEANUP_PENDING → CLEANED | Marker confirmed; source ciphertext/drafts purged, key deletion verified including recovery windows, memory/staging disposed. Retry cleanup without rewriting responses. |
| Any processing operation → FAILED | Safe campaign-level error; immutable completion remains; retry from recorded durable evidence. Missing keys/count mismatch/corruption block publication, not skip records. |
| INSUFFICIENT/CANCELLED → PURGED | Ciphertext deleted and campaign keys destroyed, tombstone recorded. No anonymous response dataset produced. |
| Release NOT_READY → QUEUED → PROCESSING → PRIVACY_CHECK → PUBLISHED | Closed batch and cleanup evidence; deterministic scoring, joint disclosure and safe manifest pass; one atomic core release. |
| Release → FAILED / INSUFFICIENT_DATA | No safe partial numbers exposed. Retry internal candidate work; below-threshold is terminal for that campaign. |
| PUBLISHED → REVOKED | Privacy/correction reason and audit, stop new downloads; cannot recall downloaded copies. Corrected release is new immutable revision with explicit review against old releases. |

Processing lease expiry does not authorize replacing the frozen batch. Every new worker checks anonymous marker first, then fences lease ownership before writes/cleanup. Competing workers may attempt work but only one UNIQUE campaign batch commits; losers discard memory and inspect marker. Detailed crash/recovery table is in privacy protocol.

## 6. Reports, recommendations and visits

Report QUEUED→RUNNING→READY requires safe pinned sources and current requester access at execution. Failure→FAILED permits idempotent retry using same generation key. READY→EXPIRED/REVOKED stops downloads; retry cannot change the source snapshot. Re-request after expiry creates a new authorized generation receipt tied to same immutable source. File registration happens only after complete upload/checksum; orphan uploads are inaccessible and later purged.

Recommendation instances never change after release. Action OPEN→IN_PROGRESS→DONE or DISMISSED; authorized staff can reopen action to OPEN with audited reason, without altering computed evidence. No action status exposes protected scores. Comparison review creates immutable definition; revision creates new ID, never changes an existing report's interpretation.

Visits DRAFT→SCHEDULED→IN_PROGRESS→COMPLETED; active authorized consultant, organization, date/time and purpose required. Cancellation from DRAFT/SCHEDULED/IN_PROGRESS requires reason. Completed amendment increments revision and audit, preserves original completed_at; no reopening by amendment. Follow-up OPEN→DONE/CANCELLED, with owner/due date, internal tasks only. Attachment UPLOADING→QUARANTINED→CLEAN or REJECTED/FAILED; only CLEAN downloadable. Scanning failure is fail-closed, retry returns to QUARANTINED, expiry deletes inaccessible bytes; metadata retains allowed audit. Attachment/visit/round organization must match.

All transition, lock and recovery checks here are specified, not executed. Phase 02 foundation may proceed on this design; C/D/E/F/14 must supply actual database, browser, artifact and failure evidence in their scopes.
