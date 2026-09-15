# Security review (Phase 14)

2026-09-14. **A self-review by the implementer, with evidence. It is not an independent security assessment, not a penetration test and not a production approval** (P-001, P-008). Nothing was deployed; no external system was contacted except the npm registry for the dependency audit.

## 1. Scope inspected

Code: `src/security.ts`, `src/auth.ts`, `src/local-auth.ts`, `src/db.ts`, `src/csp.ts`, `src/config.ts`, `src/gateway-db.ts`, `src/respondent.ts`, `src/invitation-token.ts`, `src/processor.ts`, `src/key-custody.ts`, `src/attachment-*.ts`, `src/report-*.ts`, both apps' route handlers, proxies and `next.config.ts`. Database: roles (`db/roles.sql`), migrations 001–018 and anonymous 001–002, every staff RLS policy (`pg_policies`), the `access.*` functions, grants per runtime role. Configuration: `.env*.example`, `.gitignore`, local PostgreSQL settings (`pg_settings`), the server log. Dependencies: `package-lock.json` via `npm audit`. Git: tracked files and full history for secrets.

## 2. Controls and their evidence

| Control | How it is enforced | Evidence (run in this phase unless noted) |
|---|---|---|
| Staff MFA | OIDC with allowlisted ACR; sessions refuse `mfa_verified=false` except the switched-off local password path | `test:integration`, `foundation.spec` OIDC denials (no-mfa, bad state/nonce/audience/issuer/signature, expired) |
| Session revocation | epoch bump on status/role/capability/org change; idle 30 min, absolute 12 h; revoked on logout | `foundation.spec` "disabling a logged-in staff member denies the next request"; `test:access` |
| Object and capability authorization | every route calls `requireAccess(org, capability)`; routines re-check; foreign org = 404 | `test:directory`, `test:visits`, `test:reports`, Checkpoint F F-10 (staff of Q cannot reach P's results, history, comparisons, visits, participation, report or attachment by direct id or substituted org) |
| Row security, runtime roles | FORCE RLS; runtime roles non-owner, no BYPASSRLS, no executor membership — asserted by readiness | `test:integration`; O-8 (policy rewrite preserves visibility for four caller types) |
| CSRF | exact Origin, `Sec-Fetch-Site` cross-site refused, JSON-only mutations, UUID idempotency keys | `test` (unit), `access.spec` cross-origin 403; production smoke forged PATCH refused |
| CORS | no `Access-Control-Allow-*` emitted anywhere | production smoke: page, API and hostile preflight carry none (added in Phase 14) |
| CSP and headers | nonce CSP without `unsafe-inline`/`unsafe-eval` in production; sandbox CSP for attachments; `X-Frame-Options DENY`, `nosniff`, `no-referrer`, `no-store`; no `X-Powered-By` | production smoke (extended in Phase 14); `visits.spec` attachment CSP |
| Input validation and sanitization | Zod strict schemas; plain-text-only instrument text; server re-validates every answer against the pinned version; spreadsheet formula injection neutralized | `test:instruments`, `test:scoring`, `test:respondent`, `test:reports` |
| Body and collection limits | 2 MiB streamed JSON bodies; attachment 20 MiB at the boundary; bounded lists | `test:visits` (oversize refused, row stays UPLOADING) |
| Secret management | secrets from environment only; staff and gateway processes refuse foreign credentials; no committed secret | `test` (config refusal), `check:boundaries`; secret scan of tracked files and all history: **clean**; only the three `.example` env files tracked |
| Dependencies | exact lockfile | `npm audit`: **0 vulnerabilities** (all and production-only) |
| Token rotation | per-invitation ROTATE invalidates prior sessions; digest-key rotation with a verify-only previous key (Phase 14) | `test:campaigns`; O-7 (old link works only inside the window; new links carry the new version) |
| Public rate limiting | exchange 300/min per trusted-proxy IP, 10/min per token; drafts 30/min and finals 5/min per session; counters only (Phase 14) | O-2 (limits hold; 250 NAT users allowed; invitation untouched; forged header ignored without proxy config) |
| Staff password throttling | per-address digest lock (development path) | `test:access` A-5 |
| Attachment scanning and private downloads | quarantine → separate scanner credential → CLEAN only; re-authorized download; sandbox CSP | `test:visits`, `visits.spec` |
| Logs and correlation | no application logging; no request-body/URL logging; no correlation id into processing | `privacy-verification.md` §4 |
| No session replay / third-party script | none in either app; CSP blocks third-party origins | build output, CSP |
| Restore safety | restore gate blocks both readinesses until tombstone replay (Phase 14) | O-5, restore drill |

## 3. Defects found and fixed in Phase 14

| ID | Severity | Defect | Repair | Evidence |
|---|---|---|---|---|
| SEC-F1 | High | **No rate limiting on the public respondent gateway** (exchange, draft writes, final submission) | Migration 017 `intake.rate_hit`; `src/rate-limit.ts`; limits in the route before every protected routine; 429 + `Retry-After`; truthful client message | O-2; full suites |
| SEC-F2 | High | **Rotating `INVITATION_DIGEST_KEY` silently invalidated every outstanding link**: the version was recorded but the gateway only tried the current key | `INVITATION_DIGEST_KEY_PREVIOUS` (verify-only, respondent process only); issuance always uses the current key | O-7 |
| SEC-F3 | High (availability) | **Directory listing timed out at 100,000 participants**: seven staff RLS policies evaluated session-dependent functions per row | Migration 018: init-plan evaluation, `= ANY(org_ids)`; rules unchanged | O-8; `performance-results.md` PERF-1 |
| SEC-F4 | High (availability) | **75 of 200 concurrent respondent sessions failed**; final acceptance p95 3.18 s | Hash-keyed cache of the published instrument; session still resolved per request | load run: 0 errors, p95 2.12 s; PERF-2 |
| SEC-F5 | Medium | A restored environment could receive respondent traffic before tombstone replay (staff readiness only) | `ops.ready()` in gateway readiness; `apps/respondent/app/health/ready` | O-5 |
| SEC-F6 | Medium | No retention for staff sessions, OIDC flows, password attempts, idempotency receipts, audit log, anonymous answers; no deletion tombstones for restores | Migration 017 policy + `ops.purge_core`; anonymous `purge_expired`; tombstone triggers, ledger and replay | O-3, O-4, O-5, restore drill |
| SEC-F7 | Low | Header/CORS posture was not asserted by any test | production smoke extended | `test:production` |
| SEC-F8 | Low | **Dashboard and PDF disagreed on the release date between 21:00 and 24:00 UTC**: the results tile and history dates sliced the database's timestamp text (server's +03:00 zone) while reports print UTC. Found because the Phase 14 gate ran after UTC midnight and Checkpoint E's E-6 failed | `utcDate()` in `src/zoned-time.ts` for the results tile and history dates, matching the reports; E-6 now compares instants in UTC (D-122) | `test:checkpoint-e` |

