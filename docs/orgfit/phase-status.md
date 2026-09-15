# OrgFit phase status

Updated: 2026-09-15

## Current position

**Checkpoint G has run: technical GO as an implementation gate, NO-GO for production.** The candidate is now **`orgfit-0.3.0-rc.2` (commit `e801b9a`)** after one correction (CG-001: the overview page no longer claims an independent privacy review is under way). See [checkpoint-g.md](checkpoint-g.md). Phases 00–15 are complete and Checkpoints A–G have run. Field visits, follow-up actions and quarantined private attachments are implemented and tested; see [visits.md](visits.md). Checkpoint E's record remains [checkpoint-e.md](checkpoint-e.md).

**CE-001 is real, accepted and declared — not closed.** An individual contributor's own score is recoverable from two published releases: to within about a point at company level, and **to 0.01 of a point from a single department row of a reviewed comparison**, measured against independently recomputed true scores. The gate returned BLOCKED and escalated it as P-009 rather than choosing a remedy, because every remedy changes what the product may publish. **The owner answered on 2026-09-10: accept and declare.** That made the caveat wording the whole control, so the wording was rewritten to state the consequence instead of reassuring, and a targeted caveat now fires only where two rounds' contributor counts differ by fewer than the threshold (D-086). Nothing else in the gate blocked; CE-002, a chart-label defect found by looking at rendered pages, was repaired.

**This is not production readiness, not a privacy approval and not a proof of anonymity.** A per-person score is derivable from published output by design and with the owner's knowledge, and **an independent privacy reviewer has not yet seen CE-001** — P-008 still requires that before real respondent data is collected. The privacy processor still decrypts every accepted answer for an eligible campaign; that is an explicit trust assumption, not a cryptographic property. The key custody adapter is a local development stand-in with no backup-safe crypto-erasure. The disclosure controls are k-thresholding plus complementary and homogeneity suppression — not differential privacy. Recommendation texts, band names and report wording are synthetic and illustrative. P-001 through P-008 remain unapproved, P-009 is answered, and P-010 is new and open. Uploaded visit attachments are type-verified and heuristically scanned, not scanned by an antivirus engine.

Phase 12 adds a **new** production input: **P-010**, a maintained malware scanning engine for visit attachments. The bundled scanner is a content verifier — magic-byte typing, OOXML part inspection and the EICAR marker — and no deployment may treat its `CLEAN` verdict as a malware guarantee.

**2026-09-13:** a branded overview page at `/`, staff sign-in, invitation-only activation and a development-only password path with a seeded local Super Admin were added outside the phase sequence — see the entry near the end of this file and [landing-and-access.md](landing-and-access.md). The workspace home is now `/workspace`.

**2026-09-14, after Checkpoint G:** Post-Audit Repair Pass 1 added the staff, audit, settings and profile screens and real pagination (migration 019) — see its entry near the end of this file. The production NO-GO is unchanged.

**2026-09-15:** Post-Audit Repair Pass 3 added release withdrawal, a local job supervisor with job health, runtime TLS guards and repaired a report-queue crash-recovery defect (PR3-001), migrations 022–023 — see its entry near the end of this file. Still development only; the production NO-GO is unchanged.

**2026-09-15, later:** Post-Audit Repair Pass 4 added the production-security adapters that can be built without provider choices — a malware-engine adapter with an active-document policy, a key-custody provider interface that production refuses to run on the development stand-in, staff-side rate limits with an explicit trusted-proxy decision, a sealed tombstone ledger with an Object Lock bucket sink, and an audited restore-incident intake erasure — and repaired a restore defect (PR4-001), migration 024. **No engine, key service, bucket, proxy or IdP was selected or verified; with no managed key custody, no production environment passes preflight.** See its entry near the end of this file. The production NO-GO is unchanged.

Next step: **none in the phase sequence.** What remains is owner input (P-001 … P-008, P-010, itemized in checkpoint-g.md §6) and, only with explicit authorization, staging and deployment. Nothing may be deployed without explicit authorization. Earlier handoffs remain historical evidence, including the record of the Phase 06 request that was correctly blocked before Checkpoint B ran.

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
| 13 | Localization/mobile/accessibility refinement | COMPLETE — development evidence below; no real device or screen reader |
| F | Full functional journey checkpoint | PASS — checkpoint-f.md (implementation gate; emulated devices only) |
| 14 | Security/retention/backups/resilience | COMPLETE — security-review.md, privacy-verification.md, retention-backup-runbook.md, incident-runbook.md, performance-results.md |
| 15 | Release candidate/production readiness | COMPLETE — release candidate `orgfit-0.3.0-rc.1` (`ef914d8`); NO-GO for production; final-handoff.md, release-checklist.md, deployment-runbook.md, staff-operations-guide.md |
| G | Final go/no-go checkpoint | RUN — technical GO (implementation gate), production NO-GO; candidate `orgfit-0.3.0-rc.2` (`e801b9a`); checkpoint-g.md |
| PR1 | Post-Audit Repair Pass 1: administration screens and pagination | COMPLETE (development) — entry below; D-128 … D-135 |
| PR3 | Post-Audit Repair Pass 3: release revocation, supervised jobs, runtime safeguards | COMPLETE (development, local only) — entry below; D-145 … D-154 |
| PR4 | Post-Audit Repair Pass 4: production-security adapters and remaining technical blockers | COMPLETE for in-repository work (development, local only); external integrations NOT DONE — entry below; D-157 … D-162 |

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


## Branded landing page, authentication, and development admin bootstrap — 2026-09-13 — COMPLETE (development)

**This is not Phase 13, and Phase 13 is not started.** The owner asked for a public overview page in the existing identity, an email/password staff sign-in, invitation-only staff activation as the scoped meaning of "signup", and a seeded local Super Admin. The internal-only access model is unchanged: no public registration, no client or respondent accounts. Full record: [landing-and-access.md](landing-and-access.md). Decisions: D-100 … D-106.

**The password path is development-only.** A password session satisfies no second factor. Migration 016 leaves it switched off; only the development bootstrap, which refuses production and non-loopback databases, turns it on. Production authentication is still OIDC with MFA under P-005.

### Brand references and installed skills used

- [docs/identityreference/](../identityreference/) through the existing token layers in `src/theme.css` and components in `src/ui.tsx` (the `Mark`, ink/limestone/clay, Zain / IBM Plex Sans Arabic / IBM Plex Mono, zero radius, hairline rules, the greyscale-proof rule, the 120px descriptor rule). No new colour, face or token was introduced.
- Skill `anthropic-skills:impeccable` (read and applied: persuade-mode page, no eyebrow labels on the landing, no identical-card grid, one authored motion moment, drawn icons, contrast/focus/state floor). `anthropic-skills:frontend-design` was listed but not separately loaded. No dedicated accessibility-audit skill or tool (axe, Lighthouse, screen reader) was available or run.

### Routes and screens

`/` public overview page (header with lockup, section nav, AR/EN switch, sign-in; hero with a labelled synthetic figure; capabilities; workflow; privacy with its limit; product panels; FAQ; closing action; footer). `/workspace` — the former home, moved. `/login` — email/password + identity provider + generic errors, 429 state, expired-session state. `/activate#<token>` — missing, invalid, expired, used, withdrawn, valid form, activated. APIs: `POST /api/v1/auth/password`, `/auth/invitation`, `/auth/activate`; Super Admin `GET/POST /api/v1/staff/invitations`, `POST …/:id/revoke`.

### Changed files and migrations

New: `db/migrations/016_local_access.sql`; `src/password.ts`, `src/password-policy.ts`, `src/local-auth.ts`, `src/landing-i18n.ts`, `src/landing.css`; `apps/staff/app/page.tsx` (overview), `landing-ui.tsx`, `figures.tsx`, `login/login-form.tsx`, `activate/page.tsx`, `activate/activate-form.tsx`; `scripts/bootstrap-dev-admin.ts`, `scripts/provision-dev.ts`; `.env.bootstrap.example`; `tests/access.test.ts`, `tests/browser/access.spec.ts`; `docs/orgfit/landing-and-access.md`.

Moved: `apps/staff/app/page.tsx` → `apps/staff/app/workspace/page.tsx`.

Modified: `apps/staff/app/api/v1/[...path]/route.ts` (three pre-session endpoints, invitation administration, OIDC callback lands on `/workspace`), `login/page.tsx`, `shell.tsx` and the organization/questionnaire pages (links to `/workspace`, `?expired=1`), `src/i18n.ts`, `src/http.ts` (`RATE_LIMITED` 429), `src/security.ts` (`invitationInput`), `package.json` (`db:provision-dev`, `db:bootstrap-dev-admin`, `test:access`), browser specs re-pointed from `/` to `/workspace` (assertions unchanged in force), `README.md`, `decisions.md`, this file.

Migration 016 restates the audit action/field CHECK lists from 015 plus `INVITATION_CREATED`, `INVITATION_ACCEPTED`, `PASSWORD_SET` and `password`; replaces `access.actor()`; relaxes `staff_session_mfa_verified_check` for `auth_method='PASSWORD'` only. Migrations 001–015 are untouched.

### Seed outcome

A persistent local database `orgfit_dev` was provisioned on the loopback development cluster (127.0.0.1:55432) and the development Super Admin was **created** with the requested address, role `SUPER_ADMIN` and display name. A second run reported **already present** and changed nothing. The credential was read from the ignored `.env.bootstrap`, is not in any tracked file, log, screenshot or document, and the password met the enforced policy. (The scratch `orgfit_dev` created minutes earlier in the same session was dropped once and re-provisioned to correct migration 016 before it was ever committed; it held no work.)

Real sign-in was verified over HTTP against the running application: correct credentials → 200 with the session cookie; `/api/v1/profile` → `SUPER_ADMIN`, the requested display name; `/workspace` → 200; Super Admin API → 200; wrong password → 401; unknown address → 401 with the same message; cross-origin POST → 403; logout → 204, then profile 401 and `/workspace` → `/login?expired=1`; anonymous `/workspace` → `/login`; anonymous API → 401; `/` → 200.

### Tests and visual checks actually completed

Local PostgreSQL 18.4 loopback cluster, Node 24.13.1, Chromium via Playwright, Windows 11.

| Check | Result |
|---|---|
| `npm run test:access` (A-0 … A-7) | **8 passed** |
| `npm test`, `test:integration`, `test:directory`, `test:instruments`, `test:scoring`, `test:scoring-db`, `test:checkpoint-b`, `test:campaigns`, `test:respondent`, `test:privacy`, `test:checkpoint-c`, `test:disclosure`, `test:publication`, `test:recommendations`, `test:checkpoint-d`, `test:comparison`, `test:history`, `test:reports`, `test:checkpoint-e`, `test:visits` | all pass (5/8/6/8/15/5/3/18/24/17/21/16/13/13/18/13/8/17/11/14) with migration 016 applied |
| `npx playwright test` (all specs, including 4 new) | **32 passed** (final full run, after the last repairs) |
| `npm run typecheck`, `npm run lint`, `npm run build`, `npm run check:boundaries` | clean |

