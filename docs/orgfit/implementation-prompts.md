# OrgFit — Exact Astra 6 Implementation Prompts

Version 1.0 · 8 September 2026

Use with `OrgFit-Master-Blueprint.md`. These are bounded work orders for Astra 6, not claims about a model-specific API or undocumented model capability. Use the user's chosen Astra 6 environment. No branding/design prompt is included.

## How to run the sequence

Place the blueprint in the implementation repository at `docs/orgfit/blueprint.md` and this pack at `docs/orgfit/implementation-prompts.md`. If the repository has different documentation conventions, retain them and record the actual paths. First provide the Project Brief below and Phase 00. Then send only the next phase or checkpoint after the preceding gate passes. A phase can take multiple working turns; it is a scope boundary, not a requirement to fit all work into one response.

The sequence is: **00 → 01 → 02 → 03 → A → 04 → 05 → B → 06 → 07 → C → 08 → 09 → D → 10 → 11 → E → 12 → 13 → F → 14 → 15 → G**.

The standard completion report is: implemented behavior; changed files/migrations; tests actually run with outcomes; unresolved defects/assumptions; and the next gate. Require evidence, not “production-ready” assertions. A blocked gate must name the failing check and repair needed. An unrun test is “not run,” never “passed.”

## Sessions and repository continuity

Use the same repository throughout. Phases 00–01 may share a session. Prefer a new session for each later phase and a fresh session for each checkpoint. At the start of every new session, provide the Project Brief plus the exact phase/checkpoint prompt and read `AGENTS.md`, `blueprint.md`, `decisions.md`, and `phase-status.md`. Do not restart completed work. Ensure the previous phase's changes are present in the current checkout before beginning dependent work.

These documents are already installed at the intended repository paths. Application implementation has not begun; start with Phase 00.

## Project Brief — send at the beginning of each new session

```text
You are implementing OrgFit phase by phase. Treat docs/orgfit/blueprint.md as the product and technical baseline. Read it fully before architectural work. If that path is absent, locate the supplied OrgFit-Master-Blueprint.md; do not invent missing requirements.

OrgFit is an INTERNAL platform for OrgFit personnel. It has no SaaS subscriptions, billing, client accounts, company logins, client dashboards, customer administrators, or company-to-company benchmarking. Organizations are isolated internal records/workspaces. Staff use authenticated internal pages; respondents have no accounts.

Respondents use manually shared unique secure links, save/resume before final submission, and submit once. Staff must know who has not completed a campaign. Finalized anonymous answers must have no participant/invitation/token/session/draft identifiers or other direct mapping. No staff role can browse raw answers or respondent scores. Identity tracking and final answer storage are separate security boundaries. Encrypted intake staging is temporary and explicitly not the anonymous store. Do not disguise a linkable design by removing a single foreign key.

The blueprint's precise privacy threat model is binding. It does not claim mathematical anonymity against a malicious privacy processor or infrastructure operator. Do not claim that a five-person threshold or database separation provides such a guarantee. Keep stronger-anonymity review as a production gate. Do not invent cryptography.

Completion tracking is live. Answer results are published once after closure, batch processing, scoring, and disclosure checks. At least five valid contributors are required for every released metric, including company results. Complementary suppression, rare bins, homogeneous disclosures, and report differencing must also be controlled. No arbitrary participant filters, raw response exports, or demographic intersections. Collect all requested question types, but raw text/exact dates are withheld from staff reporting by default.

Support one participant, selected participants, or one department as campaign targets. One-person campaigns remain below reporting threshold. One campaign per assessment round in v1. Roster, instrument, grouping and privacy configuration freeze at launch. Campaign start is required; end is optional; no end means open until manual closure. Closed campaigns cannot reopen.

Build reusable starter templates and full questionnaire editing with short text, long text, multiple choice, checkboxes, dropdown, yes/no, 1–5 and 1–10 ratings, matrix, number, date, and section content. Answer questions are required by default and can be optional. NO conditional branching or skip logic.

Scoring is deterministic and versioned: averages, weighted averages, bounded sums, explicitly defined percentages, reverse scoring, dimensions, coverage rules, direction, and interpretation bands. Automatic recommendations are deterministic rules over released aggregate metrics, not AI. Preserve original assessment history and compare only compatible versions within one organization. Provide safe PDF/XLSX reporting and a physical field-visits module.

Arabic is default with RTL; English is secondary with LTR. Build localization and replaceable semantic theme variables from the foundation. Mobile surveys must be excellent. Do not create branding, logo, palette, or a design prompt.

For EVERY phase:
1. Inspect repository instructions, current code, dependency lockfiles, database schema/migrations, pending changes, previous phase notes, and tests before editing. Treat existing user changes as work to preserve.
2. Identify the exact scope and dependencies. Implement only the requested phase and necessary compatible fixes. Do not modify unrelated completed modules or rewrite architecture unnecessarily.
3. Reuse established conventions. A framework/database/auth/queue change requires a written decision with evidence, impact, and migration plan; do not silently substitute architecture.
4. Use real persisted behavior, server validation, and server authorization. Do not declare mock-only screens or TODO security boundaries complete.
5. Add migrations deliberately; never reset databases or drop production data. Verify fresh installation and relevant upgrade behavior. Use synthetic data in tests.
6. Run relevant tests and repair regressions introduced by the phase. Update docs/orgfit/phase-status.md with evidence and next dependencies. Do not start the next phase automatically.
7. Never claim tests, privacy, deployment, or backups are verified without actual evidence. Document blockers precisely. Development can proceed on stated baseline assumptions; real deployment, real external messages, and external data sharing need explicit authorization.

Do not build the whole product now. Begin only with the phase prompt I provide.
```

