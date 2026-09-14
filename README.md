# OrgFit

Internal organizational assessment and consulting platform for OrgFit personnel.

This repository contains the planning baseline, staff foundation, organization directory/imports, questionnaire builder and scoring sandbox. See [foundation setup](docs/orgfit/foundation.md) for authentication and migrations, [instruments](docs/orgfit/instruments.md) for the builder, [scoring](docs/orgfit/scoring.md) for engine contracts, and [phase status](docs/orgfit/phase-status.md) for evidence and remaining gates.

## Start here

1. Read [the master blueprint](docs/orgfit/blueprint.md).
2. Open [the Astra 6 prompt pack](docs/orgfit/implementation-prompts.md).
3. Read the completed phase handoffs before requesting the next phase; preserve their changes.
4. Follow [phase status](docs/orgfit/phase-status.md). Run every checkpoint before its dependent phase.

## Working across sessions

Use this same repository for the whole project. Phases 00–01 can share a session; use a fresh session for each later phase and preferably each checkpoint. In every new session, provide the Project Brief plus the exact phase/checkpoint prompt and have the agent read `AGENTS.md`, the blueprint, decisions, and phase status first. A new session continues the existing code; it does not restart the project.

Run phases sequentially. If a tool creates an isolated checkout, ensure the previous phase's changes are brought into the next phase's checkout before continuing. Do not run dependent phases against an old snapshot of the repository.

## Documents

| File | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | Persistent project instructions for implementation agents. |
| [Blueprint](docs/orgfit/blueprint.md) | Requirements, architecture, schema, privacy, lifecycle, scoring, reports, and acceptance criteria. |
| [Implementation prompts](docs/orgfit/implementation-prompts.md) | 16 phases, seven checkpoints, recovery and scope-change prompts. |
| [Phase status](docs/orgfit/phase-status.md) | Progress, actual test evidence, blockers and next action. |
| [Decisions](docs/orgfit/decisions.md) | Baseline decisions and subsequent architecture decisions. |
| [Checkpoint C](docs/orgfit/checkpoint-c.md) | Privacy and submission-reliability gate: what was attempted, what passed, and what remains unproven. |
| [Publication](docs/orgfit/publication.md) | Safe publication and analytics: the disclosure rules as implemented, where each part runs, and what they do not promise. |
| [Checkpoint D](docs/orgfit/checkpoint-d.md) | Results and recommendation disclosure gate: the reconstruction attempts, the two repairs, and the residual limits. |
| [History](docs/orgfit/history.md) | Series history, measurement equivalence, reviewed comparisons, and the differencing limit they create. |
| [Reports](docs/orgfit/reports.md) | PDF and Excel artifacts: where a report comes from, the renderer credential, what a workbook may not hide, and the separate named participation export. |
| [Field visits](docs/orgfit/visits.md) | Visit lifecycle, follow-up actions, and private attachments: the quarantine, the scanner credential, and what a visit may never name. |
| [Checkpoint E](docs/orgfit/checkpoint-e.md) | History and report consistency gate: what passed, the chart-label repair, and the differencing finding the owner accepted and declared. |
| [Recommendations](docs/orgfit/recommendations.md) | Deterministic rules, the evaluator's UNKNOWN handling, immutable instances and the separate staff action record. |
| [Overview and access](docs/orgfit/landing-and-access.md) | Public overview page, development-only password sign-in, invitation-only activation and the local administrator bootstrap. |

## Product boundaries

OrgFit is internal only: no subscriptions, billing, company accounts, client dashboards, or cross-company benchmarks. Respondents have no accounts. Identity/completion tracking stays separate from finalized anonymous answers. Arabic is the default with RTL; English is secondary. Branding/design direction is supplied separately by the owner.

The blueprint defines the precise privacy trust model and production review gates. Do not equate a five-response threshold with a universal anonymity guarantee.

## Repository status

Local Git repository on `main`. The stack remains Node 24, Next.js 16, PostgreSQL 18 and OIDC. No remote hosting, public publication or deployment is configured. Phase 13 and later modules remain separate requests.

## Directory (Phase 03)

See [directory setup and implemented contract](docs/orgfit/directory.md). Includes organization workspaces, departments, private participants and reviewed CSV/XLSX imports. Imports need their own encryption key and private temporary storage. Run `npm run test:directory` after the foundation database tests. [Checkpoint A](docs/orgfit/checkpoint-a.md) passed before Phase 04.

## Questionnaire builder (Phase 04)

See [instruments](docs/orgfit/instruments.md). Open `/questionnaires` after staff login. Apply migrations, then run `npm run instruments:seed` with the operator migration connection for two illustrative templates. Run `npm run test:instruments` with the dedicated test database. Preview answers are local synthetic state only.

