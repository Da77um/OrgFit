# Retention, backup and restore runbook (Phase 14)

2026-09-14. **Every duration here is a non-production default. None is approved** (P-004). `ops.retention_policy` seeds every class `approved=false`, and `npm run ops:check` raises `RETENTION_POLICY_UNAPPROVED` until the owner records approval. Recovery objectives below are measured on one developer machine; they are not provider promises and not production evidence (P-002, P-003).

## 1. Retention

### Policy (migration 017, `ops.retention_policy`)

| Class | Default | Basis | Mechanism |
|---|---|---|---|
| respondent_draft | 30 days idle | renewed by a save, capped at campaign end + 7 days; deleted on acceptance | TTL on the row; `ops.purge_core` |
| respondent_session | 12 h absolute | pruned when it passes | `ops.purge_core` |
| rate_limit_window | 10 min | two windows of the longest limit | `ops.purge_core` |
| staff_session | 7 days | after expiry or revocation | `ops.purge_core` |
| oidc_flow | 1 day | after expiry | `ops.purge_core` |
| password_attempt | 1 day | after first failure | `ops.purge_core` |
| staff_mutation | 1 day | idempotency receipts after expiry | `ops.purge_core` |
| private_export | 24 h | link/participation/directory exports | row → EXPIRED (tombstoned); bytes by `links:expire` |
| report_artifact | 24 h | rendered bytes | `reports:expire` (tombstoned) |
| attachment | 365 days | clean visit files | `attachments:expire` (tombstoned) |
| insufficient_intake | 30 days | below-threshold intake after closure | purged by the processor at once; **alert** if any remains past 30 days — never deleted by retention, because unprocessed intake of an eligible campaign is accepted data |
| anonymous_response | 365 days | answers and scores after batch commit; published aggregates remain | `anonymous.purge_expired` — **whole campaign only**; tombstoned |
| audit_log | 365 days | administrative audit | `ops.purge_core` |
| retention_run | 365 days | this ledger | `ops.purge_core` |
| deletion_tombstone | 36 days | must outlive the oldest restorable backup (35 days) by one day | `ops.purge_core` |
| backup | 35 days | base backups and archived WAL | the backup system (below) |

Every pass writes counts only to `ops.retention_run`. Nothing in retention selects an answer, draft content, token or participant.

**What retention cannot do, stated before anyone asks:** it cannot delete one person's finalized answers, because nothing in the anonymous store identifies a person. Directory erasure and invitation cleanup are possible; approved whole-campaign erasure (`anonymous.purge_campaign`) removes the entire anonymous set. There is no hidden reverse lookup.

### Scheduled operator jobs

All run with the operator credential (`orgfit_migrator` / `orgfit_anon_migrator`), never inside a web process. Templates: `.env.operator.example`.

| Job | Cadence (proposed) | Failure means |
|---|---|---|
| `npm run retention:run` | daily | `RETENTION_NOT_RUNNING` after 26 h |
| `npm run drafts:expire`, `links:expire`, `reports:expire`, `attachments:expire`, `imports:expire` | hourly | expired bytes linger; downloads are already refused by expiry checks |
| `npm run tombstones:ship` | **at least as often as the backup RPO** (proposed: every 5 min) | deletions since the last ship could be resurrected by a restore; `TOMBSTONE_SHIPPING_BEHIND` (critical) once the oldest unshipped deletion is 15 min old (Pass 4) |
| `npm run privacy:process`, `publication:release` | every few minutes | `CLOSED_CAMPAIGN_UNPROCESSED` after 24 h |
| `npm run ops:check` | every 1–5 min | exit 2 = critical alert, exit 1 = the check itself failed |

## 2. Backups

### What must be backed up, separately

