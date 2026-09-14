# Final handoff — Phase 15 release candidate

2026-09-14.

> **Superseded identifier.** Checkpoint G corrected one release-blocking mislabel (CG-001) and the candidate is now **`orgfit-0.3.0-rc.2`, commit `e801b9a`** — see [checkpoint-g.md](checkpoint-g.md) §4a. Everything below describes rc.1 as handed to Checkpoint G.

## Decision

**NO-GO for production.** The release candidate is assembled, reproducible and verified on one development machine, including a production-mode rehearsal behind TLS and physical restore drills. It is **not** deployable to real respondents: no authorized environment exists to stage it in, an independent privacy and security review has not happened, and every production input (P-001 … P-008, P-010) is open. A technical GO at Checkpoint G would still not authorize deployment.

Nothing was deployed, pushed or sent. The repository has no remote.

## 1. Release identifier

| | |
|---|---|
| Release | `orgfit-0.3.0-rc.1` (package version `0.3.0-rc.1`) |
| Candidate commit | `ef914d8e22fb136096231cf25506d5493672e813` on `main` |
| Source digest (tracked files outside docs) | `5582a0ed4aa953286a3eb93ec1b3e938b8347f221a6ed39999b9ce28acaf2b66` |
| Lockfile SHA-256 (LF) | `865810b0b23e31ae20646d9f284ae498f0823c1d8f59782721a1fba0903f1291` |
| Process manifest SHA-256 (LF) | `a6a1e4144a1e7ae41495874b628650e6ff01e5d0732f4e6b929526b801e1825b` |
| Schema | core migrations 001–018, anonymous 001–002; no migration added over Phase 14 |
| Manifest | `work/release/orgfit-0.3.0-rc.1/manifest.json` (ignored path; regenerate with `npm run release:manifest -- --id orgfit-0.3.0-rc.1`) |

Commits in this phase: `fadffb1` (release tooling, RC-001 repair, tests, docs); `2f05b56`, `e010e1b` and `ef914d8` (release-manifest fixes — line endings, npm version, dirty-tree detection found by the clean-clone check). The three follow-up commits change only `scripts/release-manifest.ts`. Later documentation-only commits keep the same source digest; `npm run release:manifest -- --verify <manifest>` confirms it.

## 2. Tests actually run

Windows 11 on a 12-core Snapdragon X Elite, Node 24.13.1, npm 11.8.0, PostgreSQL 18.4 (embedded x64 package), Chromium via Playwright 1.63.0. Synthetic data only.

### Regression gate on the candidate code (working tree at `fadffb1`)

| Check | Result |
|---|---|
| `typecheck` | clean |
| `lint` | 1 error in the new rehearsal harness (`any`) → fixed → clean |
| 24 node suites: `test` 5, `test:localization` 4, `test:integration` 8, `test:directory` 6, `test:instruments` 8, `test:scoring` 15, `test:scoring-db` 5, `test:checkpoint-b` 3, `test:campaigns` 18, `test:respondent` 24, `test:privacy` 17, `test:checkpoint-c` 21, `test:disclosure` 16, `test:publication` 13, `test:recommendations` 13, `test:checkpoint-d` 18, `test:comparison` 13, `test:history` 8, `test:reports` 17, `test:checkpoint-e` 11, `test:visits` 14, `test:access` 8, `test:operations` 9, `test:release` 5 | **279 passed, 0 failed** |
| `check:boundaries`, `test:production` | pass |
| `npm audit` | 0 vulnerabilities |
| `npx playwright test` (all specs) | **52 passed** (9.6 min) |

### Phase 15 verification

