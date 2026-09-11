# OrgFit phase status

Updated: 2026-09-10

## Current position

**Phase 12 is COMPLETE as development work.** Phases 00–12 are complete and Checkpoints A, B, C, D and E passed. Field visits, follow-up actions and quarantined private attachments are implemented and tested; see [visits.md](visits.md). Checkpoint E's record remains [checkpoint-e.md](checkpoint-e.md).

**CE-001 is real, accepted and declared — not closed.** An individual contributor's own score is recoverable from two published releases: to within about a point at company level, and **to 0.01 of a point from a single department row of a reviewed comparison**, measured against independently recomputed true scores. The gate returned BLOCKED and escalated it as P-009 rather than choosing a remedy, because every remedy changes what the product may publish. **The owner answered on 2026-09-10: accept and declare.** That made the caveat wording the whole control, so the wording was rewritten to state the consequence instead of reassuring, and a targeted caveat now fires only where two rounds' contributor counts differ by fewer than the threshold (D-086). Nothing else in the gate blocked; CE-002, a chart-label defect found by looking at rendered pages, was repaired.

**This is not production readiness, not a privacy approval and not a proof of anonymity.** A per-person score is derivable from published output by design and with the owner's knowledge, and **an independent privacy reviewer has not yet seen CE-001** — P-008 still requires that before real respondent data is collected. The privacy processor still decrypts every accepted answer for an eligible campaign; that is an explicit trust assumption, not a cryptographic property. The key custody adapter is a local development stand-in with no backup-safe crypto-erasure. The disclosure controls are k-thresholding plus complementary and homogeneity suppression — not differential privacy. Recommendation texts, band names and report wording are synthetic and illustrative. P-001 through P-008 remain unapproved, P-009 is answered, and P-010 is new and open. Uploaded visit attachments are type-verified and heuristically scanned, not scanned by an antivirus engine.

Phase 12 adds a **new** production input: **P-010**, a maintained malware scanning engine for visit attachments. The bundled scanner is a content verifier — magic-byte typing, OOXML part inspection and the EICAR marker — and no deployment may treat its `CLEAN` verdict as a malware guarantee.

Next step: **Phase 13 — localization, mobile, accessibility and complete journey refinement**, as development work only, using its prompt and [visits.md](visits.md), [respondent.md](respondent.md) and [foundation.md](foundation.md). Earlier handoffs remain historical evidence, including the record of the Phase 06 request that was correctly blocked before Checkpoint B ran.

## Sequence and status

| Step | Scope | Status |
|---|---|---|
| 00 | Architecture analysis; no coding | COMPLETE — documentation evidence below |
| 01 | Schema, API and state/privacy contracts; no application coding | COMPLETE — design review and evidence below |
| 02 | Foundation/auth/access/localization infrastructure | COMPLETE — development foundation evidence below |
| 03 | Organizations/departments/participants/import | COMPLETE — evidence below |
| A | Foundation and isolation checkpoint | PASS — checkpoint-a.md |
| 04 | Questionnaire library/builder/versioning | COMPLETE — evidence below |
| 05 | Scoring/interpretation engine | COMPLETE — evidence below |
| B | Instrument/scoring checkpoint | PASS — checkpoint-b.md |
| 06 | Assessment rounds/campaigns/links | COMPLETE — evidence below |
| 07 | Respondent flow/drafts/intake/anonymous processing | COMPLETE — evidence below |
| C | Privacy and concurrency checkpoint | PASS — checkpoint-c.md (implementation gate only) |
| 08 | Safe publication/analytics | COMPLETE — publication.md and evidence below |
| 09 | Rule-based recommendations | COMPLETE — recommendations.md and evidence below |
| D | Results/recommendation disclosure checkpoint | PASS — checkpoint-d.md (implementation gate only) |
| 10 | Historical comparison | COMPLETE — history.md and evidence below |
| 11 | PDF/XLSX reports/exports | COMPLETE — reports.md and evidence below |
| E | History/report consistency checkpoint | PASS — checkpoint-e.md (implementation gate only; CE-001 accepted under P-009) |
| 12 | Field visits/attachments/follow-ups | COMPLETE — visits.md and evidence below |
| 13 | Localization/mobile/accessibility refinement | NOT STARTED |
| F | Full functional journey checkpoint | NOT RUN |
| 14 | Security/retention/backups/resilience | NOT STARTED |
| 15 | Release candidate/production readiness | NOT STARTED |
| G | Final go/no-go checkpoint | NOT RUN |

## Phase 00 handoff — 2026-09-08

- Status: COMPLETE for architecture/requirements analysis, not implementation or production readiness. Phase 01 can proceed; no architecture-analysis blocker remains.
- Artifacts: [architecture-analysis.md](architecture-analysis.md) covers repository reconciliation, supported stack direction, modules/deployment/access, trust/data diagram, transient plaintext exposure, draft/link security, atomic finalization, batch crash recovery, disclosure/history, key/log/backup boundaries, dependency graph and synthetic test plan. [requirements-traceability.md](requirements-traceability.md) maps all 18 binding IDs plus detailed baseline obligations to modules and future gates. [decisions.md](decisions.md) reaffirms D-001–D-011, adds D-012–D-023 and separates P-001–P-008 production inputs.
- Changed files: the two new artifacts above, updated `decisions.md`, and this `phase-status.md`. No migrations, application/UI/business logic, dependency installation, database operations, deployment or external messages/files. AGENTS.md, README.md, blueprint and implementation prompts remain unchanged.
- Repository inspected: local `main` at `95c72fa` (initial documentation commit); no remote configured. Tracked/hidden file inventory found no existing application, lockfiles, schemas/migrations, tests or runtime configuration. The initial commit is not evidence of completed Phase 01 or later work.
- Pending owner work preserved: untracked `OrgFit-Master-Blueprint.md` and `OrgFit-Astra-6-Implementation-Prompts.md`. Blueprint SHA-256 matches canonical document; prompt diff contains only canonical session-continuity additions/heading. Neither file was edited, staged or removed. No commit was created for Phase 00.

### Checks actually executed

| Check | Environment / evidence | Outcome |
|---|---|---|
| Required reading and repository inspection | PowerShell, local repository; AGENTS/README, full blueprint, decisions/status, Project Brief/00; file inventory, Git status/log/remotes and `.gitignore` | Complete; documentation-only baseline, no implementation to preserve or execute |
| Supplied source comparison | SHA-256 of canonical/root documents and read-only prompt diff | Blueprint identical; prompt differences explained above; originals preserved |
| Stack source verification | Official Node release schedule, Next support/install docs, PostgreSQL version policy; maintainer docs for query/queue/OIDC/crypto/report candidates, linked in architecture §2 | Supported core major choices documented; library capabilities checked, no dependency installation/compatibility or security scan claimed |
| Binding-ID coverage | Extract blueprint table IDs including alphanumeric I18N-01; compare traceability rows | 18 unique binding IDs, none missing |
| Documentation integrity | Local Markdown link existence, balanced fenced-block markers, document whitespace checks and `git diff --check` | Passed for the four Phase 00 artifacts; no Mermaid visual rendering test claimed |
| Scope and preservation review | Final Git status/diff plus hashes against original tracked baseline and untracked-source hashes | Only the four authorized documentation artifacts changed; no application or migration files added |

Git emitted a warning that the user's global ignore file was unreadable and line-ending normalization warnings; repository-level inspection and whitespace checks still completed. Initial coverage-check regex excluded the digit in I18N-01; the check was corrected to include alphanumeric prefixes and rerun. No requirement was missing from the document.

### Not run, remaining risks and next dependency

No application build, unit/property/API/browser/database test, migration, load test, report render, backup restore, crypto/security scan or independent review was run. There is no application test suite yet. All A–G checkpoints remain NOT RUN. Documentation review is not a security or privacy test pass.

No implementation regression could be tested because no implementation exists. Main unresolved technical work belongs to Phase 01: physical entity/grant matrix and scoped children; exact crypto format/key distribution/lifecycle; draft expiry for open-ended campaigns; state/closure lock details and cancellation handling; batch/restore reconciliation; joint output-disclosure contract. Exact dependency patches and compatibility tests belong to Phase 02 before installation/foundation completion. These are next-phase obligations, not reasons to label Phase 00 blocked.

Production remains blocked pending P-001–P-008: accepted threat model/notice and independent review; provider/region/domains; separate processor/key custody; approved retention and measured recovery; staff provider/bootstrap; approved real instruments/translations/scoring/rules; import/contact/content/file policy; and actual release evidence plus explicit deployment authorization. The design does not guarantee anonymity against malicious processors/infrastructure or all inference from background knowledge.

For Phase 01, read AGENTS.md, README.md, blueprint, decisions, this status, both Phase 00 artifacts, and Project Brief/Phase 01. Deliver `data-model.md`, `proposed-schema.sql` (design draft only), `api-contracts.md`, `state-machines.md`, and `privacy-protocol.md` as requested there. Do not implement application code or run migrations. Phase 02 readiness must be assessed by that design review, not inferred from this handoff.

## Phase 01 handoff — 2026-09-08

- Status: COMPLETE, design only. [Data-model review](data-model.md) concludes Phase 02 can proceed when requested, with no unresolved product contradiction blocking foundation. Production is not ready or authorized.
- New files: `data-model.md`, `proposed-schema.md` (the equivalent schema draft allowed by the prompt; no executable SQL), `api-contracts.md`, `state-machines.md`, `privacy-protocol.md`.
- Updated files: `decisions.md` (D-024–D-033 and unchanged production input gates), `requirements-traceability.md` (Phase 01 evidence), and this status. Previous Phase 00 analysis, blueprint, instructions, README, prompt pack and both root owner files preserved. No migration, runtime code, install, database execution, external sharing, commit or deployment.
- Repository before editing: same documentation-only `main` baseline; prior Phase 00 uncommitted artifacts present. Inspected instructions, README, full blueprint, Project Brief/Phase 01, Phase 00 architecture/traceability/decisions/status, hidden file inventory and pending changes. No lockfiles, tests or database/migration implementation existed.
- Design: all blueprint entities with explicit fields/nullability/keys/checks/indexes/retention; global/org instrument scope; actual proposed service-role names/access matrix; no response-to-identity relationship; typed staff/public endpoints/errors/revisions; campaign-before-invitation lock and final database-clock check; browser-secret drafts; one local accepted ciphertext/completion transaction; full-batch atomic marker and cleanup/recovery; conservative R1 safe snapshot release; immutable history and separate private exports.

### Checks actually executed in Phase 01

| Check | Evidence / outcome |
|---|---|
| Blueprint entity coverage | Static extraction of blueprint §5.2–5.5: 46 named entities; all 46 represented in proposed schema, none missing. This checks coverage, not PostgreSQL validity. |
| Documentation links/fences/whitespace | PowerShell read-only checks on all five new documents and updated planning artifacts; local Markdown links resolve, fenced-block markers balanced, no trailing whitespace. `git diff --check` passed for tracked changes. |
| Anonymous field review | Static scan of anonymous response/answer/score table specifications and A base for forbidden identity, session, envelope and generic audit fields; none in column declarations. Relationship review found no output-to-identity FK. Runtime schema/log verification NOT RUN. |
| Design consistency review | Reviewed key tuples and ownership, transition/API correspondence, closure linearization, repeated acceptance, original-link vs secret, complete-batch crash cases, 10+2/sparse/homogeneous/algebra expected outcomes. Review refinements: global mutation receipt, archive terminal metadata, report-generation numbering, encrypted bulk export transaction and decoded payload limit explicitly specified. No executable race/disclosure test claimed. |
| Official technical references | PostgreSQL 18 locking, RLS, constraints and clock functions; Web Crypto and libsodium sealed boxes consulted and linked in artifacts. No new stack/version change or dependencies installed. |
| Preservation/scope | Final status/diff and source hashes checked; only five new design documents plus decisions/traceability/status changed by this phase. Existing uncommitted Phase 00/root owner files preserved. |

Not run: SQL parsing/execution, fresh/upgrade migrations, real database grants/RLS/locks, crypto known-answer/tamper tests, API/browser/build/unit suites, concurrency/failure/load tests, report rendering, backup/key deletion/restore or independent privacy/security review. The schema is explicitly a relational design draft, not a tested migration. All A–G checkpoints remain NOT RUN. Git global-ignore permission and line-ending warnings persisted without blocking repository/documentation checks.

No implementation regression exists to assess because application behavior remains absent. The review fixed documentation-level omissions within the new design. Remaining risks: per-campaign exclusive acceptance lock throughput; actual cryptographic wrapper/nonce behavior; provider-specific key deletion/recovery windows may delay publication; R1 may suppress broadly and needs adversarial implementation proof; real auth/session/RLS/download revocation and restore consistency are unverified. These are assigned implementation/release obligations, not silently passed checks.

P-001–P-008 remain open: accepted threat model/notice and independent review, hosting/region, isolated processor/key custody, approved retention/recovery, staff provider/bootstrap, real approved content/translations/scoring/rules, import/contact/content/file policies, and actual release evidence/deployment authorization. Development defaults, including new TTLs, are not production approval. No stronger anonymity guarantee is claimed.

Next request: Phase 02 only. Read AGENTS.md, blueprint, Project Brief/02, decisions/status, Phase 00 analysis and all five Phase 01 artifacts (start with data-model review). Verify current supported exact dependencies before installing; implement only foundation/auth/access/localization and supporting infrastructure, with real PostgreSQL tests appropriate to that scope. Do not implement campaigns, scoring, surveys, analytics or visits merely because their contracts are now specified. No automatic Phase 02 start.

## Phase 02 handoff — 2026-09-08

