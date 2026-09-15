# Privacy verification (Phase 14)

2026-09-14. **This is a self-verification of an implementation, not a privacy approval and not a proof of anonymity.** An independent privacy/security review remains a production gate (P-001, P-008), and CE-001 remains accepted, declared and unreviewed.

## 1. The claim being verified, and its limits

Finalized answers are stored without any identity, invitation, token, session, draft or transport identifier; no staff role can read raw answers or an individual's score; results publish only as aggregates with at least five contributors plus complementary and homogeneity suppression; temporary identity-linked intake is purged once its anonymous output is proven.

It is **not** claimed that:
* the privacy processor cannot read answers — it decrypts every accepted envelope of an eligible campaign (trust assumption);
* an infrastructure operator holding both databases, the custodian secret, process memory or the TLS terminator cannot correlate;
* the shuffle is a verified mix network;
* backups are crypto-erased (see §5);
* five contributors makes a result non-identifying — CE-001 shows an added contributor's own score is recoverable from two overlapping releases, to 0.01 of a point from one department row (accepted and declared under P-009).

## 2. Evidence re-run in Phase 14

| Property | Evidence | Result |
|---|---|---|
| No identity column, value or mapping in the anonymous store; no staff path to drafts, envelopes, raw answers, response ids or keys | `npm run test:privacy`, `test:checkpoint-c` (adversarial walk from a named participant to their answers by every route) | pass |
| One immutable accepted payload per invitation under concurrency; safe retry after a lost response | `test:respondent`, `test:checkpoint-c`; 200-session load run (200 envelopes = 200 completed invitations) | pass; reconciled |
| Crash boundaries produce no partial or duplicate anonymous output | `test:checkpoint-c` fault points; restore drill — processor crashed after anonymous commit, resumed after a restore with `reused: true`, 6 = 6 = 6 | pass |
| Aggregate disclosure controls | `test:disclosure`, `test:publication`, `test:checkpoint-d`, `test:checkpoint-e` | pass |
| Full journey privacy boundary (free text absent from every staff surface and workbook; no participant filter; intake empty after processing; below threshold nothing decrypted) | Checkpoint F browser spec, re-run in this phase's browser suite | pass |

## 3. Phase 14 additions, verified

### Rate limiting stores no identifier (`tests/operations.test.ts` O-2)
* `intake.rate_limit` has exactly four columns: bucket, key digest, window start, hits — asserted against the catalog.
* Keys are HMACs over the window start and the client material, under a key derived from (not equal to) the invitation-digest key; the same client yields unrelated keys in different windows; no stored key equals the hex of the IP, the token, the session value or the session's SHA-256.
* The gateway credential can increment a counter but cannot read the table.
* Rows are purged after two windows (`rate_limit_window`).
* Without a configured trusted-proxy header, client-supplied addresses are ignored, so a forged header can neither escape a limit nor place another person's address in it.
* A limit event does not touch the invitation (still READY, still opens).

### Retention and tombstones name objects, never people (O-3, O-4)
* Tombstone ledger lines have exactly `seq, class, organizationId, subjectId, recordedAt`; subjects are attachment, report, export or campaign identifiers. No line contains an answer, token, participant or invitation reference (asserted on the shipped file).
* Anonymous retention is whole-campaign; after it, responses, answers and markers for the campaign are zero (asserted).
* Alert inputs are counts, ages and states only; they contain no campaign identifier (O-6).

### Restore cannot silently resurrect erased data (O-5, restore drill)
* A base-backup-only restore revived a purged anonymous campaign (6 responses) and an expired export; the ledger replay removed both **before** readiness turned true.
* Intake is re-erased only where erasing loses nothing the restore had not already lost; otherwise the replay keeps the envelopes, reports `ANONYMOUS_OUTPUT_MISSING_FOR_ERASED_INTAKE` and keeps the environment closed.
* Both readiness endpoints (staff and respondent) refuse while the gate is pending.

### Instrument cache holds no respondent data (PERF-2)
The gateway caches the **published questionnaire** by version id and schema hash — identical for every respondent of a campaign. Sessions are resolved in the database on every call; no session, draft, answer or token is cached.

### Row-security rewrite changes no visibility (O-8)
Migration 018 changes when policies are evaluated. For an administrator, an assigned member, an unassigned member and a caller with no session, the rows visible in all seven affected tables are identical before and after.

## 4. Logs, gateways, proxies and error trackers

