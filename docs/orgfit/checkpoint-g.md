# Checkpoint G — final go/no-go inspection

2026-09-14. Run against release candidate `orgfit-0.3.0-rc.1` (commit `ef914d8`), with one release-blocking correction producing **`orgfit-0.3.0-rc.2`** (§4). Synthetic data only. Nothing deployed, pushed or sent.

## Decision

**Technical: GO for Checkpoint G as an implementation gate** — the candidate matches tested code and migrations, every smoke check the prompt lists passed again, no critical or high implementation defect is open, and prohibited scope is absent.

**Production: NO-GO.** Required independent privacy and security review has not happened, no authorized staging environment exists, and every owner input in §6 is open. **A technical GO is not authorization to deploy.**

## 1. Inspection

| Item | Finding |
|---|---|
| Pending changes before the checkpoint | none; `main` at `917c3fe` |
| Candidate vs tested code | `release:manifest --verify` against the Phase 15 manifest: **matches** (current `917c3fe` differs from `ef914d8` only in README and four documents) |
| Migrations | core 001–018, anonymous 001–002; digests equal the manifest; none added since Phase 14; `59c99e3` and `b8d1bab` migrations byte-identical (R-2) |
| Deployment manifest | `deploy/processes.json` — six processes, identities and forbidden credentials; unchanged by this checkpoint |
| Checkpoint and security/privacy artifacts read | checkpoint-a … checkpoint-f, security-review (incl. §6), privacy-verification, retention-backup-runbook, incident-runbook, performance-results, release-checklist, final-handoff, decisions P-001 … P-010 |
| Mislabelled completion | **CG-001 found** (§4): the public overview page said the cross-round inference finding "is under independent privacy review". No reviewer has been engaged. Documentation: README still said Checkpoints E and F "have not run" (both passed) — corrected. No document claims production readiness, guaranteed anonymity, an approved production input or a completed independent review. |

## 2. Smoke checks re-run on the candidate

Windows 11 (Snapdragon X Elite), Node 24.13.1, PostgreSQL 18.4 loopback cluster, Chromium via Playwright 1.63.0. Run on the candidate code (`917c3fe` = `ef914d8` + documents). The CG-001 text correction was made while the node suites were running; the browser suite therefore ran with the corrected copy, and §4 records the affected checks re-run afterwards on `e801b9a`.

| Area the prompt names | Check run | Result |
|---|---|---|
| Build integrity | `typecheck`, `lint`, `npm run build`, `check:boundaries`, `test:production`, `npm audit` | all pass; 0 vulnerabilities |
| Authentication / isolation | `test:integration` 8, `test:access` 8, `test:directory` 6, browser `foundation.spec`, `access.spec`, `checkpoint-f.spec` F-10 | pass |
| Survey lifecycle boundaries | `test:campaigns` 18 | pass |
| One-use submission | `test:respondent` 24, `test:checkpoint-c` 21 (100 concurrent finalizations → one) | pass |
| Draft privacy | `test:respondent`, `test:checkpoint-c`, `journey.spec` | pass |
| Anonymous batch recovery | `test:privacy` 17, `test:checkpoint-c`, rollback drill checks 6–8 | pass |
| Suppression incl. exports and recommendations | `test:disclosure` 16, `test:publication` 13, `test:recommendations` 13, `test:checkpoint-d` 18, `test:checkpoint-e` 11 (E-5, E-7) | pass |
| Compatible history | `test:comparison` 13, `test:history` 8 | pass |
| Arabic / mobile completion | `test:localization` 4, `journey.spec`, `localization.spec`, `accessibility.spec` (emulated 320–375 px, axe) | pass |
| Report rendering | `test:reports` 17, `test:checkpoint-e` E-8, `reports.spec`; rehearsal Arabic PDF + English XLSX via the renderer process | pass |
| Visit attachment access | `test:visits` 14, `visits.spec`; rehearsal scanner gating | pass |
| Restored-data consistency | `test:operations` 9, `test:release` 5 (R-3 upgrade, R-4 cross-store), `tests/ops/rollback-drill.ts` **8/8** | pass |
| Production-mode end to end | `tests/release/rehearsal.ts` **13/13** (TLS, TLS-only DB, six process environments) | pass |
| Remaining node suites | `test` 5, `test:instruments` 8, `test:scoring` 15, `test:scoring-db` 5, `test:checkpoint-b` 3 | pass |
| **Totals** | 24 node suites **279 passed, 0 failed**; Playwright **52 passed** (10.3 min) | |
| Candidate matches tested code | `release:manifest --verify` (rc.1) | matches before the correction; after it, refused exactly the two uncommitted files — as designed |

## 3. Prohibited scope

Scanned all 158 application source, script and migration files, the dependency list and the route inventory.