- Status: **COMPLETE for the requested minimal development foundation**. No later business module or deployment started. See [foundation.md](foundation.md) for setup, exact implemented routes, boundary decisions and deliberately unimplemented endpoint/module scope.
- Behavior: pre-provisioned OIDC staff login with PKCE/state/nonce, issuer/audience/signature/expiry/authentication-age and configured MFA ACR checks; separate auth/staff DB credentials; opaque revocable sessions with idle/absolute expiry; Super Admin/Staff capabilities and assignments; database-enforced scoped organization reads; guarded admin access writes/idempotency/revision checks; safe first-admin bootstrap; append-only allowlisted audit; own locale persistence; protected shell; separate credential-free respondent entry build; safe errors/input/env checks; nonce CSP, CSRF/origin controls and coarse health/readiness.
- Localization: Arabic default RTL, complete English staff catalog, root lang/dir, logical CSS, mixed-language identifier boundaries, neutral replaceable theme tokens and keyboard-focus/44px shared controls. No branding assets, design prompt, survey or questionnaire content created. Controls wait for hydration before becoming interactive.
- Migrations: `db/roles.sql` provisions distinct roles only in a dedicated cluster; `db/migrations/001_foundation.sql` creates staff/capability/assignment/session/OIDC-state/global-mutation receipt/organization/audit tables and guarded routines; `002_revocation_guards.sql` adds DB-level epoch/revocation triggers. NOLOGIN owner/executor, runtime nonowner/NOBYPASSRLS and FORCE RLS verified. No existing database was reset/dropped and no destructive migration was used. Synthetic databases are retained under ignored local test infrastructure.
- The temporary PostgreSQL process was stopped after checks; retained synthetic files were not deleted.
- Changed/new root files: `.gitignore`, `.gitattributes` (stable SQL line endings for migration checksums), `README.md`, `.env.example`, `.env.operator.example`, `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `playwright.config.ts`, `.github/workflows/ci.yml`.
- New application/shared files: `apps/staff/{package.json,tsconfig.json,next.config.ts,next-env.d.ts,proxy.ts,AGENTS.md,CLAUDE.md}`, staff `app/{layout.tsx,page.tsx,ui.tsx,login/page.tsx,api/v1/[...path]/route.ts,health/[kind]/route.ts}`; `apps/respondent/{package.json,tsconfig.json,next.config.ts,next-env.d.ts,proxy.ts}` and respondent `app/{layout.tsx,page.tsx,s/page.tsx,health/live/route.ts}`. Next dev generated the scoped agent guidance; it was read and preserved. Shared `src/{auth,config,csp,db,http,i18n,security}.ts` and `src/theme.css`.
- New scripts/tests: `scripts/{bootstrap,migrate,seed,check-boundaries}.ts`, `scripts/local-postgres.ps1`; `tests/{database,integration.test,unit.test,oidc-provider,serve,production-smoke}.ts` and `tests/browser/foundation.spec.ts`.
- Planning updates: new `foundation.md`, updated `decisions.md` (D-034–D-037), `requirements-traceability.md` Phase 02 evidence and this status. Prior Phase 00/01 artifacts, baseline blueprint/prompt pack, root AGENTS and both owner-supplied root documents preserved. No commit, remote publication, external communication or deployment performed.

### Checks actually executed in Phase 02

Environment: Windows ARM64 host, Node 24.13.1/npm 11.8.0; PostgreSQL **18.4 native x64** test process on loopback (downloaded test-only package; not SQLite/PGlite/mocked policies); Chromium 153.0.8010.12 through Playwright 1.63.0. PostgreSQL 18.6 is configured for future CI but was NOT the local test version.

| Check | Actual outcome |
|---|---|
| Repository/required reading and continuity | Prior uncommitted Phase 00–01/root-owner work inspected and preserved; no pre-existing runtime, schema, lockfile or tests to overwrite. Foundation-only scope followed. |
| Exact dependency/peer/license inspection | npm metadata, installed package manifests and official stack/security documentation consulted. Runtime dependencies MIT; TypeScript/Playwright Apache-2.0; remaining direct development packages MIT. TypeScript/ESLint compatibility corrections described below. |
| Clean install | `npm ci` succeeded from pinned lockfile: 171 packages installed, 174 audited, zero reported vulnerabilities. No unsupported direct peer combination remains. |
| Type/lint | `npm run typecheck` and `npm run lint` pass after final code/test edits, no warnings/errors. |
| Unit tests | `npm test`: **5 passed**, covering Arabic/default/complete English catalogs, direction, missing/unsafe env, privileged credential/origin rejection, MFA allowlist, malformed session, origin/JSON/body limits, unknown fields and nonleaking errors. |
| Real PostgreSQL | `npm run test:integration`: **8 reported tests passed** (including parent test), final run 14.6s. Fresh migration 001, populated 001→002 upgrade, re-run preservation; runtime role/FORCE-RLS/write denials; staff/auth denied CONNECT to an empty isolated anonymous test DB; anonymous/malformed/disabled/session-expiry denial; org substitution, capabilities, pool context; one-use OIDC state; idempotent access changes, revocation, disable/re-enable nonresurrection, last-admin protection; first-admin bootstrap and second-bootstrap refusal. |
| Production builds | `npm run build`: both independent Next 16.3.4 webpack builds pass; staff pages/API and respondent-only entry routes enumerated. No survey or anonymous processor bundle exists. |
| Compiled dependency boundary | `npm run check:boundaries` passes: respondent server build traces exclude pg, Kysely, openid-client and shared staff auth/DB source. This is build evidence, not deployed network/key isolation. |
| Missing-env production smoke | `npm run test:production` passes against local production build: liveness works; missing configuration readiness is generic 503; Arabic login fallback exposes no config/SQL and offers no login link; nonce CSP has no unsafe-inline/eval. |
| Browser OIDC/security/localization | Final `npm run test:e2e`: **12 passed**, 53.4s. Real HTTP discovery/JWKS/signed-token exchange through openid-client and PostgreSQL; anonymous route/public-build API denial; success + scoped org shell; AR↔EN persistence/reload; CSRF; staff admin denial; health/security headers; logout replay denial; unknown/disabled identities; missing MFA, bad state/nonce/audience/issuer/signature, expired ID token; disable existing session. |
| Responsive visual inspection | AR/EN 320px full-page captures under ignored `work/` visually inspected; no page-wide overflow. Shared labels/focus/logical layout reviewed. This is not full WCAG/mobile-device certification. |
| Dependency audit / basic source scan | `npm audit --audit-level=high` reports zero vulnerabilities; clean install also audits zero. Basic private-key/token-pattern scan of new source/config returns no matches. This is not independent SAST or exhaustive secret scanning. |
| Preservation/whitespace | `git diff --check` passes. Owner root blueprint SHA-256 still matches canonical blueprint. Git continues warning that the global ignore file is unreadable; repo ignore/status/checks work. |

### Defects encountered and verified fixes

- Sandbox blocked registry access and Node/tsx user-info execution; reran necessary installs/tests with approved local execution permissions. Docker engine was unavailable; used a dedicated native PostgreSQL test cluster, not a simulated database. Initial PowerShell initdb password-file argument was malformed and fixed before successful initialization.
- TypeScript 7 was incompatible with the selected parser's supported peer range; pinned TypeScript 6.0.3. Legacy Next lint preset plugins did not support ESLint 10; replaced the preset with compatible direct TypeScript/Next lint plugins. Clean install/type/lint/build now pass without those peer warnings.
- Initial browser negative fixtures attempted to alter redirected authorization requests and did not exercise intended scenarios. Replaced them with explicit synthetic IdP form choices; all nine negative identity/token scenarios now execute and pass. No authentication bypass was added to app code.
- Initial locale interaction could occur before client hydration. Controls now remain disabled until interactive; persisted switching passes in both directions. Removed local Next dev indicator from the shell; no branding change.
- Added DB revocation guards so direct trusted membership repairs cannot resurrect old sessions. Added explicit JWS verification and auth-time validation rather than relying only on token-endpoint transport. Tampered/expired-token and disable/re-enable checks pass.

### Unrun checks, remaining scope and next step

No known failing foundation check remains. This phase does **not** establish production readiness. Not run: remote CI/Linux/PostgreSQL 18.6 execution; real external OIDC provider/MFA/TLS integration; actual deployed origin/network isolation or infrastructure log review; real Safari/iOS/Android, 200% zoom, screen-reader audit or full WCAG 2.2 AA; load/backup/restore/key deletion/retention exercises; independent security/privacy review; any A–G checkpoint. No claims about anonymous response processing or reports can follow from these foundation tests.

P-001–P-008 remain open. Foundation lists are bounded previews (100); full cursor pagination, organization CRUD/departments/participants/imports and concrete scoped queue/private-storage adapters belong to Phase 03. Staff administration is API-based; dedicated staff editor/revoke HTTP route and full future API inventory are not claimed complete. Scope details and own-locale metadata exception are explicit in foundation.md. No fake storage/queue implementation substitutes for future real behavior.

Next: **Phase 03 only on request**, reading AGENTS, blueprint, Project Brief/03, decisions/status, foundation.md and current migrations/helpers. Preserve this code and use `withStaff`/`requireAccess` plus scoped database enforcement for directory/import work. After Phase 03, stop for Checkpoint A; do not start Phase 04 automatically. No commit/release identifier exists for Phase 02.

## Phase 03 handoff — 2026-09-08–09

- Status: **COMPLETE for Phase 03 development scope**. The temporary PostgreSQL server was stopped after tests; retained synthetic databases were preserved.
- Scope: organization list/create/edit/archive and internal workspaces; department hierarchy and archive; private participant CRUD/archive; reviewed CSV/XLSX import. No campaigns, questionnaires, surveys, scores, raw answers, report exports or visits. Checkpoint A is NOT RUN and Phase 04 is NOT STARTED.
- Implemented screens and API contract: [directory.md](directory.md). Arabic-first forms and English translations, organization-specific navigation, filtering/cursor pagination, parent/department selection, private participant details and future invitation-status placeholder, upload/mapping/preview/errors/confirmation/commit and review recovery after refresh. Archived organizations are omitted from home shortcuts and active lists; archived records remain readable through their workspace and archive filters.
- Isolation/history: current assignments/capabilities on every directory/import/error-download operation; FORCE RLS and runtime direct-write denials; scoped department/participant/import foreign keys; organization-level serialization, cycle checks, optimistic revisions and idempotent writes; archived identifiers/references retained. Active dependants block department archive. No frozen historical campaign data exists to rewrite.
- Imports: strict UTF-8 CSV or single-sheet XLSX, explicit 1 MiB/500-row/30-column bounds, bounded ZIP expansion, formula/active-content rejection, encrypted private source, field mapping, all-occurrences duplicate rejection, own-organization department lookup, no dry-run directory mutation, explicit valid-subset commit, exact review revalidation under organization lock, atomic participant/receipt/state writes, safe error-only CSV attachment and 24-hour source access expiry. Local expiry cleanup and private S3 adapter exist. No deployed S3 or background import queue is claimed.
- D-038 explicitly changes the proposed split upload/202 asynchronous validation transport to bounded synchronous requests. D-015 remains the direction for future asynchronous modules. The Phase 01 design has an implementation note pointing to the actual contract. This is a development implementation choice, not approval for real directories or production.
- Migrations: `003_directory.sql` adds department, participant and import metadata tables/keys/indexes/FORCE-RLS policies, directory/import guards and sanitized audit expansion. `004_import_receipts.sql` adds organization/actor-scoped commit-key receipts. Applied only to retained synthetic PostgreSQL databases. Existing 001/002 files were not edited. No database reset/drop or destructive data migration.
- New files: `src/directory-input.ts`, `src/directory.ts`, `src/directory-i18n.ts`, `src/import-parser.ts`, `src/import-storage.ts`, `src/imports.ts`; `apps/staff/app/organizations/directory-ui.tsx`, `apps/staff/app/organizations/[[...path]]/page.tsx`; `tests/directory.test.ts`, `tests/browser/directory.spec.ts`; `scripts/expire-imports.ts`; both migrations; `docs/orgfit/directory.md`.
- Updated files: staff home and catch-all API; `src/db.ts` readiness, `src/http.ts` safe errors, `src/theme.css`; dependency manifests/lockfile, `.env.example`, CI; `tests/serve.ts`, foundation migration-count expectation; respondent dependency-boundary check; README, API implementation note, decisions, traceability and this handoff.
- Prior uncommitted Phase 00–02 work and root owner blueprint/prompt copies were preserved. No commit, remote publication, deployment, external message/file transfer or new branding. No release identifier exists.

### Checks actually executed in Phase 03

Local environment: Windows ARM64, Node 24.13.1, npm 11.8.0, PostgreSQL 18.4 native x64 on loopback, Playwright 1.63.0/Chromium. Execution crossed midnight in Asia/Riyadh. No remote CI or production environment was used.

| Check | Actual result |
|---|---|
| Required reading/continuity | Blueprint, decisions/status, Phase 03 and Checkpoint A boundary, Phase 02 handoff/foundation, schema/API/state contracts, current source/tests/migrations/lockfile and pending changes inspected. Scoped Next instructions and bundled page/route documentation read. Existing foundation retained. |
| Clean installation and advisory scan | `npm ci` succeeded: 296 installed, 299 audited, zero known vulnerabilities. Initial ExcelJS transitive UUID advisory removed with pinned compatible 11.1.1 override; XLSX fixture passed. Upstream deprecation warnings remain and are not hidden. |
| Type/lint | `npm run typecheck`, `npm run lint` passed. Full-document navigation is intentional to clear organization state and has a narrow documented Next anchor-rule exception. |
| Foundation unit suite | `npm test`: 5 passed. Safe input/env/MFA/localization/error regression coverage retained. |
| Real PostgreSQL foundation regression | `npm run test:integration`: 8 reported tests passed, including parent; final 13.1s. Retained synthetic populated migration upgrades through 004, migration rerun preservation, runtime role/auth/RLS denials, sessions, revocation, bootstrap and last-admin protections. |
| Directory/import tests | Final `npm run test:directory`: 6 reported tests passed, including parent; 25.5s including process lifecycle. CSV/XLSX parsing and full import commits, malformed/formula/over-limit rejection, duplicate/department validation, two organizations with same private reference, cross-org read/write/download denials, capabilities, direct runtime write/auth-role/FK denials, scoped cursor continuity, stale writes/replay conflicts, tree cycles, archive preservation, ciphertext/tamper, dry-run counts, concurrent same-key commits exactly once, changed-key request conflicts, newly conflicting commit rejection, expiry and local source cleanup. |
| Browser suite | Final full `npm run test:e2e`: 15 passed, 1.3 minutes. Organization creation/settings/archive; department and participant Arabic forms; CSV map/review/reload/confirm/commit; English detail/editor; 320px RTL/LTR overflow checks; every implemented resource family under foreign-org HTTP substitution and CSRF/missing preconditions; all 12 earlier foundation scenarios. |
| Visual checks | Inspected `work/directory-ar-320.png`, `work/directory-en-320.png` and desktop import capture; corrected selected department display from UUID to readable name. Final English mobile and Arabic desktop captures reinspected. No real mobile-device, screen-reader or 200% zoom test claimed. |
| Production builds | Both Next applications built successfully; staff includes the organization catch-all page/API, respondent still only its entry routes. Final archive-home adjustment also passed an additional staff build. |
| Compiled boundary | `npm run check:boundaries` passed; now also rejects directory/import/S3/CSV/XLSX dependencies in respondent traces. This does not prove deployed network isolation. |
| Production smoke | `npm run test:production` passed: missing environment fails safely, Arabic fallback, generic readiness failure, strict CSP. No configured production IdP/storage smoke claimed. |
| Repository hygiene | `git diff --check` passed; only known global-ignore/line-ending warnings. Original owner files/blueprint/prompt pack preserved. No destructive cleanup. |

### Defects found and repaired

- Migration routine ownership initially lacked the temporary schema CREATE grant; corrected before 003 was applied successfully. Runtime still has no schema CREATE grant.
- Foundation migration-count expectation was two; updated to four after actual forward migrations. No old migration or test data was discarded to pass checks.
- Shared input code imported a Node-only security helper into the browser graph; changed the browser-safe UUID schema to use Zod directly. Builds and browser journey pass.
- Upload form could be used before hydration; directory controls now render only when interactive. Initial uploaded metadata also contained an empty validation object; the UI now renders the review section only in VALIDATED state. Full upload/reload/commit journey passes.
- Added commit request receipts in forward migration 004; same-key changed requests now conflict, while concurrent valid commits insert once.
- Reviewed relation fields now show names rather than raw UUIDs. Added readiness checks for the directory schema and archive filtering for home shortcuts.

### Remaining boundaries and next step

No known failing executed Phase 03 check remains. This is a development implementation, not production readiness. Imports are synchronous and reject files above the documented bounds; no background import jobs, generic import worker, antivirus service, 100,000-participant load proof or distributed-storage failure test is claimed. Local physical expiration is exercised by the cleanup function; running cleanup periodically without traffic is an operator requirement. Private S3 calls are implemented but no live bucket, credentials, IAM, version lifecycle or expiry enforcement was exercised. No real personal data was imported.

P-001–P-008 remain open: actual staff/MFA provider, cloud/region and network boundaries, import key custody/rotation/backup/retention, approved contacts/import policy, real instruments, independent privacy/security review, device/accessibility/load/restore and explicit deployment authorization. No anonymous pipeline exists in this phase. Preserving directory rows is not evidence of future frozen campaign/history behavior.

Next: request **Checkpoint A**. Read this handoff, directory.md, foundation.md, D-038–D-041 and current migrations/source. Independently trace authorization and test every actual scoped route/storage access and fresh/upgrade schema. Include the bounded synchronous import variation and deployment gaps in the review; do not assume a background worker exists. Stop before Phase 04 until A passes. No A–G checkpoint was marked passed by this phase.

## Phase 04 handoff — 2026-09-09

Status: **COMPLETE for Phase 04 development scope.** Final full regression passed. Checkpoint A was independently executed first and passed; see [checkpoint-a.md](checkpoint-a.md). Phase 05 has not started.

- Implemented global/organization questionnaire library, blank creation, two illustrative built-in templates and custom copies, draft autosave/manual save, required-by-default questions, all twelve collection/content types, sections/options/fixed matrices, keyboard ordering/duplication, AR/EN definitions and synthetic preview, declarative dimension/item/row/overall configuration and bands, immutable publish, retirement, new-version copies and archive. No scoring computation, invitations, real collection, recommendations or raw-answer access.
- New migrations: `005_instruments.sql` (relational topology, scope/version FKs, FORCE RLS, guards, immutable children/versions, receipts/audit), `006_instrument_validation.sql` (SQL publication validation). Existing 001–004 preserved. Migrations applied only to retained synthetic PostgreSQL databases; no reset/drop or deployment.
- New code: `src/instrument-input.ts`, `instrument-records.ts`, `instrument-templates.ts`, `instruments.ts`; `apps/staff/app/questionnaires/[[...path]]/page.tsx`, `workspace.tsx`, `editors.tsx`, `preview.tsx`; `scripts/seed-instruments.ts`; `tests/instruments.test.ts`, `tests/browser/instruments.spec.ts`.
- Updated code/config: staff home/API, shared theme/readiness, `scripts/check-boundaries.ts`, `tests/database.ts`, foundation migration count, package scripts and CI. Exact dependencies/lockfile unchanged; no dependency installation required.
- Documentation: checkpoint-a.md, instruments.md, README, API/proposed-schema/traceability implementation notes, decisions D-042–D-044, and this handoff. Existing prior-phase uncommitted work and owner root source documents retained. No commit/publication/release identifier, external messages or deployment.

### Executed checks

Environment: Windows ARM64, Node 24.13.1, native PostgreSQL 18.4 loopback synthetic cluster, Playwright 1.63.0 Chromium. Reviewed local process escalation was required because Windows sandbox process startup failed for PostgreSQL/tsx. No approval rejection remains.

| Check | Actual evidence |
|---|---|
| Required reading / continuity | Blueprint, status/decisions, Phase 04 and Checkpoint A, prior handoffs, actual schema/source/tests/lockfile, scoped Next instructions and bundled page/route docs inspected |
| Type/lint | Both passed after implementation and final test additions |
| Foundation unit | 5 passed |
| Foundation PostgreSQL regression | 8 passed; fresh/seeded migration path through 006, rerun preservation, runtime/auth/session/revocation checks |
| Directory regression | 6 passed; previous scoped directory/import/archive/expiry behaviors preserved |
| Instruments | 8 reported tests passed including parent; all-type round trips/defaults/optional content, copy keys/new IDs, validation negatives, organization/global access, capability/session revocation, runtime DML/auth denials, scoped FKs, concurrent writes/replay, publish/retire/hash preservation, copied versions, matrix weights/dimensions/overall/bands, direct malformed SQL publication denial |
| Populated upgrade | Instrument suite starts at 004, inserts a department, applies 005/006, seeds/reruns; original department preserved. Fresh all-migration path also exercised |
| Browser regression | Final full suite: **19 passed (1.8m)**, including all 15 prior journeys and four Phase 04 journeys: blank creation/required/optional/keyboard order/autosave/publish/new-version; all-type bilingual preview with no answer posts/stale writes/translation failures; built-in clone; English dimension/band/reverse configuration edits and persistence |
| Build | Both production Next builds passed; staff questionnaire route present, respondent still entry-only |
| Compiled boundary | Passed; instrument service/record/template code also excluded from respondent traces |
| Production smoke | Passed; missing environment fails safely with generic readiness, Arabic fallback and strict CSP |
| Visual inspection | Inspected `work/instrument-editor-ar-320.png`, `instrument-preview-en-320.png`, `instrument-preview-ar-desktop.png`, and `instrument-dimensions-en-320.png`. Arabic/English and 320px layout checks passed. No clipping observed; no real-device or screen-reader claim |
| Repository hygiene | git diff --check passed; known global-ignore/line-ending warnings only |

### Repairs and limits

During implementation fixed a malformed TypeScript cast, missing JSX closing tag and an unknown SQL-result spread type; type/lint/build pass. Test setup initially granted a capability after issuing a session, correctly revoking it; fixed setup order and asserted session revocation plus denial after renewed login. Browser fixture reused a mutation key for a different operation and correctly conflicted; fixed per-operation test keys. A select locator mismatch was corrected to its accessible combobox role. Targeted reruns passed. Added database publication checks and canonical fingerprints before final verification; no earlier migration was rewritten.

No production readiness claim. Templates/content/notices are illustrative and require P-006/P-001 approval. Actual scoring/boundary computation and engine version pinning are Phase 05, recommendations Phase 09. No real devices, screen reader, 200% zoom, load, deployed provider/storage/network controls, independent security/privacy review or backup restore was executed. All production inputs P-001–P-008 remain open. Version summaries are bounded to 100; instrument writes are conservatively serialized and not load-tested. No later checkpoint is marked passed.

Next request: Phase 05 only. Read instruments.md, strict definition schema, node mapping, migrations 005/006 and new tests; implement the pure versioned engine and numeric sandbox compatibly without changing published definitions.

The temporary PostgreSQL test process was stopped after verification; retained synthetic databases/files were not deleted.

## Phase 05 handoff — 2026-09-09

- Status: COMPLETE for Phase 05 development scope. Engine 1.0.0 and local scoring sandbox are implemented and verified within Phase 05 only. Checkpoint B is NOT RUN; Phase 06 has not started.
- Behavior: pure deterministic rational scoring, reverse-before-normalization, equal/weighted means, full-input bounded sums and explicit fixed Yes-count percentages, item/row weighted coverage, explicit overall orientation, continuous half-open bands with inclusive final endpoint, exact classification before half-up display, engine/config version metadata and missing/unscored states. No invented overall or real analytics.
- Sandbox: existing Arabic/English preview now calculates synthetic answers locally, offers lowest/highest input fixtures, and shows coverage, raw values, direction, precise band context and version. No answer requests/storage; reload clears state and preview does not mutate the saved version.
- Migration: `007_scoring_engine.sql` adds immutable engine pins without changing published metadata/hash and adds SQL publication checks for decimal configuration, attainable bounds, nonweighted-mode weight coherence and matching raw SUM bounds. Migrations 001–006 remain untouched. Only newly created synthetic test databases were migrated; no database reset/drop, destructive migration or deployment.
- New implementation files: `src/{score-number,scoring-bounds,scoring,scoring-synthetic}.ts`, `apps/staff/app/questionnaires/scoring-sandbox.tsx`; updated `src/{instrument-input,instruments}.ts` and existing preview/workspace. New tests: `tests/{scoring-fixtures,scoring.test,scoring-database.test}.ts` and `tests/browser/scoring.spec.ts`; updated the foundation migration-count assertion in `tests/integration.test.ts`. `package.json` and CI now run the new suites; no dependency or lockfile change.
- Documentation: new `scoring.md`; synchronized README, instruments, decisions D-045–D-047, traceability and this status. Previous uncommitted phases, owner root source documents and unrelated modules preserved. No commit, remote publication, external messages/files or deployment.

### Checks actually executed in Phase 05

Environment: Windows ARM64, Node 24.13.1, retained loopback PostgreSQL 18.4 x64, Playwright Chromium. Tests use synthetic data only. The Windows sandbox prevented the initial tsx run from resolving OS user information (`uv_os_get_passwd` ENOMEM); approved execution outside that sandbox succeeded.

| Check | Actual outcome |
|---|---|
| Required reading / continuity | Blueprint/scoring spec, decisions/status, Phase 05 and Checkpoint B prompts, Phase 04 handoff/schema/mapping/migrations/tests, package/lockfile, pending changes and scoped Next client-component instructions inspected. Existing stack retained |
| Type/lint | Passed after final engine/configuration changes |
| Pure scoring | 14 passed: all seven blueprint examples; reverse involution/endpoints; 80%/60% and weighted missing coverage; all-input policies; matrix weights; signed checkbox subsets/selected percentages; invalid denominators, formulas, versions, scales/directions, precision and answer types; exact bands and decimal half-up; deterministic nonmutation/weight scaling; 200 heterogeneous items with large exact fractions |
| Scoring PostgreSQL | 5 reported tests passed including parent: populated 006→007 upgrade and rerun preserve published metadata/hash; engine pin and child immutability; persisted golden score; direct malformed SQL publication denial; SQL/pure signed checkbox bound agreement |
| Instrument regression | 8 passed: all-type persistence, scope/FKs/capability/RLS, receipt/concurrency, publish/retire/copy/translation/hash invariants and direct malformed publication denial; fresh and earlier populated upgrade paths include 007 |
| Foundation regression | 8 PostgreSQL and 5 unit tests passed. Initial migration-ledger assertion expected 6; updated it for the seventh migration and reran successfully |
| Browser regression | Full suite 20 passed (1.7m). Initial new test inherited a prior test's English staff preference; explicit Arabic setup fixed it. Targeted sandbox reruns passed after decimal endpoint/config validation and final numeric bidi refinements; final run 1 passed (19.0s) |
| Build / compiled boundary / production smoke | Both independent production builds passed. Staff build reran successfully after the final bidi edit. Compiled respondent dependency boundary and production missing-env/Arabic fallback/CSP smoke both passed again on the final build |
| Visual | Inspected final `work/scoring-ar-320.png` and `work/scoring-en-desktop.png`; no clipping. Fixed the observed Arabic fraction-order issue with explicit LTR isolation and confirmed the final score and inclusive band render correctly. Viewport overflow assertions passed; no real-device claim |
| Repository hygiene | git diff --check passed; six changed-document local link checks passed after correcting the checker for root-level README paths. Known global-ignore/line-ending warnings remain |

### Repairs, limitations and next gate

Fixed an unsupported array `toSorted` use by copying before sort, preserving the existing TypeScript/browser target. Added robust numeric conversion for exact fractions larger than native numbers, precision-aligned NUMBER bounds, optional empty-checkbox missing behavior, decimal-equivalent full coverage, strict engine-pin validation and inclusive decimal-spelled final endpoints. Corrected test setup assumptions and the observed Arabic fraction-order issue described above. No known scoring or database defect remains from executed checks. A transient Next development chunk-generation error appeared during an earlier targeted run that still passed; final targeted browser run and production builds passed without that error.

Checkpoint B must independently verify instrument/scoring correctness before Phase 06. Read scoring.md, the four pure scoring files, migration 007, golden/database/browser tests and the Phase 04 handoff. No automatic next-phase work.

Not run: independent Checkpoint B, real analytics/disclosure/privacy processing, real-device or screen-reader testing, load/backup/restore/security review or deployed infrastructure checks. A 200-item math fixture is not a system load test. P-001–P-008 remain unapproved; illustrative instruments and scoring are not scientifically validated or production-ready. Core scoring accepts partial synthetic input; future finalization must enforce mandatory completion and future publication must enforce per-metric anonymity/disclosure controls.

The temporary PostgreSQL test process was stopped after verification. All synthetic databases/files were retained.

## Checkpoint B handoff — 2026-09-09

- Status: **PASS** for the requested development instrument/scoring gate after the narrow B-001 repair. Full trace, independent reference calculations and limitations: [checkpoint-b.md](checkpoint-b.md). Phase 06 has not started.
- Independent evidence: PostgreSQL numeric arithmetic independently recalculated all seven blueprint examples and matched engine output. A published all-twelve-type fixture was reloaded through authorized staff access, validated and scored at synthetic boundaries, with deterministic nonmutating output. Weighted matrix missingness produced exact 80% eligibility and 70% insufficiency; missing mandatory unscored text stayed separate from scoring eligibility.
- Integrity: attempted changes to every published node table and root English title were rejected. Version copies retained all document lineage keys with new IDs; editing the new draft preserved the source hash/content. A-only staff could not access B instruments or substitute organization context. Recommendation rules remain unimplemented Phase 09 scope; current scoring rules/bands are immutable and arbitrary rule/expression/skip fields are rejected.
- Defect B-001: contradictory checkbox selection bounds inside a SUM dimension caused an uncaught TypeError in shared definition validation. `src/scoring-bounds.ts` now adds a bound pair to mixed-scale comparisons only after checking it. Valid-input mathematics, engine pin and published content are unchanged. Regression cases cover malformed/empty option definitions and the actual authenticated HTTP 422 response with no saved revision change.
- Tests actually run: new independent checkpoint suite **3 passed** (including parent); scoring **15 passed**; scoring PostgreSQL **5 passed**; instruments **8 passed**; foundation PostgreSQL **8 passed**; foundation unit **5 passed**; full browser suite **20 passed (1.5m)**; typecheck/lint, both production builds, compiled respondent dependency boundary and missing-env/Arabic/CSP production smoke all passed. `git diff --check` passed. Environment: Windows ARM64, Node 24.13.1, real PostgreSQL 18.4 x64 loopback, Playwright Chromium; synthetic data only.
- Changed files: `src/scoring-bounds.ts`, `tests/scoring.test.ts`, new `tests/checkpoint-b.test.ts`, `tests/browser/scoring.spec.ts`, `package.json`, `.github/workflows/ci.yml`, new `docs/orgfit/checkpoint-b.md`, this status and traceability. New repeatable command `npm run test:checkpoint-b` is included in CI. No migration, dependency/lockfile change, phase feature, commit, deployment or external communication. Previous uncommitted work preserved.
- No unresolved defect from the executed gate checks remains. Production P-001–P-008 are still open; independent external security/privacy review, real analytics/disclosure/processing, system load, backups/restore, deployed infrastructure, real devices and screen-reader checks were NOT RUN. This internal checkpoint is not production readiness or scientific validation.
- The temporary PostgreSQL process was stopped after checks; all synthetic databases/files were retained. Next step is Phase 06 when requested, following the exact phase prompt and prior handoffs. Do not bypass later checkpoints.

## Phase 06 request (2026-09-09) — historical BLOCKED record; prerequisite now satisfied

- Step and status: **Phase 06 — BLOCKED. Not started. No Phase 06 code, migration, test or document was written.**
- Missing gate: **Checkpoint B — Instrument versioning and scoring correctness.** The prompt pack states "Execute OrgFit Phase 06 only after Checkpoint B", and the mandated sequence is 04 → 05 → B → 06.

### Evidence gathered before stopping

| Check | Result |
|---|---|
| `git status` / `git log` | Working tree matches the recorded Phase 00–05 state: one commit `95c72fa` ("Initialize OrgFit blueprint and phased implementation workflow"); modified `.gitignore`, `README.md`, `docs/orgfit/decisions.md`, `docs/orgfit/phase-status.md`; untracked `apps/`, `db/`, `src/`, `tests/`, `scripts/`, `package.json`, `package-lock.json`, `tsconfig.json`, `playwright.config.ts`, `eslint.config.mjs`, `.github/` and the Phase 00–05 documents. No Phase 00–05 output is missing from this checkout. `git config --global --add safe.directory` was required because the checkout is owned by another local account |
| Phase-status ledger | Row `B — Instrument/scoring checkpoint — NOT RUN`. Current position states "Checkpoint B is NOT RUN; Phase 06 has not started" |
| Phase 05 handoff | "COMPLETE for Phase 05 development scope … Checkpoint B is NOT RUN"; its "Not run" list begins with "independent Checkpoint B" |
| Checkpoint B evidence document | Absent. `docs/orgfit/` contains `checkpoint-a.md` but no `checkpoint-b.md`; no PASS/BLOCKED record with actual outputs exists anywhere in the repository |
| Migrations present | `db/migrations/001_foundation.sql` … `007_scoring_engine.sql`; nothing beyond 007, consistent with Phase 05 as the latest completed phase |
| Test suites present | `tests/unit.test.ts`, `integration.test.ts`, `directory.test.ts`, `instruments.test.ts`, `scoring.test.ts`, `scoring-database.test.ts` and four Playwright specs; no Phase 06 campaign/invitation suite exists |

### Required before Phase 06 may begin

Run the Checkpoint B prompt from `implementation-prompts.md` in its own session: trace each builder type through persisted definition, validation, synthetic answer and scoring; verify immutable published content including translations and rules, stable-key lineage, absence of conditional logic and absence of preview side effects; independently recalculate the blueprint golden examples; test required versus scoring-eligible distinctions, optional weighted coverage, matrix contributions, exact interpretation boundaries, mixed direction and malformed definitions; confirm identical inputs and version yield identical outputs; re-run builder/scoring checks and foundation isolation smoke tests; record PASS or BLOCKED with actual outputs here. Any incorrect score, mutable published instrument or cross-org access defect blocks Phase 06.

### Tests run in this session

None. No test was executed, and no test result may be inferred from this entry.

### Regressions

None found and none introduced; no source, schema or test file was modified.

### Unrelated modules

Preserved. All Phase 00–05 code, migrations, tests and documents are untouched. The only change in this session is this status record.

### Exact next action

Run **Checkpoint B**, not Phase 06.

### Commit identifier

`95c72fa` (unchanged; this session created no commit).

## Phase 06 handoff — 2026-09-09

- Step and status: **Phase 06 COMPLETE** for its development scope. Checkpoint B PASS was verified from [checkpoint-b.md](checkpoint-b.md) and the ledger before any Phase 06 work began.

### Implemented behavior

| Area | What actually works |
|---|---|
| Series and rounds | `core.assessment_series` and `core.assessment_round` with revision checks, idempotency receipts and audit rows. A series anchors to a questionnaire lineage the staff member can actually read; a round pins one PUBLISHED version owned globally or by the same organization. A draft version cannot anchor a round. Version and collection definition are editable only while the round is DRAFT. |
| Campaign | Exactly one campaign per round, enforced with an explicit STATE_CONFLICT before the unique index fires. A campaign pins exactly its round's version and nothing else. Timezone validated against `pg_timezone_names`; end must exceed start; threshold >= 5. DRAFT-only editing. |
| Targeting | SINGLE, SELECTED and DEPARTMENT. Duplicates collapse to one person. A foreign-organization participant, an archived person or an unknown identifier rejects the whole target rather than being dropped. DEPARTMENT is flat by decision D-048. |
| Launch freeze | One transaction resolves the target, creates COMPANY / per-department DEPARTMENT / OTHER report groups, one unissued READY invitation and one roster row with a private department snapshot per person, writes `frozen_manifest` (instrument hash, version, allowed groups, locales, notice, policy, start, timezone) and `frozen_invited_count`, sets SCHEDULED or OPEN from the clock, and moves the round to COLLECTING. Relaunch is denied. |
| Launch review | `core.launch_review` reports resolved count, group shape, threshold and releasability to a campaigns.manage holder who has no directory.manage. A SINGLE campaign and any under-threshold campaign are reported not releasable with an explicit warning. |
| State rules | Request-time `core.effective_state` plus `core.normalize_campaign` under the campaign lock. Manual close needs a reason; cancel needs a reason from DRAFT/SCHEDULED/OPEN; archive is an orthogonal flag; CLOSED and CANCELLED are terminal with no reopen route. End date may be set, extended or removed only before closure, never into the past, and never once the boundary has passed. Changes are audited as CAMPAIGN_END_DATE_CHANGED. |
| Durable scheduling | `scripts/close-campaigns.ts` (`npm run campaigns:normalize`) under a try-advisory lock and the operator credential. It is bookkeeping only; a late or stopped scheduler cannot widen access because every request re-derives the boundary. |
| Invitations | 256-bit random tokens; only an HMAC-SHA256 keyed digest and its `digest_key_version` persist. `orgfit_staff` holds no column privilege on either. Opaque `INV-` display references are unique per organization and non-authenticating. Issue is generation 0 to 1 once; retries and replayed idempotency keys return 409 TOKEN_ALREADY_ISSUED with the current generation, never plaintext. Rotation replaces the digest, increments the generation and deletes sessions. Revocation nulls the digest, marks the roster REVOKED and deletes sessions. COMPLETED is terminal against both. No impersonation or draft-view endpoint exists. |
| Manual link export | `core.issue_export_plan` applies a whole sorted plan atomically; any unexpected generation, foreign invitation or completed invitation aborts it entirely. Rotating already-issued links requires explicit confirmation. One file encrypted under a separate key, 24-hour expiry, capability- and organization-scoped download, CSV formula characters neutralized. No automatic sending anywhere. |
| Participation | Named READY/COMPLETED/REVOKED lists and blueprint denominators (invited, completed, revoked, outstanding, eligible = invited − revoked, rate null when eligible is zero). No answer, response identifier, score or completion timestamp. |
| Gateway contract | `core.gateway_exchange` / `core.gateway_status` plus `src/gateway.ts` and `intake.respondent_session`. Opening never consumes. Status precedence ACCEPTED > generic UNAVAILABLE > NOT_YET_OPEN/OPEN/CLOSED. Sessions bind to token generation. Neither function is granted to `orgfit_staff` nor wired to any HTTP route. |
| Staff UI | `/organizations/:org/assessments` and `/organizations/:org/campaigns/:id`, Arabic default with RTL, launch review with releasability warnings, lifecycle actions, participation table, one-time link reveal and export. |

### Changed files and migrations

| Kind | Files |
|---|---|
| Migration | New `db/migrations/008_campaigns.sql` (7 core/ops tables, `intake` schema with `respondent_session`, RLS and column privileges, four freeze triggers, and the guard/save/launch/transition/invitation/export/participation/review/gateway routines). No earlier migration edited. |
| New source | `src/campaigns.ts`, `src/campaign-input.ts`, `src/campaign-i18n.ts`, `src/invitation-token.ts`, `src/link-storage.ts`, `src/gateway.ts`, `apps/staff/app/organizations/campaigns-ui.tsx`, `scripts/close-campaigns.ts`, `scripts/expire-link-exports.ts` |
| Modified source | `apps/staff/app/api/v1/[...path]/route.ts` (mount campaign and invitation routers, export PUT), `apps/staff/app/organizations/[[...path]]/page.tsx` (allow assessments/campaigns segments and render the new component), `src/theme.css` (additive table and `.scroll` rules) |
| Tests | New `tests/campaigns.test.ts`, new `tests/browser/campaigns.spec.ts`; `tests/serve.ts` gains the two new keys; `tests/integration.test.ts` migration-ledger count derived from the directory instead of a hardcoded 7 |
| Config and docs | `package.json` (`test:campaigns`, `campaigns:normalize`, `links:expire`), `.github/workflows/ci.yml`, `.env.example`, new `docs/orgfit/campaigns.md`, `README.md`, `decisions.md` (D-048–D-052), this file |

Unrelated modules were not modified. `src/directory.ts`, `src/instruments.ts`, `src/scoring*.ts`, `src/imports.ts`, the directory and questionnaire UIs and migrations 001–007 are byte-for-byte unchanged; a defensive edit to `src/directory.ts` was made and then reverted once it proved redundant.

### Tests actually run and exact results

Windows ARM64, Node 24.13.1, real PostgreSQL 18.4 on the retained loopback synthetic cluster (port 55432), Playwright Chromium. Every database suite creates fresh synthetic databases; nothing was reset or dropped.

| Check | Actual result |
|---|---|
| `npm run test:campaigns` | **18 tests, 18 pass, 0 fail.** 17 named subtests plus parent: capability/organization denial, series and round lineage, version pinning and one-campaign-per-round, target deduplication and rejection, launch freeze with department resolution, single-person ineligibility, one-time issuance, rotation/revocation with session invalidation, completed-invitation immutability, participation denominators, no-end and exact-end boundary with a stale scheduler, scheduled opening and end-date rules, manual close/cancel/archive, atomic link export with expiry, gateway status contract, CSV formula neutralization, cross-organization detail denial |
| `npm run test:integration` | 8 pass, 0 fail (after the ledger repair below) |
| `npm run test` (foundation unit) | 5 pass, 0 fail |
| `npm run test:directory` | 6 pass, 0 fail |
| `npm run test:instruments` | 8 pass, 0 fail |
| `npm run test:scoring` | 15 pass, 0 fail |
| `npm run test:scoring-db` | 5 pass, 0 fail |
| `npm run test:checkpoint-b` | 3 pass, 0 fail |
| `npx playwright test` (full suite) | **21 passed (2.8m)**, including the new Arabic campaign journey; the previous 20 all still pass |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Both independent production builds passed |
| `npm run check:boundaries` | Passed — the respondent build still excludes staff auth and database packages |
| `npm run test:production` | Passed — missing configuration fails safely, Arabic fallback and strict CSP verified |
| Populated upgrade | A 007-populated database with an existing department row upgraded to 008 and re-ran idempotently with the row preserved; asserted inside the campaign suite |
| Visual | Inspected `work/campaign-ar-320.png` and `work/campaign-review-ar-desktop.png`. Arabic RTL renders correctly at 320px with no page-level horizontal overflow and no clipping; wide tables scroll inside their own container. No real-device or screen-reader claim |

### Required tests not run

Real answer collection, encrypted drafts, anonymous intake or finalization (Phase 07 scope, deliberately absent). Concurrency load against launch/close races beyond the single-connection lock ordering; the lock order is a correctness choice, not a measured capacity result. Real-device, screen-reader and accessibility audits. Backup/restore, key-custody, retention and independent security or privacy review. `npm audit` was not run in this session. No English-locale browser journey was recorded for the campaign screens; the catalog is complete and the Arabic path is tested, but the English rendering of these specific screens is asserted only by the shared locale mechanism, not by its own browser run.

### Regressions found and fixes applied

| Regression or defect | Fix and verification |
|---|---|
| **C-001** `tests/integration.test.ts` asserted exactly 7 migration ledger rows; the eighth migration failed it. | The assertion now derives the expected count from `db/migrations`, so a future phase neither breaks it nor silently weakens it. Suite re-run: 8 pass. |
| **C-002** A second campaign on the same round surfaced as a raw unique-constraint string rather than a state conflict. | `core.save_campaign` now checks for an existing campaign on the round and raises STATE_CONFLICT explicitly. Covered by test. |
| **C-003** `gen_random_bytes` is pgcrypto-only and is not installed; display-reference generation failed at launch. | Replaced with `encode(uuid_send(gen_random_uuid()),'hex')`, which uses the built-in strong RNG. Launch tests pass. |
| **C-004** The staff campaign screen still offered issue, rotate, revoke and link export after a campaign closed. The server correctly denied them, but the UI invited a guaranteed failure. | Invitation and export controls are gated on `SCHEDULED`/`OPEN`. Browser test asserts the buttons disappear after closure. |
| **C-005** The campaign participation table overflowed a 320px viewport by 15px. | Additive `.scroll` and table rules in `src/theme.css`; tables scroll inside their own container. Browser test asserts page overflow <= 1px, screenshot inspected. |
| Trigger naming | `CREATE TRIGGER freeze` failed because FREEZE is a reserved function/type keyword; triggers renamed. |

Two test-authoring errors of my own were also corrected: an assertion that fabricated a frozen `starts_at` through the operator role (the freeze trigger correctly refused it, so the tests now wait for the real clock instead), and two strict-mode locator ambiguities.

### Open defects, assumptions and production prerequisites

- `intake.respondent_session` and the two gateway routines exist but have **no HTTP surface and no runtime credential**. Phase 07 must add a dedicated gateway database role and the respondent endpoints. Nothing in this phase should be read as a working respondent flow.
- `COMPLETED` invitation status can only be produced by the Phase 07 acceptance transaction. Tests simulate it through the operator role and say so explicitly.
- Rotating `INVITATION_DIGEST_KEY` invalidates every outstanding link. A rotation procedure and window are a Phase 14 operational prerequisite; no re-keying path exists yet.
- The 24-hour link-export TTL and the local-filesystem export store are development defaults. Production needs a private bucket with a one-day lifecycle rule on `link-exports/` and approved retention under P-004.
- A bearer link cannot prove which human used it. The screen states this; it is not mitigated.
- Five contributors is a floor, not an anonymity guarantee. Disclosure controls are Phase 08.
- P-001–P-008 remain unapproved. Instruments remain illustrative pending P-006.
- A transient Next development chunk error (`Failed to generate static paths for /api/v1/[...path]`) appeared once during a browser run that still passed; both production builds and the full 21-test suite completed cleanly afterwards. `apps/staff/AGENTS.md` and `apps/staff/CLAUDE.md` are regenerated by `next dev` and appear as untracked files.

### Confirmation that unrelated modules were preserved

All Phase 00–05 code, migrations 001–007, their tests and their documents are intact. The only edits outside Phase 06 files are the additive theme rules, the two-line router mount, the page-segment allowlist, the e2e server environment, and the migration-ledger count repair — each recorded above with its reason.

### Exact next action

**Phase 07 — respondent flow, encrypted drafts and anonymous intake.** Read `campaigns.md` (its gateway handoff section), the state-machine and privacy-protocol documents, and migration 008 before starting. Checkpoint C follows Phase 07. No Phase 07 work was started here.

### Commit identifier

`95c72fa` — unchanged. This session created no commit; all Phase 06 work is present in the working tree alongside the earlier uncommitted phases.

## Phase 07 handoff — 2026-09-09

- Step and status: **Phase 07 COMPLETE** for its development scope. Phase 06 COMPLETE was verified from this ledger and from the checkout before any Phase 07 work began: migration `008_campaigns.sql`, `src/campaigns.ts`, `src/gateway.ts`, `src/invitation-token.ts`, `src/link-storage.ts`, the campaign UI and `tests/campaigns.test.ts` were all present, and `npm run test:campaigns` was re-run and passed 18/18 before implementation started.

### Implemented behavior

| Area | What actually works |
|---|---|
| Public respondent flow | `apps/respondent` serves `/s` on its own origin. The token is read from the URL fragment, POSTed once, and removed from the address bar and history with `replaceState` before anything else. Arabic default with full RTL; English is a complete parallel catalog. Welcome, campaign privacy notice **plus** the standing limits, fixed sections covering every question type, save/resume, review, explicit final confirmation, locked accepted state, and every lifecycle error. No third-party script, no analytics, no session replay. |
| Invitation exchange and campaign state | `POST /public/v1/invitations/exchange` returns a short-lived HttpOnly session and generic context. Opening never consumes. Unknown, malformed, revoked, rotated-away and cancelled all return the same `UNAVAILABLE`. A passed end boundary is refused at request time even when the stored state is still `OPEN` and no scheduler has run. |
| Encrypted drafts (DF1) | Web Crypto AES-256-GCM, 256-bit browser-generated key, fresh 96-bit nonce per encryption, AAD `["OrgFit","DF1",handle,versionId,revision]`. The server stores opaque bytes and cannot decrypt. Private resume code `DF1.<handle>.<key>`; staff hold no copy. Same-device resume from local material; cross-device resume from the original link plus the code. `expectedRevision` conflicts instead of overwriting; save status reports only what the server acknowledged. Start-over deletes the ciphertext so the old code can never open anything again. 30-day idle TTL, write-renewed, capped at closure + 7 days. |
| Acceptance | `intake.accept`: validate the complete payload against the frozen instrument **before** any lock or write; seal to the campaign's ACTIVE public key; lock campaign then invitation; re-check session, generation, state and `clock_timestamp()` under the lock; insert the envelope, mark `COMPLETED` and delete the draft in one durable transaction. Finalize accepts **only** an answers map — organization, campaign, version, report group and scores are server-resolved and cannot be expressed by a client. A retry returns the same generic `ACCEPTED` with no response id, no timestamp and no payload comparison. |
| Key custody | Per-campaign X25519 sealed-box key pair created **inside the launch transaction**. Only the public half reaches the core database and the staff process; the private half is sealed to the custodian with `crypto_box_seal` and can only be opened by the processor. No custody, no launch. |
| Anonymous processing | `scripts/process-campaigns.ts` under `orgfit_processor`. Freeze under the campaign lock with an accepted-versus-stored count check; below five, purge without decrypting anything; otherwise decrypt in memory, verify each envelope against the frozen manifest, strip every identity and transport field, keep only the department/other group, shuffle with a cryptographic RNG, assign fresh random ids, score with the pinned engine, and commit responses, answers, scores and the `processed_batch` marker in one anonymous transaction. Marker-first recovery; cleanup only after a proven commit; `CLEANED` only after key destruction. |
| Separation | `orgfit_staff` has **no privilege at all** in schema `intake` — not even USAGE. `orgfit_gateway` and `orgfit_processor` hold **zero table privileges** and can call only their own definer routines. No staff, auth or gateway login can connect to the anonymous database. The anonymous store is append-only to the processor. |

### Changed files and migrations

| Kind | Files |
|---|---|
| Migration | New `db/migrations/009_intake.sql` (campaign keys, drafts, submission inbox, processing batch, sixteen routines, grants, RLS, and defect repair R-001). New `db/anonymous/001_anonymous.sql` — a **separate database**. `db/roles.sql` rewritten as idempotent and extended with `orgfit_gateway`, `orgfit_processor`, `orgfit_anon_owner`, `orgfit_anon_migrator`. Migrations 001–008 unchanged. |
| New source | `src/respondent.ts`, `src/gateway-db.ts`, `src/key-custody.ts`, `src/intake-envelope.ts`, `src/draft-format.ts`, `src/respondent-i18n.ts`, `src/processor.ts`, `apps/respondent/app/survey-ui.tsx`, `apps/respondent/app/public/v1/[...path]/route.ts`, `scripts/process-campaigns.ts`, `scripts/migrate-anonymous.ts`, `scripts/expire-drafts.ts` |
| Modified source | `src/campaigns.ts` (launch provisions a campaign key), `src/config.ts` (staff process refuses gateway/processor/operator/custodian-secret credentials), `src/theme.css` (additive survey rules), `apps/respondent/app/page.tsx` and `app/s/page.tsx`, `scripts/check-boundaries.ts` (both directions) |
| Tests | New `tests/respondent.test.ts`, `tests/privacy.test.ts`, `tests/respondent-fixture.ts`, `tests/browser/respondent.spec.ts`; `tests/database.ts` provisions the anonymous database and the new roles; `tests/serve.ts` gives the respondent process its gateway credential and the custodian public key; `tests/campaigns.test.ts` and `tests/browser/foundation.spec.ts` updated for the two behaviour changes below |
| Dependency | `libsodium-wrappers` 0.8.4 and `@types/libsodium-wrappers` 0.7.14, pinned exactly. `npm audit --audit-level=high`: 0 vulnerabilities. |
| Config and docs | `package.json` (`test:respondent`, `test:privacy`, `db:migrate-anonymous`, `privacy:process`, `drafts:expire`), `.github/workflows/ci.yml`, `.env.example`, `.env.operator.example`, new `docs/orgfit/respondent.md`, `README.md`, `decisions.md` (D-053–D-057, R-001, P-003 note), this file |

### Tests actually run and exact results

Windows ARM64, Node 24.13.1, real PostgreSQL 18.4 on the retained loopback synthetic cluster (port 55432), Playwright Chromium. Every database suite creates fresh synthetic databases; nothing was reset or dropped.

| Check | Actual result |
|---|---|
| `npm run test:respondent` | **24 tests, 24 pass, 0 fail** |
| `npm run test:privacy` | **17 tests, 17 pass, 0 fail** |
| `npx playwright test` (full suite) | **23 passed (3.0m)** — the previous 21 plus the two new respondent journeys |
| `npm run test:campaigns` | 18 pass, 0 fail (after the C-006 repair below) |
| `npm run test:integration` | 8 pass, 0 fail |
| `npm run test` (foundation unit) | 5 pass, 0 fail |
| `npm run test:directory` | 6 pass, 0 fail |
| `npm run test:instruments` | 8 pass, 0 fail |
| `npm run test:scoring` | 15 pass, 0 fail |
| `npm run test:scoring-db` | 5 pass, 0 fail |
| `npm run test:checkpoint-b` | 3 pass, 0 fail |
| `npm run typecheck`, `npm run lint` | Passed |
| `npm run build` | Both independent production builds passed |
| `npm run check:boundaries` | Passed in both directions |
| `npm run test:production` | Passed |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| Visual | Inspected `work/respondent-ar-320.png` and `work/respondent-en-desktop.png`. Arabic RTL renders correctly at 320px with page overflow <= 1px asserted in the test. No real-device or screen-reader claim. |

### Concurrency and fault-injection results

| Scenario | Result |
|---|---|
| 100 concurrent finalizations of one invitation | Exactly **1** ACCEPTED and **99** generic duplicates; one inbox row; one COMPLETED invitation |
| Retry with different answers after a lost success | Generic acceptance; stored ciphertext byte-identical before and after |
| Invalid, tampered, out-of-range and unknown answers | 422 in every case; invitation stays READY; zero envelopes written |
| Closure racing with finalization | Either accepted-and-completed or refused-and-untouched; never a half state. Post-closure attempts refused with the link intact |
| Failure before the anonymous commit (after freeze, after decrypt, during transfer) | No marker, no partial responses, frozen input intact, full retry succeeds |
| Failure after the anonymous commit (lost response) | Output committed; retry finds the marker, skips decryption, appends nothing |
| Duplicate batch delivery | Marker `UNIQUE(organization, campaign)` refuses; response count stays 7 |
| Failure after intake cleanup, before key destruction | Batch stays `CLEANUP_PENDING`, release blocked; resuming reaches `CLEANED` |
| Refreeze after a crash | Same batch id, count, manifest hash and assigned set |
| Accepted vs processed count mismatch | `COUNT_MISMATCH`; nothing frozen, nothing decrypted, no count adjusted, nobody marked incomplete |
| Campaign below five accepted | `PURGED` without decryption; zero anonymous rows of any kind; completion untouched; not releasable |

### Privacy invariants verified

- No column in the anonymous schema is named after any identity or transport attribute; the **only** time column in the whole schema is the batch marker's campaign-level commit instant.
- No anonymous response identifier equals any participant, invitation, roster or token-digest value, and no identity value appears inside any stored answer.
- `intake.submission_inbox` has no timestamp column at all, and `core.invitation` records completion as a state rather than an instant.
- `orgfit_staff` is denied on every intake table and every intake routine, including `draft_read`, `batch_payload` and `accept`.
- `orgfit_processor` is denied on `core.participant`, `core.invitation`, `intake.draft_blob`, `intake.submission_inbox` and `intake.accept`.
- `orgfit_staff`, `orgfit_auth` and `orgfit_gateway` cannot connect to the anonymous database.
- Neither the invitation token, the stored token digest nor the draft handle decrypts a DF1 draft.
- Every respondent-visible error is a coarse code with no token, invitation, participant, organization or campaign value in the payload.
- Responses carry only DEPARTMENT/OTHER groups; the database refuses a COMPANY assignment.
- Committed anonymous content is immutable to the processor (no UPDATE, no DELETE).

### Regressions found and fixes applied

| ID | Regression or defect | Fix and verification |
|---|---|---|
| **R-001** | Migration 005's questionnaire-version CHECK evaluated to NULL when `schema_hash` was NULL, so a PUBLISHED version could exist with no content hash — which Phase 07 binds envelopes and manifests to. | Migration 009 restates the constraint with an explicit NOT NULL test. Recorded in decisions.md. |
| **C-006** | `tests/campaigns.test.ts` failed after launch gained the key-custody precondition. | The suite now configures a custodian public key and directory. A new Phase 07 test asserts the fail-closed behaviour: launch without custody rolls back and leaves no campaign OPEN without a key. 18/18 pass. |
| **C-007** | `intake.accept` deleted sibling sessions, so a second tab or a retry after a lost success saw `SESSION_REQUIRED` instead of generic acceptance. | Sessions now survive acceptance and can do nothing but read status. Recorded as D-055 and covered by the 100-way test. |
| **C-008** | The survey used inline `style` attributes, which the strict CSP on the public origin blocks. | Replaced with classes in `src/theme.css`. Verified in the browser run. |
| **C-009** | A development double-mount consumed the URL fragment on the first run and left the second run with no token, showing a valid link as an expired session. | The token is captured once per page load and the bootstrap runs once. |
| **C-010** | A first-time visitor to the bare survey origin was told "your session ended", which is untrue and hints that a questionnaire exists. | That message is now shown only when a link was actually presented; otherwise the generic unavailable state. `tests/browser/foundation.spec.ts` updated to assert it. |
| **C-011** | `.choice` was scoped to the staff editor containers, so survey rating options stacked above their controls at 320px. | Bare `.choice` and `.survey-question` rules added. Screenshot re-inspected. |

Two test-authoring errors of my own were also corrected: a fixture that published an instrument version without passing its document (which is what exposed R-001), and a fixture that granted a capability after issuing a staff session, which correctly revoked it.

### Required tests not run

- **Checkpoint C itself has not been run.** This handoff is phase evidence, not the gate.
- No backup, restore, replica or WAL behaviour was tested. The claim that intake ciphertext is gone after cleanup covers live rows only.
- No real key destruction was verified. The custody adapter unlinks a local file; provider recovery windows, wrapped copies and destruction attestation are untested (P-003).
- No independent security or privacy review, no adversarial re-identification exercise, and no timing or traffic-correlation analysis.
- No load or capacity measurement. The 100-way test proves correctness under contention, not throughput; lock ordering remains an unmeasured correctness choice.
- No real-device, screen-reader or accessibility audit.
- Batch sizes beyond 7 responses were not exercised; the whole-campaign transaction limit stated in the privacy protocol (10k respondents) is unmeasured.
- No test of an actual deployed network separation between the staff, gateway and processor hosts; separation is verified as credentials, grants and build traces on one machine.

### Open defects, assumptions and production prerequisites

- The privacy processor decrypts every accepted answer for an eligible campaign. Anonymity against the processor, against a colluding infrastructure operator, or against someone who can read process memory is **not provided** and must not be claimed.
- The key custody adapter is a development stand-in. It is not an HSM, and a backup taken before destruction still contains the sealed key and the ciphertext. No campaign may be described as crypto-erased.
- A bearer link cannot prove which human used it, and a respondent can identify themselves in free text. Both are stated in the respondent notice.
- Named completion tracking discloses participation by design.
- Five contributors is a floor, not an anonymity guarantee. Disclosure control is Phase 08.
- Retention values (30-day draft idle TTL, closure + 7 days, 24-hour export TTL) are development defaults pending P-004.
- The processor selects work by polling closed campaigns; there is no queue, no lease-expiry sweeper and no alerting integration. Lease fencing exists and is tested, but an abandoned lease is not reclaimed automatically.
- P-001 through P-008 remain unapproved. Instruments remain illustrative pending P-006.

### Confirmation that Phase 06 and unrelated modules were preserved

Migrations 001–008 are byte-for-byte unchanged. All Phase 00–06 source is unchanged except for the four edits recorded above, each required by this phase: the launch key provisioning in `src/campaigns.ts`, the staff foreign-credential guard in `src/config.ts`, additive rules in `src/theme.css`, and the two-direction boundary check. `src/directory.ts`, `src/instruments.ts`, `src/scoring*.ts`, `src/imports.ts`, `src/auth.ts`, `src/db.ts`, `src/gateway.ts`, `src/invitation-token.ts`, `src/link-storage.ts` and every staff UI are untouched. Two existing tests were updated for genuine behaviour changes (C-006, C-010), not to make failures disappear. No database was reset and no migration was rewritten.

### Current commit identifier

`95c72fa` — unchanged. This session created no commit; all Phase 06 and Phase 07 work is present in the working tree alongside the earlier uncommitted phases.

### Exact next action

**Checkpoint C — the blocking privacy and submission-reliability review. Not Phase 08.**

Run it with the Checkpoint C prompt from `implementation-prompts.md`, reading `respondent.md`, `privacy-protocol.md`, migration `009_intake.sql`, `db/anonymous/001_anonymous.sql` and this handoff first. Checkpoint C must independently attempt re-identification through schema keys, digests, handles, request identifiers, row order, timestamps, audit columns, jobs, errors, backups and exports; verify the role separation in the actual configuration; and re-run the concurrency and crash boundaries. A direct link, plaintext draft exposure, a duplicate or lost accepted submission, or an unimplemented trust boundary blocks Phase 08 and all real respondent data.

## Checkpoint C handoff — 2026-09-09

- Step and status: **Checkpoint C PASS**, implementation gate only. Repaired defect CC-001 and re-ran every affected check. Full report in [checkpoint-c.md](checkpoint-c.md).

### What was done

A new adversarial suite, `tests/checkpoint-c.test.ts`, independent of the Phase 07 assertions. It reads privileges out of the PostgreSQL catalog rather than trusting the migration text, then attempts to walk from a named participant to that person's finalized answers through schema keys, token digests, draft handles, request identifiers, row order, precise timestamps, generic audit columns, jobs, errors and exports. It builds a seven-person campaign in a **known submission order** with a unique marker answer per respondent, so any surviving correlation channel is directly measurable.

**21 checks, 21 pass, 0 fail.**

### Findings

| Attempted route | Outcome |
|---|---|
| Any anonymous column value matching any identity value | None. Every column enumerated, every distinct value compared. |
| Any anonymous response id present on the identity side | None. |
| Physical (`ctid`) row order reproducing submission order | No; nor does ordering by response id. All seven markers survive exactly once. |
| A time value able to separate individuals | None. The only time column in the anonymous schema is the campaign-level `processed_batch.committed_at`; the inbox has no timestamp at all. |
| Audit log linking a person to an answer | None. No respondent event is audited, so no staff-visible per-person completion instant exists. |
| A queue, job or outbox carrying a payload | No such table exists in this build. |
| Public error surfaces leaking identity, credentials or SQL | None, including `stack`. |
| A decrypted link export containing answers | No; links only. |
| **Super Admin** reading answers, response ids or drafts | Denied on every projection and on eight direct database attempts. |
| An administrator with the original link decrypting a saved draft | Failed against eight candidate keys including the token, its stored digest, the handle, the invitation id, the participant id and the campaign's own sealed-box private key. The ciphertext contains neither the secret nor readable JSON. |
| Catalog-verified role separation | Gateway and processor hold **zero** table privileges; staff holds no privilege and no `USAGE` in `intake`; `PUBLIC` holds nothing in any application schema; executable surfaces match the intended lists exactly; no `orgfit%` role is superuser or `BYPASSRLS`; no runtime login inherits another role; staff, auth, gateway and migrator are all refused connection to the anonymous database. |

Submission reliability was re-verified independently: 100-way concurrency (1 accepted / 99 duplicates, payload immutable across three differing retries), closure race, all five crash boundaries, duplicate batch delivery, cleanup after already-committed output, count reconciliation, count-disagreement blocking, sub-five suppression, and key destruction after a terminal batch.

### Defect found and repaired

| ID | Defect | Repair |
|---|---|---|
| **CC-001** | The sub-five purge path unlinked the sealed campaign key file but never called `intake.keys_destroyed`, so the key register stayed at `DELETE_REQUESTED` for ever with no destruction evidence — for exactly the campaigns the blueprint wants erased soonest. An operator could not distinguish it from a stalled destruction. | `src/processor.ts` records destruction on the suppressed path, ordered after the terminal `PURGED` transition so the batch state is preserved. Regression test in `tests/privacy.test.ts`. |

Two authoring errors in the checkpoint suite were also corrected: an allowlist omitting `intake.accept` from the gateway's legitimate surface, and a campaign processed before being closed.

### Tests run after the repair

| Check | Result |
|---|---|
| `npm run test:checkpoint-c` | **21/21** |
| `npm run test:respondent` | 24/24 |
| `npm run test:privacy` | 17/17 (includes the CC-001 regression) |
| `npm run test:campaigns` | 18/18 |
| `npm run test:checkpoint-b` | 3/3 |
| `test` / `test:integration` / `test:directory` / `test:instruments` / `test:scoring` / `test:scoring-db` | 5 / 8 / 6 / 8 / 15 / 5 — all pass |
| `npx playwright test` | 23 passed (3.1m) |
| `typecheck`, `lint`, `build`, `check:boundaries`, `test:production` | Passed |
| `npm audit --audit-level=high` | 0 vulnerabilities |

### Required checks NOT run — and what stays unproven

This checkpoint tested the implementation. It did **not** test infrastructure, and passing it is not proof against a malicious infrastructure operator.

- The privacy processor decrypts every accepted answer for an eligible campaign. Anonymity against the processor is **not provided** and was not claimed.
- Key destruction is unverified beyond unlinking a local file. Provider recovery windows, wrapped copies, replicas and attestation do not exist. **No campaign may be described as crypto-erased.**
- Backups, WAL and replicas were not tested. Every "the ciphertext is gone" statement covers live rows only.
- No deployed network separation, host isolation or secret-management integration.
- No TLS terminator, proxy log, error-tracker or host observability inspection in a deployed configuration.
- No independent third-party security or privacy review; no external adversarial re-identification exercise; no timing or traffic-correlation analysis.
- No load or capacity measurement; batches larger than seven responses were not exercised.
- No real-device, screen-reader or accessibility audit.
- Disclosure control is Phase 08 and explicitly out of scope; five contributors remains a floor, not a guarantee.

### Changed files

`tests/checkpoint-c.test.ts` (new), `src/processor.ts` (CC-001), `tests/privacy.test.ts` (CC-001 regression), `package.json` (`test:checkpoint-c`), `.github/workflows/ci.yml`, new `docs/orgfit/checkpoint-c.md`, `README.md`, `decisions.md`, this file. No migration was added or altered. No unrelated module was modified.

### Current commit identifier

`95c72fa` — unchanged. This session created no commit.

### Exact next action

**Phase 08 — safe publication and analytics, as development work only.** Read the Phase 08 prompt, [checkpoint-c.md](checkpoint-c.md) and `respondent.md` first, and consume `core.release_readiness` / `reconcile` as the release gate. **Real respondent data, deployment and any public anonymity claim remain blocked** on P-001, P-002, P-003, P-004 and P-008.

## Phase 08 handoff — 2026-09-09

- Step and status: **COMPLETE for the development safe-publication and analytics scope.** Not a production privacy approval, and not a proof that no suppressed value is reachable. Checkpoint D has not run.

### What was built

A trusted score-aggregation and disclosure path, an immutable snapshot per closed campaign, and a staff analytics surface that can read nothing else. Full record in [publication.md](publication.md).

- **`src/disclosure.ts`** — the disclosure engine. Pure: no database, clock, randomness, network or authorization. It turns a whole campaign's anonymous per-response scores and answers into one release plan and decides, jointly, what is safe to publish.
- **`db/migrations/010_publication.sql`** — the `publication` schema. `result_snapshot`, `snapshot_group`, `snapshot_metric`, `aggregate_cell`, immutability triggers, and the routines `check_plan`, `publish_release`, `mark_release_state`, `snapshot` plus the processor's `due_campaigns` queue.
- **`src/publication.ts` and `scripts/publish-campaigns.ts`** — the release job, running under the privacy processor's identity, the only credential that can read anonymous answers.
- **`src/results.ts`**, wired into the staff API — three fixed views over published cells.
- **`apps/staff/app/organizations/results-ui.tsx`**, `src/results-i18n.ts`, chart tokens in `src/theme.css` — bars, radar, department table and heatmap, safe question analysis, bands, strengths and areas to review, coverage and status explanations, and accessible data tables, Arabic-first.

### The boundary, as actually configured

`orgfit_staff` holds **no table privilege in the `publication` schema**, no write routine, and no CONNECT on the anonymous database. Its entire analytics surface is `publication.snapshot(campaign)`, which returns the current PUBLISHED release or a release state with no numbers. `orgfit_processor` may publish and record an outcome but cannot read a snapshot back through the staff routine. Both are asserted against the live catalog in `tests/publication.test.ts`.

### Disclosure rules implemented

Threshold `max(campaign, 5)`, with five a hard CHECK on the cell table. Distinct valid contributors are counted per metric, never per campaign. Homogeneous metrics are withheld. Company values are contributor-weighted means of respondent-level values. The department partition is released whole or not at all and never without its company cell. Distributions require every nonempty bin to clear the threshold; checkbox bins count respondents. Numbers get a bounded mean and no extremes. Free text and exact dates are never a released value. AVAILABLE, SUPPRESSED, INSUFFICIENT, UNSCORED and NOT_COMPARABLE are distinct, and none is a numeric zero.

A withheld cell is **empty in storage**, not hidden by a view: value, contributor count, coverage, distribution and band are all NULL, enforced by a table CHECK. The plan is validated as a whole in TypeScript and again, independently, in SQL.

### Changed files and migrations

New: `db/migrations/010_publication.sql`, `src/disclosure.ts`, `src/publication.ts`, `src/results.ts`, `src/results-i18n.ts`, `scripts/publish-campaigns.ts`, `apps/staff/app/organizations/results-ui.tsx`, `tests/disclosure.test.ts`, `tests/publication.test.ts`, `tests/publication-fixtures.ts`, `tests/browser/results.spec.ts`, `docs/orgfit/publication.md`.

Modified: `src/processor.ts` (stores the pinned instrument in the anonymous manifest; shares the overall definition key with the disclosure engine), `scripts/process-campaigns.ts` (queue routine instead of an ungranted SELECT), the staff API route, the organizations page, `campaigns-ui.tsx`, `src/campaign-i18n.ts`, `src/theme.css`, `scripts/check-boundaries.ts`, `tests/serve.ts`, `tests/campaigns.test.ts`, `package.json`, `.github/workflows/ci.yml`.

No dependency or lockfile change. No change to the anonymous schema, the intake schema, the gateway, key custody or the scoring engine.

### Tests actually run

Local PostgreSQL 18.4 loopback cluster, Node 24.13.1, Chromium via Playwright.

| Suite | Result |
|---|---|
| `npm run typecheck`, `npm run lint` | clean |
| `npm run test:disclosure` (16 checks) | 16 pass |
| `npm run test:publication` (10 checks) | 10 pass |
| `npm test`, `test:integration`, `test:campaigns`, `test:respondent`, `test:privacy`, `test:checkpoint-c` | all pass, no regressions |
| `npm run build`, `npm run check:boundaries` | pass; the staff build links neither the processor, the gateway pool nor the publication writer |
| `npx playwright test tests/browser/results.spec.ts` | pass, with Arabic 320px and English desktop screenshots in `work/` |

Not run in this session: `test:directory`, `test:instruments`, `test:scoring`, `test:scoring-db`, `test:checkpoint-b`, `test:production`, the remaining browser specs, and `npm audit`. None of them touch the modules changed here except through the shared theme file.

### Regressions found and fixed

- **Phase 07 defect.** The processor wrote the batch manifest into `anonymous_campaign_manifest.instrument_snapshot` instead of the pinned questionnaire, so publication could not resolve labels or bands after the intake was purged. The column now holds `{manifest, instrument}`. `manifest_hash` is unchanged, and the Phase 07 and Checkpoint C suites still pass.
- **Phase 07 defect.** `scripts/process-campaigns.ts` selected due campaigns with a SELECT on `core.campaign` and `intake.processing_batch` that the processor credential has never been granted, so the operator entry point would have failed at runtime. Both operator scripts now use `publication.due_campaigns`.
- **Phase 06 test defect.** `tests/campaigns.test.ts` set a past end date as `clock_timestamp() - 1s` on a campaign whose start was two seconds old, violating `ends_at > starts_at` on a fast machine. It now offsets from `starts_at`; the assertion is unchanged. Confirmed pre-existing by reproducing it with migration 010 removed.

### Open defects, assumptions and production prerequisites

1. No correction workflow. The schema supports a superseding revision; a changed plan for a released campaign is refused, not reconciled.
2. REVOKED is handled by the schema and the read path; no endpoint produces it.
3. Question analysis is company-level by design, not because department distributions were proved unsafe.
4. This is k-thresholding with complementary and homogeneity controls. It is not differential privacy and does not model an adversary with outside knowledge of a specific person.
5. Everything upstream still rests on the Phase 07 trust boundary: the privacy processor decrypts every accepted answer, and key custody is a development stand-in.
6. P-001 through P-008 remain unapproved. Real respondent data, deployment and any public anonymity claim remain blocked.

### Commit

`95c72fa` — unchanged. This session created no commit.

### Exact next action

**Phase 09 — deterministic recommendation engine and actions.** Read the Phase 09 prompt, [publication.md](publication.md) and the SafeCell contract in [api-contracts.md](api-contracts.md) first. Rules must consume published aggregate cells only; a suppressed, missing or not-comparable input is UNKNOWN and never zero. **Checkpoint D remains mandatory before Phase 10**, and passing the Phase 08 suites is not a substitute for its adversarial reconstruction review.

## Phase 09 handoff — 2026-09-09

- Step and status: **COMPLETE for the development deterministic-recommendation scope.** Not a production privacy approval, not approved consulting content, and not a proof that a recommendation cannot narrow a reader's belief about an individual. Checkpoint D has not run.

### What was built

Versioned rules, a pure deterministic evaluator, immutable published instances and a separate staff action record. Full record in [recommendations.md](recommendations.md).

- **Rules as instrument nodes.** `instrument.recommendation_rule` is a node of the questionnaire version, so a rule inherits the Phase 04 guarantees: the `draft_only` trigger refuses any write against a published version, the rule is inside the version content hash, and it travels in the pinned instrument snapshot the privacy processor carries into the anonymous database. Publication evaluates the rules frozen with the measurement, not today's questionnaire.
- **`src/recommendation-engine.ts`** — pure evaluator: no database, clock, randomness, network or authorization. Input is the approved release plan only. Bounded `ALL`/`ANY` trees of `LT/LTE/GT/GTE/BETWEEN` comparisons over `OVERALL` and `DIMENSION` metrics, full-precision thresholds, explicit direction through the published band, priority with stable tie-breaking, exclusivity groups and dedup keys per group.
- **UNKNOWN is absorbing.** Suppressed, insufficient, unscored, not-comparable and absent are one state, and any unknown input anywhere in a rule stops it — deliberately stricter than Kleene logic, because a fired `ANY` beside a suppressed branch would itself disclose that branch. No severity badge, priority or counter survives an unknown either.
- **`db/migrations/011_recommendations.sql`** — `instrument.recommendation_rule`, `instrument.node_tables()`, `publication.recommendation_instance` with its evidence trigger and immutability trigger, `core.recommendation_action`, `publication.check_recommendations`, a replaced `publish_release` that writes instances inside the same transaction and content hash, `publication.recommendations(campaign)` for staff reads, and `core.save_recommendation_action`.
- **Staff surface.** `GET O/assessments/:round/results/recommendations` as a fourth fixed view (locale remains the only accepted query parameter) and `PATCH O/recommendation-actions/:instanceId` for the action row. UI: a rule editor tab in the questionnaire workspace and a recommendations tab in results showing the top five with "show all eligible", read-only computed text and evidence, and a clearly labelled human follow-up form.

### The boundary, as actually configured

`orgfit_staff` holds no privilege on `publication.recommendation_instance` and cannot write one through any path; the only staff write is the action row beside it, revision-checked, idempotency-keyed and audited as `RECOMMENDATION_ACTION_CHANGED` with the field group only. The database independently refuses an instance whose target is not an `AVAILABLE` cell of its own snapshot, whose evidence crosses groups, whose evidence value does not equal the published cell numerically, or whose evidence is empty — enforced both on the whole plan and again per row at insert.

### Changed files and migrations

New: `db/migrations/011_recommendations.sql`, `src/recommendation-engine.ts`, `src/recommendations.ts`, `apps/staff/app/questionnaires/rules-editor.tsx`, `tests/recommendations.test.ts`, `docs/orgfit/recommendations.md`.

Modified: `src/instrument-input.ts` (rule schema, `newRule`, copy remapping, `ruleIssues` folded into `definitionIssues`), `src/instrument-records.ts` (rule node table), `src/publication.ts` (evaluates rules and publishes instances; `versions.rules`), `src/results.ts` (fourth view), `src/results-i18n.ts`, `apps/staff/app/organizations/results-ui.tsx`, `apps/staff/app/questionnaires/workspace.tsx`, the staff API route, `package.json` (`test:recommendations`), `tests/respondent-fixture.ts`, `tests/publication-fixtures.ts`, `tests/publication.test.ts`, `tests/checkpoint-b.test.ts`, `tests/browser/instruments.spec.ts`, `tests/browser/results.spec.ts`.

Migration 011 also replaces two existing routines, for one reason each: `instrument.write_version` writes the new node table (guard, idempotency, revision and lifecycle behaviour unchanged), and `intake.batch_payload` now takes its node list from `instrument.node_tables()` so a node table cannot be missing from a processed batch. `intake.gateway_instrument` is deliberately unchanged — rule thresholds and consulting text are not sent to a respondent's browser.

No dependency or lockfile change. No change to the anonymous schema, the gateway, key custody, the scoring engine or the disclosure engine.

### Tests actually run

Local PostgreSQL 18.4 loopback cluster, Node 24.13.1, Chromium via Playwright.

| Suite | Result |
|---|---|
| `npm run typecheck`, `npm run lint` | clean |
| `npm run test:recommendations` (13 checks) | 13 pass |
| `npm run test:publication` (13 checks, 3 new) | 13 pass |
| `npm test`, `test:disclosure`, `test:scoring` | pass |
| `test:instruments`, `test:scoring-db`, `test:checkpoint-b` | pass |
| `test:campaigns`, `test:respondent`, `test:privacy` | pass |
| `test:checkpoint-c`, `test:directory`, `test:integration` | pass |
| `npm run build`, `npm run check:boundaries` | pass |
| `npx playwright test tests/browser/{instruments,scoring,results}.spec.ts` | 7 pass, including the new rule-editor journey |

Not run in this session: `test:production`, the `foundation`, `directory`, `campaigns` and `respondent` browser specs, and `npm audit`. Checkpoint D is NOT run and is not implied by any of the above.

### Regressions found and fixed during the phase

- The processed batch payload enumerated node tables literally, so rules would not have reached the pinned instrument at all. Fixed by `instrument.node_tables()`; caught by the end-to-end publication suite, not by review.
- The evidence trigger compared published values as text, so a stored `60.0` did not match a cited `60`. It now compares numerically.
- `tests/checkpoint-b.test.ts` proved published-node protection by updating every node table; with no rule in its fixture the new table matched zero rows and proved nothing. The fixture now carries a rule.
- **UI defect found by the browser journey.** The results page rendered whichever view the tab state requested, using whatever payload was still loaded. The three cell views share a shape so this never showed; the recommendations release carries no cells, so switching tabs crashed the page. Views now render only their own loaded payload. The results browser spec also publishes its own scored instrument with a rule, because the illustrative template produces no metric and therefore could never have exercised this path.

### Open defects, assumptions and production prerequisites

1. Historical-change rules are not implemented and are blocked until Phase 10 provides reviewed comparison compatibility.
2. Rules address `OVERALL` and `DIMENSION` metrics only. Question-level distributions are not rule inputs; that is a scope decision, not a proof that they would be unsafe.
3. Recommendations are inside the release content hash. A campaign released before migration 011 and re-released after it would raise `RELEASE_ALREADY_PUBLISHED` instead of `reused`; no released development data is affected.
4. There is still no correction or revocation workflow for a published release, so there is none for its recommendations either.
5. Rule texts, thresholds and severities anywhere in the repository are synthetic and illustrative and require P-006 approval before real use.
6. Everything upstream still rests on the Phase 07 trust boundary and the Phase 08 disclosure limits. P-001 through P-008 remain unapproved; real respondent data, deployment and any public anonymity claim remain blocked.

### Commit

`95c72fa` — unchanged. This session created no commit.

### Exact next action

**Checkpoint D — results and recommendation disclosure.** Run it with the Checkpoint D prompt from `implementation-prompts.md`, reading [publication.md](publication.md), [recommendations.md](recommendations.md), migrations `010` and `011`, and this handoff first. It must independently attempt reconstruction through totals, tooltips, serialized chart configuration, caches, statuses and recommendations, using its own adversarial datasets rather than the fixtures here. Any suppressed value reachable through an API, the UI or a recommendation — or reconstructable from the supported partition views — blocks Phase 10.

## Checkpoint D handoff — 2026-09-09

- Step and status: **PASS as an implementation gate**, after repairing CD-001 and CD-002 and re-running every affected check. Not a production privacy approval and not a proof of anonymity against an adversary with outside knowledge. Full record in [checkpoint-d.md](checkpoint-d.md).

### What was run

`tests/checkpoint-d.test.ts`, a new adversarial suite that reuses no Phase 08 or Phase 09 assertion: **18 checks, 18 pass**. Nine attack the disclosure and rule arithmetic directly with datasets in which every protected quantity is a distinct searchable number; nine repeat the attempt against the real gateway, processor, release job and staff API on PostgreSQL 18.4.

Reconstruction was attempted from totals, contributor counts, chart payloads, statuses, recommendations, recommendation counts and severities, caches, repeated releases, candidate snapshots and alternate partitions. None succeeded. The ten-plus-two case was run twice — synthetically and through the real pipeline with the small department's true value recomputed independently by the scoring engine — and neither department value, neither group size nor any respondent's free text appears in any view, in the snapshot routine or in any recommendation.

Independent verification: published company values equal the contributor-weighted mean of respondent-level scores computed by `scoreInstrument` (and not the unweighted mean of department means); a live directory rename does not rewrite a published label; staff hold no privilege on any publication table and cannot connect to the anonymous database; all four views and the action write are NOT_FOUND for the other organization.

### Defects found and repaired

- **CD-001** — `rankDimensions` presented the worst dimension as a strength whenever fewer than four dimensions were released, because "areas to review" started only at the fourth entry. A critical HIGH_RISK dimension could appear under "Strengths". Repaired in `src/disclosure.ts` by splitting the ranked list at its midpoint, at most three a side. Regression `D-A9`.
- **CD-002** — `publication.snapshot` served cell values through `trim_scale`, so a released `60.0` reached the results view as `"60"` while the frozen recommendation citing the same cell carried `"60.0"`. Repaired by `db/migrations/012_result_precision.sql`, which serves the stored value as released. Read path only; no stored value, released cell or content hash changes. Regression asserts the two representations are identical.

### Changed files and migrations

New: `db/migrations/012_result_precision.sql`, `tests/checkpoint-d.test.ts`, `docs/orgfit/checkpoint-d.md`. Modified: `src/disclosure.ts` (ranking split), `package.json` (`test:checkpoint-d`), `.github/workflows/ci.yml`. No dependency change; no change to the anonymous schema, intake, gateway, key custody, the scoring engine or the recommendation evaluator.

### Tests re-run after the repairs

`test:checkpoint-d` 18 pass; `test:disclosure` + `test:recommendations` + `npm test` + `test:scoring` 49 pass; `test:publication` + `test:checkpoint-c` 34 pass; `test:integration` + `test:directory` + `test:campaigns` 32 pass; `playwright tests/browser/results.spec.ts` pass; typecheck, lint, build and `check:boundaries` clean. Not re-run: `test:instruments`, `test:scoring-db`, `test:checkpoint-b`, `test:respondent`, `test:privacy`, `test:production`, the other browser specs, `npm audit` — all passed earlier this session and none asserts on the two repaired paths.

### Residual limitations

Background knowledge is outside the threat model; a released mean still discloses its contributor sum; cross-round differencing is untested because the product offers no comparison surface yet — Phase 10 creates it and Checkpoint E must test it; question analysis is company-level by design rather than by proof; the Phase 07 processor trust boundary and development key custody are unchanged; P-001 through P-008 remain open, including the P-006 approval every rule text and band still needs.

### Commit

`95c72fa` — unchanged. This session created no commit.

### Exact next action

**Phase 10 — history and assessment comparison**, as development work only. Read the Phase 10 prompt, [checkpoint-d.md](checkpoint-d.md) and D-021 first. Comparison must require reviewed compatible measurements within one organization; missing or suppressed values stay gaps and cannot produce deltas or recommendations. Note the new obligation this gate identified: comparing releases of overlapping rosters whose membership changed is a differencing surface that Checkpoint E must attack directly.

## Phase 10 handoff — 2026-09-10

- Step and status: **COMPLETE for the development history and comparison scope.** Not a production privacy approval. Checkpoint E has not run, and it now has a surface to attack that Checkpoint D did not.

### What was built

Within-organization series history, an automatic company trend, and immutable reviewed two-round comparisons over published snapshots. Full record in [history.md](history.md).

- **`src/comparison.ts`** — pure: no database, clock, authorization or network. Metric **fingerprints** cover aggregation mode, coverage, direction, denominator and every scored item's weight, reverse flag, mode and option scores, and exclude all translated text and the metric's own identity. A translation-only revision keeps its fingerprint; a stable key alone proves nothing.
- **`db/migrations/013_comparison.sql`** — `publication.comparison_definition` (immutable, RLS, no staff table privilege), `series_history`, `comparison_context`, `comparison_side`, `comparisons` and `save_comparison`.
- **`src/history.ts`** wired into the staff API — series list, series history with trend, comparison list/detail, the reviewer's compatibility proposal, and the review write path.
- **`apps/staff/app/organizations/history-ui.tsx`** with `src/history-i18n.ts` — series list, per-metric trend chart and accessible table, comparison list and detail with caveats, and a review form that shows which metrics still match before anything is recorded.

### The properties that matter

A delta exists only where the review is not NOT_COMPARABLE **and** the mapped pair's fingerprints still agree when the comparison is read — a forged or stale review yields NOT_COMPARABLE cells with both published values shown and no number computed. A withheld or absent value on either side is a GAP with an explicit reason; gaps never become zero and nothing is interpolated. Improvement is direction-aware. Groups pair by department lineage so a rename keeps the pairing and its historic labels, while a merger or split has no counterpart and is declared. The automatic trend is stricter still: it connects points only while the measurement is unchanged.

Reading a history needs `results.read`; declaring equivalence additionally needs `instruments.manage`, and a results reader is refused both the review and the review aid.

### Changed files and migrations

New: `db/migrations/013_comparison.sql`, `src/comparison.ts`, `src/history.ts`, `src/history-i18n.ts`, `apps/staff/app/organizations/history-ui.tsx`, `tests/comparison.test.ts`, `tests/history.test.ts`, `docs/orgfit/history.md`.

Modified: the staff API route (history routes), the organizations page dispatcher (`history` path), `campaigns-ui.tsx` (a history link), `package.json` (`test:comparison`, `test:history`), `.github/workflows/ci.yml`, `tests/browser/results.spec.ts` (a history journey).

No dependency change. No change to the anonymous schema, intake, the gateway, key custody, the scoring engine, the disclosure engine or the recommendation evaluator. Migration 013 adds one table and five routines and alters no existing one.

### Tests actually run

Local PostgreSQL 18.4 loopback cluster, Node 24.13.1, Chromium via Playwright.

| Suite | Result |
|---|---|
| `npm run test:comparison` (13 checks) | 13 pass |
| `npm run test:history` (8 checks, real gateway → processor → release) | 8 pass |
| `npm test`, `test:disclosure`, `test:scoring`, `test:recommendations`, `test:checkpoint-d` | 72 pass |
| `test:publication`, `test:checkpoint-c`, `test:respondent`, `test:privacy` | pass |
| `test:campaigns`, `test:integration`, `test:directory`, `test:instruments`, `test:checkpoint-b`, `test:scoring-db` | 48 pass |
| `npx playwright test tests/browser/{results,campaigns}.spec.ts` | pass |
| `npm run typecheck`, `npm run lint`, `npm run build`, `npm run check:boundaries` | clean |

Not run: `test:production`, the `foundation`, `directory`, `instruments`, `scoring` and `respondent` browser specs, `npm audit`.

### Defects found during the phase

- The series list joined `publication.result_snapshot` directly, which `orgfit_staff` has no privilege to read — the page failed with a generic unavailable error. It now counts released rounds from the campaign's own release state. The browser journey caught it; the database suite had not covered the list endpoint, and now does.
- Two test-side defects were fixed rather than worked around: a NEW_VERSION call that omitted the copied document (the writer requires it), and a patch that set an item weight without switching the dimension to `WEIGHTED_AVERAGE`, which `definitionIssues` correctly refuses.

### Open defects, assumptions and production prerequisites

1. **Cross-round differencing is now reachable and untested.** Subtracting two releases of overlapping populations can narrow what a reader believes about people who joined or left between rounds. Caveats are declared; the inference is not defeated. Checkpoint E must attack it, including rounds differing by one or two contributors.
2. Historical-change recommendation rules remain disabled by decision (D-074) until that gate has run.
3. Equivalence is structural, not psychometric: a matching fingerprint means the arithmetic matches, not that a reworded item measures the same construct. That judgement is the reviewer's, which is why a named reviewer and a rationale are mandatory and stored.
4. Population comparability is declared, never verified — the module cannot know who answered either round, by design.
5. There is still no correction or revocation workflow for a published release, so a comparison of a superseded release cannot arise but also cannot be repaired.
6. P-001 through P-008 remain unapproved, including the P-006 approval every instrument, band and rule text still needs.

### Commit

`95c72fa` — unchanged. This session created no commit.

### Exact next action

**Phase 11 — professional PDF and Excel outputs**, as development work only. Read the Phase 11 prompt, [history.md](history.md) and [publication.md](publication.md) first. Reports must generate from immutable privacy-approved snapshots and reviewed comparisons only, with report-worker credentials that cannot reach the private directory or raw answers, and every suppression carried into the document rather than resolved in it.

## Phase 11 handoff — 2026-09-10

- Step and status: **COMPLETE for the development report artifact scope.** Not a production privacy approval, and not a font-license approval. Checkpoint E has not run.

### What was built

Asynchronous PDF and Excel reports rendered from immutable published releases, and a named participation export kept deliberately apart from them. Full record in [reports.md](reports.md).

- **`db/migrations/014_reports.sql`** — `ops.report_job` (frozen `source`, lifecycle trigger, RLS, no grant to any runtime credential), `publication.check_report_input` and `withheld_leak`, `report_source_payload`, `snapshot_document`, `report_recommendations`, the staff routines `core.request_report` / `report_jobs` / `report_download`, the participation-export routines, and the renderer's five job routines.
- **`db/roles.sql`** — adds `orgfit_report`, a login role with no table privilege anywhere and no CONNECT on the anonymous database.
- **`src/report-model.ts`** — pure: no database, clock, authorization or network. One document model, consumed by both renderers, whose single path from a stored cell to a printable row reads a value only inside the AVAILABLE branch.
- **`src/report-html.ts` / `report-pdf.ts`** — deterministic escaped HTML with theme tokens and inline OFL fonts, drawn by a sealed Chromium context: no URL, no JavaScript, offline, every network request aborted and counted.
- **`src/report-xlsx.ts`** — seven sheets, typed numbers, empty withheld cells with status and reason beside them, no chart/pivot/hidden sheet/formula anywhere.
- **`src/report-worker.ts`, `report-db.ts`, `report-storage.ts`, `participation-storage.ts`, `scripts/generate-reports.ts`, `scripts/expire-reports.ts`** — the renderer process, its credential guard, and two separately keyed private stores.
- **`src/reports.ts`** plus a **Reports tab** on the results page (`apps/staff/app/organizations/reports-ui.tsx`) — request, list and download; the panel shows a job's state and size and never a metric.

### The properties that matter

The render input is **frozen on the job** and re-checked by the database before it is stored: no non-AVAILABLE cell may carry a value, count, coverage, distribution or band anywhere in the payload, and every released number the document quotes must equal the stored aggregate cell it cites. A defect in the application cannot put a withheld number into a report, because the database refuses to store the document containing one. The renderer addresses a **job**, holds no table privilege, and cannot connect to the anonymous database or decrypt a file of names. Downloads are re-authorized against current access at the moment they are clicked, expire in a day, and stop working if the release is revoked after rendering. Nothing is ever sent anywhere.

### Changed files and migrations

New: `db/migrations/014_reports.sql`, `src/report-model.ts`, `src/report-i18n.ts`, `src/report-theme.ts`, `src/report-fonts.ts`, `src/report-html.ts`, `src/report-pdf.ts`, `src/report-xlsx.ts`, `src/report-storage.ts`, `src/participation-storage.ts`, `src/report-db.ts`, `src/report-worker.ts`, `src/reports.ts`, `scripts/generate-reports.ts`, `scripts/expire-reports.ts`, `apps/staff/app/organizations/reports-ui.tsx`, `tests/reports.test.ts`, `tests/browser/reports.spec.ts`, `tests/browser/published-round.ts`, `docs/orgfit/reports.md`.

Modified: `db/roles.sql` (the `orgfit_report` role), the staff API route (report routes), `src/config.ts` (refuse `REPORT_DATABASE_URL` in the staff process), `src/results-i18n.ts` (report panel wording), `apps/staff/app/organizations/results-ui.tsx` (the Reports tab), `scripts/check-boundaries.ts`, `tests/database.ts` (the new role and its CONNECT), `tests/respondent-fixture.ts` (`reports.manage` granted before the fixture session is issued), `tests/serve.ts` (report keys and the renderer URL in the e2e fixture), `tests/browser/results.spec.ts` (fixture split, stamped series name), `tests/checkpoint-c.test.ts` (see below), `package.json`, `.github/workflows/ci.yml`, `.env.example`, `.env.operator.example`, `README.md`.

Dependencies added: `playwright` and `@fontsource/cairo`, `@fontsource/noto-sans` as runtime dependencies of the renderer; `pdfjs-dist` and `@napi-rs/canvas` as development dependencies used only to read and rasterize the produced PDFs in tests. `@fontsource/noto-naskh-arabic` was installed, measured and removed (D-078). No change to the anonymous schema, intake, the gateway, key custody, the scoring engine, the disclosure engine, the recommendation evaluator or migrations 001–013.

### A Checkpoint C assertion was changed, deliberately

`tests/checkpoint-c.test.ts` asserted that **no** job, queue, outbox, task or event table exists anywhere in the build. Phase 11 introduces one, so that assertion no longer states the property it was protecting. It now asserts the property directly against whatever queue tables exist: none may be reachable by any runtime credential, none may have a column shaped like a respondent body or a link, and nothing any of them holds may be a value drawn from the anonymous store. Checkpoint C passes again with 21 of 21 checks. Checkpoint E should re-examine this substitution rather than take it on trust.

### Tests actually run and exact results

Local PostgreSQL 18.4 loopback cluster, Node 24.13.1, Chromium via Playwright, on Windows 11.

| Suite | Result |
|---|---|
| `npm run test:reports` (17 checks) | 17 pass |
| `npm run test:checkpoint-c` after the substitution above | 21 pass |
| `npm test`, `test:integration`, `test:directory`, `test:instruments`, `test:scoring`, `test:scoring-db`, `test:checkpoint-b` | pass |
| `test:campaigns`, `test:respondent`, `test:privacy`, `test:disclosure`, `test:publication`, `test:recommendations`, `test:checkpoint-d`, `test:comparison`, `test:history` | pass |
| `npx playwright test tests/browser/{reports,results,campaigns}.spec.ts` | 3 pass |
| `npm run typecheck`, `npm run lint`, `npm run build`, `npm run check:boundaries` | clean |

**Artifacts actually inspected, not merely produced.** Three PDFs (Arabic 8 pages, English 10 pages, a shorter Arabic round 6 pages) were rasterized page by page with pdf.js and looked at, and their text was extracted and asserted: zero unmappable glyphs, more than 2000 Arabic characters present as text, Latin identifiers exact. Two workbooks were unzipped and every part inspected for charts, pivot caches, hidden sheets, defined names, formulas and comments. Screenshots of the staff panel at 320px and desktop width, in both languages, are in `work/`.

Not run: `test:production`, the `foundation`, `directory`, `instruments`, `scoring` and `respondent` browser specs, `npm audit`. No S3-backed storage path was exercised; both stores ran on their local development adapters.

### Defects found during the phase and repaired

1. **The PDF omitted its methodology section entirely.** The model built it and the HTML never emitted it. Caught by the English word assertion, not by a human reading the page.
2. **Visual inspection found three more.** A recommendation's evidence table printed a band's UUID instead of its name; distribution-only questions printed a "published —" line with nothing after it; the strengths section repeated its own heading. All repaired and re-inspected.
3. **Arabic was rendering perfectly and copying as nothing.** With Noto Naskh Arabic roughly a quarter of the shaped glyphs had no reverse mapping in the produced PDF. Measured across four faces and repaired by switching to Cairo (D-078). One stacked shadda-plus-fatha ligature still had no mapping even in Cairo, so the report catalog no longer stacks those two marks.
4. **Excel reserves the sheet name "History"**, which failed every English workbook render. The sheet is now "Round history".
5. **A nine-column job table overflowed a 320px viewport.** It now scrolls inside its own box, matching the campaign lists.
6. Two test-harness defects were fixed rather than worked around: a capability granted after the shared fixture had issued its session (which silently revoked it), and two browser specs creating identically named series in one database.

### Open defects, assumptions and production prerequisites

1. **Cross-round differencing is now portable and still untested.** A report can carry a trend and a two-round comparison into a file that leaves the platform. Checkpoint E must attack it, including rounds differing by one or two contributors, and must inspect PDF pages and XLSX internals rather than trusting that a file was produced.
2. **The font choice is a measured development default, not an approval.** Cairo and Noto Sans are OFL 1.1, which permits embedding; P-007 owns the final family and its license confirmation.
3. **The renderer depends on a browser build.** `npx playwright install chromium` is a deployment prerequisite, and a different engine version can paginate differently — the assertions are on content and structure, not on an exact page count.
4. **Report, band and recommendation wording remains synthetic** and illustrative pending P-006/P-007.
5. **Neither private store was exercised against S3.** The bucket lifecycle rules on `reports/` and `participation-exports/` are documented, not verified.
6. There is still no correction or revocation workflow for a published release; a report of a revoked release stops downloading, but nothing can re-issue a corrected one.
7. P-001 through P-008 remain unapproved.

### Confirmation that unrelated modules were preserved

Migrations 001–013 are unchanged and their checksums still match. The anonymous schema, the gateway, the intake path, key custody, the scoring engine, the disclosure engine and the recommendation evaluator were not modified. The only behavioural change outside Phase 11 is the Checkpoint C substitution recorded above; every other test file changed only for fixture wiring.

### Commit

`95c72fa` — unchanged. This session created no commit.

### Exact next action

**Checkpoint E — history and report consistency.** Read its prompt, [reports.md](reports.md), [history.md](history.md) and [publication.md](publication.md) first. It must choose a comparable series, an incompatible series, a department reorganization, a sparse campaign and a long Arabic instrument; compare dashboard, history, PDF and XLSX values, dates, labels, versions and suppression statuses; inspect PDF pages visually and XLSX hidden sheets, formulas and chart caches; and attempt unauthorized, expired and post-revocation downloads.

## Checkpoint E handoff — 2026-09-10

- Step and status: **PASS as an implementation gate**, after CE-001 was escalated to the owner as P-009 and answered the same day. One repair (CE-002) and one declaration change (D-086) were made and retested. Full record in [checkpoint-e.md](checkpoint-e.md).

### What was run

`tests/checkpoint-e.test.ts`, a new adversarial suite reusing none of the Phase 10 or Phase 11 assertions. **11 checks, 11 pass** — the suite passing is not the verdict: E-1 is a check that *demonstrates* a disclosure and passes because the disclosure occurred.

The prompt's five cases were built as one real series so the trend had to survive a break in the middle rather than end at one. Every round was collected through the real gateway, mixed by the real privacy processor and released by the real publication job: R1 (V1, 12 contributors), R2 (V1, 13, department B renamed before launch), R6 (V1, 14), R3 (V2, an item re-specified — incompatible), R4 (V3, translation-only with long Arabic labels, department B dropped and D added — the reorganization), R5 (V1, 4 — sparse).

### CE-001 — the blocking finding

`n₂·M₂ − n₁·M₁` over two overlapping releases returns whatever the second added. Measured against independently recomputed true scores: 0.71, 1.03 and 0.32 points of error at company level, and **0.01 points from one department row of a reviewed comparison** (permitted rounding bound 0.65). Smaller groups give a tighter interval, so a department is the sharper channel, not the safer one.

The company-level subtraction is inherited from Phase 08 and needs only two results pages. The department row is created by Phase 10: one row of one artifact carries both values, both counts, and a lineage certification that the two groups are the same department — the correspondence the attack needs.

The gate chose no remedy, because every remedy changes what the product may publish and each has a consulting cost only the owner can weigh. It was raised as **P-009** with three costed options. The intake and processor boundaries are untouched, and the recovery is exact only under a stable-population assumption the product can neither detect nor warn about.

**The owner answered on 2026-09-10: option 3, accept and declare.** No restriction was added to what a round may publish. That answer made the caveat wording the entire control, so the declaration was brought up to the job (D-086 below). CE-001 therefore does not block — it is accepted knowingly and stated plainly — but it is **not closed**: a per-person score remains derivable from published output by design, and an independent privacy reviewer has still not seen it. P-008 continues to require that sign-off before any real respondent data is collected.

### D-086 — what "declare" obliged

The wording as it stood was not adequate to be the control. `CONTRIBUTORS_CHANGED` *reassured* ("the difference is descriptive and does not mean the same people changed their minds"), the standing limitation *hedged* ("may narrow what a reader can infer"), and nothing told a reader when they were in the sharp case. The limitation now states the consequence — one person's individual result is derivable from the published figures alone — and a new `POPULATION_CHANGE_SMALL` caveat fires **only** where the two rounds' contributor counts differ by fewer than the publication threshold, on the staff comparison screen and in both report formats, in both languages. A caveat printed on every comparison would declare nothing. This is a disclosure statement, not a control: it does not make the inference harder.

### CE-002 — repaired

Every bar-chart label in the Arabic report was silently cut to its tail, because the `<svg>` inherited `direction: rtl` and `text-anchor="end"` anchored the logical end, and because the opaque track is painted after the label. Repaired in `src/report-html.ts` with an explicit `direction="ltr"` drawing context and visible truncation at 26 characters; the full label stays in the table beneath. Found by rasterizing rendered pages and looking at them (D-084).

### Changed files

New: `tests/checkpoint-e.test.ts`, `docs/orgfit/checkpoint-e.md`.

Modified: `src/report-html.ts` (the CE-002 repair), `src/comparison.ts`, `src/history-i18n.ts` and `src/report-i18n.ts` (the D-086 declaration), `docs/orgfit/decisions.md` (D-084, D-085, D-086, P-009), `docs/orgfit/phase-status.md`, `README.md`, `package.json` (`test:checkpoint-e`), `.github/workflows/ci.yml`.

No migration was added or altered. No unrelated module was modified, and no test was weakened.

### Tests actually run

Local PostgreSQL 18.4 loopback cluster, Node 24.13.1, Chromium via Playwright, on Windows 11.

| Suite | Result |
|---|---|
| `npm run test:checkpoint-e` (11 checks) | 11 pass |
| `npm run test:reports` (17 checks) after the CE-002 repair | 17 pass |
| `npm run test:publication`, `test:history`, `test:comparison`, `test:checkpoint-d` | pass |
| all of the above re-run after the D-086 declaration change | pass |
| `npx playwright test tests/browser/{reports,results}.spec.ts` | pass |
| `npm run typecheck`, `npm run lint` | clean |

**Artifacts actually inspected.** Four PDFs and two workbooks produced by the real renderer under the real `orgfit_report` credential were opened: a 10-page long-Arabic report and an 8-page comparable report rasterized and looked at, with the chart region re-cropped at 3× before and after the CE-002 repair; two workbooks unzipped part by part.

Not run: the `foundation`, `directory`, `instruments`, `scoring`, `campaigns` and `respondent` browser specs, `npm audit`, `test:production`, and the DB suites unaffected by the one-file repair (they passed unchanged in the Phase 11 handoff).

### Exact next action

**Phase 12 — physical field visits and attachments**, as development work only. Read the Phase 12 prompt first.

Carry two things forward. First, CE-001 is accepted, not closed: nothing in Phase 12 should be built as though a per-person score were unreachable, and the independent privacy review P-008 requires must still see it. Second, if that reviewer disagrees with option 3, options 1 and 2 of P-009 remain available and CE-001's measurement in `tests/checkpoint-e.test.ts` is already written as the regression that would prove either control works.

## Phase 12 handoff — 2026-09-10

- Step and status: **COMPLETE for the development field-visit scope.** Not a production security approval, and not a claim that uploaded files are safe. Checkpoint F has not run.

### What was built

Physical field visits, follow-up actions and quarantined private attachments, kept structurally apart from survey data. Full record in [visits.md](visits.md).

- **`db/migrations/015_visits.sql`** — `core.field_visit`, `core.visit_follow_up` and `core.attachment` with lifecycle triggers, RLS and no grant to any runtime credential; the staff routines `visit_guard`, `visit_consultants`, `visit_eligible_consultant`, `save_visit`, `visit_transition`, `visits`, `visit_detail`, `save_follow_up`, `visit_follow_ups`, `begin_attachment`, `complete_attachment`, `attachment_download`, `delete_attachment`; and the scanner's three routines `claim_attachments`, `record_scan`, `expire_attachments`.
- **`db/roles.sql`** — adds `orgfit_scanner`, a fifth login identity with no table privilege anywhere and no CONNECT on the anonymous database.
- **`src/attachment-scan.ts`** — pure: no database, clock, network or authorization. Magic-byte typing, OOXML part inspection, executable and archive signatures, active-markup detection and the EICAR marker, with the declared type and the file extension both required to agree with the bytes.
- **`src/attachment-storage.ts`, `src/attachment-types.ts`** — a separately keyed private store under its own `attachments/` prefix, and a dependency-free module holding the allowlist and limits so the browser form does not pull in the object-store client.
- **`src/scanner-db.ts`, `src/attachment-worker.ts`, `scripts/scan-attachments.ts`, `scripts/expire-attachments.ts`** — the scanner process, its credential guard and its readiness assertion, plus retention.
- **`src/visits.ts`, `src/visits-i18n.ts`** and a **Visits screen** (`apps/staff/app/organizations/visits-ui.tsx`) — the staff surface, Arabic-default with full RTL: calendar/list with filters, create/edit, transitions, follow-up actions, an internal overdue list, and attachments showing their scan status before anything else.

### The properties that matter

A visit's separation from survey data is a property of the schema: `core.field_visit` may reference `core.assessment_round` and nothing else, and no column in any of the three tables can name a response, an invitation, a participant, a draft or an anonymous row. A completed visit is amended with a reason, never reopened, and its original `completed_at` cannot be rewritten. Attachment bytes are quarantined on arrival and are downloadable only after a **separate credential** has read them back and proved what they are; failure is fail-closed in both directions, so an unreadable object never becomes an available file. Downloads are re-authorized at the moment they are clicked and served under a `sandbox` policy. Nothing in this module sends anything anywhere.

### Changed files and migrations

New: `db/migrations/015_visits.sql`, `src/visits.ts`, `src/visits-i18n.ts`, `src/attachment-types.ts`, `src/attachment-scan.ts`, `src/attachment-storage.ts`, `src/attachment-worker.ts`, `src/scanner-db.ts`, `scripts/scan-attachments.ts`, `scripts/expire-attachments.ts`, `apps/staff/app/organizations/visits-ui.tsx`, `tests/visits.test.ts`, `tests/browser/visits.spec.ts`, `docs/orgfit/visits.md`.

Modified: `db/roles.sql` (the `orgfit_scanner` role), the staff API route (visit routes, the binary upload exception and a `DELETE` export), `apps/staff/app/organizations/[[...path]]/page.tsx` (the `visits` segment), `src/security.ts` (`binaryInput`, and `checkMutation` accepting an octet stream for exactly one route and no media type for `DELETE`), `src/http.ts` (the Phase 12 error codes and a 413 message), `src/i18n.ts` (`tooLarge`), `src/config.ts` (refuse `SCANNER_DATABASE_URL` in the staff process), `src/csp.ts` (see the defect below), `scripts/check-boundaries.ts`, `tests/database.ts` (the new role and its CONNECT), `tests/respondent-fixture.ts` (`visits.manage` granted before the fixture session is issued), `tests/serve.ts` (attachment keys and the scanner URL in the e2e fixture), `package.json`, `.env.example`, `.env.operator.example`, `README.md`, `docs/orgfit/decisions.md`, `docs/orgfit/api-contracts.md`.

No dependency was added. No change to migrations 001–014, the anonymous schema, intake, the gateway, key custody, the scoring engine, the disclosure engine, the recommendation evaluator or the report renderer.

### Tests actually run and exact results

Local PostgreSQL 18.4 loopback cluster, Node 24.13.1, Chromium via Playwright, on Windows 11.

| Suite | Result |
|---|---|
| `npm run test:visits` (13 checks) | 13 pass |
| `npx playwright test tests/browser/visits.spec.ts` (2 specs) | 2 pass |
| `npx playwright test tests/browser/{foundation,reports}.spec.ts` (13 specs) after the CSP repair | 13 pass |
| `npm test`, `test:integration`, `test:directory`, `test:instruments`, `test:scoring`, `test:scoring-db`, `test:checkpoint-b` | pass |
| `test:campaigns`, `test:respondent`, `test:privacy`, `test:checkpoint-c` | pass |
| `test:disclosure`, `test:publication`, `test:recommendations`, `test:checkpoint-d`, `test:comparison`, `test:history` | pass |
| `test:reports` (17), `test:checkpoint-e` (11) | pass |
| `npm run typecheck`, `npm run lint`, `npm run build`, `npm run check:boundaries` | clean |

The attachment checks are driven with real bytes through the real route and scanned by the real `orgfit_scanner` credential: a PDF, a PNG, a Word document, an executable renamed `invoice.pdf`, an HTML page renamed `chart.png`, an SVG renamed `logo.jpg`, a PNG declared as a PDF, the EICAR sample, a macro-enabled document and a document carrying a nested archive — each asserted for its exact rejection code and for remaining undownloadable. An oversize body is refused at the HTTP boundary with the row still `UPLOADING`.

Not run: `test:production`, `npm audit`, the `directory`, `instruments`, `scoring`, `campaigns`, `respondent` and `results` browser specs, and any S3-backed storage path. No real antivirus engine was exercised, because none is integrated.

### Defects found during the phase and repaired

1. **The site policy was overwriting the attachment sandbox policy.** `src/visits.ts` set `Content-Security-Policy: sandbox; default-src 'none'; …` on a downloaded file, and the proxy in `src/csp.ts` then replaced it with the application policy on the way out — so every attachment was being served under `default-src 'self'`, with `'unsafe-eval'` in development. Found by asserting the header on a real download in the browser spec rather than on the route's return value. Repaired by defining `ATTACHMENT_CSP` once in `src/csp.ts` and having the proxy re-assert it for exactly the two file routes; the route still sets it too, so the policy survives either path.
2. **A plpgsql parameter named `attachment` was ambiguous** against the table of the same name, and `core.complete_attachment` failed at runtime with `column reference "attachment" is ambiguous` — invisible to the type checker and to every static review. Renamed throughout.
3. **A transition to the state a visit was already in was accepted as a no-op.** The lifecycle trigger only guards `NEW.state <> OLD.state`, so `SCHEDULED → SCHEDULED` bumped the revision and audited a transition that had not happened. `core.visit_transition` now refuses it explicitly.
4. **The local storage janitor would have deleted live attachment bytes.** It was adapted from the report store, whose artifacts live for a day; attachments live for a year, so an age bound of the orphan window would have removed files a `CLEAN` row still pointed at. It now uses the maximum retention as its bound.

### Open defects, assumptions and production prerequisites

1. **The bundled scanner is not an antivirus engine** — P-010. It will refuse a renamed executable, an HTML page wearing an image name and a macro-enabled document, and it will not recognize a novel malicious PDF or a crafted image-decoder exploit.
2. **Attachment types, size limits and retention are development defaults** — P-007 and P-004. 20 MiB and 365 days are proposals.
3. **Neither the attachment store nor its lifecycle rule was exercised against S3.** The bucket rule on `attachments/` is documented, not verified, and unlike `reports/` it is not a one-day rule.
4. **Preview is sandboxed, not proven safe.** A browser rendering a malicious PDF is still doing so; the policy limits what it could then reach.
5. **Attachment encryption reads a key from the environment.** There is no managed key service here either — P-003.
6. **A visit cannot record which named person was met.** That is the deliberate cost of D-087; the directory is where identified people live.
7. CE-001 is unchanged by this phase and remains accepted, declared and unreviewed. P-001 through P-008 remain unapproved.

### Confirmation that unrelated modules were preserved

Migrations 001–014 are unchanged and their checksums still match. The anonymous schema, the gateway, the intake path, key custody, the scoring engine, the disclosure engine, the recommendation evaluator and the report renderer were not modified. The only behavioural change outside Phase 12 is the CSP repair above, which affects the two attachment routes and leaves every other response's policy byte for byte as it was — asserted by re-running the foundation browser specs. No test was weakened.

### Commit

`95c72fa` — unchanged. This session created no commit.

### Exact next action

**Phase 13 — localization, mobile, accessibility and complete journey refinement.** Read its prompt first, with [respondent.md](respondent.md), [foundation.md](foundation.md) and [visits.md](visits.md).

Carry three things forward. The visits screens are new and have had **one** 320px check and no keyboard or screen-reader pass, so they are Phase 13 work rather than finished. The attachment upload is the only route in the product that accepts a non-JSON body, and its error states — oversize, rejected, scan failed — must read truthfully on a phone in both languages. And CE-001 remains open for the independent privacy review P-008 requires; nothing in Phase 12 changed what is derivable from published output.


## UI/UX design-system pass — 2026-09-11 — COMPLETE

**This is not Phase 13, and Phase 13 is not started.** The owner supplied a brand identity package and asked for a design-system pass over everything built through Phase 12, plus reusable patterns for the phases still to come. No business behaviour, permission, lifecycle, scoring, disclosure or privacy control was changed. Two latent defects the work exposed are repaired and recorded below.

### Brand reference files used

Everything in [docs/identityreference/](../identityreference/) was read.

| File | What was taken from it |
|---|---|
| `OrgFit Identity.dc.html` | The symbol's construction (three rhombic units on a plumb line, the middle one displaced 0.5U toward the writing hand and carried in clay, 20° pen angle), the two lockups and why A is preferred, clear space = 1U, the 24px bare-symbol minimum and the 16px squared-tile form, and the 120px width below which the Arabic descriptor is dropped. |
| `OrgFit Signature System.dc.html` | The palette as actually used, the typographic roles (Zain display, IBM Plex Sans Arabic body, IBM Plex Mono for numerals and Latin micro-labels), the in-platform screen in **section 04** — ink bar, quiet rail, work on limestone, mono stat readouts, hairline rules — and the greyscale-proof rule in section 05: *the information is in the shape, not the colour*. |
| `screenshots/` (18 PNGs) | Read for direction. `hero.png` and the `01`–`04` series are an **earlier exploration (v1/v2)**; the two `.dc.html` documents are marked PASS 02 and are the later, authoritative artefact, so where the two disagree the documents won. |
| `Canvas.dc.html`, `support.js`, `.thumbnail` | Canvas shell and vendored runtime. No design content; `support.js` is now lint-ignored as reference material rather than product source. |

Colours taken verbatim: ink `#191614`, ink-soft `#3A342E`, ink-mute `#625B53`, ink-faint `#9A9186`, limestone `#E4DCCF` / `#EFE8DD` / `#F7F3EC`, rule `#CFC7BA` / `#E3DCD1`, clay `#9A4E2A`, clay-light `#C97B52`.

