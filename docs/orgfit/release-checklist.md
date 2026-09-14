# Release checklist — orgfit-0.3.0-rc.1 (Phase 15)

2026-09-14. Each line is **DONE** (with the evidence actually produced in this phase), **NOT DONE** (with what is missing) or **OWNER INPUT** (a decision or resource only the owner or a named role can supply). Nothing is marked done because a document describes it. Checkpoint G re-inspected this list: [checkpoint-g.md](checkpoint-g.md). After CG-001 the candidate is `orgfit-0.3.0-rc.2` (`e801b9a`); every status below still holds for it.

**Decision: NO-GO for production.** The technical candidate is assembled and verified on one machine; every owner input below is still open, and no authorized environment exists to stage it in. See [final-handoff.md](final-handoff.md).

## A. Candidate identity and build

| # | Item | Status | Evidence |
|---|---|---|---|
| A1 | Candidate is one commit with a manifest | DONE | `ef914d8`, source digest `5582a0ed…`; `npm run release:manifest -- --id orgfit-0.3.0-rc.1` (final-handoff §1) |
| A2 | Manifest verification refuses a differing checkout | DONE | `--verify` compares source digest, lockfile, process manifest, roles, migrations, uncommitted changes |
| A3 | Clean installation from the commit | DONE | fresh clone of `ef914d8`: `npm ci` (0 vulnerabilities), typecheck, lint, build, boundaries, production smoke, `--verify` matches; release suite, rollback drill and rehearsal pass inside the clone (final-handoff §3) |
| A4 | Dependency lock and audit | DONE | `npm ci` from lockfile; `npm audit`: 0 vulnerabilities. Four caret ranges remain in `package.json` (RC-005, pinned by the lockfile) |
| A5 | Web builds exclude other processes' code | DONE | `check:boundaries` (now also excludes the preflight module) |
| A6 | CI covers every suite | DONE in file / NOT DONE remotely | `.github/workflows/ci.yml` updated (RC-002); **remote CI has never run** — no remote exists |

## B. Database and migrations

| # | Item | Status | Evidence |
|---|---|---|---|
| B1 | Fresh installation applies every migration | DONE | rehearsal §5 (TLS cluster, CLI migrators); every node suite creates fresh databases |
| B2 | Upgrade from the previous supported schema with real state | DONE | R-3: Checkpoint F (`59c99e3`) code writes state, candidate upgrades 016→018 and anonymous 001→002 in 201 ms, idempotent re-run |
| B3 | No released migration was edited | DONE | R-2 against `59c99e3` and `b8d1bab`; migrator checksum refusal |
| B4 | Candidate adds no migration over Phase 14 | DONE | R-2: "since Phase 14 (b8d1bab): added no migration" |
| B5 | Runtime roles are non-owner, no superuser/bypassrls/createrole/createdb | DONE | preflight `role:*` for all nine URLs in the rehearsal; `test:integration` |
| B6 | Server logging settings keep values out of logs | DONE locally | preflight `log-settings:*` PASS on the rehearsal cluster. OWNER INPUT: set on the chosen provider (SEC-M4) |
| B7 | Database connections verified TLS | DONE locally | rehearsal: plaintext refused, untrusted certificate refused, all processes `verify-full` |

## C. Configuration, secrets and permissions

| # | Item | Status | Evidence |
|---|---|---|---|
| C1 | Process manifest lists every process, identity and forbidden credential | DONE | `deploy/processes.json`; R-1 |
| C2 | Preflight refuses unsafe environments without printing values | DONE | R-1 (11 failure classes, 9 boundary crossings), R-1b; rehearsal mixed file refused |
| C3 | Secrets stored in a secret manager | OWNER INPUT | P-002 — no provider |
| C4 | Distinct production keys generated and escrowed | OWNER INPUT | P-002/P-003 |
| C5 | Managed key custody with measured deletion | OWNER INPUT | P-003, SEC-H1 — file custody is a development stand-in |
| C6 | Development password path off | DONE | preflight `local-password-path` PASS (off) in the rehearsal; migration 016 default |

## D. Services, storage, jobs and health