## Phase 00 — Architecture analysis, no coding

```text
Execute OrgFit Phase 00 only: architecture and requirements analysis. Read the supplied blueprint and project brief, then inspect the current repository, repository instructions, existing code, lockfiles, migrations/database structure, and tests. Do not implement application code or execute migrations.

Produce docs/orgfit/architecture-analysis.md, docs/orgfit/requirements-traceability.md, docs/orgfit/decisions.md, and docs/orgfit/phase-status.md using existing documentation conventions if different.

Your analysis must:
- Reconcile the repository against every binding requirement and identify existing modules that should be preserved.
- Define module boundaries, deployment units, dependencies, organization isolation, two staff roles/capabilities, and the public respondent trust boundary.
- Recommend the existing stack when suitable. If empty, propose an adaptable mainstream stack and verify current supported dependency choices using official sources. Do not invent version numbers or replace a working stack for stylistic reasons.
- Diagram identity tracking, encrypted drafts, temporary encrypted intake, anonymous storage, scoring, publication, exports, and key/log/backup access. Identify every place identity and plaintext answers may transiently coexist.
- Analyze original-link versus private-resume-secret security, one-use finalization, crash recovery, completion-versus-processing semantics, frozen groups, small targets, text/date disclosures, complementary suppression, and repeated-result differencing.
- State precisely what anonymity is and is not guaranteed. Flag malicious processor/infrastructure resistance as outside the baseline rather than falsely claiming it. Identify independent privacy-review requirements for production.
- Define the phase dependency graph and a practical testing plan with synthetic two-organization fixtures.
- Record baseline assumptions without repeatedly asking optional questions. Separate development decisions from real-deployment inputs.

Do not modify unrelated completed modules or rewrite architecture unnecessarily. Deliver a concrete reviewable analysis, decisions, open risks, and readiness for Phase 01. No UI, business logic, dependency installation, or application implementation in this phase.
```

## Phase 01 — Database, state machines, and API contracts, no application coding

```text
Execute OrgFit Phase 01 only. First inspect existing code/database/migrations, Phase 00 decisions, the blueprint, repository instructions, and pending changes. Preserve unrelated completed modules and do not rewrite architecture unnecessarily. This phase produces design artifacts and reviewable proposed schema; do not run migrations or build application behavior.

Create docs/orgfit/data-model.md, proposed-schema.sql (or equivalent schema draft), api-contracts.md, state-machines.md, and privacy-protocol.md.

Specify every entity from the blueprint with field types, nullability, keys, indexes, checks, org-scoped foreign keys, unique constraints, deletion/retention behavior, credentials and access boundary. Explicitly exempt anonymous rows from generic created_at/updated_by/request-ID metadata. Include a relationship diagram showing NO edge from finalized responses to participants, invitations, drafts, tokens, or envelopes.

Design endpoint contracts for staff organization/directory/instrument/campaign/results/report/visit operations and public invitation exchange, draft create/save/resume, review/finalize/status. Include request/response schemas, authorization, relevant states, error codes, idempotency and organization resolution. Do not return raw response IDs or payloads from staff APIs.

Specify:
1. One local transaction for validated encrypted intake acceptance plus invitation completion; campaign-before-invitation lock order; uniqueness; and the exact closure/end-time race rule.
2. Independent respondent-held draft key; original invitation link alone cannot reveal existing draft content; cross-device resume contract; stale revision handling.
3. Closed-campaign full-batch anonymization, independent random output IDs, batch-level idempotency, commit marker, recovery after every crash point, and backup-safe staging/key cleanup.
4. One-time safe result publication, metric-specific five-contributor minimum, conservative company-only fallback when any department cell is small, sparse-bin and homogeneous-output suppression.
5. Immutable instrument/scoring/rule versions and historic snapshots; state transition guards and authority of request-time start/end checks.

Produce an access matrix for actual database roles. Application runtime roles must not own tables or bypass row security. Explain the limits of database policies against infrastructure administrators.

End with a design review checklist, unresolved contradictions, and whether Phase 02 can proceed. Do not claim the custom privacy pipeline is independently verified merely because the design is written.
```

## Phase 02 — Foundation, authentication, and shared infrastructure

```text
Execute OrgFit Phase 02 only. Inspect current repository/code/database/migrations, Phase 00–01 artifacts, pending changes and tests first. Preserve unrelated completed modules; do not rewrite architecture unnecessarily. Confirm the actual stack before installing dependencies.

Implement the minimal working foundation:
- Staff authentication without public registration; Super Admin/Staff roles, capabilities, organization assignments, server authorization helpers, protected routes and session handling.
- Foundational schema/migrations for staff/access/organization boundaries and safe audit infrastructure. Runtime and migration credentials must be distinct. Use real PostgreSQL integration tests for applicable policies.
- Staff application shell and separate respondent origin/entry architecture, without implementing surveys yet.
- Arabic default localization catalogs, English fallback policy, root lang/dir, logical CSS, locale persistence, accessible shared controls, and centralized replaceable semantic theme variables. No branding decisions.
- Shared input validation, safe error format, environment validation, secret handling, private storage/queue adapters as required by the approved design, and health/readiness endpoints.
- CI/build/type/lint/test setup and synthetic seed procedure. Use a safe bootstrap procedure for the first admin; do not commit credentials.

Tests must show anonymous staff-route denial, disabled staff denial, capability enforcement, Arabic/English direction switching, safe missing-environment failure, and fresh/upgrade migration behavior for implemented tables.

Do not build questionnaire, campaign, analytics or visit business features yet. Record actual tests and changed files/migrations in phase-status.md. Fix foundation regressions before reporting Phase 02 complete.
```