## Scoring (Phase 05)

See [scoring](docs/orgfit/scoring.md). Apply migration 007 for immutable engine pins and additional publication validation. Use Synthetic preview to test scores and boundary inputs. Run `npm run test:scoring` and `npm run test:scoring-db`. No real score collection or staff individual results exist. [Checkpoint B](docs/orgfit/checkpoint-b.md) passed before Phase 06.

## Campaigns and invitation links (Phase 06)

See [campaigns](docs/orgfit/campaigns.md). Apply migration 008, then supply `INVITATION_DIGEST_KEY` and `LINK_EXPORT_ENCRYPTION_KEY`. Open `/organizations/:org/assessments` after staff login. Invitation links are generated manually and revealed once; nothing is sent automatically. Run `npm run test:campaigns`.

## Respondent flow, encrypted drafts and anonymous intake (Phase 07)

See [respondent.md](docs/orgfit/respondent.md), and read its privacy section before describing this module to anyone. Apply migration 009 to the core database and `db/anonymous/001_anonymous.sql` to a **separate** anonymous database, re-apply the idempotent `db/roles.sql`, then generate one custodian key pair per environment and give the staff process only its public half.

Respondents open `/s#<token>` on the survey origin. Drafts are encrypted in the browser with a key OrgFit never receives; the private resume code is the only way to reopen one, and staff cannot recover it. Submission is a single durable transaction that consumes the invitation exactly once. After closure, `npm run privacy:process` moves the campaign into the separate anonymous store, stripping every identity and transport field, or purges it undecrypted when fewer than five people answered.

Run `npm run test:respondent`, `npm run test:privacy` and the browser journey. **[Checkpoint C](docs/orgfit/checkpoint-c.md) passed** after repairing CC-001, which cleared Phase 08 as development work only. Nothing in this module is a proof of anonymity: the privacy processor decrypts accepted answers, and the key custody adapter is a development stand-in with no backup-safe erasure.

## Safe publication and analytics (Phase 08)

See [publication.md](docs/orgfit/publication.md), and read its limits section before describing any result as anonymous. Apply migration 010 to the core database.

After a campaign has been processed, `npm run publication:release` builds one release plan from the anonymous answers and publishes a single immutable snapshot. Staff then read it at `/organizations/:org/results/:round` — overall and dimension scores, a department comparison and safe question analysis. A metric with fewer than five valid contributors, a unanimous metric, a rare option bin or a small department breakdown is withheld with an explanation, and a withheld cell carries no value anywhere in storage or in the API. The only accepted query parameter is `locale`; any other slice is refused.

Run `npm run test:disclosure`, `npm run test:publication` and the results browser journey. Apply migration 012 as well: it serves a released value at the precision it was published with. **[Checkpoint D](docs/orgfit/checkpoint-d.md) passed** — see its residual limits before describing any result as anonymous.

## Deterministic recommendations and actions (Phase 09)

See [recommendations.md](docs/orgfit/recommendations.md). Apply migration 011 to the core database.

Rules are edited on a questionnaire draft under **قواعد التوصيات / Recommendation rules** and freeze when the version publishes; changing one needs a new version. A rule is a bounded tree of numeric comparisons over the overall score and dimensions — there is no expression language and no AI. When a campaign is released, the evaluator turns the approved aggregate cells into immutable recommendations published in the same transaction; staff read them under **التوصيات / Recommendations** and track status, owner, due date, consultant notes and a resolution in a separate record beside each frozen finding.

A suppressed, missing or not-comparable input is UNKNOWN, never zero, and a rule that touches one does not fire at all — so no recommendation, severity badge or counter can stand in for a withheld score. Run `npm run test:recommendations` and `npm run test:publication`. **[Checkpoint D](docs/orgfit/checkpoint-d.md) passed** after repairing CD-001 and CD-002, which cleared Phase 10 as development work. It is an implementation gate, not a proof of anonymity against an adversary with outside knowledge.

## History and assessment comparison (Phase 10)

See [history.md](docs/orgfit/history.md). Apply migration 013 to the core database.

Open **السجل التاريخي / History** from an organization's assessments page. A series lists its rounds chronologically and plots a company trend from published results only — an unreleased round is a gap, and a round whose measurement definition changed is an explicit break rather than a line drawn through it.