### Design-system decisions and component patterns created

Recorded as **D-091 … D-099** in [decisions.md](decisions.md). In short:

- **Token architecture** — three layers in `src/theme.css`: BRAND (identity primitives in the identity's own words), SEMANTIC (the only layer a component may read), COMPONENT. A rebrand edits layer 1. `--radius: 0` because the identity is a drawn system of hairline rectangles.
- **`src/ui.tsx`** — a shared, pure-presentation module usable by both apps and by both server and client components: `Mark`, `MarkTile`, `Lockup`, `Micro`, `Label`, `Num`, `Badge`, `Alert`, `EmptyState`, `LoadingState`, `ErrorState`, `DeniedState`, `PageHeader`, `Tile`, `Meter`, `Sparkline`, `Modal`. It imports nothing from the data layer, so it is legal in the respondent build.
- **`apps/staff/app/shell.tsx`** — `Workspace` (ink app bar + section rail + canvas, the layout of signature-system section 04) and `Frame` (screens with no organization). One `<main id="main">` lives here. A rail entry whose permission the viewer lacks is not rendered at all.
- **No component emits a `style` attribute.** Dynamic geometry is SVG. This is a CSP consequence, not taste — see the defects below.
- **Latin-only vs localized small text** are different components, because letter-spacing and `text-transform` are Latin-only operations.
- **Every status carries a word and a glyph**; the hue only reinforces. The heatmap's absent cell is hatched, not shaded.
- **Four distinct absent-state shapes** so "empty", "loading", "failed" and "not permitted" cannot be mistaken for one another.
- **Brand typography self-hosted** through `@fontsource` because `font-src` is `'self'`; the CSP is unchanged.

### Screens and routes improved

| Route | What changed |
|---|---|
| `/login` | Lockup A at the one size the identity keeps the Arabic descriptor at; the sign-in action is the page's single primary control. |
| `/` (workspace home) | App bar, page header, organization list as a real record list with codes in mono, account panel, empty state. |
| `/organizations` and `/organizations/{id}/{overview,settings,departments,participants}` | Workspace shell with the section rail; organization facts as stat tiles; record lists as cards with a filter toolbar; permission-denied and empty states. |
| `/organizations/{id}/assessments`, `/campaigns/{id}` | Shell; series and rounds as carded lists; the campaign's lifecycle state as a labelled badge. **The assessments link was `//assessments`** — a protocol-relative URL to a host named `assessments`. Repaired. |
| `/organizations/{id}/results/{round}` | Shell; tabs; contributor/threshold/release as tiles with provenance beneath; **score and distribution bars rebuilt as SVG** (see defect 1); radar gained axes and per-dimension nodes with the weakest dimension in clay; band column as a badge; heatmap in a sticky-header scroll box. |
| `/organizations/{id}/history` | Shell, page header, comparison tables in scroll boxes. |
| `/organizations/{id}/visits` | Shell, filter toolbar, visit state as a badge, list card with empty state, confidentiality notes as qualifying notes rather than warnings. |
| Reports panel | Card with a request toolbar, job state as a badge, download as a secondary button that exists only for a `READY` rendering. |
| `/questionnaires/**` | App bar and page header, controls as one toolbar, library as cards with the "illustrative, not scientifically validated" caveat carried as a badge, validation checklist as an assertive alert. |
| Respondent `/s` — welcome, privacy notice, form, progress, save/resume, review, validation, submission, locked confirmation, campaign error states | Rebuilt for the phone first: privacy notice as a card with the limits inside the same block as the promise; rating scales as a wrapping band of ≥44px targets; matrix as one labelled group per row; a discrete section stepper plus an answered count; a save chip whose glyph sits outside the live region; a sticky action bar below 44rem; an **actionable** error summary that moves to the question's section, focuses its control and shows an inline message; the irreversible submission behind a real `role="dialog"`. |

### Changed files

New: `src/ui.tsx`, `apps/staff/app/shell.tsx`, `apps/staff/app/icon.svg`, `apps/respondent/app/icon.svg`, `scripts/showcase.ts`.

Modified: `src/theme.css` (rewritten), `src/i18n.ts`, `src/respondent-i18n.ts`, `src/report-theme.ts`, `apps/staff/app/page.tsx`, `apps/staff/app/login/page.tsx`, `apps/staff/app/organizations/{directory,campaigns,results,history,visits,reports}-ui.tsx`, `apps/staff/app/questionnaires/workspace.tsx`, `apps/respondent/app/page.tsx`, `apps/respondent/app/survey-ui.tsx`, `eslint.config.mjs`, `package.json`, `tests/oidc-provider.ts` (staff origin is now a parameter), `tests/browser/published-round.ts` (origin from the environment), `tests/browser/results.spec.ts` (one assertion re-pointed at the stat tile).

No migration, no schema change, no API change, no route added or removed.

### Tests and checks actually run

Local PostgreSQL 18.4 loopback cluster on 55432, Node 24.13.1, Chromium via Playwright, Windows 11.

| Check | Result |
|---|---|
| `npx playwright test` — all 28 browser specs | **28 passed** |
| `npm test`, `test:integration`, `test:directory`, `test:instruments`, `test:scoring`, `test:scoring-db`, `test:checkpoint-b` | pass |
| `test:campaigns`, `test:respondent`, `test:privacy`, `test:checkpoint-c` | pass |
| `test:disclosure`, `test:publication`, `test:recommendations`, `test:checkpoint-d`, `test:comparison`, `test:history` | pass |
| `test:reports`, `test:checkpoint-e`, `test:visits` | pass |
| `npm run typecheck`, `npm run lint`, `npm run build`, `npm run check:boundaries` | clean |

**Visual and behavioural inspection**, by hand in Chromium against `npm run showcase` (staff 3100, respondent 3101, test identity provider 4110, with a real published round and a live one-use invitation):

- Sign-in, workspace home, organization overview, assessments, campaign detail, results (overview / departments / question analysis / recommendations / reports tabs), field visits, questionnaire library — Arabic RTL at desktop and at 320px, English LTR at desktop.
- Respondent journey walked end to end at 375px: welcome and privacy notice → form → rating scale → save state → review → validation summary → jump-to-question with focus → confirmation dialog → locked acceptance.
- **Horizontal-overflow check**: `document.scrollWidth` vs `clientWidth` at 320px on the results screen. It was **715px against 320px before** and is 320 against 320 after; the two causes are recorded as defects 3 and 4 below.
- **CSP check**: the browser console was read on the results screen. 299 `Applying inline style violates … style-src` violations were present; after the repair the only `[style]` elements left in the document are `NEXTJS-PORTAL`, `NEXT-ROUTE-ANNOUNCER` and Next's dev-overlay script — none from product markup.
- Keyboard: focus ring visible on the ink app bar (clay, 3px, 3px offset) and on scale options; tab order follows document order; the survey's jump-to-question moves focus to the control.

### Defects found during this pass and repaired

1. **Every published score bar was rendering empty.** `results-ui.tsx` sized bar fills with `style={{ inlineSize: … }}`, and both origins run under `style-src 'self' 'nonce-…'` with no `'unsafe-inline'`, which makes a `style` attribute inert. The bars had no width in a real browser and nothing reported it — the value beside them was correct, so the screen looked merely plain rather than broken. Rebuilt as SVG (`<Meter>`), whose `width` is a presentation attribute and not CSS. D-092.
2. **Arabic was being letter-spaced.** The identity's tracked uppercase micro-label was applied to localized strings, which pulls Arabic's connected letterforms apart — `مساحة العمل` rendered as `م س ا ح ة`. Split into `<Micro>` (Latin only, `lang="en"`) and `<Label>` (localized). The same class of error applied monospace to Arabic stat values, which the mono face cannot set; `<Tile>` now chooses the face from the value. D-094.
3. **A 320px viewport scrolled sideways.** `.stack` was an implicit `auto` grid track, sized by its widest child's min-content, so one long string widened the page. It is now `minmax(0, 1fr)`, and the section rail carries `min-inline-size: 0`.
4. **Wide result tables had no scroll box.** Six `.result-table` instances in the results and history screens were bare. All are wrapped in `.table-wrap.scroll`, with the row header sticky in the department heatmap.
5. **A rating option's radio could not be clicked.** The first implementation shrank the input to 1px with `pointer-events: none`, leaving the numeral span as the only hit target — fine for a mouse, but the control itself was unreachable, and Playwright's `check()` proved it. The input now covers the whole option box invisibly, so the entire 44px cell is the native control.
6. **A live region was announcing a decorative glyph.** The save chip's `✓`/`×`/`•` sat inside the `role="status"` element. `aria-hidden` keeps it out of the accessibility tree but not out of the region's text. Moved outside it.
7. **The campaigns screen linked to `//assessments`** — a protocol-relative URL naming a host, not a route. Removed with the per-screen headers.

### Remaining UI/UX work reserved for Phase 13

- **Report PDF typography.** `src/report-theme.ts` now carries the identity palette, but `src/report-fonts.ts` still embeds Cairo and Noto Sans. Moving the renderer to Zain and IBM Plex is a font-embedding change with its own PDF evidence to produce, and **no PDF was re-rendered in this pass** — the retheme is asserted by the token table and by the renderer reading only tokens.
- **A real accessibility audit.** No automated tool (axe, Lighthouse) and no screen reader were run. Contrast ratios were computed by hand for the main text pairs and are recorded in `src/theme.css`; the rest of WCAG is unverified. Nothing here may be described as a conformance claim.
- **Screen-reader passes** on the visit screens and the questionnaire builder, which are the two densest surfaces and have had none.
- **A locale switch reachable from every screen.** It still lives only on the workspace home and the sign-in page; it was deliberately not duplicated into the app bar because doing so would have made `getByLabel("اللغة")` ambiguous on the home page and silently weakened an existing test.
- **The questionnaire builder's interior** (question editor, rules editor, scoring sandbox) received the token layer and the shell but no structural redesign.
- **A drawer pattern** is defined in CSS and unused; the first screen that needs one should be the one that proves it.
- Tablet-width layouts were reasoned about through the 64rem rail breakpoint but **checked only at desktop, 375px and 320px**.

### Assumptions and unresolved brand-reference gaps

1. **The identity supplies no functional status palette.** It is ink plus one clay, deliberately. Success/caution/danger/neutral were introduced as a functional set in the same muted earth register (`#3F5F3A`, `#7A5C12`, `#8A2015`) and are never the only carrier of a state. If the owner has a status palette, replacing three tokens is the whole change.
2. **The identity's Arabic wordmark is not a finished drawing.** Its own production note says the Arabic descriptor is set in Zain with tight typographic control rather than drawn as final vector lettering, and that the final drawing needs a session with an Arabic lettering specialist. The product therefore uses the Latin `ORGFIT` in the app bar and shows the Arabic descriptor only in Lockup A on the sign-in page, at a size above the identity's 120px minimum.
3. **No dark theme.** The identity is a light limestone system and specifies no dark rendering; inventing one would be inventing identity. `color-scheme: light` stands, and `prefers-contrast: more` is honoured.
4. **Chart scale steps** (`--chart-scale-1…5`) are interpolated between limestone and clay. The identity defines no five-step scale.
5. **The screenshots and the `.dc.html` documents disagree** (v1/v2 exploration vs PASS 02). The documents were treated as authoritative.
6. **Pantone 7523 C**, named in the identity for single-colour print, is a print instruction and has no screen equivalent applied here.

### Confirmation that behaviour was preserved

Migrations 001–015 are untouched. No API route, request shape, response shape, capability check, campaign transition, disclosure rule, scoring path, export control or attachment control was modified. Organization isolation, authentication, the anonymous survey architecture, one-use links, publication gating and visit permissions are unchanged and are asserted by the same suites that asserted them before, all of which pass. One test assertion was re-pointed (`results.spec.ts`, the contributor count moved from a `<dd>` to a stat tile) with its force unchanged: the published figure must still be visible beside its own label. No test was weakened or skipped.

### How to look at it

```
npm run showcase
```

Brings the whole product up on **staff `http://127.0.0.1:3100`**, **respondent `http://localhost:3101/s`** and a test identity provider on `4110`, with a real published round and a live one-use invitation printed on the console. It uses its own throwaway databases and its own port pair so it does not collide with `npm run test:e2e` — but Next refuses two dev servers from one app directory, so only one of the two may be up at a time.

### Commit

`57a2d3a` — **Add the implementation through Phase 12 and the UI/UX design-system pass**, on `main`, parent `95c72fa`.

This is the first commit to carry any code. `95c72fa` held only the blueprint and the phased workflow; everything Phases 02–12 produced had been left uncommitted in the working tree across sessions, so this one commit records that body of work together with the design pass made on top of it. It is a single commit because the earlier phases' history cannot be reconstructed after the fact — not because they belong together. 238 files. The repository has no remote and nothing was pushed.

`.gitignore` keeps `work/`, `node_modules/`, `.next/` and every `.env.*` out; only the two `.env*.example` templates are tracked, and they carry placeholders. `.gitattributes` pins `*.sql` to LF, and the stored migration blobs were checked to contain no CR, so the migration checksums are stable across a Windows or Linux checkout.

### Exact next action

**Phase 13 — localization, mobile, accessibility and complete journey refinement**, as the Phase 12 handoff already directed. Read its prompt with [respondent.md](respondent.md), [foundation.md](foundation.md) and [visits.md](visits.md), and start from the "Remaining UI/UX work" list above: the report renderer's typography, a real accessibility audit with a tool and a screen reader, the visit screens' keyboard and screen-reader pass, and tablet widths. The design system those phases should build on is `src/theme.css`, `src/ui.tsx` and `apps/staff/app/shell.tsx`; new screens should reach for its components rather than restating markup.


## Handoff format for subsequent steps (template)

- Step and status: COMPLETE / BLOCKED / IN PROGRESS.
- Implemented behavior or design artifacts.
- Changed files and migrations.
- Tests actually run, environment and outcomes; explicitly list required checks not run.
- Regressions found and fixes verified.
- Open defects, assumptions and production-only prerequisites.
- Exact next phase/checkpoint and relevant files to read.
- Commit/release identifier when available.

Do not mark a checkpoint passed solely because its preceding phase is implemented.