## Phase 03 — Organizations, departments, and participants

```text
Execute OrgFit Phase 03 only. Read the blueprint and inspect existing code/database/migrations, access helpers, phase notes, pending changes and tests before editing. Reuse the foundation. Do not modify unrelated completed modules or rewrite architecture unnecessarily.

Implement organization list/create/edit/archive and internal workspaces; department CRUD/archive with optional hierarchy and cycle prevention; participant CRUD/archive with private reference, name, department, position, job level, optional gender/age group/years of service and optional approved contact fields. Scope all queries, writes, selection state, jobs and files to one authorized organization.

Implement a reviewed CSV/XLSX import: field mapping, dry-run validation, duplicate reference handling, invalid department reporting, preview, explicit commit, idempotent commit, temporary-file expiration and error download. Do not silently merge ambiguous participants or let one organization's references resolve into another.

Participant details may show directory information and future invitation-status placeholders, never individual scores. Organization landing pages must not blend company assessment scores. Archive preserves referential history. Add appropriate indexes and scoped foreign keys.

Test two organizations with overlapping participant codes, cross-org ID substitution on every implemented read/write/download, staff assignments/capabilities, duplicate imports, dry-run nonmutation, idempotent commits, department cycles, archive behavior, and Arabic/English forms.

Finish with actual test evidence, migrations and screen coverage, then stop for Checkpoint A. Do not build campaign or survey features in this phase.
```

## Checkpoint A — Foundation and organization isolation

```text
Run OrgFit Checkpoint A. Inspect current code, live development/test schema, migrations, pending changes, Phase 00–03 artifacts and test evidence. Do not add features, modify unrelated completed modules, or rewrite architecture unnecessarily.

Independently trace staff authentication and every implemented org-scoped read/write/job/file operation. Use two organizations and overlapping references to attempt cross-org access. Verify runtime database roles, scoped foreign keys, capability revocation, default Arabic direction, import dry-run/idempotency, and archive integrity. Run a fresh database setup and an upgrade path appropriate to current migrations.

Identify reproducible defects and regressions. Fix them with the smallest compatible changes and regression tests; rerun affected checks. Report each finding with severity, evidence, fix and retest result. Update phase-status.md with PASS or BLOCKED. Any isolation or data-loss defect blocks Phase 04. Do not claim success for checks you could not execute.
```

## Phase 04 — Questionnaire library and full builder

```text
Execute OrgFit Phase 04 only after Checkpoint A passes. First inspect existing code/database/migrations, blueprint, phase notes, validation/localization conventions and pending changes. Preserve unrelated completed modules and do not rewrite architecture unnecessarily.

Implement blank questionnaire creation, built-in illustrative template cloning, custom library, draft editing, immutable publication, retirement, and new-version creation. Seed only clearly labeled illustrative templates; do not claim scientific validation.

Build section/question/options/matrix editing, keyboard-accessible ordering/duplication, AR/EN content, required-by-default questions, optional toggle, validation, optimistic concurrency and synthetic respondent preview. Support short/long text, multiple choice, checkboxes, dropdown, yes/no, rating 1–5, rating 1–10, fixed-row matrix, number, date, and section content. No conditional logic or skip behavior anywhere.

Implement dimensions and declarative scoring/interpretation configuration storage/editors required by the approved schema, but leave actual computation to Phase 05. Validate structure and references. Model matrix rows as separately weighted scoring items. Preserve stable lineage keys while assigning new IDs to copies. Content blocks never count as required questions or progress items.

Publication must reject incomplete enabled-language content, invalid options/types/ranges, inconsistent mandatory constraints, invalid references, unknown conditional configuration and unsafe markup. Published records cannot be changed through API or direct ordinary application writes. Editing creates a draft version; copying never changes the source.

Test round trips for every question type, mandatory defaults, optional questions, publish failures, immutable versions, concurrent editing, keyboard ordering, AR/EN preview and sanitization. No real invitations or response collection yet. Record evidence and hand off to Phase 05.
```

## Phase 05 — Scoring and interpretation engine

