# Incident runbook (Phase 14)

2026-09-14. For the operator and the privacy lead of a real deployment. **Owners are roles to be named by the owner before production (P-008);** nothing here sends a message to anyone, and no step contacts a respondent automatically.

## 0. Principles

1. **Do not weaken a privacy control to restore service.** No raw-answer export, no identity-to-answer lookup, no disabled rate limit, no reopened campaign, no manual edit of counts.
2. **Preserve evidence without copying sensitive data.** Record counts, identifiers of campaigns/objects, times and alert codes. Never paste tokens, draft keys, answers, envelopes or custody secrets into tickets or chat.
3. **An unrecoverable accepted payload is a data incident.** Never report it as analyzed; never release a result that silently lacks it.
4. **State what is true.** A respondent whose submission was lost is told only what the owner approves; the product does not message anyone.

## 1. Alerts (`npm run ops:check`)

| Code | Severity | Meaning | First response |
|---|---|---|---|
| `RESTORE_REAPPLY_PENDING` | critical | A restored environment has not replayed its tombstones | Keep traffic off; run `restore:reapply`; see §4 |
| `INTAKE_PROCESSED_COUNT_MISMATCH` | critical | A batch's processed count differs from accepted envelopes | §3. Do not release; do not edit counts |
| `PUBLICATION_BLOCKED` | critical | Release refused because accepted/processed counts did not reconcile | §3 |
| `INSUFFICIENT_INTAKE_RETENTION_OVERDUE` | critical | Intake of a closed campaign still present past 30 days | Run `privacy:process` for the campaign; if it fails, §3 |
| `BACKUP_STALE_OR_MISSING` | critical | Newest backup older than 26 h, or none | Fix the backup job before anything else; RPO is unbounded meanwhile |
| `LOW_DISK` | critical | Under 10% free on the monitored volume | Expand storage; do not delete WAL or intake to make room |
| `CLOSED_CAMPAIGN_UNPROCESSED` | warning | Closed ≥ 24 h with intake still waiting | Check the processor job and key custody availability |
| `REPORT_QUEUE_BACKLOG` | warning | Oldest queued report older than 15 min | Check the renderer process and its credential |
| `EXPORT_FAILURES` | warning | Report jobs FAILED in the last day | Inspect failure codes (no payloads are logged); requeue by re-requesting |
| `SCAN_BACKLOG` | warning | Attachment quarantined or failed > 1 h | Check the scanner; files stay undownloadable meanwhile (fail-closed) |
| `TOKEN_ABUSE_SUSPECTED` | warning | A rate-limit bucket exceeded its limit in the last 10 min | §5 |
| `RETENTION_NOT_RUNNING` | warning | No retention pass in 26 h | Run `retention:run`; check the scheduler |
| `RETENTION_POLICY_UNAPPROVED` | warning | Retention durations still defaults | Owner decision (P-004); expected until production approval |

Alert inputs contain counts, ages and states only (asserted by `tests/operations.test.ts` O-6). Every alert was drilled by inducing its condition (O-6); none is wired to a paging system in this repository.

## 2. Suspected privacy leak

Examples: a staff screen or export shows a respondent's free text, a result is visible below threshold, a raw answer or token appears in a log.

1. **Contain:** revoke the affected staff sessions (`PATCH /api/v1/staff/:id` or the operator revocation routine); if a release is involved, it must be withdrawn. **Gap:** the schema permits `PUBLISHED → REVOKED` (and the results screens then show "not available"), but no routine or operator tool performs that transition yet; until one exists, withdrawal is a reviewed operator transaction on `publication.result_snapshot` and `core.campaign.release_state`, never a row deletion (SEC-M5 in security-review.md).
2. **Stop the source:** disable the offending route or job by deployment rollback, not by data edits.
3. **Assess without copying:** identify the campaign(s), the release identifier and the time window. Do not re-read the leaked content more than needed to confirm scope.
4. **Check logs for bridges:** confirm server logging settings (`retention-backup-runbook.md` §2); grep proxy/access logs for 43-character token patterns and `/s#`; confirm no request body capture is enabled anywhere.
5. **Record** in the incident log: time, scope (counts/campaigns), controls that failed, repair, and whether an independent reviewer must be informed (P-001/P-008).
6. **Remember CE-001**: an individual's score is derivable from two overlapping releases by design and with the owner's knowledge. A report of that effect is the declared disclosure, not a new leak — but it must still be recorded and reviewed.