| Prohibited | Result |
|---|---|
| Subscriptions / billing | **Absent.** 16 hits are React `useSyncExternalStore` `subscribe` callbacks; 3 are the word "checkout" in a script comment. No payment dependency. Overview page test asserts no pricing/trial words. |
| Client accounts / dashboards | **Absent.** Roles are `SUPER_ADMIN` and `STAFF` only (CHECK constraint); no registration route; respondents have no account. Hits are the word "register" in "participant register". |
| Cross-company benchmarks | **Absent.** Every hit is a disclaimer ("no benchmarking against other organizations") or the within-organization strengths/risks section; comparisons are same-organization by migration 013. |
| Skip / conditional logic | **Absent.** Hits are skip-to-content links, `FOR UPDATE SKIP LOCKED` and the review screen's jump-to-question. Instrument publication rejects `skipLogic`, `branch` and `conditional` configuration (`test:instruments`, `test:checkpoint-b`). |
| Raw respondent exports | **Absent.** No response/answer export route; the participation export carries names and completion only; anonymous database unreachable from staff credentials (`test:privacy`, `test:checkpoint-c`). |
| AI-dependent recommendations | **Absent.** No model/LLM dependency; rules are bounded numeric trees (`test:recommendations`); hits are disclaimers and "embeddings" in the XLSX active-content rejection list. |

## 4. Defects found and repaired

| ID | Severity | Defect | Repair | Verification |
|---|---|---|---|---|
| CG-001 | High (release-blocking mislabel) | Public overview copy, Arabic and English, stated that the documented cross-round inference (CE-001) "is under independent privacy review". P-001/P-008 are open and no reviewer has seen it, so the product represented a required privacy review as under way. | `src/landing-i18n.ts`: both languages now say an independent privacy review "not yet carried out" is required before any real data collection. `tests/browser/access.spec.ts` asserts the corrected sentence in both languages and that the "under review" wording is absent (D-127). | On `e801b9a`: typecheck, lint, build, `check:boundaries`, `test:production` pass; `access.spec` 4 passed (new assertions included); full browser suite during the gate 52 passed with the corrected copy. Clean clone: §4a. |
| CG-002 | Low (documentation) | README Phase 10/12/13 sections said Checkpoints E and F had not run | Corrected with links to their records | — |
| CG-003 | Low (test harness, open) | In a fresh clone the browser harness cannot write `work/e2e-fixture.json` until `work/` exists (`tests/serve.ts`); the CI workflow already creates it | Not changed in this checkpoint (it would alter the candidate for a harness precondition); run `mkdir work` before `npx playwright test` in a new checkout | clone: first `access.spec` run failed at web-server start, re-run with `work/` present passed |

No other release-blocking regression was found.

### 4a. Release candidate after the correction

| | |
|---|---|
| Release | `orgfit-0.3.0-rc.2` |
| Commit | `e801b9a0a130f94fd53dfd37afeccfc57fdf0fba` |
| Source digest | `19dce1d82642d443976af59642b15bcff4c8a55dee936dff332d1d234f345fba` |
| Lockfile / process manifest SHA-256 (LF) | `fafe87958e58d7634110fbdf93a4a17102cc8e323c4a8c749fe5ad0a1102a121` / `a6a1e4144a1e7ae41495874b628650e6ff01e5d0732f4e6b929526b801e1825b` (the lockfile differs from rc.1 only in its two root version fields; dependencies unchanged) |
| Schema | unchanged: core 001–018, anonymous 001–002 |
| Difference from rc.1 | `src/landing-i18n.ts` (two sentences), `tests/browser/access.spec.ts` (four assertions), version fields |

Genuine clean clone of `e801b9a` into `work/cg-clean` (working directory and HEAD recorded in `work/cg-clean-clone.log`): `npm ci` 0 vulnerabilities; typecheck, lint, build, `check:boundaries`, `test:production` pass; `release:manifest --verify` **matches**; `access.spec` 4 passed (after CG-003); `tests/release/rehearsal.ts` 13/13; `--verify` matches again afterwards.

Not re-run on `e801b9a` itself, because the difference is two sentences of overview copy and their test: the 24 node suites, the rollback drill and the rest of the browser suite (all run on the rc.1 code in §2, the browser suite already with the corrected copy).

## 5. Final acceptance matrix

**VERIFIED** — evidence produced and re-run for this candidate (development environment, synthetic data). **NOT VERIFIED** — the named check has not been performed. **BLOCKED** — a known defect, with owner. Rows that are VERIFIED for implementation but depend on production evidence carry a separate NOT VERIFIED row.

### Binding requirement IDs