| Check | Result |
|---|---|
| R-1 process manifest and preflight (11 unsafe settings, 9 trust-boundary crossings, ledger comparison) | pass |
| R-1b preflight CLI prints no value | pass |
| R-2 migrations of `59c99e3` and `b8d1bab` byte-identical; additions listed | pass — none added since `b8d1bab` |
| R-3 upgrade from the Checkpoint F schema populated by `59c99e3`'s own code | pass — 016→018 + anonymous 001→002 in 201 ms; consumed links `ACCEPTED`; unused links open once; B processed 6 = 6 and published like A |
| R-4 cross-store reconciliation (missing, mismatch, ahead-of-core; replay stays closed; `ops:check` critical) | pass |
| `tests/ops/rollback-drill.ts` — physical base-backup rollback, point-in-time restore, mixed restore points | **8/8 checks** (below) |
| `tests/release/rehearsal.ts` — production builds, TLS, TLS-only DB, six separate process environments | **13/13 stages** (below) |
| Clean clone of `ef914d8` | all pass — §3 |

Rollback drill checks, each asserted:
1. both readinesses closed before the ledger replay;
2. an export deleted after the backup (tombstone) and one whose expiry passed after it (time) are expired again;
3. intake whose committed anonymous output the restore lost is an incident; the environment stays closed and the envelopes are kept;
4. invitations consumed before the restore point cannot reopen and add nothing;
5. a submission lost with the restore point can be made again exactly once (six envelopes);
6. processing the undecryptable campaign fails closed and writes no anonymous row;
7. point-in-time restore: every acceptance survives, the cleaned campaign keeps its six rows, no link reopens, no incident;
8. mixed restore points are reported in both directions, and the processor refuses with `MARKER_MISMATCH` without duplicating rows.

Rehearsal stages: TLS-only database (plaintext and untrusted certificate refused) · migrations, anonymous migrations and bootstrap over `verify-full`, second bootstrap refused · preflight of all six processes in production mode with database checks, mixed staff file refused · both builds ready over https · OIDC over https issues a `__Host-` Secure HttpOnly cookie · staff journey through the API · Arabic survey at 320 px and staff campaign screen with no CSP violation, Secure survey cookies · six acceptances over https, consumed link adds nothing, per-IP bucket counts the proxy address, cross-origin submission refused · processor and publication as separate processes (6 = 6, PUBLISHED), individual slicing refused · Arabic PDF and English XLSX rendered into the bucket, encrypted at rest · attachment quarantined until the scanner process marks it clean, byte-identical download under a sandbox policy · retention, draft expiry, tombstone shipping, alerts; restore gate closes and reopens both https readiness endpoints · revoked session refused.

### Required checks not run

Staging in an authorized non-production environment (none exists); a real identity provider and MFA; real TLS certificates, domains, proxy/CDN/WAF; a real S3 bucket's policy, lifecycle, versioning and IAM (a local test double was used); managed KMS deletion; a real antivirus engine; network segmentation; paging integration; load and restore on production hardware or provider PITR; real iOS/Android devices, WebKit/Firefox, screen readers; remote CI; penetration test; independent privacy or security review.

## 3. Clean installation from the candidate

A fresh `git clone` of the repository into `work/rc-clean3`, checked out at `ef914d8`, with its own `node_modules`:

| Step (inside the clone) | Result |
|---|---|
| `npm ci` | 310 packages added, 313 audited, **0 vulnerabilities** |
| `typecheck`, `lint` | clean |
| `npm run build` (both apps) | pass |
| `check:boundaries`, `test:production` | pass |
| `release:manifest -- --verify` against the manifest generated in the main checkout | **matches**, no problems |
| `test:release` (R-1, R-1b, R-2, R-3, R-4) | 5 passed |
| `tests/ops/rollback-drill.ts` | 8 checks passed |
| `tests/release/rehearsal.ts` | 13 stages passed |
| `--verify` again after the drills and rehearsal | matches |

**Two earlier "clean clone" attempts were not clean clones**, and are recorded so nobody relies on them: Git refused the local clone ("dubious ownership" — the repository directory belongs to another local account), the output was discarded, and the steps ran in the main checkout instead. The first of them nevertheless exposed RC-006 (fixed in `ef914d8`); it also detached the main checkout's HEAD at the same commit, which was reattached to `main` with a fast-forward. The genuine clone above passed `safe.directory` for that one command only; no global Git configuration was changed.

## 4. Defects found in this phase