```text
Execute OrgFit Phase 05 only. First inspect current code/database/migrations, Phase 04 instrument schema/editor, blueprint scoring specification, pending changes and tests. Do not modify unrelated completed modules or rewrite architecture unnecessarily.

Implement a pure, deterministic versioned scoring module with declarative validated inputs. Support averages, weighted averages, bounded sums, explicit numerator/denominator percentages and reverse scoring. No eval, SQL expressions, arbitrary formulas, network calls or AI.

Apply reverse x'=L+U-x before min–max normalization n=100*(x'-L)/(U-L). For 1–5 rating 4 the normalized value is 75, not 80. Enforce positive weights, valid bounds and denominator, coherent matrix weights, per-dimension direction, required coverage and explicit missing policies. Default average coverage is 80%; SUM/fixed-denominator percentage require all contributing inputs. Optional missing is not zero. Overall requires all configured dimension scores in v1 and explicit common direction/orientation.

Implement continuous interpretation bands covering the full valid domain with half-open boundaries and inclusive final endpoint. Classify before display rounding. Include raw value where meaningful, normalized score, coverage, status, engine/config version and direction. Never invent an overall for an unscored questionnaire.

Connect the synthetic scoring sandbox and publish validators. Add golden tests for all blueprint examples: 83.333333 equal mean; 81.25 weighted; 80% vs 60% coverage; 9/12 sum; 8/10 yes percentage; overall 78; company respondent-weighted 60 rather than unweighted department mean 65. Test zero denominators, bands/boundary rounding, reverse twice, scale endpoints, weight-scale invariance, mixed scale/direction rejection and deterministic execution.

Do not create staff individual scorecards or real analytics. Record evidence and stop for Checkpoint B.
```

## Checkpoint B — Instrument versioning and scoring correctness

```text
Run OrgFit Checkpoint B. Inspect current code/database/migrations, instrument definitions, scoring implementation and prior evidence before testing. Do not add features, modify unrelated completed modules, or rewrite architecture unnecessarily.

Trace each builder type through persisted definition, validation, synthetic answer and scoring. Verify immutable published content including translations/rules, stable-key lineage, no conditional logic, and no side effects from previews. Independently recalculate the blueprint golden examples. Test required versus scoring-eligible distinctions, optional weighted coverage, matrix contributions, exact interpretation boundaries, mixed direction and malformed definitions. Confirm identical inputs/version yield identical outputs.

Fix reproducible defects with narrow patches and regression tests. Re-run builder/scoring checks and foundation isolation smoke tests. Record PASS or BLOCKED with actual outputs in phase-status.md. Any incorrect score, mutable published instrument, or cross-org access defect blocks Phase 06.
```

## Phase 06 — Assessment rounds, campaigns, and secure invitation links

```text
Execute OrgFit Phase 06 only after Checkpoint B. Inspect existing code/database/migrations, blueprint state/privacy contracts, prior evidence and pending changes. Reuse completed modules; do not modify unrelated completed modules or rewrite architecture unnecessarily.

Implement assessment series/round records with one campaign per round, version selection, SINGLE/SELECTED/DEPARTMENT targeting, target deduplication, frozen roster/group snapshots, and campaign launch review. Create one invitation per participant per campaign/round. No automatic invitation sending: copy and short-lived manual link export only.

Generate 256-bit random bearer tokens; persist keyed digests only with key version/generation. Provide opaque display references separate from credentials. Implement unused-token rotation and revocation that also invalidate existing sessions. Do not create an impersonation/draft-view endpoint. Generated raw links are revealed only at issuance; lost unused links are rotated.

Implement DRAFT/SCHEDULED/OPEN/CLOSED/CANCELLED state rules, required start, optional end, request-time boundary checks, durable scheduling, manual close, audited end-date adjustments before closure, and no reopening. A passed end boundary cannot be bypassed because the scheduler is late. Freeze instrument, roster, groups, privacy policy and threshold at launch; later directory edits do not alter them.

Build named participation status lists and denominator definitions from the blueprint. No answers or live assessment scores. Prepare the gateway validation/status contract without falsely marking the anonymous finalization pipeline complete.

Test all targeting modes, single-person report-ineligibility messaging, org mismatches, duplicate invitations, roster changes after launch, no-end campaigns, exact start/end cases, stale scheduler behavior, token rotation/revocation, generic invalid-link errors and export access/expiry. Hand off the tested campaign state/locking contract to Phase 07.
```

## Phase 07 — Respondent flow, encrypted drafts, and anonymous intake

```text
Execute OrgFit Phase 07 only. First inspect current code/database/migrations, campaign/token code, privacy-protocol design, approved threat model, pending changes and tests. Preserve unrelated completed modules and do not rewrite architecture unnecessarily. Do not improvise cryptography; use reviewed established libraries and document the actual trusted processor/key boundary.

Implement the mobile-capable Arabic-first public flow: invitation exchange, welcome/privacy notice, fixed-section form, save/resume, review, final confirmation, accepted/locked state and all lifecycle errors. Respondents have no accounts. No third-party tracking or session replay.

For drafts, generate a respondent-held independent high-entropy secret in the browser and use vetted authenticated encryption. The original admin-generated link alone must not decrypt a previous draft. Implement same-browser resume and cross-device resume using the invitation plus private resume code, optimistic revisions, conflict handling, accurate save status, explicit lost-code/start-over behavior, and draft cleanup/inaccessibility after submission. Never log or store a usable draft key server-side.

For final submission, server-resolve pinned version/org/group, validate the complete answer payload, lock campaign then invitation, recheck state/time/token generation, and atomically insert the restricted encrypted inbox envelope plus mark invitation COMPLETED in one database transaction. Return success only after durable commit. Invalid input does not consume a link. Retried completion returns generic acceptance without payload retrieval or overwrite. The unique invitation constraint and lock must enforce one accepted final submission.

Implement closed-campaign privacy processing: freeze accepted set; never release sub-five campaigns; trusted worker strips transport/identity data, uses approved coarse groups, shuffles, assigns fresh random response IDs and commits output plus batch marker atomically in separate anonymous storage. No invitation/token/draft/envelope identifiers, exact submission timestamps, IP/user agent, request IDs, answer checksums linked to identity, or per-person transfer logs may survive in finalized storage. Retain only batch-level idempotency. Verify commit before purging intake and applying documented key/backup-safe cleanup. Count mismatch blocks publication.

Run fault-injection tests before commit, after intake commit, during transfer, after anonymous commit before cleanup, and after lost HTTP success. Run 100 concurrent final attempts for one invitation and prove exactly one immutable accepted payload. Test close-vs-submit race, expired/revoked token, tampered group/version/options, draft privacy, logging configuration, and cross-org separation. Audit queue payloads, error traces and SQL logs for forbidden fields.

Do not expose answer analytics yet. Document precise privacy guarantees and residual privileged-operator risks. Stop for Checkpoint C; a UI-only survey flow is not phase completion.
```