Two released rounds can be compared, but only through a recorded review: reading a history needs `results.read`, while declaring that two versions measure the same thing additionally needs `instruments.manage`. The reviewer is shown which metrics still match before deciding; a metric whose scoring changed cannot be accepted as equivalent, and a comparison can always be documented as not comparable instead. Deltas are re-verified against the pinned questionnaire definitions every time they are read, so a stored review can never produce a number the definitions do not support. Withheld values stay gaps, improvement is direction-aware, departments pair by lineage so renames keep their historic labels, and no participant is ever linked across rounds.

Run `npm run test:comparison` and `npm run test:history`. **Checkpoint E has not run**, and it must attack cross-round differencing — comparing releases of populations that changed between rounds is a new surface this phase creates.

## Report artifacts and participation exports (Phase 11)

See [reports.md](docs/orgfit/reports.md). Apply `db/roles.sql` (it adds `orgfit_report`) and then migration 014, supply `REPORT_ENCRYPTION_KEY` and `PARTICIPATION_EXPORT_ENCRYPTION_KEY`, and install a browser build for the renderer with `npx playwright install chromium`.

A staff member with `results.read` and `reports.manage` requests an Arabic or English **PDF** or **XLSX** from a published round, optionally including a reviewed comparison. The request freezes the whole render input on the job and the database re-checks it: no withheld cell may carry a value anywhere in the document, and every released number it quotes must equal the stored cell it claims to come from. A separate worker process — `npm run reports:generate`, running as `orgfit_report`, a role with no table privilege anywhere and no access to the anonymous answer database — renders the frozen source. Retries are idempotent, downloads are private, expire after a day and are re-authorized against current access at download time, and nothing is ever sent anywhere.

The PDF shapes Arabic properly right to left with embedded OFL fonts, keeps its text selectable and searchable, repeats table headers across pages, numbers its pages and reads every colour and size from replaceable theme tokens. The workbook writes released metrics as typed numbers across Summary/Dimensions/Departments/Questions/Recommendations/Round history/Methodology sheets, leaves a withheld cell genuinely empty with its status and reason beside it, and contains no chart, pivot cache, hidden sheet or formula for a value to hide in.

Named participation lists stay a **separate** file: their own path, their own `participation.export` capability, their own key and their own storage prefix. They carry names and completion status and no response identifier, score or result; an assessment report carries no name at all.

Run `npm run test:reports` and `npm run test:checkpoint-e`. **[Checkpoint E](docs/orgfit/checkpoint-e.md) passed as an implementation gate**, with one finding the owner accepted knowingly: an individual contributor's own score is recoverable from two published releases — to 0.01 of a point from a single department row of a reviewed comparison. Under P-009 the owner chose to accept and declare it rather than restrict what a round may publish, so the caveats are the control and were rewritten to state the consequence plainly. A per-person score is therefore derivable from published output **by design**; an independent privacy reviewer must still sign off on that before any real respondent data is collected.

## Field visits and private attachments (Phase 12)

See [visits.md](docs/orgfit/visits.md). Apply `db/roles.sql` (it adds `orgfit_scanner`) and then migration 015, and supply `ATTACHMENT_ENCRYPTION_KEY`.

A staff member with `visits.manage` — and no other capability grants any of this — records a physical visit to an organization: date, timezone, an active assigned consultant, purpose, notes, findings, recommendations, a follow-up date and optionally one same-organization assessment round. The visit moves `DRAFT → SCHEDULED → IN_PROGRESS → COMPLETED`, or is cancelled with a reason from any of those. Both endings are final: a completed visit is **amended** with an explicit reason, which is counted, timestamped and audited separately, and never reopens the visit or moves its original completion time. Follow-up actions carry an owner, a due date and a status, and appear in an internal overdue list. No email, calendar invitation or external integration exists anywhere in this module.

**Visit records are identified consulting material and are kept structurally apart from survey data.** The only assessment relationship a visit may have is a round identifier of the same organization; there is no column in any of the three tables that can name a response, an invitation, a participant, a draft or an anonymous row, and `npm run test:visits` asserts that against the live catalog rather than against a comment.

Attachments are private, bounded and quarantined. An upload mints a **generated** object name, streams the bytes, and lands `QUARANTINED` — not downloadable. A separate process, `npm run attachments:scan`, running as `orgfit_scanner` (no table privilege anywhere, no access to the anonymous answer database, three routines), reads the bytes back and proves what they actually are: PDF, PNG, JPEG, GIF, WEBP, DOCX or XLSX, up to 20 MB, with the declared type and the file extension both required to agree with the content. Executables, HTML and SVG wearing image names, macro-enabled documents, nested archives and the EICAR marker are rejected, and rejected bytes are deleted while the record survives as audit. **A scan that cannot complete blocks the download; it never permits it.** Downloads are re-authorized against current access at the moment they are clicked, served as an attachment under a `sandbox` policy with `nosniff`, and previewed inline only for images and PDFs. `npm run attachments:expire` runs retention.