| Channel | Inspected | Finding |
|---|---|---|
| Application code | every `console.*` call in `src/` and `apps/` | **none** in either web application; operator scripts print counts and generic failure sentences only |
| Next.js request logging | `apps/*/next.config.ts` | `logging.incomingRequests: false`, `poweredByHeader: false` in both apps |
| PostgreSQL server log (local cluster, 40,111 lines from all phases' tests) | scanned for 43-character token shapes, `answers`, `ciphertext`, key/value DETAIL lines | the only 43-character matches are SQL comment dividers and constraint names; `answers`/`ciphertext` occur only inside migration comments; **no** `DETAIL: Key (...)=(...)` value lines; `log_parameter_max_length_on_error=0` |
| Error trackers, analytics, session replay | dependencies and both apps' markup | none present; no third-party script; CSP `script-src 'self' 'nonce-…'` |
| Respondent URL | client | token read from the fragment and removed with `replaceState` before any request; never in a path, query string, Referer or server log |
| Reverse proxy, load balancer, CDN, provider logs | **not inspectable here** | must be configured to disable body capture and full-URL logging; network metadata retention must be documented (P-002) |
| Correlation identifiers | route handlers, gateway, processor | no request id is propagated; no idempotency cache on the public API |

Recommended server settings are recorded in `retention-backup-runbook.md` §2; they are verified in the drill cluster, not enforced by the application.

## 5. Key custody and deletion — limits

* Development custody unlinks a sealed key file; any earlier copy of that file plus the custodian secret can decrypt the matching intake. **No crypto-erasure** (P-003).
* Encrypted intake exists in core-database backups for their retention; keeping custody backups out of that set is the control and is procedural.
* Tombstone replay cleans the restored environment, not the backup media.
* Restored environments can bring back intake of campaigns processed after the backup (it was not yet erased then); the replay erases it again only when its output is proven.

## 6. What remains for the independent reviewer

1. CE-001 and P-009: the accepted longitudinal disclosure.
2. The processor trust assumption and who operates it (P-003).
3. The deployment's proxy/CDN/provider logging and network metadata (P-002).
4. Backup and custody separation as actually configured by the operator.
5. Whether the rate-limit HMAC design meets the jurisdiction's treatment of IP addresses as personal data.

## 7. Post-Audit Repair Pass 4 additions (2026-09-15)

Self-verification only; not a privacy approval. CE-001 is unchanged (accepted and declared under P-009, not prevented, not independently reviewed).

### Staff rate limits store no identifier (AD-2)
* `access.staff_rate_limit` holds bucket, keyed digest, window start, hits and a refused count. Keys are HMACs over the window and the client material (a trusted-proxy address bucket or a session digest) under a key derived from the invitation-digest key with a staff-specific label, so a staff counter can equal neither a gateway counter nor a stored digest. Asserted: no stored key contains the hex of the address, the session token or its SHA-256; one client's key differs between windows.
* Only `orgfit_auth` may count (EXECUTE only); neither `orgfit_auth` nor `orgfit_staff` can read the table. Rows are removed on the `rate_limit_window` retention class. Alerts carry counts only.
* Whether hashed address buckets are personal data in the deployment jurisdiction is §6 item 5, now for the staff side too.

### Tombstone ledger (AP-9, AP-10, AD-3)
* Ledger lines are unchanged: exactly `seq, class, organizationId, subjectId, recordedAt` — objects and campaigns, never people (re-asserted). Seals add counts, sequence bounds and hashes only.
* The S3 sink's Object Lock and deletion protection are **not** verified (test double only). A restore replay refuses a ledger whose seals do not verify, keeping both readiness endpoints closed.
* PR4-001 repaired: deletions made after a restore now reach the ledger, so a second restore cannot resurrect them.

### Intake erasure after a restore incident (AD-4)
* Erases one closed campaign's encrypted envelopes, drafts and respondent sessions, only after the ledger-verified incident, with a Super Admin approver and an incident reference. It reads no envelope, touches no invitation or completion record and nothing in the anonymous database (asserted by counts before and after), and records only identifiers, counts, the reference and the reason.
* It does **not** erase backup copies; the ciphertext remains in core backups for their retention.

### Key custody (AP-7, AD-5)
* No change to the protocol or to who can open a campaign key. Destruction evidence now comes from the provider; the development provider states it is not crypto-erasure, and AP-7 demonstrates why (a copy taken before destruction plus the custodian secret still opens the key). §5 above stands in full; see [key-custody.md](key-custody.md).

### Attachments (AP-1…AP-6, AD-1)
* Visit attachments are identified consulting material, not respondent data; nothing here links them to survey answers. The engine adapter sends decrypted file bytes to the engine, so production requires a local socket or loopback address. No engine has been run.