## 4. Residual issues, severity-ranked

Production gates listed in `decisions.md` remain open and are not repeated as defects: **P-001/P-008** independent privacy/security review (CE-001 included), **P-002** hosting/network/TLS, **P-003** key custody, **P-004** retention approval, **P-005** production IdP and MFA, **P-006** real instruments, **P-007** data/attachment policy, **P-010** antivirus engine.

| ID | Severity | Issue | Owner (role) | Repair steps |
|---|---|---|---|---|
| SEC-H1 | High | **No crypto-erasure.** Local custody unlinks files; backups of custody + core backups of encrypted intake remain decryptable for their retention | Key custodian (P-003) | Adopt a managed KMS/HSM with scheduled deletion; keep custody out of core backup sets; record the provider's deletion/recovery window; re-run the restore drill against it |
| SEC-H2 | High | **Attachments are type-verified, not malware-scanned** | Owner/operator (P-010) | Integrate a maintained engine in the scanner process; fail closed on engine errors; add EICAR + real-sample tests |
| SEC-M1 | Medium | Staff-side endpoints (OIDC start/callback, staff API) have no application rate limit | Platform operator | Edge rate limits at the proxy (P-002); optionally a DB bucket on `auth/start` and callback per IP |
| SEC-M2 | Medium | Per-IP gateway limit is **off** until `RATE_LIMIT_CLIENT_IP_HEADER` names a header the trusted proxy overwrites | Platform operator | Configure with the chosen proxy; tune limits with measured traffic |
| SEC-M3 | Medium | Tombstone ledger is a local append-only file: no tamper evidence; deletions since the last ship can be resurrected | Platform operator | Ship to an object-locked bucket; run `tombstones:ship` at the WAL-archive cadence; alert on ship failure |
| SEC-M4 | Medium | Required PostgreSQL logging settings are documented, not enforced | DB operator | Set in provider parameter groups; add a readiness check comparing `pg_settings` |
| SEC-M5 | Medium | No routine/tool to **revoke a published release** (state machine allows it) | Implementer (Phase 15 or later, with owner approval) | Add an audited `publication.revoke_release` with reason; staff/operator surface; test that results and reports refuse afterwards |
| SEC-M6 | Medium | No tool to erase intake retained by a restore incident after the owner decides | Implementer + privacy lead | Add an audited operator routine that deletes a campaign's inbox and records a `CAMPAIGN_INTAKE` tombstone; require the incident reference |
| SEC-M7 | Medium | No HTTP/TLS-level load or production-configuration smoke with a real database | Release owner (Phase 15) | Staging rehearsal through the real proxy with TLS and `sslmode=verify-full` |
| SEC-L1 | Low | Retention durations are unapproved defaults | Owner/records lead (P-004) | Approve per class; set `approved_by/approved_at` |
| SEC-L2 | Low | Development password path remains in the codebase (migration 016, switched off; bootstrap refuses production) | Owner | Keep off in production; consider removing from production builds |
| SEC-L3 | Low | Alerts are evaluated (`ops:check`) but not wired to paging | Operator | Wire exit codes/JSON to the monitoring system; drill end to end |
| SEC-L4 | Low | Final acceptance p95 2.1 s at 200 simultaneous submissions on one instance leaves limited margin | Release owner | Re-measure on production hardware; consider pool sizing |