The bundled scanner is a **content verifier, not an antivirus engine** — magic-byte typing, OOXML part inspection and the EICAR marker. Supplying a maintained engine is production input P-010; attachment types and size limits remain P-007 and the retention window P-004.

Run `npm run test:visits` and `npx playwright test tests/browser/visits.spec.ts`. **Checkpoint F has not run.**

## Overview page, staff sign-in and invitation activation

See [landing-and-access.md](docs/orgfit/landing-and-access.md). Apply migration 016. `/` is now the public overview page and the workspace home is `/workspace`. `/login` offers the identity provider whenever OIDC is configured, and an email/password form **only** where the database's local access switch is on; `/activate#<token>` activates an account from a Super Admin's invitation, whose role and access the invitee cannot change. There is no public registration.

The password path is **development-only**: a password session satisfies no second factor, migration 016 leaves the switch off, and only `scripts/bootstrap-dev-admin.ts` — which refuses production and non-loopback databases — turns it on while creating the local Super Admin from the ignored `.env.bootstrap` (template: `.env.bootstrap.example`). `scripts/provision-dev.ts` creates a persistent local `orgfit_dev` database. Run `npm run test:access` and `npx playwright test tests/browser/access.spec.ts`.

## Localization, mobile and accessibility refinement (Phase 13)

No migration and no API change. The respondent screen now states server facts truthfully (offline, not saved, save conflict, a draft saved from another browser, session ended, campaign closed while answering, submission not confirmed), keeps Back inside the questionnaire, moves focus to each new screen's heading, validates numbers, dates and selections beside the field, and accepts Arabic-Indic digits while sending canonical Latin ones. Staff screens carry a language switch in the app bar, read and show visit and campaign times in the record's own timezone, and report network failures in the reader's language. See D-107 … D-112 in [decisions.md](docs/orgfit/decisions.md).

```bash
npm run test:localization
npx playwright test tests/browser/journey.spec.ts tests/browser/localization.spec.ts tests/browser/accessibility.spec.ts
```

The accessibility spec uses axe-core (dev dependency only). A clean run is not a WCAG conformance claim; no real iOS or Android device and no screen reader have been used. **Checkpoint F has not run.**

## Security, retention, backups and resilience (Phase 14)

Apply migrations **017** (rate limits, retention policy, deletion tombstones, restore gate, alert inputs) and **018** (row-security evaluation that scales), and anonymous migration **002** (whole-campaign retention). Operator jobs: `retention:run`, `tombstones:ship`, `restore:reapply`, `ops:check` — see [retention-backup-runbook.md](docs/orgfit/retention-backup-runbook.md) and [incident-runbook.md](docs/orgfit/incident-runbook.md). New configuration is documented in `.env.example` (rate limits, digest-key rotation) and `.env.operator.example` (ledger, backups, disk).

```bash
npm run test:operations
npx tsx tests/ops/restore-drill.ts   # timed backup/PITR/base-only restore on a throwaway cluster
npx tsx tests/ops/load.ts            # 100k directory, 10k campaign, 200 concurrent respondents
```

Evidence and residual issues: [security-review.md](docs/orgfit/security-review.md), [privacy-verification.md](docs/orgfit/privacy-verification.md), [performance-results.md](docs/orgfit/performance-results.md). **Retention durations are unapproved defaults; recovery figures are from one developer machine; this is not production readiness.**

## Release candidate (Phase 15)

**`orgfit-0.3.0-rc.1` — NO-GO for production.** Start with [final-handoff.md](docs/orgfit/final-handoff.md), then [release-checklist.md](docs/orgfit/release-checklist.md), [deployment-runbook.md](docs/orgfit/deployment-runbook.md) and the [staff operations guide](docs/orgfit/staff-operations-guide.md). No migration. [`deploy/processes.json`](deploy/processes.json) names every process, its database identity and what it must never hold.

```bash
npm run release:preflight -- --process staff --env-file /secure/staff.env --production --check-database
npm run release:manifest -- --id orgfit-0.3.0-rc.1
npm run test:release
npx tsx tests/ops/rollback-drill.ts    # physical restores: no reopened link, no duplicate, no silent loss, no revived expiry
npx tsx tests/release/rehearsal.ts     # after npm run build: production builds behind TLS, TLS-only database
```

The drill and the rehearsal use the embedded Windows PostgreSQL package and Git's OpenSSL (`PG_BIN`, `OPENSSL` override the paths). The rehearsal is a local rehearsal with an S3 test double, **not staging**; no authorized non-production environment exists. **Checkpoint G has not run.**