| # | Item | Status | Evidence |
|---|---|---|---|
| D1 | Production builds start and report ready over https | DONE locally | rehearsal stage 4 |
| D2 | OIDC sign-in issues `__Host-` Secure HttpOnly cookies | DONE with synthetic IdP | rehearsal stage 5. OWNER INPUT: real IdP + MFA (P-005) |
| D3 | Private bucket storage code path in production mode | DONE against a test double | rehearsal: reports and attachments stored encrypted, retrieved, deleted. NOT DONE: real bucket policy, lifecycle, versioning, IAM (P-002) |
| D4 | Processor, publication, renderer, scanner, operator jobs run as separate processes | DONE locally | rehearsal stages 9–12 |
| D5 | Job scheduler with cadences | DONE locally / NOT DONE on infrastructure | Post-Audit Repair Pass 3: `npm run jobs:supervise` runs `deploy/processes.json` → `schedule` with per-process environment files, order, no overlap, bounded retries, timeouts, shutdown and status (`tests/supervisor.test.ts` SV-1 … SV-9). NOT DONE: running it under a provider's process manager with secrets from a secret manager (P-002, deployment-runbook §9) |
| D6 | Report rendering (Arabic PDF, English XLSX) | DONE | rehearsal stage 10; `test:reports`, `test:checkpoint-e` |
| D7 | Readiness closes on a pending restore | DONE | rehearsal stage 12 (both https endpoints 503, then 200) |
| D8 | TLS certificates and domains | OWNER INPUT | P-002 — rehearsal used a local CA |
| D9 | Proxy overwrites client address; per-IP limit on | DONE locally | rehearsal: `exchange_ip` bucket counted. Real proxy: P-002 (SEC-M2) |
| D10 | Staff-side rate limiting at the edge | NOT DONE | SEC-M1 |
| D11 | Alerts wired to paging | NOT DONE (adapter prepared) | `ops:check` now also judges job health; `src/alert-delivery.ts` can write a file or post to a webhook when explicitly enabled. No destination or credentials exist and nothing has been sent (SEC-L3) |

## E. Verification of the candidate

| # | Item | Status | Evidence |
|---|---|---|---|
| E1 | Full automated node suites | DONE | 24 suites, 279 tests, 0 failures (final-handoff §2) |
| E2 | Full browser suite | DONE | `npx playwright test`: 52 passed (development servers, Chromium only) |
| E3 | Final synthetic end-to-end smoke on production builds | DONE | rehearsal 13/13 |
| E4 | Rollback/restore cannot reopen consumed invitations | DONE | rollback drill checks 4, 7; R-3 |
| E5 | … duplicate accepted submissions | DONE | rollback drill checks 5, 8 (`MARKER_MISMATCH`, no duplicate rows) |
| E6 | … lose committed intake silently | DONE after RC-001 repair | rollback drill checks 3, 8; R-4 |
| E7 | … expose expired data | DONE | rollback drill check 2 (tombstoned and time-expired exports). Limit: deletions after the last ship (SEC-M3) |
| E8 | Staging in an authorized non-production environment | NOT DONE | none exists (P-002); local rehearsal only (D-126) |
| E9 | Load and restore on production hardware | NOT DONE | Phase 14 figures are one developer machine |
| E10 | Real iOS/Android, WebKit/Firefox, screen reader | NOT DONE | unavailable (Phase 13, Checkpoint F) |

## F. Documentation and people

| # | Item | Status | Evidence |
|---|---|---|---|
| F1 | Deployment runbook | DONE | [deployment-runbook.md](deployment-runbook.md) — unexecuted on real infrastructure |
| F2 | Staff operations guide | DONE | [staff-operations-guide.md](staff-operations-guide.md) |
| F3 | Backup/restore and incident runbooks | DONE (Phase 14) | [retention-backup-runbook.md](retention-backup-runbook.md), [incident-runbook.md](incident-runbook.md) |
| F4 | Named release owner, operator, key custodian, privacy lead, on-call | OWNER INPUT | P-003, P-008 |

## G. Owner inputs and approvals (all open)

| # | Input | Reference |
|---|---|---|
| G1 | Accepted privacy threat model and respondent notice | P-001 |
| G2 | Independent privacy and security review, including CE-001 (per-person score derivable from two releases) | P-001, P-008 |
| G3 | Hosting provider, region/residency, domains/TLS, network separation, environments | P-002 |
| G4 | Separate processor operator and key custodian; managed keys; deletion/recovery windows | P-003 |
| G5 | Approved retention per class; approved RPO/RTO; restore measured on the provider | P-004 |
| G6 | Production identity provider with MFA; first Super Admin subject; staff capabilities | P-005 |
| G7 | Approved Arabic/English instruments, scoring, bands, rules, equivalences | P-006 |
| G8 | Import/contact fields, qualitative output, attachment types/limits, font licences | P-007 |
| G9 | Maintained antivirus engine for attachments | P-010 |
| G10 | Explicit production deployment authorization | P-008 |