Visual and behavioural inspection (dev server against `orgfit_dev`, plus scripted Chromium): Arabic RTL and English LTR at 1440px; 768px; 720px (the 200%-zoom equivalent of 1440); 375px and 320px — no horizontal overflow on `/`, `/login`, `/activate`; an injected 40-character unbroken Arabic run in the hero at 320px; mobile menu open/close, Escape returns focus; keyboard tab order skip link → brand → four section links → language → sign-in, each with the 3px clay outline; reduced motion (`animation-name: none`, `scroll-behavior: auto`) vs. the one load-time animation otherwise; login generic error; activation missing state. Production build started **unconfigured**: `/`, `/login`, `/activate`, `/workspace` all 200 with no console CSP violation and no product `style` attribute (in development, the only `[style]` elements are Next's overlay, as in the design pass).

Defects found by this verification and repaired: unknown address answered **503 instead of 401** (an enumeration signal); mobile menu rendered open (`display:grid` beat `[hidden]`); menu sign-in button text nearly invisible (link colour beat button colour); footer descriptor muted-on-ink; workspace `main` padding opened a gap under the header; Arabic figure labels clipped outside the SVG (text anchor wrongly swapped under RTL); unbroken text could widen a 320px page; `/login` **threw 500** when configuration was absent (it rendered an unavailable state before this change); activation ignored a second link pasted into the same tab (fragment-only change); `local_access_enabled()` was not granted to `orgfit_auth`.

### Required checks not run

- No automated accessibility audit (axe/Lighthouse), no screen reader, no measured contrast audit beyond reading the token pairs; no WCAG conformance claim.
- No real browser zoom — 200% was checked as the equivalent CSS viewport width.
- Rate limiting's screen was checked with a stubbed 429; the lock itself is tested at database level (A-5), not through the browser.
- No timing measurement of the equal-cost rejection path; it is equal by construction only.
- MFA for password sessions: none exists, by design; not a check that could pass.
- Remote CI has not run.

### Remaining defects and environment limitations

- **No screen for issuing staff invitations** — the API exists (Super Admin), the UI does not.
- The test harness resets LOGIN role passwords on whatever cluster it uses; with `orgfit_dev` on the same cluster, rerun `scripts/provision-dev.ts` (same `DEV_ROLE_PASSWORD`) after tests. Documented.
- The hero figure's SVG text becomes small at 320–375px; it is labelled for assistive technology and is illustrative, but it is not comfortably readable at that width.
- Crash recovery of the local cluster after the machine restart took about eight minutes because the harness retains every test database.
- P-005 (production identity provider and MFA) is unchanged and still open; nothing here is production authentication.

### Commit

Recorded in the commit that adds this entry, on `main`. No remote, nothing pushed, nothing deployed, no message or invitation sent.

### Exact next action

**Phase 13 — localization, mobile, accessibility and complete journey refinement**, unchanged from the design-pass handoff, now also covering the overview, sign-in and activation screens, and adding an invitation-issuing screen for Super Admins if the owner wants one before Phase 14.

## Phase 13 handoff — 2026-09-13

- Step and status: **COMPLETE for the development localization, mobile, accessibility and journey scope.** Not a WCAG conformance claim, not a real-device result and not production readiness. **Checkpoint F has not run.**

### Implemented behavior

**Respondent journey** ([respondent.md](respondent.md#phase-13-refinements), D-109 … D-111):

- Truthful states for every failure the prompt names: offline, a request past the 20 s limit, a stale save (conflict), a draft first created in another browser (`DRAFT_EXISTS`, previously shown as a generic failure), an ended session (save and submit disabled, instruction to reopen the link), a campaign closed while answering, an already-accepted invitation, and a submission whose response never arrived ("not confirmed; submitting again never creates a second submission"). Start-over now deletes locally only after the server confirmed it.
- Session idle window renewed at most every 5 minutes while answering, through the existing refresh route. Absolute limit unchanged.
- Browser Back/Forward walk sections (history entries carry only a stage and section index); inert after acceptance; unsaved changes trigger the browser's leave prompt.
- Focus moves to each new screen's heading; review jump focuses the control; both dialogs focus Cancel, trap Tab, close on Escape and restore focus.
- Per-field rules shown beside the field with `aria-describedby`, from the same `checkAnswer` the server uses (D-107): number range/precision/format, date bounds, selection counts, length. Constraint hints before errors.
- Arabic-Indic, Persian, Arabic decimal separator and U+2212 accepted; canonical Latin digits sent. Number fields are `type=text` with a numeric input mode.
- Language choice persisted in the survey locale cookie; answers untouched by switching.
- Phone layout: `interactive-widget=resizes-content`; action bar returns to the flow on short (keyboard-up) viewports; 44px targets under a coarse pointer; review list wraps long prompts and keeps page direction; resume code and invitation-link inputs isolated LTR.

**Staff** (D-108, D-112):

- **Timezone defect repaired**: visit and campaign wall-clock times were read in the browser's timezone, and the visit edit form moved a visit by the browser's offset on every save. Now read and shown in the record's zone (`src/zoned-time.ts`); report job times say UTC; overdue follow-ups use the organization's calendar day.
- Language switch in the app bar on every signed-in screen (`apps/staff/app/locale-switch.tsx`), persisted on the profile.
- Arabic-Indic digits accepted in every builder and campaign numeric field.
- Network failures and non-JSON error bodies reported in the reader's language instead of browser/parser text (`apps/staff/app/staff-fetch.ts`, seven screens).
- Attachment refusals (type, size, dropped upload) stated beside the upload control and scrolled into view.
- 13 scrolling table regions keyboard-reachable and named by their caption; two contrast failures repaired; English greeting punctuation.

### Changed files and migrations

New: `src/answer-rules.ts`, `src/zoned-time.ts`, `apps/staff/app/locale-switch.tsx`, `apps/staff/app/staff-fetch.ts`, `tests/localization.test.ts`, `tests/browser/journey-fixture.ts`, `tests/browser/journey.spec.ts`, `tests/browser/localization.spec.ts`, `tests/browser/accessibility.spec.ts`.

Modified: `apps/respondent/app/survey-ui.tsx` (rewritten around the same privacy properties), `apps/respondent/app/layout.tsx` (viewport), `src/respondent-i18n.ts`, `src/scoring.ts` (delegates to `answer-rules`), `src/theme.css`, `src/campaign-i18n.ts`, `src/visits-i18n.ts`, `apps/staff/app/shell.tsx`, `apps/staff/app/workspace/page.tsx`, `apps/staff/app/organizations/{campaigns,directory,history,reports,results,visits}-ui.tsx`, `apps/staff/app/questionnaires/{editors,rules-editor,workspace}.tsx`, `package.json` (`test:localization`; dev deps `@axe-core/playwright` 4.13.0 and `axe-core` 4.13.0, exact, approved by the owner), `package-lock.json`, `README.md`, `docs/orgfit/decisions.md` (D-107 … D-112), `docs/orgfit/respondent.md`, this file.

**No migration, no schema change, no API route or contract change.** Migrations 001–016 untouched.

### Tests actually run and exact results

Local PostgreSQL 18.4 loopback cluster, Node 24.13.1, Chromium (Playwright 1.63.0), Windows 11.

| Check | Result |
|---|---|
| `npm run test:localization` (L-1 … L-4) | 4 pass |
| `npm test`, `test:integration`, `test:directory`, `test:instruments`, `test:scoring`, `test:scoring-db`, `test:checkpoint-b`, `test:campaigns`, `test:respondent`, `test:privacy`, `test:checkpoint-c`, `test:disclosure`, `test:publication`, `test:recommendations`, `test:checkpoint-d`, `test:comparison`, `test:history`, `test:reports`, `test:checkpoint-e`, `test:visits`, `test:access` | all pass (5/8/6/8/15/5/3/18/24/17/21/16/13/13/18/13/8/17/11/14/8) |
| `npx playwright test` — full suite, fresh server, including 10 new specs | **42 passed** (final run) |
| `npm run typecheck`, `lint`, `build`, `check:boundaries` | clean |

What the new browser specs exercise, all against the real gateway and a published instrument carrying every question type, a content block and an unbroken 66-character Arabic prompt: welcome → keyboard-only answer → Arabic-Indic numerals with a range error → language switch both ways → save → reload → same-device resume → Back/Forward → matrix rows as named groups → review → dialog focus/trap/Escape → one submission with canonical digits → Back inert → reopened link locked (320px, touch); multi-tab conflict, draft existing from another browser, private-code resume in English on a second context (375/360px); offline, delayed past the limit, lost finalize response then retry with exactly one envelope and zero drafts; expired session cookie; campaign closed by staff mid-answer; 320×280 keyboard strip including type-then-tap-Save; 640px and 320px (200%/400% zoom widths). axe WCAG 2.0/2.1/2.2 A+AA on respondent screens (blocked, welcome with resume panel, three sections with an error shown, review with missing answers, dialog, accepted) in Arabic at 320px and English at 1280px, and on 15 staff screens plus all five results tabs and the new-visit form in both configurations. Staff: app-bar switch; New York browser scheduling a Riyadh visit; Arabic 320px attachment refusals.

### Defects found during the phase and repaired

1. **Visit times drifted and campaign times used the browser's zone** (D-108). Reproduced before repair: the same browser test against the previous screen stored 13:00Z for a 09:00 Riyadh visit.
2. **Review screen overflowed a 320px page by 55px** on a long Arabic prompt, and rendered answers in mono LTR.
3. **`DRAFT_EXISTS` was shown as a generic "not saved, try again"**, which retrying could never fix.
4. **A lost submission response was reported as "service unavailable"** although the submission may have been accepted.
5. **An ended session and a mid-answer closure on save were reported as "not saved, try again".**
6. **"Copied" was shown even when the clipboard refused.**
7. **Start-over cleared the local draft even when the server refused to delete it.**
8. **Scroll regions unreachable by keyboard** (axe `scrollable-region-focusable`), **rail labels at 2.54:1**, **heat-map secondary text at 4.32:1**.
9. **Staff screens could print "Failed to fetch" or a JSON parser error** in an Arabic interface.
10. **Attachment refusals printed at the top of a long phone page**, out of sight of the control.
11. The respondent language toggle was an ink button on the ink bar; the English greeting used an Arabic comma.
12. **Introduced and caught in this phase:** a focus-keyed rule that un-stuck the action bar moved Save out from under the tap (withdrawn, D-111); new visit tests collided with `visits.spec.ts`'s empty-list assertion in the shared database (moved to organization B; the existing assertion was not weakened).

### Required checks not run, and device limitations

- **No real iOS Safari or Android Chrome device.** Every mobile result is Chromium with viewport, touch and `isMobile` emulation. **WebKit was not installed** (offered; the owner approved axe only), and Firefox was not run. Safari-specific behaviour — `interactive-widget` (unsupported in Safari), date input rendering, visual-viewport keyboard handling, VoiceOver — is unverified.
- **No screen reader** (NVDA, JAWS, VoiceOver, TalkBack) was used. Announcements are inferred from roles, names and live regions, not heard.
- **No manual keyboard pass by a person.** Keyboard coverage is scripted: tab order to the rating scale, focus ring, dialog trap/Escape/return, heading focus.
- **Real browser zoom** was not used; 200% and 400% were checked as equivalent CSS widths.
- axe covers the listed screens only; the questionnaire builder interior (question editor, rules editor, scoring sandbox) was audited only as the library page.
- Not run: `test:production`, `npm audit` (npm reported 0 vulnerabilities while installing axe), remote CI.

### Open defects, assumptions and production prerequisites

1. **Report PDF typography** still embeds Cairo/Noto Sans rather than the identity's Zain/IBM Plex. Deferred deliberately: this phase is functional refinement, and the swap needs its own ToUnicode/searchability evidence (D-078). RTL/LTR of reports and XLSX is unchanged and still asserted by `test:reports` and `test:checkpoint-e`.
2. The native file input's "Choose File / No file chosen" text follows the browser's language, not the page's.
3. Switching staff language reloads the page; an unsaved staff form on screen is lost (the questionnaire builder autosaves).
4. A slow save that completes after the 20 s limit leaves the server one revision ahead; the next save then reports a conflict and offers the newer version — truthful, but a respondent on a very slow link will see it.
5. The organization list option text `name (CODE)` inside a `<select>` cannot be bidi-isolated.
6. CE-001 unchanged, accepted and declared, still awaiting the independent review P-008 requires. P-001 … P-008 and P-010 remain open.

### Confirmation that unrelated modules were preserved

No migration, schema, API contract, capability, lifecycle, disclosure, publication, recommendation, report-renderer, key-custody, intake or gateway routine changed. The scoring engine's public behaviour is unchanged except the documented numeral relaxation (D-107), and every scoring, privacy and checkpoint suite passes. No existing assertion was weakened or removed.

### Commit

`f1d372b` — **Phase 13: localization, mobile, accessibility and journey refinement**, on `main`, parent `28ca5fa`. The ignore rules kept `work/` and every environment file out of it. No remote, nothing pushed or deployed. A stale staff dev server from the previous session was stopped with the owner's approval so the harness could bind port 3000.

### Exact next action

**Checkpoint F — full functional journey**, in a fresh session, with its prompt, this handoff, [respondent.md](respondent.md) and [visits.md](visits.md). Checkpoint F should record plainly which real devices, browsers and assistive technologies are genuinely unavailable rather than treat the emulated runs above as device evidence.

## Checkpoint F handoff — 2026-09-13 to 14

- Step and status: **PASS as an implementation gate.** Full record: [checkpoint-f.md](checkpoint-f.md). Not production readiness, not a privacy approval, not device evidence.

### What was run

`tests/browser/checkpoint-f.spec.ts` (new): ten serial stages of one staff journey in two new synthetic organizations — organizations, departments and a CSV import with errors; clone, edit, scoring preview and publish; series, round, 12-person campaign and 12 links obtained by hand; respondents in Arabic at 320 px (save, second-device resume, keyboard) and English at 375 px; the live outstanding list; close, process, publish; results, departments, questions and recommendations; a second compatible round reviewed on the history screen and an incompatible version refused; Arabic and English PDF and XLSX; a field visit with a follow-up and a scanned attachment; a below-threshold campaign; and organization scoping by a staff member of the other organization. The Phase 13 respondent journey, localization and axe specs were re-run with it.

### Findings

- **CF-001** — the history screen hid comparison review from the Super Admin (UI gate lacked the role clause the server and every other screen apply). Repaired.
- **CF-002** — Arabic classification and reviewer name set in the mono LTR readout, letters disconnected; RTL heading arrow pointed backwards. Repaired.
- **CF-003** — a below-threshold round told staff results "will be available". Repaired without changing the API contract (D-113).
- **CF-004** — signed numbers, percentages and dates reversed beside Arabic on screen and in the Arabic PDF (`10.0-`, `%10.2-`, `14-09-2026`). Repaired (D-113).
- **CF-005** — results tabs `disabled` while loading dropped keyboard focus and left the 320 px tab strip unreachable (found by axe, intermittently). Repaired.
- No privacy leak, no cross-organization access, no core journey failure.

### Changed files

New: `tests/browser/checkpoint-f.spec.ts`, `docs/orgfit/checkpoint-f.md`. Repairs: `apps/staff/app/organizations/{history,results,campaigns,visits}-ui.tsx`, `src/report-html.ts`, `src/theme.css`, `src/results-i18n.ts`, `src/campaign-i18n.ts`. Records: `docs/orgfit/decisions.md` (D-113), this file. No migration, schema, API contract or permission change; no test weakened.

### Tests actually run

See the table in [checkpoint-f.md](checkpoint-f.md#tests-actually-run): the complete node gate (22 suites) and build checks after CF-001; the report, history, comparison, publication and Checkpoint D/E suites after CF-002–CF-004; and the final build checks with the full browser suite — **clean; 52 passed**.

### Genuinely unavailable

No real iOS or Android device, no WebKit or Firefox, no screen reader, no real browser zoom, no manual keyboard pass by a person. Not run: `test:production`, `npm audit`, remote CI, S3, a real antivirus engine.

### Commit

`59c99e3` — **Checkpoint F: full functional journey — PASS, with five repairs**, on `main`, parent `2fcbbc0`. No remote, nothing pushed.

### Exact next action

**Phase 14 — security, retention, backups and resilience**, development work only, in a fresh session. CE-001 and P-008 remain open; P-001 … P-008 and P-010 unapproved.

## Phase 14 handoff — 2026-09-14

- Step and status: **COMPLETE for the development scope.** Not production readiness, not a privacy or security approval, not a proof of anonymity. Recovery and load figures come from one developer machine.

### Implemented behavior

- **Public gateway rate limits** (D-114): exchange per trusted-proxy IP bucket and per token, draft writes and final submissions per session; database-counted fixed windows keyed by windowed HMACs; a limit never touches an invitation; 429 with `Retry-After` and a truthful respondent message.
- **Digest-key rotation window** (D-120): `INVITATION_DIGEST_KEY_PREVIOUS` lets outstanding links open while issuance uses the new key.
- **Retention** (D-115): 16 policy classes seeded as unapproved non-production defaults; core purge, whole-campaign anonymous purge, run ledger, alert while unapproved.
- **Deletion tombstones and restore gate** (D-116): triggers for non-time-derived deletions; ledger shipped outside backups; both readiness endpoints closed until `restore:reapply` replays it; intake re-erased only where nothing further is lost, otherwise an incident keeps the environment closed.
- **Alerts** (`ops:check`): count mismatch, blocked publication, overdue intake, backup staleness, low disk, queue backlogs, export failures, scan backlog, token abuse, retention stale or unapproved, restore pending.
- **Performance repairs found by measurement**: RLS init-plan evaluation (migration 018, D-118) and a hash-keyed published-instrument cache with per-request session checks (D-119).
- **Consistency repair**: dashboard/history dates in UTC like the reports (D-122).
- Respondent `/health/ready`; production smoke asserts headers and CORS; build boundary forbids the operator module in either web app.

### Changed files and migrations

New: `db/migrations/017_operations.sql`, `db/migrations/018_policy_performance.sql`, `db/anonymous/002_retention.sql`, `src/rate-limit.ts`, `src/operations.ts`, `scripts/retention.ts`, `scripts/ship-tombstones.ts`, `scripts/restore-reapply.ts`, `scripts/ops-check.ts`, `apps/respondent/app/health/ready/route.ts`, `tests/operations.test.ts`, `tests/ops/restore-drill.ts`, `tests/ops/load.ts`, `docs/orgfit/security-review.md`, `privacy-verification.md`, `retention-backup-runbook.md`, `incident-runbook.md`, `performance-results.md`.

Modified: `src/respondent.ts` (rate limits, rotation-aware exchange, instrument cache), `src/invitation-token.ts`, `src/gateway-db.ts` and `src/db.ts` (restore gate in readiness), `src/respondent-i18n.ts`, `src/zoned-time.ts`, `apps/respondent/app/public/v1/[...path]/route.ts`, `apps/respondent/app/survey-ui.tsx` (limit states), `apps/staff/app/organizations/results-ui.tsx` and `history-ui.tsx` (UTC dates), `scripts/check-boundaries.ts`, `tests/production-smoke.ts`, `tests/checkpoint-c.test.ts` and `tests/checkpoint-e.test.ts` (deliberate assertion changes, D-121 and D-122), `package.json`, `.env.example`, `.env.operator.example`, `README.md`, `decisions.md` (D-114 … D-122).

Migrations 001–016 are untouched.

### Tests actually run and exact results

Local PostgreSQL 18.4 loopback cluster, Node 24.13.1, Chromium, Windows 11 on a 12-core Snapdragon X Elite with 31.6 GiB.

| Check | Result |
|---|---|
| `npm run test:operations` (O-1 … O-8) | 9 pass (O-1 populated 016→latest upgrade 115 ms) |
| All node suites (gate 1): `test`, `test:localization`, `test:integration`, `test:directory`, `test:instruments`, `test:scoring`, `test:scoring-db`, `test:checkpoint-b`, `test:campaigns`, `test:respondent`, `test:privacy`, `test:disclosure`, `test:publication`, `test:recommendations`, `test:checkpoint-d`, `test:comparison`, `test:history`, `test:reports`, `test:visits`, `test:access` | all pass |
| Gate 1 failures, repaired and re-run (gate 2) | `test:checkpoint-c` 21/21 after D-121; `test:checkpoint-e` 11/11 after D-122; lint clean after removing an unused test import |
| `typecheck`, `lint`, `build`, `check:boundaries`, `test:production` | clean / pass |
| `npx playwright test` (all 52 specs, final run) | **52 passed** |
| Timed restore drill (`tests/ops/restore-drill.ts`) | backup 4.3 s; PITR 7.3 s; data loss 17.4 s; base-only 6.0 s; replay removed revived data before opening; crashed processor resumed marker-first |
| Load (`tests/ops/load.ts`) | all baseline targets met after PERF-1/PERF-2 (see performance-results.md) |
| `npm audit` (all and production) | 0 vulnerabilities |
| Secret scan, tracked files and full history | clean |

**Not run:** real identity provider/MFA, TLS, proxy/CDN/WAF, managed database PITR, S3 lifecycle and KMS deletion, real antivirus, HTTP-level load, penetration test, paging integration, a restore of production-sized data.

### Defects found during the phase and repaired

SEC-F1 no public rate limiting; SEC-F2 digest-key rotation broke all links; SEC-F3 directory timeout at 100k (per-row RLS functions); SEC-F4 37% failures at 200 concurrent sessions; SEC-F5 respondent readiness ignored the restore gate; SEC-F6 missing retention/tombstones; SEC-F7 no header/CORS assertion; SEC-F8 dashboard/PDF date disagreement near UTC midnight. Implementation defects of my own caught before completion: `RETURN next` parsed as `RETURN NEXT`; a trigger reading columns absent from other tables; `= ANY((SELECT …))` parsed as a subquery; `spawnSync` hanging on `pg_ctl start`; a base-only restore that lacked the backup's own WAL.

### Release-readiness gap list for Phase 15

Blocking production (owner inputs): P-001/P-008 independent privacy and security review including CE-001; P-002 hosting, domain/TLS, network separation, proxy logging; P-003 managed key custody with real deletion (SEC-H1); P-004 retention approval and measured production RPO/RTO; P-005 production IdP and MFA; P-006 approved instruments; P-007 data and attachment policy; P-010 antivirus engine (SEC-H2).

Implementation or operational work: SEC-M1 staff-side rate limiting at the edge; SEC-M2 configure the trusted IP header; SEC-M3 object-locked tombstone ledger; SEC-M4 enforce server logging settings; SEC-M5 release revocation routine; SEC-M6 audited intake-erasure tool for restore incidents; SEC-M7 staging rehearsal through the real proxy with TLS and `sslmode=verify-full`; SEC-L3 wire alerts to paging; re-measure load and restore on production hardware; real iOS/Android and screen-reader passes (carried from Phase 13 and Checkpoint F).

### Commit

`b8d1bab` — **Phase 14: security, retention, backups and resilience**, on `main`, parent `59c99e3`. The ignore rules kept `work/` (drill clusters, load output, ledgers) and every environment file out of it. No remote, nothing pushed or deployed, no external message sent.

### Exact next action

**Phase 15 — final release candidate and production readiness**, in a fresh session, starting from the gap list above. Deployment requires explicit authorization.

## Phase 15 handoff — 2026-09-14

- Step and status: **COMPLETE.** Release candidate **`orgfit-0.3.0-rc.1`**, commit **`ef914d8e22fb136096231cf25506d5493672e813`**, source digest `5582a0ed4aa953286a3eb93ec1b3e938b8347f221a6ed39999b9ce28acaf2b66`. **Decision: NO-GO for production** — no authorized environment to stage in, no independent review, every production input open. Full record: [final-handoff.md](final-handoff.md); go/no-go items: [release-checklist.md](release-checklist.md).

### Implemented

- **Release tooling** (D-124, D-125): `deploy/processes.json` (six processes, database identities, required/forbidden variables, storage, job cadences); `npm run release:preflight` (environment and database checks per process, never prints a value; now checks the server logging settings, SEC-M4); `npm run release:manifest` with `--verify`.
- **Repair RC-001** (D-123): restore replay and `ops:check` reconcile the core batch record with the anonymous marker; stores restored to different points are an incident, not a silent loss.
- **Verification harnesses**: `tests/release.test.ts` (R-1, R-1b, R-2, R-4), `tests/release-upgrade.test.ts` (R-3, upgrade from state written by the Checkpoint F commit's own code), `tests/ops/rollback-drill.ts` (physical restores with assertions), `tests/release/rehearsal.ts` (production builds behind TLS against a TLS-only database, D-126).
- **CI** now runs `test:localization`, `test:access`, `test:operations`, `test:release` with full history (RC-002).
- **Documents**: release-checklist.md, deployment-runbook.md, staff-operations-guide.md, final-handoff.md; decisions D-123 … D-126; security-review.md §6.

### Changed files and migrations

New: `deploy/processes.json`, `src/preflight.ts`, `scripts/release-preflight.ts`, `scripts/release-manifest.ts`, `tests/release.test.ts`, `tests/release-upgrade.test.ts`, `tests/release/baseline-state.ts`, `tests/release/rehearsal.ts`, `tests/ops/rollback-drill.ts`, the four documents. Modified: `src/operations.ts`, `scripts/ops-check.ts`, `scripts/check-boundaries.ts`, `tests/oidc-provider.ts` (optional public issuer), `package.json` and `package-lock.json` (version `0.3.0-rc.1`, three scripts), `.github/workflows/ci.yml`, `decisions.md`, `security-review.md`, this file, `README.md`. **No migration**; 001–018 and anonymous 001–002 untouched.

### Tests actually run

See [final-handoff.md §2–3](final-handoff.md#2-tests-actually-run). In short: typecheck and lint clean; 24 node suites **279 passed, 0 failed**; `check:boundaries`, `test:production` pass; `npm audit` 0 vulnerabilities; Playwright **52 passed**; rollback drill **8/8**; rehearsal **13/13**; and inside a genuine clean clone of `ef914d8`: `npm ci`, typecheck, lint, build, boundaries, production smoke, release suite 5/5, rollback drill 8/8, rehearsal 13/13, manifest `--verify` matches.

**Not run:** staging (none exists), real IdP/MFA, real TLS/domains/proxy/WAF, real bucket policies and lifecycle (S3 test double only), managed KMS, antivirus engine, network segmentation, paging, production-hardware load and restore, real devices/WebKit/Firefox/screen readers, remote CI, penetration test, independent review.

### Defects found and repaired

RC-001 (High, product) and RC-002 (Medium, CI) as above. RC-006 (Low, release tooling): manifest hashes depended on line endings, spawned npm through a shell, and `--verify` refused every freshly built checkout (clipped first path; generated `next-env.d.ts` counted as a source change) — fixed in `2f05b56`, `e010e1b`, `ef914d8`. Harness defects of my own: a report request asserted 201 instead of the API's 202; a blocking spawn deadlocked against the in-process storage double. **Process defect, recorded:** two "clean clone" attempts silently failed (Git "dubious ownership") and ran in the main checkout; their results are not used as clone evidence, and one of them detached the main checkout's HEAD at the same commit, which was fast-forwarded back onto `main`. No global Git configuration was changed.

### Open defects and production prerequisites

RC-003 (no provider packaging, P-002), RC-004 (operator/processor scripts rely on preflight for TLS), RC-005 (four caret ranges, lockfile-pinned). Unchanged: SEC-H1, SEC-H2, SEC-M1, SEC-M3, SEC-M5, SEC-M6, SEC-L1–L4, CE-001. P-001 … P-008 and P-010 open — itemized in final-handoff §5.

### Commit

`fadffb1`, `2f05b56`, `e010e1b`, `ef914d8` on `main`, plus the documentation commit that adds this entry. A git worktree of `59c99e3` remains at `work/release-baseline-59c99e3` (ignored) for R-3. No remote, nothing pushed, nothing deployed, no message sent.

### Exact next action

**Checkpoint G — final go/no-go inspection**, in a fresh session, against `ef914d8` and `work/release/orgfit-0.3.0-rc.1/manifest.json` (regenerate if absent). Stop there.

## Checkpoint G handoff — 2026-09-14

- Step and status: **RUN. Technical GO as an implementation gate; production NO-GO.** Full record and acceptance matrix: [checkpoint-g.md](checkpoint-g.md). A technical GO is not authorization to deploy.
- **Inspected**: clean tree at `917c3fe`; `release:manifest --verify` matched the Phase 15 candidate `ef914d8`; migrations 001–018 / anonymous 001–002 unchanged; `deploy/processes.json`; every checkpoint, security and privacy artifact.
- **Re-run on the candidate**: typecheck, lint, build, boundaries, production smoke, `npm audit` (0); 24 node suites **279 passed**; Playwright **52 passed**; rollback drill **8/8**; TLS rehearsal **13/13**.
- **Prohibited scope**: none of subscriptions/billing, client accounts/dashboards, cross-company benchmarks, skip logic, raw respondent exports or AI-dependent recommendations — 158 files, dependencies and route inventory scanned; every hit explained in checkpoint-g.md §3.
- **Defects**: **CG-001** (release-blocking mislabel) — the public overview page said CE-001 "is under independent privacy review"; no reviewer has been engaged. Corrected in Arabic and English with regression assertions (D-127) → candidate **`orgfit-0.3.0-rc.2`**, commit `e801b9a`, source digest `19dce1d82642d443976af59642b15bcff4c8a55dee936dff332d1d234f345fba`. **CG-002** — README said Checkpoints E and F had not run; corrected. **CG-003** (low, open) — browser harness needs `work/` in a fresh clone; CI already creates it.
- **After the correction**: on `e801b9a` typecheck, lint, build, boundaries, production smoke, `access.spec` 4 passed; genuine clean clone of `e801b9a`: `npm ci` (0 vulnerabilities), typecheck, lint, build, boundaries, production smoke, manifest `--verify` matches, `access.spec` 4 passed, rehearsal 13/13.
- **Acceptance matrix**: every binding ID and blueprint §16 module is VERIFIED for implementation; NOT VERIFIED lines: production IdP/MFA, real key custody and crypto-erasure (SEC-H1), independent privacy/security review including CE-001, antivirus (SEC-H2), real devices/screen readers, visual chart inspection in G, provider-hardware restore/load. **No line BLOCKED.**
- **Remaining owner inputs**: P-001 … P-008 and P-010 (checkpoint-g.md §6), including explicit deployment authorization.
- **Commits**: `e801b9a` (CG-001 fix and version), and the documentation commit that adds this entry. No remote, nothing pushed, deployed or sent.
- **Next**: no further phase or checkpoint. Stop.

## Post-Audit Repair Pass 1 — administration screens and pagination — 2026-09-14

- Step and status: **COMPLETE for audit findings 1–3** of `OrgFit-Audit-2026-09-14.md` (parent outputs directory), as development work. Not production readiness; the Checkpoint G production NO-GO is unchanged. Decisions D-128 … D-135.
- Starting point: clean tree at `9e52403`; no changes had been made since the audit.

### Findings verified before repair

| Audit item | Verified how | Result |
|---|---|---|
| 1 — no staff-administration UI (P1) | Route inventory: no `staff` page under `apps/staff/app`; backend routes present in `route.ts` | Confirmed |
| 2 — no `/audit`, `/settings`, `/profile` (P2) | Route inventory; no global settings table or routine in 001–018; profile limited to locale + logout on `/workspace` | Confirmed |
| 3 — 100-row truncation (P2) | `001_foundation.sql` `list_staff()`/`audit()` `LIMIT 100`; `016_local_access.sql` `list_invitations()` `LIMIT 100`; routes return `nextCursor: null`; no later replacement in 002–018 | Confirmed |
| Found in this pass (PR1-004) | `POST /api/v1/staff/invitations` generated a new secret on every request; an idempotent retry returned the original row's id with a link built from the new secret, matching no row | Confirmed by reading the route against `access.create_invitation`; repaired (D-132), AD-7 |
| Found in this pass (PR1-005) | `access.revoke_sessions` (001) existed with no HTTP route | Confirmed; now `POST /api/v1/staff/:id/revoke-sessions` |
| Found in this pass (PR1-006) | `POST /api/v1/staff` accepted any URL issuer, including ones that can never sign in | Confirmed; now bound to `OIDC_ISSUER` (D-133) |

Audit findings 4–10 were not in this pass's scope and are unchanged (see remaining gaps).

### Implemented

- **Staff** `/staff`: search by name/email, role and status filters, keyset "Show more"; identity-provider account registration (issuer fixed to the configured provider); staff invitations — issue (link shown once, copy, replay explained), filter by state, withdraw with in-place confirmation; the invitation form is shown only while the development password switch is on and says it is development-only. **`/staff/:id`**: identity facts, access editor (role, eight capabilities, organization checklist with filter), last-Super-Admin notice and locked role, self-edit warning, stale-revision reload, disable/re-enable, end all sessions, link to that account's audit history.
- **Audit** `/audit`: action, organization and UTC date-range filters; actor filter from any row and target filter from the staff record, both removable; filters kept in the address; keyset pages of 50; readable action labels in both languages with the code; target shown as a staff link, an identifier, or "withheld" for respondent invitations; CSV export of the current selection (≤5000 rows or refused; audited).
- **Settings** `/settings`: versioned defaults (timezone, campaign threshold ≥5, staff invitation validity) with `If-Match`, used by the campaign and invitation forms; fixed policies (Arabic default, five-contributor floor); authentication mode (provider origin, development password switch, a danger alert if it is on in production); operational status tiles from `ops.alert_inputs()`; retention table exactly as recorded, unapproved classes labelled as proposals; version history. No secret is read or displayed.
- **Profile** `/profile`: name, email, role, capabilities, assigned organizations; the existing language and sign-out controls; password/MFA section (provider link only when `OIDC_ACCOUNT_URL` is configured; plain statement for development password accounts); own active sessions with end-one and end-all-others.
- **Pagination**: staff, invitations and audit are keyset pages with bounded size, allowlisted filters, validated opaque cursors and real `nextCursor` values (D-128).
- **Navigation**: workspace home account panel links to My account and, for Super Admins only, Staff/Audit/Settings; a shared administration rail (`AdminFrame`); the organization rail links to My account.
- **Authorization at three layers**: server page renders the permission-denied state without loading data for a non-administrator; `src/administration.ts` checks the role before touching the database; every new routine checks `access.is_admin()` or derives the account from `access.actor()`.

### Changed files and migrations

New: `db/migrations/019_administration.sql`; `src/administration.ts`, `src/pagination.ts`, `src/admin-i18n.ts`; `apps/staff/app/account-page.tsx`, `admin-client.ts`, `admin-controls.tsx`, `staff/[[...path]]/page.tsx`, `staff/staff-ui.tsx`, `audit/page.tsx`, `audit/audit-ui.tsx`, `settings/page.tsx`, `settings/settings-ui.tsx`, `profile/page.tsx`, `profile/profile-ui.tsx`; `tests/administration.test.ts`, `tests/browser/administration.spec.ts`.

Modified: `apps/staff/app/api/v1/[...path]/route.ts` (staff/audit/invitation blocks moved to `src/administration.ts`), `shell.tsx`, `workspace/page.tsx`, `organizations/[[...path]]/page.tsx` and `campaigns-ui.tsx` (settings defaults), `results-ui.tsx` (owner picker follows cursors), `src/config.ts` (`identityAccountUrl`), `src/theme.css` (`.checklist`, `.confirm-inline`, `.once-value`, `.filter-chips`, `.facts`, `.admin-table`, all from existing tokens), `tests/localization.test.ts` (administration catalog parity and a label for every audit action), `playwright.config.ts`, `tests/serve.ts`, `tests/browser/access.spec.ts`, `tests/browser/foundation.spec.ts` (overridable ports only, D-134), `package.json` (`test:administration`), `.github/workflows/ci.yml`, `.env.example` and `deploy/processes.json` (optional `OIDC_ACCOUNT_URL`), `README.md`, `docs/orgfit/decisions.md`, `api-contracts.md`, `foundation.md`, `landing-and-access.md`, this file.

Migration 019 adds four indexes, restates the audit action/field CHECK lists (+`SETTINGS_CHANGED`, `AUDIT_EXPORTED`; +`settings`, `session`, `audit`), creates append-only `ops.system_setting` (row 1 = the values 008/016 already used), and 16 routines. **Migrations 001–018 and anonymous 001–002 are untouched**; the superseded 100-row routines remain in place, unused.

### Tests actually run

Local PostgreSQL 18.4 loopback cluster (127.0.0.1:55432, started with `scripts/local-postgres.ps1`; every suite created fresh synthetic databases; nothing reset or dropped), Node 24.13.1, Chromium, Windows 11.

| Check | Result |
|---|---|
| `tests/administration.test.ts` (AD-1 … AD-8) | **8 passed** — >100 staff reachable once and in order; 240 same-microsecond audit events + 60 more paginated identically to database order; filters; malformed cursor/limit/unknown key → 422; ordinary staff refused at route and at each routine, internal selector not executable by the runtime role; export bounded, audited, formula-safe, respondent invitation id absent, >5000 refused; own-session scoping (another account's session → NOT_FOUND and still valid; current → STATE_CONFLICT); settings floor at route and routine, invalid zone, concurrent saves → one REVISION_CONFLICT, idempotent replay, immutable history (operator UPDATE/DELETE/TRUNCATE refused), retention unapproved, no secret in status; LAST_ADMIN, stale revision, missing If-Match, two administrators disabling each other concurrently (≥1 active admin remains), revoke-sessions, issuer binding; >100 invitations paginated, state filters, **replay returns `url: null`**; cursor and account-URL validation |
| All 24 existing node suites (`test` … `test:release`, incl. `test:integration`, `test:access`, `test:checkpoint-c/d/e`, `test:visits`, `test:operations`) with migration 019 applied | **279 passed, 0 failed** (logs `work/pass1-node-*.log`) — with the new suite, **287 passed** |
| `npx playwright test tests/browser/administration.spec.ts tests/browser/access.spec.ts tests/browser/foundation.spec.ts` (ports 3100/3101) | **22 passed** (6 new + 4 access + 12 foundation). New spec: Super Admin invites → invitee activates → admin searches, edits access (invitee session ends), ends sessions via keyboard confirmation, disables (sign-in refused) and re-enables, stale second tab refused with reload, withdraws an invitation, registers a provider account — **UI only**; ordinary staff gets the denied page on `/staff`, `/staff/:id`, `/audit`, `/settings` and 403 on eight admin API calls; profile session scoping; 130 same-timestamp audit events reached through "Show more" plus CSV download row count; settings version, stale save, floor 4 → 422, retention labels; English LTR at 375px with no horizontal overflow on all four screens, skip link and keyboard path; axe (WCAG A/AA tags) on staff, profile, audit, settings (Arabic) and all four screens (English 375px) with **no violations** after repairs |
| `npm run typecheck`, `npm run lint`, `npm run build`, `npm run check:boundaries`, `npm run test:production` | clean / pass; build lists `/audit`, `/profile`, `/settings`, `/staff/[[...path]]` |

Defects found by this verification and repaired before completion: axe contrast on `.faint` identifiers (now `.muted`); Arabic dates rendered inside LTR spans reordered unreadably (D-135); a long sentence inside a non-wrapping badge overflowed `/settings` at 375px; administration tables broke codes mid-token; my own test expectations (a 29/30 window count, `Response.text()` stripping the CSV BOM, sign-in restoring the saved Arabic preference).

**Not run in this pass:** the other 12 browser specs (they hard-code ports 3000/3001, which were held by two processes outside this repository that were not stopped; none of their screens changed apart from the campaign form's default values and the organization rail's extra link); `npm audit`; release manifest/rehearsal/rollback drill; real identity provider or `OIDC_ACCOUNT_URL` target; real devices, WebKit/Firefox, screen reader; remote CI.

### Remaining gaps

- Audit findings **4** (no staff request timeout), **5** (locale switch discards unsaved input), **6** (no scheduler), **7** (no malware engine), **8** (release revocation, SEC-M5), **9** (production prerequisites P-001 … P-008, P-010) and **10** (tooling, CG-003) are untouched.
- Observed, not repaired: a click on the app-bar language switch before hydration is lost (existing `LocaleSwitch`); `access.save_staff` (001) checks `is_admin()` before taking its advisory lock, so a statement already running when its actor is disabled can still complete — the last-admin invariant held under the concurrent test, but the check order is unchanged because 001 is released.
- The access editor lists at most 1000 organizations and says so; the recommendation owner picker follows at most 20 pages (2000 active staff).
- No local password-change or MFA screen exists (by design, D-131); development invitations remain the only local account path, gated by the development switch.
- The audit actor filter is set from a row, not by searching for a person; CSV export is limited to 5000 rows per selection.
- The candidate identifier `orgfit-0.3.0-rc.2` no longer describes this tree; a new manifest is needed before any release decision.

### Commit

Not committed in this session; the working tree holds the changes above. No remote, nothing pushed, deployed or sent; no invitation was delivered anywhere (all links were synthetic and used only inside the test harness).

### Exact next action

**Post-Audit Repair Pass 2** — audit findings 4 and 5 (staff request deadlines with idempotency-safe retry, and an unsaved-change guard on the language switch, including the pre-hydration click), then finding 8 (release revocation). Before it, run the full Playwright suite on free ports 3000/3001.
## Questionnaire department targeting — 2026-09-14

**Status: IMPLEMENTED (development).** Owner instruction: Questionnaire → Organization → optional Department(s). Decisions D-141 … D-143.

Changed: `db/migrations/020_questionnaire_targeting.sql` (new); `src/instruments.ts` (target input, `saveTarget`, department options, target data on list/detail, department filter, target on create); `apps/staff/app/questionnaires/target-picker.tsx` (new), `workspace.tsx`; `apps/staff/next.config.ts`, `.gitignore`, `eslint.config.mjs` (opt-in `E2E_NEXT_DIST_DIR` so the browser harness can run beside another `next dev` of this app; default unchanged); `package.json` (`test:targets`); `tests/questionnaire-targets.test.ts`, `tests/browser/questionnaire-targets.spec.ts` (new).

| Check | Result |
|---|---|
| `npm run test:targets` | **9 passed** — upgrade from 019 keeps an existing questionnaire as entire organization; create with departments in one transaction; a foreign department rejects create (no row) and change (revision unchanged); direct inserts refused by composite FKs; empty/malformed/unknown/global/stale/missing If-Match refused; keyed replay and key-reuse conflict; audit; filter semantics; targeted department cannot be archived, archived department cannot be targeted; options organization-scoped; target change needs `instruments.manage` |
| `npm test`, `test:instruments`, `test:directory`, `test:campaigns`, `test:localization` | 5, 8, 6, 18, 4 passed |
| `npx playwright test tests/browser/questionnaire-targets.spec.ts` (ports 3100/3101, `E2E_NEXT_DIST_DIR=.next-e2e`) | **2 passed** — create, organization switch clears the selection, filter, edit, back to entire organization (English); Arabic RTL at 375px with no horizontal overflow. Screenshots `work/questionnaire-target-*.png` |
| `npm run typecheck`, eslint on changed files | clean |

**Not run:** the other node suites (integration, access, privacy, checkpoints, reports, visits, operations, release — 020 is a new migration, so the release manifest must be regenerated), the other browser specs, axe on the new controls, production build.

**Open:** the department filter and picker exist on the questionnaire library only.

### Campaign launch enforces the questionnaire target — 2026-09-14 (D-144)

Changed: `db/migrations/021_campaign_questionnaire_target.sql` (new: campaign mode `ALL`, `core.questionnaire_audience`, `core.resolve_campaign_target`; `save_campaign`, `launch_campaign`, `launch_review` restated); `src/campaign-input.ts`, `src/campaigns.ts`, `src/http.ts`, `src/campaign-i18n.ts`; `apps/staff/app/organizations/campaigns-ui.tsx` (default mode "Everyone the questionnaire targets", questionnaire target and refusal in the launch review); `tests/campaign-targets.test.ts`, `tests/browser/campaign-targets.spec.ts` (new); `test:targets` runs both node files.

| Check | Result |
|---|---|
| `npm run test:targets` | **16 passed** (9 questionnaire + 7 campaign: entire organization → all 4 active people, archived and foreign excluded; global template → whole organization; HR target → only HR; single/selected/department outside refused, inside launches; target narrowed after draft → review reports, launch refused, draft stays DRAFT with no invitations, widening lets it launch; launched roster unchanged by later edits; empty audience refused) |
| `test:campaigns`, `test:instruments`, `test:directory`, `test:respondent`, `test:publication`, `test:checkpoint-c` | 18, 8, 6, 24, 13, 21 passed |
| `npx playwright test tests/browser/campaign-targets.spec.ts tests/browser/questionnaire-targets.spec.ts` (3100/3101, `E2E_NEXT_DIST_DIR=.next-e2e`) | **3 passed**; screenshots `work/campaign-target-*.png` |
| `npm run typecheck`, eslint on changed files | clean |

**Not run:** `tests/browser/campaigns.spec.ts` and other specs that hard-code port 3000 (held by another session), remaining node suites, release manifest regeneration (migrations 020–021 are new).

## Post-Audit Repair Pass 3 — release revocation, background-job operation and runtime safeguards — 2026-09-15

- Step and status: **COMPLETE (development, local only)** for audit finding 8 (SEC-M5), the local/portable part of finding 6 (D5; D11 prepared), RC-004 and CG-003. **Not production readiness; the Checkpoint G production NO-GO is unchanged.** Decisions D-145 … D-154.
- Starting point: `6e1aae5` (the owner committed targeting and Pass 2 at 23:38 on 2026-09-14, while this pass was reading). **Unrelated concurrent work, not part of this pass and left untouched:** `scripts/role-password.ts` (new), `scripts/provision-dev.ts`, `tests/database.ts`, `tests/release-upgrade.test.ts` were changed by another session at 23:42–23:43 (a stable cluster role password) and committed by it as `9d85c88`. This pass's test runs used that harness as it was on disk.

### Implemented

- **Release revocation** (migration 022): Super Admin panel on the round's Results page (reason category, written reason, incident reference, typed 8-character fingerprint, acknowledgement that downloaded copies cannot be recalled); `GET/POST /api/v1/organizations/:org/assessments/:round/release[/revocation]`; operator fallback `npm run release:revoke` with an active Super Admin approver. One immutable record per release; same decision → same record; different decision → `RELEASE_ALREADY_REVOKED`; one `RELEASE_REVOKED` audit row. `ops.report_job_dependency` (own release, comparison sides, whole-series trend rounds; back-filled); all dependent jobs revoked in any state; downloads, results, recommendations/follow-ups, comparisons, trends and new reports refused; processor cannot republish; purge queue drained by `reports:expire`; `downloads_before` counted and shown; restore replay via tombstone class `RELEASE_REVOCATION`. Every reader sees withdrawn/when/category/download count; only a Super Admin sees reason, reference and actor. Comparison list marks withdrawn reviews.
- **Supervised jobs**: `npm run jobs:supervise` (`src/supervisor.ts`) reads the new `schedule` section of `deploy/processes.json`; per-process environment files started with `node --env-file`; supervisor refuses credentials in its own environment; group order normalize → process → publish; no overlap; single-instance lock; orphan wait; bounded retries (15 s doubling, 3); timeouts; graceful stop (signals, STOP file, `--stop`); atomic `status.json`; `--status`; stderr suppressed by default; `--interval-scale` nonproduction only. Jobs record their own outcome (migration 023 `ops.job_status`, `ops.record_job_run`, `ops.job_health`); `access.system_status` includes it; Settings screen shows a job table and backlog; `ops:check` raises `JOB_STALE`/`JOB_FAILING`/`JOB_NEVER_RUN`. Alert adapter `src/alert-delivery.ts` (none/console/file/webhook; webhook gated and https-only in production).
- **Runtime safeguards**: `src/runtime-guard.ts` applied to processor, publication, operator, migration, bootstrap, restore, retention, tombstone, ops-check and revocation entry points (verified TLS in production before connecting; forbidden variables refused by name). Nonproduction loopback unchanged.
- **Harness**: `tests/serve.ts` creates `work/` and its store directories before anything writes (CG-003).

### Defects found during this pass and repaired

| ID | Found how | Repair |
|---|---|---|
| PR3-001 (High, availability, released code 014) | The supervised end-to-end run: `reports:generate` failed every minute with `UNAVAILABLE`. `claim_report_jobs` reclaimed an expired lease RUNNING→RUNNING, which the 014 trigger refuses, so one crashed renderer blocked **every** later claim | `claim_report_jobs` restated in 023 (requeue or `LEASE_EXPIRED` after max attempts); RV-11; SV-9 then drew the abandoned job on attempt 2 (D-152) |
| PR3-002 (Low) | Reading `src/http.ts` while wiring revocation: `RESULTS_UNAVAILABLE` from a routine answered 503 | Mapped to 409 (D-153) |
| PR3-003 (my code) | SV-6 hung: a second supervisor in the same process treated a lock holding its own pid as stale | Any live holder keeps the lock |
| PR3-004 (presentation) | Screenshot: the withdrawal date reordered inside Arabic text | Date rendered as its own LTR run (D-135 pattern) |
| Test expectations (mine) | RV-1/RV-5/RV-7 assumed a report depends only on earlier rounds; the trend is the whole series. SV-7 assumed orphans survive on Windows (Node job objects end them). Browser spec assumed sign-in keeps the chosen language | Tests corrected to the observed, correct behaviour; SV-7 now covers both platforms |

**Checkpoint C assertion changed deliberately:** `checkpoint-c.test.ts` "no job, queue or outbox table…" now expects `ops.job_status` and `ops.report_job_dependency` beside `ops.report_job`; both pass every payload check it applies (no runtime grants, no body-shaped columns, no anonymous values).

### Changed files and migrations

New: `db/migrations/022_release_revocation.sql`, `db/migrations/023_job_health.sql`; `src/revocation.ts`, `src/runtime-guard.ts`, `src/job-run.ts`, `src/supervisor.ts`, `src/alert-delivery.ts`; `scripts/revoke-release.ts`, `scripts/supervise.ts`; `apps/staff/app/organizations/release-ui.tsx`; `tests/revocation.test.ts`, `tests/supervisor.test.ts`, `tests/safeguards.test.ts`, `tests/supervisor/fake-job.ts`, `tests/supervisor/run-supervisor.ts`, `tests/browser/revocation.spec.ts`.

Modified: `apps/staff/app/api/v1/[...path]/route.ts`, `organizations/results-ui.tsx`, `history-ui.tsx`, `settings/settings-ui.tsx`, `audit/audit-ui.tsx`; `src/http.ts`, `src/operations.ts`, `src/processor.ts`, `src/report-worker.ts`, `src/administration.ts`, `src/results-i18n.ts`, `src/history-i18n.ts`, `src/admin-i18n.ts`; `scripts/migrate.ts`, `migrate-anonymous.ts`, `bootstrap.ts`, `close-campaigns.ts`, `expire-drafts.ts`, `retention.ts`, `ship-tombstones.ts`, `ops-check.ts`, `restore-reapply.ts`, `process-campaigns.ts`, `publish-campaigns.ts`, `generate-reports.ts`, `expire-reports.ts`, `scan-attachments.ts`, `expire-attachments.ts`, `check-boundaries.ts`; `tests/serve.ts`, `tests/checkpoint-c.test.ts`; `deploy/processes.json` (`schedule`, `supervisor`; the six processes unchanged), `package.json` (`release:revoke`, `jobs:supervise`, `test:safeguards`, `test:revocation`, `test:supervisor`), `.github/workflows/ci.yml`, `.env.operator.example`, `README.md`; docs `decisions.md`, `deployment-runbook.md` (§9–10), `incident-runbook.md` (§8–9, alert codes), `security-review.md` (§7), `staff-operations-guide.md`, `publication.md`, `reports.md`, `release-checklist.md` (D5, D11), `api-contracts.md`, this file. **Migrations 001–021 and anonymous 001–002 untouched** (R-2 confirms none edited).

### Tests actually run

Windows 11, Node 24.13.1, PostgreSQL 18.4 loopback cluster 127.0.0.1:55432 (fresh synthetic databases per suite; nothing reset or dropped), Chromium. Logs `work/pass3-*.log`.

| Check | Result |
|---|---|
| `npm run test:safeguards` | **9 passed** — RG-1 URL guard matrix; RG-2 helpers refuse before a pool; RG-3 **13 entry points** in production mode against a counting TCP listener: all exit 1, **0 connections**, no value printed; RG-4 foreign credential refused by name; CI-1/CI-2 supervisor refuses credentials, mixed files refused, a child started the supervisor's way holds only its own file's variables; AL-1 sanitize/dedupe/job alerts; AL-2 webhook gating, loopback delivery with one retry, failure codes without URL; RG-5 |
| `npm run test:revocation` | **12 passed** — RV-1 dependencies; RV-2 authorization, organization boundary, fingerprint, operator approver; RV-3 staff withdrawal (4 reports revoked, 1 prior download counted, one audit row); RV-4 retry-safety; RV-5 refusal on every surface, later series report works, no republication, reason visible to Super Admin only; RV-6 evidence kept and immutable, purge 3 then 0, renderer still 0 table privileges; **RV-7** download authorized first completes while three concurrent revocations wait → exactly one record, later download 409; **RV-8** request during uncommitted revocation refused with no job row, completion after revocation → `REVOKED`, worker deletes its bytes, purge; **RV-9** download during uncommitted revocation refused, rolled-back revocation leaves nothing; **RV-10** logical restore simulation re-applied by `restore:reapply`, idempotent; **RV-11** abandoned lease requeued without blocking another job, `LEASE_EXPIRED` after 3 attempts |
| `npm run test:supervisor` | **9 passed** — SV-1 order and no overlap; SV-2 exactly 3 attempts with growing backoff, recovering job resets, alert to sink; SV-3 timeout; SV-4 STOP → INTERRUPTED, lock released; SV-5 per-process isolation and refusals; SV-6 lock (separate process and same process); SV-7 real supervisor kill + orphan wait; SV-8 schedule = manifest text = npm scripts; **SV-9 real**: `scripts/supervise.ts` with four environment files → closed campaign processed and **published**, attachment **CLEAN**, supervisor stopped via `--stop`; a report job claimed by a "crashed" worker with a 1 s lease plus a new Arabic PDF → both **READY** under a restarted supervisor (abandoned job on attempt 2), downloads 200, every job in `ops.job_status` `SUCCESS`, database cadences equal the manifest, no configured secret in supervisor output |
| All other node suites with 022–023 applied (`test`, localization, requests, integration, directory, instruments, scoring, scoring-db, checkpoint-b, campaigns, respondent, privacy, disclosure, publication, recommendations, checkpoint-d, comparison, history, reports, checkpoint-e, visits, access, operations, administration, targets) | 5, 4, 8, 8, 6, 8, 15, 5, 3, 18, 24, 17, 16, 13, 13, 18, 13, 8, 17, 11, 14, 8, 9, 8, 16 passed, **0 failed** |
| `test:checkpoint-c` | first run 19 passed / 2 failed (the deliberate queue-table assertion above); after the change **21 passed** |
| `test:release` | first run 4 passed / 1 failed: R-3's **baseline child process** (Checkpoint F code in its worktree) crashed natively (exit 3221226505) before any upgrade step; rerun alone **R-3 passed**; R-1, R-1b, R-2, R-4 passed. Recorded as a transient environment failure, not reproduced |
| Clean clone (`git clone` of `6e1aae5` at `%TEMP%\oft-p3` + exactly this pass's files; the other session's two harness files copied in so the shared cluster's role passwords were not randomized; **no `work/` directory**) | `npm ci` ok; `typecheck`, `lint`, `build`, `check:boundaries`, `test:production` **all exit 0**; Playwright on 3100/3101 with `E2E_NEXT_DIST_DIR=.next-e2e`: harness created `work/` itself and wrote the fixture; `access.spec` **4 passed**; `revocation.spec` **1 passed** after correcting my spec (language after sign-in, an ambiguous locator) and the date direction fix — Super Admin withdraws through the UI in Arabic, results/download 409 over HTTP, ordinary staff (English, 375 px, no overflow) sees the notice without reason or reference and gets 403, Settings job section; axe (WCAG A/AA) on the form, the page and the job section with no violations. Screenshots `work/pass3-*.png` |
| `npm run typecheck`, eslint on all changed files (main checkout) | clean |

### Not run / unverified on real infrastructure

- No provider: the supervisor was **not** installed as a service, run under a process manager, given secrets from a secret manager, or run on Linux. No remote deployment. No staging.
- No alert was sent to any external destination; no monitoring destination, credential or paging drill exists (D11, SEC-L3).
- Production-mode TLS was exercised only as refusal (RG-3); the TLS rehearsal (`tests/release/rehearsal.ts`) and the physical rollback/restore drills were **not re-run**, so a real `verify-full` connection through the new guards and the revocation replay on a physical restore are unverified. RV-10 is a logical simulation.
- Not run: the other 17 browser specs (only access and revocation), `npm audit`, release manifest regeneration (migrations 019–023 are new; the `rc.2` identifier no longer describes the tree), remote CI, real devices/WebKit/Firefox/screen readers.
- Report bucket deletion of revoked artifacts is exercised on local storage only.

### Open defects, assumptions and production prerequisites

- A withdrawal cannot recall downloaded files (by nature); there is no correction/superseding-release workflow.
- Because trends span the series, withdrawing one round revokes every existing report of that series; this is deliberate (they quote its values) and documented.
- The supervisor host can read all four job environment files; restrict them to the supervisor's service identity. Exactly one supervisor per environment is a deployment rule.
- Tombstone ledger durability (SEC-M3) now also protects revocations across restores.
- Unchanged: SEC-H1, SEC-H2, SEC-M1–M4, SEC-M6, SEC-M7, SEC-L1, SEC-L2, SEC-L4, RC-003, RC-005, CE-001; P-001 … P-008, P-010 open.

### Commit

Committed as "Post-Audit Repair Pass 3: release revocation, supervised jobs and runtime safeguards" on `main`, on top of `9d85c88`. No remote, nothing pushed, deployed or sent; no service installed.

### Exact next action

Owner review of this pass. Then, with explicit authorization only: choose the hosting provider and monitoring destination (P-002), wire the supervisor (deployment-runbook §9), re-run the TLS rehearsal and physical rollback drill with migrations 019–023, run the full Playwright suite, and regenerate the release manifest.

### Independent verification of this pass — 2026-09-15 (second session)

- Step and status: **VERIFIED (development, local only); three defects repaired (D-156).** The pass was re-read against the owner's brief, code and migrations 022–023 reviewed (lock order of revocation, download, report request and render; purge keys; supervisor credential handling, overlap, retries, shutdown), and the evidence suites re-run.
- Housekeeping: decision ID D-145 had been used twice; another session renumbered the role-password decision to D-155 in `c05ad8f` while this verification ran. No further renumbering.

| Check (Windows 11, Node 24.13.1, loopback PostgreSQL 18.4 :55432) | Result |
|---|---|
| `npm run test:revocation` on `7bb9936` code | **12 passed** (RV-1 … RV-11, incl. RV-7/8/9 concurrency, RV-10 restore replay, RV-11 crash recovery) |
| `npm run test:supervisor` on `7bb9936` code | **9 passed** (SV-1 … SV-9; SV-9 real supervised run published a campaign, cleaned an attachment, drew reports incl. an abandoned lease) |
| `npm run test:safeguards` on `7bb9936` code | 9 passed — but see PR3-006: RG-3's connection count could not fail |
| Probe with an asynchronous listener (`verify-full` + `NODE_TLS_REJECT_UNAUTHORIZED=0`, production) | committed `generate-reports.ts` and `scan-attachments.ts` **opened 1 connection each** (PR3-005); after the repair 0; a valid URL connects (2), proving the probe counts |
| `npm run test:safeguards` after the repair | **11 passed** (RG-3 now two variants with per-entry-point assertion, RG-6 preflight); the same suite against the unrepaired pools **fails** (`generate-reports.ts opened no connection`) |
| `npm run typecheck`, eslint on changed files, `npm run test:reports` after the repair | clean, clean, **17 passed** |
| Clean clone (`git clone` of `c05ad8f` + the four changed source/test files, no `work/`, `npm ci`) | `typecheck`, `lint`, `build`, `check:boundaries`, `test:production` exit 0; `test:safeguards` **11 passed** |
| After the cluster recovered, on the repaired code: `test:supervisor`, `test:visits`, `test:checkpoint-e`, `test:release` | **9, 14, 11, 5 passed**, 0 failed (SV-9 ran the real report and scanner scripts through the changed pools) |
| Clean-clone browser start: `npx playwright test tests/browser/access.spec.ts tests/browser/revocation.spec.ts` with `E2E_STAFF_PORT=3100`, `E2E_RESPONDENT_PORT=3101`, `E2E_NEXT_DIST_DIR=.next-e2e`, existing role password passed in | Harness created `work/` and `work/e2e-fixture.json` itself (CG-003 confirmed). First run: access **4 passed**, revocation **failed** — `published-round.ts` went to `127.0.0.1:3000` (PR3-007). After the repair: revocation **1 passed** (withdrawal through the UI, 409 on results/download, ordinary-staff view, Settings job section, axe) |

**Defects found and repaired (D-156):** PR3-007 (test tooling) — `tests/browser/published-round.ts` fixed the staff origin to port 3000 unless `SHOWCASE_STAFF_ORIGIN` was set, ignoring `E2E_STAFF_PORT` (D-134), so the revocation spec could not run on the override ports the Pass 3 entry records; it now honours `E2E_STAFF_PORT`. PR3-005 (Medium) — the renderer and scanner pools checked `sslmode` only, so `NODE_TLS_REJECT_UNAUTHORIZED=0` (honoured by `pg`) disabled certificate verification, and preflight — the supervisor's validation of each job file — did not check the variable; both pools now use `databaseUrl`, preflight FAILs the variable in production. PR3-006 (evidence) — RG-3 used `spawnSync` beside an in-process listener, so "0 connections" was unfalsifiable; now asynchronous. Changed: `src/report-db.ts`, `src/scanner-db.ts`, `src/preflight.ts`, `tests/safeguards.test.ts`, `tests/browser/published-round.ts`, `docs/orgfit/decisions.md`, `security-review.md`, `deployment-runbook.md` §10, this file. No migration.

**Environment events and what was not run:**
- The shared loopback cluster was terminated externally at 03:00:25 (exception 0x40010004, not a command of this session); restarted with `scripts/local-postgres.ps1`, crash recovery completed at 10:15:37 with no data loss reported. Suites attempted during the outage failed only with `ECONNREFUSED` and were re-run above.
- Not run: the other browser specs, the full node suite set, `npm audit`, release manifest regeneration, the TLS rehearsal and physical rollback drill, anything on real infrastructure.
- Incident in this session: a clone step failed ("dubious ownership") and the script continued, so `npm ci` ran in the main checkout and removed part of `node_modules` before stopping on a locked file (EPERM). Restored with `npm install` from the unchanged lockfile (`npm ls` clean, lockfile bytes restored with `git checkout`). A dev server of another session on port 3000 may have been affected during that window.
- Unchanged residuals: the web processes (`src/config.ts`, `src/gateway-db.ts`) still check `sslmode` only at runtime (preflight now catches the override for them); everything listed under "Not run / unverified on real infrastructure" above still stands. Production NO-GO unchanged.

**Next action:** unchanged from the Pass 3 entry above — owner review, then (with explicit authorization only) provider and monitoring destination, supervisor wiring, TLS rehearsal and rollback drill with 019–023, full Playwright suite, release manifest.
## Post-Audit Repair Pass 4 — production-security adapters and remaining technical blockers — 2026-09-15

- Step and status: **COMPLETE for the in-repository work (development, local only). The external integrations are NOT DONE** — no malware engine, managed key service, Object Lock bucket, proxy, IdP/MFA or hosting was selected, contacted, activated or verified. **Not production readiness; the Checkpoint G production NO-GO is unchanged, and with no managed key custody no production environment passes preflight.** Decisions D-157 … D-162; migration 024.
- Starting point: clean tree at `2452213` (Pass 3 verification). Read before editing: AGENTS.md, blueprint, decisions (P-001 … P-010, D-086, D-145 … D-156), this file, the 14 September audit (`../OrgFit-Audit-2026-09-14.md`), security-review.md, privacy-verification.md, privacy-protocol.md §4–5, the runbooks, and the code of every finding below.

### Findings verified against current code before repair

| Finding | Verified how | Result |
|---|---|---|
| SEC-H2 / audit 7 — no malware engine; active PDF passed | `src/attachment-scan.ts`, `src/attachment-worker.ts`; the audit's `%PDF` + `/OpenAction /JavaScript` probe run against the `2452213` code | Confirmed: `{"verdict":"CLEAN"}` |
| SEC-H1 — development file custody, preflight WARN only | `src/key-custody.ts`, `src/preflight.ts`, processor evidence string | Confirmed; no provider interface, production not refused, fixed evidence text |
| SEC-M1 — no staff application limits | staff route, `src/local-auth.ts` (per-account lock only) | Confirmed |
| SEC-M2 — trusted header optional; hop count | `src/rate-limit.ts` `clientBucket` | Confirmed, plus PR4-002: an unparseable hop count silently meant 0 and any string became a bucket |
| SEC-M3 — local append-only ledger, no tamper evidence, no delivery signal | `src/operations.ts` ship/read/replay | Confirmed, plus **PR4-001** (below) |
| SEC-M6 — no restore-incident erasure tool | incident-runbook §4.3 "Gap", code search | Confirmed |
| Available engine on this machine | `clamscan`/`clamd` absent; Docker installed but daemon not running; Windows Defender present but not a deployable server engine and not used (its real-time protection and exclusions are system settings) | No maintained engine available to test; nothing downloaded |

### Implemented

- **Attachment scanning** (D-157): two separate controls — `verifyAttachment` (type, size, container, new active-document policy for PDF and OOXML, `DOCUMENT_ACTIVE_CONTENT` / `DOCUMENT_UNVERIFIABLE`) and `src/malware-engine.ts` (`clamd` INSTREAM adapter; `development-heuristic` = the old EICAR check, refused in production). Production without a maintained engine refuses before claiming; clamd only over a Unix socket or loopback. Engine outage before a run: nothing claimed; mid-run: claim released without spending an attempt; timeout / non-verdict: attempt spent, FAILED after three; never CLEAN. Migration 024: `scan_engine`, `scan_engine_version`, `core.record_scan_result`, `core.release_scan_claim`, CLEAN-requires-engine constraint, scanner's `record_scan` revoked, earlier verdicts labelled `development-heuristic`. CLEAN label → "Passed the file checks" / "اجتاز فحص الملف" (PR4-003).
- **Key custody** (D-158): `CustodyProvider` interface, `CAMPAIGN_KEY_CUSTODY_PROVIDER`, production refusal of the development provider (rehearsal-only acknowledgement that preflight itself fails), unsupported names refused, provider-reported `DestructionEvidence` recorded by the processor ("not crypto-erasure"). Preflight `key-custody` is now FAIL for staff and processor in production. Integration plan, deletion/recovery-window questions and backup implications: [key-custody.md](key-custody.md). No other local implementation labelled managed.
- **Staff rate limits and trusted proxy** (D-159): `src/staff-rate-limit.ts` + `access.staff_rate_hit` — per address for the five pre-session endpoints, per session for the signed-in API, 429 + `Retry-After`, `STAFF_SIGN_IN_ABUSE_SUSPECTED` / `STAFF_API_RATE_LIMITED`, retention. `trustedProxy()` shared with the gateway: production requires the header or `none`; malformed values fail closed; non-addresses ignored.
- **Tombstone delivery** (D-160): `src/tombstone-ledger.ts` — sealed hash-chained batches verified on every read; `local-file` (development) and `s3` sinks (conditional create, SHA-256 checksum, COMPLIANCE Object Lock ≥ 36 days required in production); delivery record, `TOMBSTONE_SHIPPING_BEHIND` (critical); restore replay refuses an unverifiable ledger; **PR4-001 repaired**.
- **Restore-incident intake erasure** (D-161): `npm run intake:erase` / `ops.erase_campaign_intake` — ledger-verified incident, restore gate, closed campaign, active Super Admin approver, incident reference, reason, exact envelope count; immutable record, `INTAKE_ERASED` audit row, tombstone kept; retry-safe. Incident runbook §10.
- **Production prerequisites separated**: deployment-runbook §11 and release-checklist C5, D10, D12, D13, E7 now distinguish implemented code from missing hosting, IdP/MFA, storage, key-provider, engine, retention, approved content and independent-review inputs.

### Defects found during this pass and repaired

| ID | Found how | Repair |
|---|---|---|
| PR4-001 (High, restore integrity, released code 017) | Reading the restore replay against the tombstone identity sequence while designing durable delivery | A restored database's sequence restarts behind the ledger cursor, so deletions made after a restore were never shipped and a second restore would resurrect them; the reader also collapsed entries by sequence number. Replay advances the sequence first (`ops.advance_tombstone_sequence`), shipping refuses `TOMBSTONE_SEQUENCE_BEHIND_LEDGER`, reader deduplicates exact repeats only. AD-3 reproduces it and **fails with the advance removed** ("new tombstone 3 is past the ledger cursor 4") |
| PR4-002 (Medium) | Reading `clientBucket` | Strict trusted-proxy parsing, fail-closed, `isIP` |
| PR4-003 (Medium, wording) | Reading the visit screens against the scan model | CLEAN label no longer says "scanned and clean" |
| Harness defects of my own | RG-3 failed ("printed a configured value": the engine name, deliberately printed); the rehearsal's preflight value check matched the provider name `development-file` in a finding's text; a PowerShell multi-replace silently skipped two R-1 edits | RG-3 exempts the engine name only; preflight text rephrased; edits re-applied with the editor and re-run |

**Assertions changed deliberately (D-162):** R-1 expects `key-custody` FAIL for production staff and processor environments and a trusted-proxy FAIL for a production respondent without the header; RG-3 configures custody and engine settings so that the TLS guard is still what refuses `process-campaigns.ts` and `scan-attachments.ts`, and asserts no custody/engine code appears; the visits and Checkpoint F browser specs assert the new CLEAN label; the TLS rehearsal expects exactly the custody preflight failures, uses a clamd protocol double and an S3 ledger bucket on its test double (which gained ListObjectsV2 and `If-None-Match`).

### Duplicate files removed (owner instruction in this session)

`OrgFit-Master-Blueprint.md` (byte-identical to `docs/orgfit/blueprint.md`) and `OrgFit-Astra-6-Implementation-Prompts.md` (an older copy of `docs/orgfit/implementation-prompts.md`, lacking its session-continuity section) were deleted from the repository root; both remain in git history (`95c72fa`). The canonical copies under `docs/orgfit/` are unchanged and AGENTS.md already points to them. Other byte-identical tracked files (`apps/*/app/icon.svg`, `apps/*/next-env.d.ts`, `apps/*/proxy.ts`, `apps/*/tsconfig.json`) are per-application files each app needs and were kept.

### Changed files and migrations

New: `db/migrations/024_security_adapters.sql`; `src/malware-engine.ts`, `src/staff-rate-limit.ts`, `src/tombstone-ledger.ts`; `scripts/erase-intake.ts`; `tests/adapters.test.ts`, `tests/adapters-database.test.ts`, `tests/adapters/clamd-double.ts`, `tests/adapters/s3-double.ts`; `docs/orgfit/key-custody.md`.

Modified: `src/attachment-scan.ts`, `src/attachment-worker.ts`, `src/key-custody.ts`, `src/processor.ts`, `src/operations.ts`, `src/preflight.ts`, `src/rate-limit.ts`, `src/visits-i18n.ts`; `apps/staff/app/api/v1/[...path]/route.ts`; `scripts/scan-attachments.ts`, `ship-tombstones.ts`, `restore-reapply.ts`, `process-campaigns.ts`, `check-boundaries.ts`; `deploy/processes.json` (storage kind `TOMBSTONE_LEDGER`; new optional/recommended variables; `intake:erase`); `package.json` (`intake:erase`, `test:adapters`, `test:adapters-db`); `.github/workflows/ci.yml`; `.env.example`, `.env.operator.example`; `tests/release.test.ts`, `tests/safeguards.test.ts`, `tests/release/rehearsal.ts`, `tests/browser/visits.spec.ts`, `tests/browser/checkpoint-f.spec.ts`; `README.md`; docs `decisions.md`, `security-review.md` (§8), `privacy-verification.md` (§7), `incident-runbook.md` (alerts, §4.3, §10), `retention-backup-runbook.md`, `deployment-runbook.md` (§2, §3, §4, §11), `release-checklist.md`, `visits.md`, this file. Deleted: the two root duplicates above. **Migrations 001–023 and anonymous 001–002 untouched** (R-2 lists 024 as the only addition since Pass 3).

### Tests actually run

Windows 11, Node 24.13.1, PostgreSQL 18.4 loopback cluster 127.0.0.1:55432 (fresh synthetic databases per suite; nothing reset or dropped), Chromium. Logs `work/pass4-*.log`.

| Check | Result |
|---|---|
| `npm run test:adapters` | **9 passed, 1 skipped** — AP-1 PDF policy (audit probe, hex-escaped name, Launch, EmbeddedFiles, AA, XFA, encrypted, no `%%EOF`, JavaScript inside a Flate object stream, LZW object stream, corrupt stream, 70 MiB inflation bound; hyperlink, open action and image bytes spelling `/JS` pass); AP-2 OOXML policy; AP-3 separation of type check and engine; AP-4 engine configuration and preflight; **AP-5 [mocked-engine]** clamd adapter against a protocol double: version, 300 KiB byte-exact reassembly, EICAR, ERROR reply, garbage, dropped connection, timeout within deadline, closed port; AP-7 custody resolution, preflight and destruction evidence (a pre-destruction copy still opens the key); AP-8 trusted proxy; AP-9 ledger seals (changed, removed, reordered line detected; interrupted shipment repaired; legacy ledger sealed; production sink refusals); **AP-10 [mocked-storage]** S3 sink (conditional create, checksum, Object Lock headers ≥ 36 days, interrupted-shipment retry without overwrite, conflicting overwrite refused, tamper and deletion detected, outage beyond retries fails, transient failure retried). **AP-6 [real-engine] NOT RUN** — `ORGFIT_TEST_CLAMD_ADDRESS` unset, no engine available |
| `npm run test:adapters-db` | **6 passed** — AD-1 provenance, pre-run outage (nothing claimed, attempts 0 after 5 runs), mid-run outage (released 5×, still QUARANTINED, bytes intact), timeouts through the real adapter and a hanging double → FAILED after 3 and not claimed again, EICAR rejected with `clamd` recorded and bytes removed, error reply spends an attempt, active PDF rejected end to end, type rejection without engine verdict records no engine, old `record_scan` permission denied, CLEAN without engine refused, scanner still 0 table privileges, constraint; AD-2 staff limits (20 then 429, other address/endpoint unaffected, forged header counts nothing, malformed hops 503, per-session 5 then 429, no identifier stored, keys differ per window, auth/staff cannot read, staff cannot count, both alerts, retention); AD-3 delivery alert raised and cleared, PR4-001 reproduced and repaired, tampered ledger keeps both readiness endpoints closed, post-restore deletion ships; AD-4 intake erasure negatives (not an incident, staff and disabled approvers, wrong count, short reason, blank reference, bystander campaign, restore gate NORMAL, open campaign, six application roles denied) then success (envelopes 6→0, invitations kept, bystander 5 kept, anonymous count unchanged, audit row, one tombstone, immutable to UPDATE/DELETE/TRUNCATE, replay same id, replay opens the environment, tombstone ships); AD-5 processor records provider evidence |
| Falsification | audit PDF probe on `2452213` code → CLEAN; AD-3 with the sequence advance removed → fails |
| All 32 node suites in one run (`work/pass4-node-summary.txt`) | test 5, localization 4, requests 8, integration 8, directory 6, instruments 8, scoring 15, scoring-db 5, checkpoint-b 3, campaigns 18, respondent 24, privacy 17, checkpoint-c 21, disclosure 16, publication 13, recommendations 13, checkpoint-d 18, comparison 13, history 8, reports 17, checkpoint-e 11, visits 14, access 8, operations 9, **release 4 passed / 1 failed**, administration 8, targets 16, revocation 12, supervisor 9, safeguards 11, adapters 9 (+1 not run), adapters-db 6 — **357 passed, 1 failed, 1 skipped** |
| The one failure | R-3: the **baseline child process** (Checkpoint F code in its worktree) crashed natively (exit 3221226505) before any upgrade step — the same transient recorded in Pass 3. `test:release` run alone before the full run and again after it: **5 passed** both times (R-3 included) |
| `npm run typecheck`, `npm run lint` | clean, clean |
| `npm run build`, `npm run check:boundaries`, `npm run test:production` | exit 0, exit 0 (boundary check now also forbids the engine adapter and ledger in web builds and the staff limiter in the respondent build), exit 0 |
| TLS release rehearsal `tests/release/rehearsal.ts` (production builds, TLS proxy, TLS-only PostgreSQL, synthetic OIDC, S3 test double, **clamd protocol double**) | **13/13 PASS**: preflight — report, respondent, scanner, operator pass; staff and processor fail exactly `key-custody` and `key-custody-rehearsal`; the scanner job ran through the clamd adapter; `tombstones:ship` shipped 2 to the **s3** sink and `restore:reapply` read and verified the bucket ledger and reopened the environment |
| Browser, Chromium, `E2E_NEXT_DIST_DIR=.next-e2e` | Run 1 on ports 3100/3101 (`access`, `administration`, `reliability`, `revocation`, `visits`, `checkpoint-f`): **21 passed, 4 failed, 9 not run** — `visits.spec` and `checkpoint-f.spec` still hard-code port 3000 (connection refused; Checkpoint F serial tests then skipped), and `revocation.spec` found the results page in English after the administration spec had changed the shared Super Admin's language in the same run (the spec expects Arabic; test-order interference, not this pass). Run 2: `revocation.spec` alone on 3100/3101 **1 passed**. Run 3: `visits.spec` + `checkpoint-f.spec` on the now-free default ports 3000/3001 **12 passed** (new CLEAN label, attachment scanned through the development heuristic, F-1…F-10). All 34 selected tests passed in some run; the other browser specs were not run |

### Not run / unverified on real infrastructure

- **No maintained malware engine was run** (AP-6 not run). No ClamAV or other engine was installed, downloaded or started; no live malware was used — the only threat sample is the harmless EICAR string, and every engine test is labelled mocked.
- **No managed key custody** exists or was contacted; no crypto-erasure is claimed; deletion/recovery windows are unknown.
- **No real bucket**: Object Lock, versioning, deny-delete policy and lifecycle are unverified (S3 test doubles only).
- **No real proxy, TLS terminator, WAF or IdP/MFA**; limits are untuned defaults.
- Not re-run: the physical rollback and restore drills (`tests/ops/*.ts`) with migration 024; the remaining browser specs (the full Playwright suite was not run in one pass; the spec-order language interference above is unrepaired test tooling); `npm audit`; release manifest regeneration (019–024 are new; `orgfit-0.3.0-rc.2` no longer describes this tree); remote CI; real devices, WebKit/Firefox, screen readers.
- No alert was delivered anywhere; nothing deployed, pushed or sent.

### Open defects, assumptions and production prerequisites

**Implementation work still open (can be done in the repository):** a correction/superseding-release workflow (Pass 3); the web processes' runtime TLS check is sslmode-only (preflight covers the override); the erasure tool leaves any restored processing-batch record as it is — erasure where the restored core also holds a batch for the campaign was **not exercised** (AD-4 covers a campaign closed before processing); SEC-M4 continuous logging enforcement; RC-005 caret ranges; manifest regeneration.

**External inputs (cannot be completed without them, none approved):**

| Input | Needed for | State |
|---|---|---|
| P-010 | selecting and hosting a maintained engine, update cadence, running AP-6 | open |
| P-003 | managed key custody, custodian separation, deletion/recovery windows, custody backup policy | open — **blocking; no environment passes preflight** |
| P-002 | hosting, region, TLS, proxy header, edge limits, network separation, Object Lock bucket, secret manager, monitoring destination | open |
| P-005 | production IdP and MFA | open |
| P-004 | retention durations, backup retention/RPO/RTO measured | open |
| P-006 | approved Arabic/English questionnaire content, scoring, rules | open |
| P-007 | data and attachment policy, including approval of the active-document policy (it refuses embedded objects such as pasted Excel charts) | open |
| P-001 / P-008 | accepted threat model; independent privacy and security review, including CE-001; deployment authorization | open |

**CE-001 preserved:** the owner's P-009 answer (accept and declare, D-086) is unchanged; no disclosure rule, caveat or output was altered; the caveat remains a declaration, not a prevention, and an independent reviewer has still not seen it.

### Commit

Committed on `main` on top of `2452213` as "Post-Audit Repair Pass 4: production-security adapters and remaining technical blockers". No remote, nothing pushed, deployed or sent; no service installed or activated.

### Exact next action

Owner input, in this order: P-003 (custodian and managed key service — the blocking one), P-010 (engine), P-002 (hosting, proxy, bucket with Object Lock, monitoring), P-005, P-004, P-007, then the independent review (P-001/P-008). In the repository, once any of those arrive: write the provider adapter against its staging account (key-custody.md §5), run AP-6 against the chosen engine, re-run the TLS rehearsal and physical rollback drill with 024, run the full Playwright suite, and regenerate the release manifest.

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