## Checkpoint C — Privacy and submission reliability gate

```text
Run OrgFit Checkpoint C as a blocking privacy/concurrency review. Inspect current code, actual database grants/schema, gateway/processor deployment identities, migrations, queue payload formats, observability configuration and previous test evidence. Do not add features, modify unrelated completed modules, or rewrite architecture unnecessarily.

Attempt to connect a named participant to finalized answers through schema keys, tokens/hashes, draft handles, request IDs, row order, precise timestamps, generic audit columns, jobs, errors, backups and exports. Verify no staff role including Super Admin can retrieve raw answers or decryptable drafts. Test whether an administrator's copy of the original invitation can reveal saved draft content. Verify role separation in the actual configuration, not just comments.

Re-run concurrent finalization and every crash boundary, including retry after uncertain commit, closure races, duplicate batch delivery and intake cleanup after already-committed output. Reconcile accepted and processed counts. Confirm sub-five campaigns cannot yield an answer release and completed answers cannot be edited/retrieved through resume.

Document infrastructure/key-custodian assumptions and any unverified cryptographic/backup property. Fix implementation defects with regression tests. Mark PASS or BLOCKED, with separate production privacy-review prerequisites. A direct link, plaintext draft exposure, duplicate/lost accepted submission, or unimplemented trust boundary blocks Phase 08 and all real respondent data. Do not equate passing these tests with proof against malicious infrastructure operators.
```

## Phase 08 — Safe publication and analytics

```text
Execute OrgFit Phase 08 only after Checkpoint C's implementation gate passes. Inspect current code/database/migrations, score library, privacy output, previous evidence and pending changes. Do not modify unrelated completed modules or rewrite architecture unnecessarily.

Implement trusted score computation, immutable result snapshots and a centralized disclosure/publication service. Staff analytics may read only published aggregate cells, never raw-answer storage. Keep live operational participation separate from closed-campaign assessment results. One release per closed campaign; no reopening or live score polling.

For every metric, count distinct valid contributors and require >=5. Campaign total does not satisfy a sparse metric. Suppressed cells contain no protected value in staff-accessible storage/API/chart metadata. Treat INSUFFICIENT, UNSCORED, SUPPRESSED and NOT_COMPARABLE separately; none is numeric zero.

Implement conservative disclosure rules: company plus one fixed flat department partition; if any nonempty department contributor cell is <5, release company-only for that metric unless a reviewed algorithm proves a safer permitted release. Protect sparse option bins, complementary totals, unknown-department categories and homogeneous sensitive endpoint results. No arbitrary filters, participant exclusions, submission-time slices, hierarchy rollups, demographic intersections or raw text/exact-date outputs. Validate the complete release plan, not isolated cards.

Build overall/dimension bars and radar, department-vs-company table/bar/heatmap, safe question analysis, bands, strengths/weaknesses, coverage/status explanations and accessible data tables. Use existing replaceable theme tokens. Company metrics average valid respondent-level values, not unweighted department means. Do not pool unrelated questionnaires or organizations.

Test n=4/n=5, campaign n=20 with metric n=4, 10+2 department reconstruction, sparse bins, multiple selections, homogeneous endpoints, cache leaks, hidden chart data, missing-vs-zero and API rejection of unsupported filters. Verify an open campaign produces no assessment metrics. Snapshot generation must be repeatable and idempotent. Record evidence and prepare Phase 09.
```

## Phase 09 — Deterministic recommendation engine and actions

```text
Execute OrgFit Phase 09 only. Inspect existing code/database/migrations, versioned rules schema, publication/disclosure contracts, prior evidence and pending changes. Preserve unrelated completed modules; do not rewrite architecture unnecessarily.

Implement the versioned rule editor/evaluator using allowlisted bounded ALL/ANY numeric comparisons over known aggregate metrics. Rules and translations freeze with the instrument version; changes require a new draft/version. No arbitrary code evaluation or AI integration.

Evaluate only privacy-approved available metrics from the same snapshot and group. Suppressed/missing/not-comparable inputs are UNKNOWN, never zero, and rules depending on them do not fire. Apply explicit direction, full-precision thresholds, priority, deterministic tie-breaking, exclusivity groups and dedup keys. Persist rule version and safe rationale/evidence with localized recommendation text.

Build recommendation results with priorities, explanations, acknowledgment/action status, owner, due date and separately labeled consultant notes. Computed evidence stays immutable. Do not expose raw underlying respondent scores. Defer historical delta rules until compatible comparison support exists.

Test exact boundaries, no-match, unknown/suppressed inputs, contradictory exclusive matches, deterministic order, deduplication, localization and version immutability. Verify a hidden score cannot be inferred from a displayed recommendation or risk badge. Record results and stop for Checkpoint D.
```