| ID | Severity | Status |
|---|---|---|
| RC-001 anonymous store restored earlier than core lost committed answers silently | High | **Fixed** (D-123) |
| RC-002 CI omitted three suites; shallow checkout | Medium | Fixed in the workflow; remote CI never run |
| RC-003 no provider deployment packaging | Medium | Open (P-002) |
| RC-004 operator/processor scripts do not refuse non-TLS URLs themselves | Low | Open; preflight is the control |
| RC-005 caret ranges in `package.json` | Low | Open; lockfile pins |
| RC-006 release manifest: CRLF-dependent hashes; npm version via a shell spawn; `--verify` refused every freshly built checkout (clipped first path; generated `next-env.d.ts` counted) | Low | Fixed (`2f05b56`, `e010e1b`, `ef914d8`); the last found by the clean-clone check |
| Harness defects of my own: a report-status expectation (202, not 201) and a deadlock between a blocking spawn and the in-process storage double | — | Fixed in the harness; not product defects |

Unresolved from earlier phases, unchanged: SEC-H1 (no crypto-erasure), SEC-H2 (no antivirus), SEC-M1, SEC-M3, SEC-M5 (no release revocation workflow), SEC-M6, SEC-L1–L4, CE-001 (accepted and declared; awaiting independent review). No critical implementation defect is known to be open.

## 5. Exact remaining production inputs

| Input | Owner role | Blocks |
|---|---|---|
| Accepted privacy threat model and respondent notice (P-001) | Owner | Any real collection |
| Independent privacy and security review of protocol, implementation, disclosure and infrastructure, **including CE-001** (P-001, P-008) | Independent reviewer | Any real collection |
| Real approved Arabic/English instrument content, constructs, scoring, bands, recommendation rules, equivalence mappings (P-006) | Instrument owner | Real assessments |
| Hosting provider, region/residency, domains/TLS, network separation, staging and production environments (P-002) | Owner + infrastructure operator | Staging, production |
| Separate privacy-processor operator and key custodian; managed key service; deletion and recovery windows (P-003) | Owner + key custodian | Real intake; any erasure claim |
| Production identity provider with MFA; first Super Admin subject; staff capabilities and assignments (P-005) | Identity administrator | Staff access |
| Approved retention per class, consulting/aggregate schedule, RPO/RTO (P-004) | Records lead | Production retention |
| Actual restore evidence on the chosen provider with representative data (P-004, P-008) | Operator | Production readiness |
| Import/contact fields, qualitative-output policy, attachment types/limits, font licences (P-007) | Data steward | Real directories and files |
| Maintained antivirus engine (P-010) | Owner/operator | Real attachments |
| Named release owner, on-call and runbook owners (P-008) | Owner | Operation |
| **Explicit production deployment authorization** (P-008) | Owner | Deployment |

## 6. Rollback plan

- **This candidate adds no migration over Phase 14**, so rolling back the application is redeploying the previous build; operator preflight confirms the ledgers still equal that build's migrations.
- Any future release that adds migrations: do not run an older build on the newer schema (preflight fails with "applied but not in this release"); fix forward or restore both databases to the pre-upgrade backup, then redeploy.
- Data restore: retention-backup-runbook §3, whose guarantees the rollback drill now asserts. Ship tombstones at least as often as the backup RPO; a deletion after the last ship can be revived (SEC-M3).

Full procedure: [deployment-runbook.md](deployment-runbook.md) §5 and §7.

## 7. Documents

[release-checklist.md](release-checklist.md) · [deployment-runbook.md](deployment-runbook.md) · [staff-operations-guide.md](staff-operations-guide.md) · [security-review.md](security-review.md) §6 · [decisions.md](decisions.md) D-123 … D-126 · [retention-backup-runbook.md](retention-backup-runbook.md) · [incident-runbook.md](incident-runbook.md) · [privacy-verification.md](privacy-verification.md) · [performance-results.md](performance-results.md).

## 8. Next step

Checkpoint G has run — [checkpoint-g.md](checkpoint-g.md): technical GO as an implementation gate, production NO-GO. Deployment requires explicit authorization.