**No critical implementation defect is known to remain open.** That statement covers what was inspected and tested here; it is not a substitute for the independent review.

## 5. Not verified

Real identity provider and MFA factors; TLS configuration; network segmentation; provider IAM; proxy/CDN logs; secret manager integration; S3 bucket policies and lifecycle rules; KMS deletion windows; WAF; container/host hardening; penetration testing; any production data.

## 6. Phase 15 addendum — release candidate (2026-09-14)

Still a self-review, not an independent assessment.

### Found and fixed

| ID | Severity | Defect | Repair | Evidence |
|---|---|---|---|---|
| RC-001 | High | **An anonymous store restored to an earlier point than the core lost committed answers silently.** The two databases are separate backup sets; with the anonymous side older, a campaign whose intake was already erased had no answers anywhere while every core count agreed, and nothing — not the replay, not `ops:check` — compared the stores. | Cross-store reconciliation in `restore:reapply` (incident, environment stays closed) and `ops:check` (`ANONYMOUS_STORE_INCONSISTENT`, critical) — D-123 | R-4; rollback drill mixed restore points, both directions |
| RC-002 | Medium | **CI did not run `test:localization`, `test:access` or `test:operations`**, so Phase 13 and 14 guarantees were unguarded outside this machine; the shallow checkout could not compare migrations with earlier commits | Suites and `test:release` added; `fetch-depth: 0` | `.github/workflows/ci.yml` (remote CI still not run) |

### Residual, added by this phase

| ID | Severity | Issue | Owner (role) | Repair steps |
|---|---|---|---|---|
| RC-003 | Medium | No provider deployment packaging or infrastructure definition — the process manifest and runbook are provider-neutral by design | Platform operator (P-002) | Once the provider is chosen: images or units per process, secret-manager wiring, network policy, proxy config; re-run the rehearsal steps there |
| RC-004 | Low | Operator, processor and publication scripts do not themselves refuse a non-TLS database URL in production (staff, gateway, renderer and scanner do); release preflight does | Implementer | Add the same `sslmode=verify-full` guard to `operatorUrl`, `corePool`, `anonymousPool` and the migrators |
| RC-005 | Low | Four dependency ranges in `package.json` use `^` (`@fontsource/*`, `playwright`, `@napi-rs/canvas`, `pdfjs-dist`); the lockfile pins them and `npm ci` is reproducible, but a lockfile regeneration could drift | Implementer | Pin exact versions |