## Checkpoint D — Results and recommendation disclosure

```text
Run OrgFit Checkpoint D. Inspect current code/database/migrations, every result endpoint, caches, charts, recommendation evaluator, publication storage and previous tests. Do not add features, modify unrelated completed modules, or rewrite architecture unnecessarily.

Use adversarial datasets: four contributors; five total but four valid for a metric; departments of ten and two; sparse categorical bins; checkbox overlap; missing groups; homogeneous endpoint answers; and attempts to obtain alternate partitions or successive snapshots. Try to reconstruct protected values from totals, tooltip data, serialized chart configuration, recommendations, statuses and caches.

Verify scores against the scoring engine, contributor-weighted company means, direction-aware strengths, frozen publication and no live response-score exposure. Confirm rule output is absent when required evidence is protected.

Repair defects with the smallest compatible changes, add regressions and rerun affected tests plus org-isolation checks. Record PASS or BLOCKED with evidence. Any suppressed value reachable through API/UI/recommendations or reconstructable by the supported partition views blocks Phase 10. State residual background-knowledge limitations honestly.
```

## Phase 10 — History and assessment comparison

```text
Execute OrgFit Phase 10 only after Checkpoint D. Inspect existing code/database/migrations, assessment series/rounds, frozen manifests, result snapshots and prior evidence. Do not modify unrelated completed modules or rewrite architecture unnecessarily.

Implement within-organization series history, chronological round lists, trend charts/tables and two-round comparisons. Preserve original questionnaire/scoring/rule/privacy versions, roster/group labels and collection periods. Never join respondent identities across rounds.

Add IDENTICAL/REVIEWED_EQUIVALENT/NOT_COMPARABLE classification with explicit mapping and review rationale. Default numeric comparison requires compatible constructs, item mappings, normalization, weights and direction. Translation-only changes may be reviewed equivalent; stable question keys alone are not equivalence. Department renames retain lineage and historic labels; mergers/splits block automatic comparison.

Show eligible earlier/later metrics, absolute score-point change, direction-correct improvement, dates and population/coverage caveats. Missing/suppressed values remain gaps and cannot produce deltas or recommendations. Do not draw interpolated values through hidden points. No company-to-company benchmark or individual history.

If enabling historical recommendation conditions, require available comparable metrics from both snapshots and apply existing disclosure policy. Do not silently re-score or replace historic publications.

Test incompatible versions, translated-equivalent versions, direction flips, zero baseline, missing rounds, participant department moves, department rename/merger and cross-org comparison denial. Record actual evidence and hand off to reports.
```

## Phase 11 — Professional PDF and Excel outputs

```text
Execute OrgFit Phase 11 only. Inspect current code/database/migrations, publication/history APIs, storage authorization, queue behavior, localization and prior evidence. Preserve unrelated completed modules; do not rewrite architecture unnecessarily.

Implement async PDF and XLSX generation from immutable privacy-approved snapshots only. Report worker credentials must not read the private directory or raw answers. Include organization/assessment/period, executive summary, methodology, participation totals without names, eligible overall/dimensions/departments, strengths/risks, deterministic recommendations, consultant commentary clearly labeled, compatible history, suppression limitations and version manifest.

PDF must support actual Arabic shaping/RTL, selectable text, licensed embedded fonts, long tables, chart labels, repeated headers, page numbering and replaceable report theme tokens. Generate Arabic and English variants. Render and visually inspect representative short/long reports; do not stop after successful file creation.

XLSX should provide typed numeric metrics and Summary/Dimensions/Departments/Questions/Recommendations/History/Methodology sheets as applicable. Suppressed cells contain no hidden value, hidden sheet, formula or embedded chart cache that leaks it. Add status/reason separately. Neutralize spreadsheet formula injection in user-entered strings; verify Arabic and sheet direction.

Keep named participation exports in a separate private export path/file with separate capability checks and no response/score identifiers. Do not combine it with the assessment workbook. Downloads are private, expiring and reauthorized against current organization access. Job retries are idempotent; never send reports externally automatically.

Test dashboard/PDF/XLSX value equality, suppression leakage including internal workbook/chart structures, long Arabic rendering, injection, expired/revoked downloads, cross-org access, permission revocation after job creation and failed-job retry. Record artifacts inspected and actual results; stop for Checkpoint E.
```

## Checkpoint E — History and report consistency

```text
Run OrgFit Checkpoint E. Inspect current code/database/migrations, comparison manifests, report jobs/artifacts, export internals and prior evidence. Do not add features, modify unrelated completed modules, or rewrite architecture unnecessarily.

Choose a comparable series, an incompatible series, a department reorganization, a sparse campaign and a long Arabic instrument. Generate dashboard/history/PDF/XLSX outputs from each eligible case and compare actual values, direction, dates, labels, versions and suppression statuses. Inspect PDF pages visually and XLSX hidden sheets/formulas/chart caches. Attempt unauthorized and expired downloads and permission revocation after generation.

Repair regressions narrowly and retest. Ensure historic directory edits cannot change already-published results and incompatible data cannot appear as a valid trend. Record PASS or BLOCKED, actual artifacts inspected and unrun checks. Any protected-data leak, incorrect historic delta or unreadable Arabic report blocks Phase 12.
```