| Store | Contents | Backup policy |
|---|---|---|
| Core database | directory, invitations, campaigns, **encrypted intake inbox and drafts**, publication snapshots, audit | base backup + continuous WAL archive; 35 days; encrypted at rest with a key the application does not hold |
| Anonymous database | finalized anonymous answers and scores | **separate** backup set, separate access policy; 35 days |
| Key custody store | sealed campaign private keys | **must not be in the same backup set as the core database** — see §4 |
| Tombstone ledger | deletion records | **outside every database backup**; retained ≥ 36 days. Since Pass 4: sealed batches (SHA-256 hash chain, verified on every read); production requires a bucket (`TOMBSTONE_LEDGER_S3_BUCKET`) written with conditional creates, SHA-256 checksums and an Object Lock COMPLIANCE retention of `TOMBSTONE_LEDGER_OBJECT_LOCK_DAYS` ≥ 36. The bucket must be created **with Object Lock enabled** and a policy denying deletion to the operator identity — provider configuration this repository cannot verify (UNREHEARSED; exercised against an S3 test double only). A local directory is development-only |
| Object storage | visit attachments, report and export bytes | provider versioning with lifecycle rules matching the classes above |

### Method used in the drill (PostgreSQL 18, no pg_basebackup available)

The embedded PostgreSQL package ships only the server binaries, so the drill used PostgreSQL's documented low-level API, which is valid on any installation:

1. `archive_mode=on`, `archive_command` copying each completed WAL segment, `archive_timeout=60`.
2. In one session: `SELECT pg_backup_start('label', true)`; copy the data directory excluding `postmaster.pid`, `postmaster.opts` and `pg_wal/*`; `SELECT lsn, labelfile, spcmapfile FROM pg_backup_stop(true)`; write `backup_label` (and `tablespace_map` if present) into the copy.
3. Keep the WAL segments up to `pg_walfile_name(lsn)` **with** the base copy — without them the copy cannot reach a consistent state (the drill proved this: a restore without them fails with `could not locate required checkpoint record`).

A managed provider's PITR replaces steps 1–3; the restore procedure below does not change.

### Required server logging for every environment

`log_statement=none`, `log_min_duration_statement=-1`, `log_parameter_max_length=0`, `log_parameter_max_length_on_error=0`, `log_error_verbosity=terse`. Statement text in this product carries bind placeholders only; these settings keep bind values and constraint-detail values out of server logs. Verified present in the drill cluster; **not enforced by the application** — the operator must set them.

## 3. Restore procedure

Order matters. The environment must not receive traffic until step 6 completes.

1. **Isolate.** Restore to hosts that no load balancer targets. Both readiness endpoints (`staff /health/ready`, `respondent /health/ready`) return 503 while the restore gate is pending.
2. **Restore the anonymous database first**, then the core database, to the same target time where both are recoverable.
3. **Start the core database** and, as its first statement: `npm run restore:reapply -- --mark` (sets `ops.restore_state=REAPPLY_PENDING`).
4. **Do not restore the key custody store from the core database's backup set.** Use the custody store as it is now.
5. **Replay the ledger:** `npm run restore:reapply`. It first verifies the ledger's seals (a ledger that does not verify is refused and the environment stays closed — `TOMBSTONE_LEDGER_INTEGRITY_FAILED`), then advances the restored database's tombstone sequence past every number the ledger holds (PR4-001: otherwise deletions made after the restore would take numbers the shipping cursor has passed and never ship; `tombstones:ship` now refuses with `TOMBSTONE_SEQUENCE_BEHIND_LEDGER` if this step was skipped). It purges anonymous campaigns that were purged, re-expires attachments, reports and exports, re-destroys campaign keys, erases intake that had been erased — **only where** the anonymous marker exists, the campaign was below threshold, or its output was itself purged — then runs a retention pass and clears the gate.
6. **If it exits 2**, it found an incident (§4 of the incident runbook): accepted envelopes whose anonymous output the restore lost, for a campaign whose intake had already been erased. The envelopes are kept and the environment stays closed. Humans decide: either the audited whole-campaign erasure (`npm run intake:erase`, incident runbook §10) followed by `restore:reapply` again, or `--open-despite-incidents`, which opens without erasing.
7. **Resume processing:** `npm run privacy:process`. A batch whose marker exists is cleaned up without appending (marker-first recovery).
8. **Reconcile:** `npm run ops:check` must show no `INTAKE_PROCESSED_COUNT_MISMATCH` or `PUBLICATION_BLOCKED`.
9. **Tell respondents nothing automatically.** Submissions accepted after the recovery point are lost; their invitations are READY again in the restored core database, so those respondents can submit again with the same link. Decide with the owner whether to notify anyone (no external message is sent by the product).
10. Only then route traffic.