### Status of Phase 14 residuals

SEC-M2 exercised in the rehearsal (proxy overwrites `X-Forwarded-For`; the per-IP bucket counted it) — still requires the real proxy. SEC-M4 is **checked** by release preflight, not continuously enforced. SEC-M7 **rehearsed locally** (TLS proxy, TLS-only database, `verify-full`) — not on real infrastructure. SEC-H1, SEC-H2, SEC-M1, SEC-M3, SEC-M5, SEC-M6, SEC-L1–L4 unchanged. **No critical implementation defect is known to remain open.**

## 7. Post-Audit Repair Pass 3 addendum (2026-09-15)

Still a self-review by the implementer, not an independent assessment. Decisions D-145 … D-154.

### Closed in code, development evidence only

| ID | Was | Now | Evidence |
|---|---|---|---|
| SEC-M5 | No routine or tool to revoke a published release | Super Admin screen and route, operator command with a named Super Admin approver; one immutable revocation record; dependent reports (own release, comparison sides, whole-series trends) revoked; row-lock ordering for concurrent download, request and render; purge of stored bytes; restore replay; downloaded copies counted and stated as unrecallable | `tests/revocation.test.ts` RV-1 … RV-11, `tests/browser/revocation.spec.ts` |
| RC-004 | Processor, publication, operator and migration scripts relied on preflight for TLS | Entry points refuse a production URL without `verify-full` (or with verification disabled) before connecting, and refuse forbidden variables by name | `tests/safeguards.test.ts` RG-1 … RG-4 (13 entry points, 0 connections — this count became trustworthy only with the PR3-006 repair below) |
| CG-003 | Browser harness needed `work/` in a fresh clone | The harness creates its scratch directories | RG-5; clean-clone browser start (phase-status.md) |

### Found and fixed in this pass

| ID | Severity | Defect | Repair | Evidence |
|---|---|---|---|---|
| PR3-001 | High (availability) | **One crashed renderer blocked every report thereafter.** `claim_report_jobs` reclaimed an expired lease with a RUNNING→RUNNING update the lifecycle trigger forbids, so every later claim raised and nothing was drawn | Restated in 023: requeue elapsed leases (or fail with `LEASE_EXPIRED` after `max_attempts`), then claim | Found by the supervised end-to-end run SV-9; RV-11 |
| PR3-002 | Low | A revoked report download answered 503 instead of 409 (`RESULTS_UNAVAILABLE` unmapped) | Code mapping in `src/http.ts` | browser revocation spec |
| PR3-005 | Medium (found in the verification of this pass) | **Report and scanner jobs connected without certificate verification** when their environment held `NODE_TLS_REJECT_UNAUTHORIZED=0`: their URL checks tested `sslmode` only, and preflight did not check the variable, so the supervisor's validation accepted such a file | Both pools use `databaseUrl` from the runtime guard; preflight FAILs the variable in production (D-156) | RG-3 second variant, RG-6 |
| PR3-006 | Medium (evidence) | The RG-3 "0 connections" assertion could not fail (`spawnSync` blocked the in-process listener), so the recorded RC-004 evidence overstated what was proven | Asynchronous spawn, per-entry-point assertion; shown to fail on the unfixed pools | RG-3 |

### Changed residuals

- **SEC-L3 / D11**: an alert-delivery adapter exists (none/console/file/webhook, webhook gated and https-only in production, codes only). Still NOT wired to a real destination; no alert has been sent externally; the monitoring destination, credentials and a paging drill are operator inputs.
- **D5 / RC-003**: a portable supervisor runs the schedule with per-process environment files, order, overlap protection, bounded retries, timeouts, shutdown and status. Still NOT deployed on any provider; process-manager restart, secret-manager mounting and log shipping are provider wiring (P-002).
- New trust note: the supervisor host can read the four job environment files (it validates them). It never merges them or places their values in its own environment, but anyone who controls that host controls every job credential — the same as any scheduler of these jobs. Keep the files in a secret manager readable by the supervisor's service identity only.

SEC-H1, SEC-H2, SEC-M1, SEC-M2, SEC-M3, SEC-M4, SEC-M6, SEC-M7, SEC-L1, SEC-L2, SEC-L4, RC-005 and CE-001 are unchanged.