## Phase 12 — Physical field visits and attachments

```text
Execute OrgFit Phase 12 only after Checkpoint E. Inspect existing code/database/migrations, organization authorization, staff records, storage/scanning adapters, prior evidence and pending changes. Preserve unrelated completed modules and do not rewrite architecture unnecessarily.

Implement visit calendar/list/detail/create/edit for organization, date/time/timezone, assigned active OrgFit consultant, purpose, notes, findings, recommendations, follow-up date, status and optional same-organization assessment round. Add follow-up action items with owner/due date/status and internal overdue list. No automatic emails/calendar messages or external integrations.

Enforce DRAFT/SCHEDULED/IN_PROGRESS/COMPLETED/CANCELLED transitions, cancellation reasons and audited amendments to completed visits. Visit content is confidential consulting material, distinct from anonymous survey data; no links to raw response records.

Implement private attachments with approved type/size limits, actual content-type verification, generated storage names, quarantine/scanning, safe download/preview, access checks and retention cleanup. Block executable/active content and unscanned access.

Test invalid transitions, inactive consultant assignment, cross-org assessment/attachment access, malicious/mislabeled/oversized files, scanning failures, download expiration, follow-up filters and Arabic forms. Record evidence and proceed only to Phase 13.
```

## Phase 13 — Localization, mobile, accessibility, and complete journey refinement

```text
Execute OrgFit Phase 13 only. Inspect current code/database/migrations, all implemented routes, localization catalogs, theme variables, browser tests and prior evidence. Preserve unrelated completed modules; do not rewrite architecture unnecessarily. This is functional refinement, not a new branding or design exercise.

Audit and repair Arabic-default RTL and English LTR across staff pages, respondent flow, validation/errors, emails if any exist for staff identity only, reports, charts, tables and files. Verify language switching preserves answers/state, mixed-direction IDs/URLs remain legible, numeric inputs accept Arabic-Indic and Latin numerals, and timezone/date presentation is consistent. Keep canonical stored values locale independent.

Refine mobile respondent experience at 320px and wider: no page overflow; matrix rows stack with correct semantics; 44px preferred targets; keyboard/focus and screen-reader labels; 200% zoom; long Arabic prompts; progress excludes content blocks; save/conflict/offline status is truthful. Target WCAG 2.2 AA. Keep theme changes centralized and replaceable.

Exercise welcome → draft save → browser refresh → same-device resume → second-device private-code resume → review → final submission → retry/already submitted. Cover slow/disconnected network, multi-tab conflict, expired session, campaign closing while editing, browser back and virtual keyboard obstruction. Never weaken token/privacy rules to smooth an error state.

Run representative iOS Safari and Android Chrome tests when available and state clearly which real devices/browsers were actually tested. Add automated accessibility and browser regressions plus manual keyboard/screen-reader checks. Record remaining device limitations and stop for Checkpoint F.
```

## Checkpoint F — Full functional journey

```text
Run OrgFit Checkpoint F. Inspect current code/database/migrations, phase evidence and pending changes. Do not add features, modify unrelated completed modules, or rewrite architecture unnecessarily.

Using synthetic data in two organizations, run the complete staff journey: create organization/departments/participants, import with errors, clone/edit/publish an instrument, verify scoring preview, launch a campaign, manually obtain links, save/resume/submit, verify outstanding list, close/process/publish, inspect safe analytics/recommendations, compare a second compatible round, generate Arabic/English PDF/XLSX, and record a visit with follow-up/attachment. Also run a below-threshold campaign and incompatible history case.

Repeat the respondent journey on narrow screens and in both languages with keyboard/error/network tests. Confirm the privacy boundary remains intact and no new translation/mobile behavior bypasses validation or exposes drafts. Verify visit attachments and reports are organization-scoped.

Fix regressions with targeted changes and test evidence. Record PASS or BLOCKED and any genuinely unavailable manual/device checks. Any core journey failure, broken Arabic/mobile completion, cross-org access or privacy leak blocks Phase 14.
```

## Phase 14 — Security, retention, backups, and resilience

```text
Execute OrgFit Phase 14 only after Checkpoint F. Inspect current code/database/migrations, actual deployment configuration, database grants, dependencies, logs, storage, queues, key handling and previous evidence. Do not modify unrelated completed modules or rewrite architecture unnecessarily. Do not use production personal data.

Harden and verify staff MFA/session revocation, object/capability authorization, row-security runtime roles, CSRF/CORS/CSP, sanitization, input/body limits, secret management, token rotation, rate limiting with shared-NAT usability, attachment scanning and private downloads. Audit all gateways/proxies/error trackers/SQL logs for tokens, answers, draft keys and correlation bridges. No public survey session replay.

Implement approved configurable retention jobs and purge/crypto-erasure handling for drafts, intake, exports, anonymous responses, audit records and backups. If owner-specific durations remain unapproved, use documented nonproduction defaults and keep production approval flagged; do not silently declare them accepted. Restore must reapply deletion tombstones before access. Verify key custody and limits of backup/key deletion honestly.

Run fresh/upgrade migrations, fault injection, queue duplicate/retry/dead-letter tests, measured load against the blueprint targets, count reconciliation, monitoring alert drills and a timed isolated backup restore. Demonstrate invitation completion/inbox/anonymous-batch consistency after recovery. Record actual RPO/RTO results rather than assumed provider promises.

Produce docs/orgfit/security-review.md, privacy-verification.md, retention-backup-runbook.md, incident-runbook.md and performance-results.md. Include severity-ranked residual issues, exact tests/configuration inspected, owners and repair steps. Fix critical/high implementation defects within scope. Independent privacy/security review remains a production gate where required; do not self-certify cryptographic anonymity.

Do not deploy to production or send external messages. Hand off a factual release-readiness gap list to Phase 15.
```