## 3. Count mismatch or blocked publication

1. **Do not** delete intake, re-run with weaker checks, edit `accepted_count`, or mark anyone incomplete.
2. Run `reconcile` for the campaign (processor module) and record `acceptedCount`, `batchAcceptedCount`, `processedCount`, `anonymousCount`, `batchState`.
3. If a marker exists with a different count or manifest hash (`MARKER_MISMATCH`): stop. This is an integrity incident; preserve both databases (snapshot) before any further action.
4. If keys are still ACTIVE/DECRYPT_ONLY and no marker exists: re-run `privacy:process` (freeze is idempotent; recovery is marker-first).
5. If keys are DESTROYED and no marker exists: accepted payloads are unrecoverable → §4.3.

## 4. Restore-related incidents

### 4.1 Restore pending too long
The replay exited with an error or was never run. Re-run `npm run restore:reapply`; it is idempotent. Readiness stays 503 until it completes.

### 4.2 Replay reports `ANONYMOUS_OUTPUT_MISSING_FOR_ERASED_INTAKE`
The ledger says the campaign's intake was erased after processing, but the restored anonymous database does not hold the output. The envelopes are kept, the environment stays closed.
* If keys are still available (custody not yet destroyed for that campaign): re-run processing, verify the marker, then re-run the replay.
* If keys are destroyed: §4.3.

### 4.3 Unrecoverable accepted payloads
1. Record campaign id, number of accepted envelopes, and why (e.g., anonymous backup older than intake erasure, keys destroyed).
2. The owner decides between: releasing nothing for the campaign; or a documented partial state that is **never** presented as a complete analysis. The product has no path that silently drops envelopes.
3. Only after that decision: `npm run restore:reapply -- --open-despite-incidents`, which opens the environment. **It does not erase the retained envelopes**; they stay (undecryptable if the keys are destroyed) until the owner approves their erasure. **Gap:** there is no product tool for that erasure yet; it is a reviewed operator transaction deleting the campaign's `intake.submission_inbox` rows and recording a `CAMPAIGN_INTAKE` tombstone (SEC-M6).

## 5. Token abuse or scraping

1. Read `TOKEN_ABUSE_SUSPECTED`'s count; confirm `RATE_LIMIT_CLIENT_IP_HEADER` is set to a header the trusted proxy overwrites (otherwise per-IP limiting is off by design).
2. Limits are counters only: a limited request never consumes, rotates or revokes an invitation. Legitimate respondents behind one NAT recover within a minute.
3. Suspected leaked links: rotate the affected invitations (staff campaign screen → rotate), which invalidates prior sessions. Do not change `INVITATION_DIGEST_KEY` for a local leak.
4. Suspected leak of `INVITATION_DIGEST_KEY` itself: rotate it **without** `INVITATION_DIGEST_KEY_PREVIOUS` (every outstanding link stops working immediately), then reissue links. This is the only situation in which a rotation window must not be used.
5. Edge protection (WAF, provider rate limits) belongs to the deployment (P-002); the application limits are defense in depth.

## 6. Credential or key compromise

| Secret | Immediate action | Consequence |
|---|---|---|
| Staff session / account | Disable the account or replace its access (revokes sessions immediately) | Staff re-authenticates |
| `INVITATION_DIGEST_KEY` | Rotate without previous key; reissue links | Outstanding links stop working |
| `CAMPAIGN_KEY_CUSTODY_SECRET_KEY` | Treat all undestroyed campaign keys and every backup of the custody store as exposed; rotate the custodian key pair; review whether affected intake must be erased | Intake of open campaigns may need re-collection (owner decision) |
| Report / export / attachment encryption keys | Rotate; expire existing artifacts (`reports:expire`, `links:expire`); attachments must be re-encrypted or purged | Downloads fail until regenerated |
| Database role passwords | Rotate in the secret manager; restart processes | Brief outage |

## 7. After any incident

Record in `docs/orgfit/phase-status.md` (development) or the operator's incident log (production): timeline, detection source, scope in counts, controls that held, controls that failed, repair and its test, and follow-up owner. Re-run `npm run test:operations`, `test:privacy` and `test:checkpoint-c` after any repair that touches intake, processing or retention.