| ID | Requirement | Status | Evidence / missing check |
|---|---|---|---|
| ORG-01 | Organization scope for records, queries, jobs, files, reports | VERIFIED | `test:directory`, `test:visits`, `test:reports`, `test:checkpoint-d` "another organization reaches none of it", Checkpoint F F-10 (browser, by id and substituted org), FORCE RLS + runtime-role checks in `test:integration` |
| AUTH-01 | Staff only; no public registration; MFA; revocation | VERIFIED (synthetic IdP) | `foundation.spec` OIDC denials incl. missing MFA; `test:access` (invitation-only, password path off by default); rehearsal: OIDC over https, `__Host-` Secure cookie, revoked session refused |
| AUTH-01 | … with the production identity provider and real MFA factors | NOT VERIFIED | P-005 — no provider chosen |
| PRIV-01 | Separate identity and finalized anonymous boundaries | VERIFIED | `test:privacy`, `test:checkpoint-c` (grants, no mapping, crash recovery), R-4, rollback drill (both stores, mixed points); processor decryption is a declared trust assumption |
| PRIV-01 | … under real key custody with crypto-erasure | NOT VERIFIED | SEC-H1 / P-003 — file custody stand-in |
| PRIV-02 | No role browses raw answers, scorecards or mappings | VERIFIED | `test:checkpoint-c` schema/log/API inspection, `test:checkpoint-d`, `test:checkpoint-e` E-7 (no workbook part hides a value); rehearsal: individual result slicing refused |
| PRIV-03 | ≥ 5 valid contributors per released metric | VERIFIED | `test:checkpoint-d` D-A1, D-A2; `test:disclosure`; `test:checkpoint-e` E-5 (below threshold: no results, no report); rollback drill and rehearsal below-threshold paths unaffected |
| PRIV-04 | Complementary, repeated-release, text/timestamp controls | VERIFIED with accepted exception | D-A3 (10+2), D-A5, D-A6, D-A8; withheld prose/dates. **CE-001** (per-person score derivable from two releases) accepted and declared by the owner under P-009 |
| PRIV-04 | Independent review of CE-001 and the disclosure design | NOT VERIFIED | P-001 / P-008 — required before real data; now stated truthfully in product copy (CG-001) |
| SUR-01 | Random manually shared links; one final use | VERIFIED | `test:checkpoint-c` and `test:respondent` 100 concurrent finalizations → one accepted; rotation/revocation (`test:campaigns`); R-3 and rollback drill: consumed links stay consumed across upgrade and restore; rehearsal over https |
| SUR-02 | One participant, selected set or department targeting | VERIFIED | `test:campaigns` targeting/dedup/frozen roster |
| SUR-03 | Required start, optional end, manual close, no reopen | VERIFIED | `test:campaigns` exact boundary and scheduler outage; `test:checkpoint-c` close race; `campaign_freeze` trigger |
| SUR-04 | Save/resume before immutable finalization | VERIFIED (emulated devices) | `test:respondent` DF1 drafts (original link cannot decrypt), `journey.spec` same/cross-device resume, conflict, lost response |
| BUILD-01 | Builder, templates, required default, all types, no branching | VERIFIED | `test:instruments`, `instruments.spec`, `test:checkpoint-b`; skip/conditional rejection |
| SCORE-01 | Versioned deterministic scoring | VERIFIED | `test:scoring` golden examples, `test:scoring-db`, `test:checkpoint-b` independent recalculation |
| REC-01 | Deterministic recommendations over eligible aggregates | VERIFIED | `test:recommendations`, `test:checkpoint-d` D-A7 … D-A9 |
| HIST-01 | Preserve history; same-org equivalence; no respondent linking | VERIFIED | `test:comparison`, `test:history`, `test:checkpoint-e` E-9, Checkpoint F incompatible version refused |
| REPORT-01 | Arabic/English PDF and Excel under the same privacy policy | VERIFIED | `test:reports`, `test:checkpoint-e` (dashboard/PDF/XLSX agreement, E-7, E-8, E-10), `reports.spec`; rehearsal: renderer process, bucket, encrypted at rest |
| VISIT-01 | Visits, consultants, actions, files, follow-ups, round relation | VERIFIED | `test:visits`, `visits.spec`, Checkpoint F F-8; rehearsal: quarantine until scanner process marks clean |
| VISIT-01 | Malware scanning of attachments | NOT VERIFIED | SEC-H2 / P-010 — content verifier only |
| I18N-01 | Arabic default RTL, English LTR | VERIFIED | `test:localization`, `localization.spec`, `access.spec` (now incl. corrected copy), Arabic PDF (`test:checkpoint-e` E-8), rehearsal Arabic survey at 320 px |
| UX-01 | Mobile survey and accessible web experience | VERIFIED (emulated, automated) | `journey.spec` (320/360/375 px, touch emulation, keyboard, offline, conflicts), `accessibility.spec` axe WCAG 2.0–2.2 A/AA |
| UX-01 | Real mobile browsers, WebKit/Firefox, screen reader, manual keyboard pass | NOT VERIFIED | unavailable on this machine (Phase 13, Checkpoint F) |