## 4. Measured drill results (2026-09-14)

Harness: `tests/ops/restore-drill.ts`; raw output `work/p14-restore-drill.json`. A dedicated throwaway cluster, synthetic data, real components.

| Measurement | Result |
|---|---|
| Online base backup (58 MB cluster) | **4.3 s** |
| Restore 1 — base + archived WAL (PITR): copy / recovery / total until promoted | 2.0 s / 0.6 s / **7.3 s** |
| Data loss window (heartbeat committed every second until an immediate shutdown) | **17.4 s** — bounded by `archive_timeout=60` plus archiver lag; the tail WAL segment was lost with the "disaster" |
| Restore 2 — base backup only: total until promoted | **6.0 s** |
| Consistency after PITR | campaign A: 6 completed / 0 inbox / batch CLEANED; campaign C (processor crashed after anonymous commit): 6 / 6 / PROCESSING with marker of 6; campaign B (submitted after the backup): 6 / 6, recovered through WAL |
| Processor resume on C after restore | `reused: true`, state CLEANED, accepted 6 = processed 6 = anonymous 6, `countsAgree: true` — no duplicate rows |
| Base-only restore revives deleted data | purged anonymous campaign A came back with **6 responses**; the expired export came back READY |
| Restore gate | staff readiness **false** while pending |
| Ledger replay on base-only restore | re-purged campaign A (`ANONYMOUS_CAMPAIGN: 1`), re-expired the export (`PRIVATE_EXPORT: 1`), no incident, gate cleared, readiness **true** |
| Data lost by the base-only restore | campaign B and its 6 accepted submissions — created after the backup, so absent entirely; reported, not invented |

**Interpretation.** On this hardware and data size the blueprint's suggested RTO (≤ 4 h) and RPO (≤ 15 min) are met by a wide margin. That says little about production: real RTO is dominated by database size, storage throughput and people; real RPO by the provider's WAL shipping. Both must be re-measured on the chosen provider with representative data (P-002, P-004, P-008).

## 5. Key custody and backup deletion — the honest limits

* The development custody adapter unlinks a sealed key **file**. Any backup, snapshot or replica of that directory taken before destruction still holds the sealed key, and whoever holds the custodian secret can open it. **Crypto-erasure is therefore not achieved** by this adapter (P-003).
* The encrypted intake inbox lives in the core database; its backups hold the ciphertext for the backup retention (35 days). If a custody backup from the same period exists, the pair is decryptable. **Keeping custody backups out of the core backup set, with a shorter or zero retention, is the control;** it is procedural here.
* The tombstone replay removes restored data from the **restored environment**. It does not and cannot remove it from the backup media itself; backups age out only by their own retention.
* A managed KMS with scheduled key deletion changes this materially, but its deletion/recovery window must be read from the provider and recorded — it is not assumed here.
* **Pass 4:** custody now sits behind a provider interface with explicit production checks; production refuses the development adapter and preflight fails it. No managed provider is integrated. The integration plan, the questions about deletion/recovery windows and custody backups, and what must be proven before any campaign may be called crypto-erased are in [key-custody.md](key-custody.md). The processor now records the provider's own destruction evidence, which for the development adapter says "not crypto-erasure".
* The intake erasure tool (`intake:erase`) removes restored intake from the live environment only; the same envelopes remain in core backups until those age out.