## Phase 15 — Final release candidate and production readiness

```text
Execute OrgFit Phase 15 only. Inspect current code/database/migrations, every phase/checkpoint status, security/privacy findings, unresolved tests, actual deployment environment and pending changes. Preserve unrelated completed modules; do not rewrite architecture unnecessarily.

Assemble a reproducible release candidate and stage it only in an already authorized nonproduction environment. Verify environment variables and secret/key references, build/dependency locks, service permissions, migrations, private storage, jobs, health/readiness checks, TLS/domain configuration where available, monitoring, report rendering, backups and rollback/recovery procedures. Never reset a database or deploy to production without explicit authorization.

Run the full relevant automated suite and a final synthetic end-to-end smoke test on the release candidate. Demonstrate that rollback or restore cannot reopen consumed invitations, duplicate accepted submissions, lose committed intake silently, or expose expired data. Validate a clean installation and upgrade from the previous supported release schema.

Prepare docs/orgfit/release-checklist.md, deployment-runbook.md, staff-operations-guide.md and final-handoff.md. Document how staff manage directories, publish instruments, generate links manually, track outstanding participants, close/publish results, read suppression, generate reports and manage visits. Explain private resume codes and inability to recover individual anonymous answers.

List exact remaining production inputs: accepted privacy threat model/notice, independent review where required, real approved instrument content/translations/scoring/rules, provider/region and key custody, staff bootstrap, retention decisions, actual restore evidence and deployment authorization. Do not hide unavailable infrastructure checks behind a generic 'ready' label.

Report GO or NO-GO with evidence, release identifier, tests actually run, unresolved blockers and rollback plan. Finish all reviewable authorized preparation before asking for any necessary final production approval. Do not deploy as part of this prompt. Stop for Checkpoint G.
```

## Checkpoint G — Final go/no-go inspection

```text
Run OrgFit Checkpoint G against the exact Phase 15 release candidate. First inspect current code/database/migrations, pending changes, deployment manifest and every checkpoint/security/privacy artifact. Do not add features, modify unrelated completed modules, or rewrite architecture unnecessarily.

Verify the candidate matches tested code and migrations. Re-run final smoke checks for authentication/isolation, all survey lifecycle boundaries, one-use submission, draft privacy, anonymous batch recovery, suppression including exports/recommendations, compatible history, Arabic/mobile completion, report rendering, visit attachment access and restored-data consistency. Check that no unresolved critical/high defect or required privacy review is mislabeled as complete.

Produce a final acceptance matrix against blueprint requirement IDs and major module acceptance criteria. For every line mark VERIFIED with evidence, NOT VERIFIED with the missing check, or BLOCKED with defect and owner. Confirm prohibited scope has not appeared: subscriptions/billing, client accounts/dashboards, cross-company benchmarks, skip logic, raw respondent exports or AI-dependent recommendations.

Fix any release-blocking regression with minimal changes and rerun affected verification. Output a concise GO/NO-GO decision and a factual list of remaining owner inputs/approvals. A technical GO is not authorization to deploy. Stop; do not publish, send messages or start unrelated work.
```

## Recovery prompt — use only when a checkpoint is blocked

```text
Repair the blocked OrgFit checkpoint described in the latest checkpoint report. Inspect current code/database/migrations, pending changes, the failing evidence and relevant blueprint requirements before editing. Preserve unrelated completed modules and do not rewrite architecture unnecessarily.

Reproduce each blocker, identify its cause, implement the smallest compatible fix, add a regression test and rerun affected checks plus relevant isolation/privacy smoke tests. Do not bypass a requirement, weaken a test, remove suppression, add a hidden identity mapping, or reset data to make the checkpoint pass.

Update the checkpoint report and phase-status.md with evidence. If a blocker depends on missing infrastructure, credentials, independent review or an explicit owner decision, state exactly what is missing and complete unaffected work. Do not mark the checkpoint passed without verification. Do not start the next phase automatically.
```

## Scope-change prompt — use if a later requirement changes

```text
Analyze the following proposed OrgFit change before implementation: [insert the exact change]. First inspect current code/database/migrations, the blueprint, completed phase evidence and pending changes. Do not code yet, modify unrelated completed modules, or rewrite architecture unnecessarily.

Identify affected requirements, modules, schema/API contracts, historic compatibility, privacy/anonymity guarantees, report disclosure, migrations, tests and deployment consequences. State whether the change conflicts with any binding constraint. Propose the smallest compatible implementation and a regression plan, preserving immutable published instruments/results.

Provide a concrete change plan and decision record for review. Do not silently broaden scope or weaken anonymity to accommodate convenience. Do not execute destructive migrations or deploy.
```