### Module acceptance criteria (blueprint §16)

| Module | Status | Evidence / missing check |
|---|---|---|
| Access and isolation | VERIFIED | two organizations with overlapping references (`test:directory`), capability revocation (`foundation.spec`, `test:instruments`), runtime role cannot bypass policy (`test:integration`), O-8 policy rewrite |
| Directory | VERIFIED | duplicates/invalid departments flagged, dry run writes nothing, idempotent concurrent commit, archive preserves snapshots (`test:directory`, E-9) |
| Builder | VERIFIED | all types round-trip, required default, no branching, invalid definitions cannot publish, immutability, copy independence (`test:instruments`, `test:checkpoint-b`) |
| Scoring | VERIFIED | golden fixtures, boundaries, reverse, weighted coverage, matrix weights, direction, invalid denominators (`test:scoring`, `test:checkpoint-b`) |
| Campaign | VERIFIED | target modes, frozen roster, one invitation per participant, no-end campaigns, exact end boundary, close-vs-submit lock (`test:campaigns`, `test:checkpoint-c`) |
| Links/drafts | VERIFIED | rotation/revocation, original link cannot decrypt draft, resume, stale revision conflict, final deletes draft (`test:respondent`, `journey.spec`) |
| Intake | VERIFIED | 100 concurrent finalizations → one payload; before/after-commit failures; dropped success response (`test:checkpoint-c`, `journey.spec`) |
| Privacy processing | VERIFIED | forbidden fields absent; batch retry writes once; crash after output commit resumes (`test:privacy`, `test:checkpoint-c`, rollback drill check 8); sub-five releases nothing |
| Analytics | VERIFIED | n=4/n=5, metric n=4 in campaign of 20, 10+2, sparse bins, homogeneous endpoints (`test:checkpoint-d`) — with CE-001 accepted |
| Recommendations | VERIFIED | edges, unknown/suppressed evidence, conflicts, dedup, AR/EN (`test:recommendations`, `test:checkpoint-d`) |
| History | VERIFIED | incompatible blocked, direction, renames, gaps (`test:comparison`, `test:history`, `test:checkpoint-e`) |
| Reports | VERIFIED | value agreement, no hidden data, RTL rendering, formula injection, unauthorized download denied (`test:reports`, `test:checkpoint-e`, `reports.spec`) |
| Reports — visual inspection of charts on this candidate | NOT VERIFIED in G | last human visual inspection: Checkpoint F (CF-002, CF-004); G re-ran automated render/readback only |
| Visits | VERIFIED | same-org relation, invalid transitions, quarantine/scan/access, follow-up list (`test:visits`, `visits.spec`) |
| Localization/mobile | VERIFIED (emulated) / NOT VERIFIED (real devices, screen reader) | as UX-01 |
| Operations — fresh/upgrade migrations, job recovery, alerts, rollback rehearsal | VERIFIED | rehearsal (fresh over TLS), R-3 upgrade, `test:operations` O-1 … O-8, rollback drill 8/8 |
| Operations — restore timing, measured load | VERIFIED on one developer machine only | Phase 14 drill and load; NOT VERIFIED on provider hardware (P-002, P-004) |
| Operations — key custody/erasure | NOT VERIFIED | SEC-H1 / P-003 |

No line is BLOCKED: no known implementation defect remains open at critical or high severity. SEC-H1 and SEC-H2 are high-severity **production gaps** that depend on owner inputs (P-003, P-010), recorded as NOT VERIFIED rather than as implementation defects, and they block production.

## 6. Remaining owner inputs and approvals

| Input | Reference |
|---|---|
| Accepted privacy threat model and respondent notice | P-001 |
| Independent privacy and security review of protocol, implementation, disclosure and infrastructure, including CE-001 | P-001, P-008 |
| Hosting provider, region/residency, domains/TLS, network separation, staging and production environments | P-002 |
| Separate processor operator and key custodian; managed keys with measured deletion | P-003 |
| Approved retention per class and RPO/RTO; restore measured on the provider | P-004 |
| Production identity provider with MFA; first Super Admin; staff capabilities | P-005 |
| Approved Arabic/English instruments, scoring, bands, rules, equivalences | P-006 |
| Import/contact fields, qualitative output, attachment types/limits, font licences | P-007 |
| Maintained antivirus engine | P-010 |
| Named release owner, operator and on-call; explicit production deployment authorization | P-008 |

Stop. Nothing is to be published, deployed or sent on the strength of this checkpoint.
