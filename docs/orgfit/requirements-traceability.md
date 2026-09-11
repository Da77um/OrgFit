# OrgFit requirements traceability

Date: 2026-09-08 · Phase 00 design reconciliation

Phase 11 evidence update (2026-09-10): REPORT-01 gains development evidence in [reports.md](reports.md). Arabic and English PDF and XLSX are rendered asynchronously from an immutable published release whose whole render input is frozen on the job and re-checked by the database — no non-AVAILABLE cell may carry a value anywhere in the document, and every released number it quotes must equal the stored aggregate cell it cites. The renderer runs as `orgfit_report`, which holds no table privilege anywhere and no CONNECT on the anonymous database, so PRIV-02 now covers the report worker with a privilege boundary rather than a code convention. Arabic shaping and RTL, selectable text with zero unmappable glyphs, embedded OFL fonts, repeated table headers, page numbering and replaceable theme tokens were verified against the produced files, and produced pages were rasterized and inspected. Workbook internals were unzipped and asserted free of charts, pivot caches, hidden sheets, defined names and formulas; user-entered strings are formula-neutralized. Named participation exports keep their own path, capability, key and storage prefix and carry no response identifier, score or result. **Checkpoint E is NOT RUN**, and a report now carries the untested cross-round differencing surface into a portable file.

Phase 08 evidence update (2026-09-09): PRIV-02, PRIV-03, PRIV-04 and SCORE-01 gain development publication evidence in [publication.md](publication.md). PRIV-02: `orgfit_staff` holds no privilege on any `publication` table and no CONNECT on the anonymous database; its whole analytics surface is one routine over published cells. PRIV-03: every released cell counts distinct valid contributors for **that metric** and clears `max(campaign, 5)`, with five a hard database CHECK; n=4, n=5 and campaign n=20 with metric n=4 are asserted. PRIV-04: complementary company-only fallback, sparse-bin, homogeneous-endpoint, respondent-count checkbox denominators, withheld free text and dates, refused arbitrary filters, and no live scores. SCORE-01: company values are contributor-weighted respondent-level means. **Checkpoint D is NOT RUN**, and none of this is a proof that no suppressed value is reachable. Recommendations, history, exports and reports remain future obligations.

Checkpoint B evidence update (2026-09-09): **PASS** for BUILD-01/SCORE-01 development instrument/scoring scope after repairing malformed checkbox-SUM validation. [checkpoint-b.md](checkpoint-b.md) records independent SQL golden calculations, persisted all-type trace, version/translation/scoring immutability, lineage, scope, missingness and rerun evidence. Phase 06 has not started; production/privacy/reporting gates remain future obligations.

Phase 05 evidence update (2026-09-09): SCORE-01 computation now has the pure engine, exact bands/coverage, golden/property tests, immutable engine pins and local AR/EN sandbox described in [scoring.md](scoring.md). BUILD-01 gains attainable-bound and weight publication checks. Checkpoint B is NOT RUN. Response processing, real analytics and disclosure control remain future work; original design rows below retain their historical context.

Phase 04 evidence update (2026-09-09): Checkpoint A passed before implementation. BUILD-01/SCORE-01 declarative configuration and I18N-01 now have builder/preview evidence in [instruments.md](instruments.md) and [phase-status.md](phase-status.md): all twelve types, required defaults, no branching, typed settings, immutable publication/copies, scoped/versioned FKs, Arabic/English and local-only synthetic preview. Scoring computation and future response/privacy/publication requirements remain unimplemented. The original design matrix below is historical, not a claim that later gates passed.

Source: [blueprint.md](blueprint.md), especially sections 1.1 and 16. Architecture references below use section numbers in [architecture-analysis.md](architecture-analysis.md). All rows are **DESIGNED / NOT IMPLEMENTED / NOT RUNTIME VERIFIED**. The repository contains planning only; no binding requirement has existing application evidence. Future gates are obligations, not recorded passes.

## Binding requirements — complete ID coverage

| ID | Baseline requirement | Architecture owner / control | Delivery and verification |
|---|---|---|---|
| ORG-01 | Organization scope for all records, queries, jobs, files and reports | §3: authorized context, scoped foreign keys, non-owner RLS roles, cache/download/job reauthorization; includes privacy child records | 01 contracts; 02–03/A two-org negative tests, repeated at every gate |
| AUTH-01 | OrgFit staff only; no public registration | §3: OIDC/MFA, Super Admin/Staff, capabilities plus organization assignment, disabled-session revocation | 02 and A; final security review 14/G |
| PRIV-01 | Separate identity and finalized anonymous boundaries | §§3–5, 7: core restricted ciphertext vs separate anonymous DB, distinct keys/roles/retention; atomic core acceptance | 01 privacy/access design; 07/C grants, mapping search, crash recovery; 14 restore |
| PRIV-02 | No role can browse raw answers, scorecards or mappings | §§3–4, 6: staff/report workers read safe snapshots only; no forbidden metadata or raw endpoints; no draft key recovery | 07/C, 08–09/D, 11/E schema/API/log/export adversarial inspection |
| PRIV-03 | At least five valid contributors per released metric | §6: eligibility before threshold for company, dimensions, questions/bins, departments, history and exports | 08/D n=4, n=5 and campaign n=20/metric n=4; E consistent exports/history |
| PRIV-04 | Complementary, repeated-release, demographic, text and timestamp controls | §§4–7: company-only small-partition fallback, joint release review, no live scores, fixed snapshots, withheld prose/dates, no completion timestamps | C logs; D 10+2/sparse/homogeneous/algebra fixtures; E prior release/history leakage |
| SUR-01 | Random unique manually shared links; one final use | §5: >=256-bit token, keyed digest, fragment exchange, generation revocation; local transaction and unique inbox invitation | 06–07/C 100 competing submits, rotation, lost reply and invalid-payload nonconsumption |
| SUR-02 | One participant, selected set or department targeting | §6: deduplicated frozen roster, one campaign/round; small targets allowed but no individual results | 06/C target and roster tests; D single-person suppression |
| SUR-03 | Required start, optional end; manual closure without end | §5: database-time inclusive start/exclusive end under shared closure lock; no reopening | 06–07/C scheduler outage, exact boundary, close race and expired extension tests |
| SUR-04 | Save/resume before immutable finalization | §5: independent browser secret, revision conflict, private cross-device code, final cleanup | 07/C original-link draft denial, code loss/start-over, concurrent save/finalize; F mobile journey |
| BUILD-01 | Complete builder/templates, required default, all types, no branching | §§3, 6, 8: instruments own immutable localized definitions and synthetic preview; illustrative templates | 04–05/B all types and validation, copy/publish immutability, explicit skip-config rejection |
| SCORE-01 | Versioned deterministic modes, reverse, weights, dimensions and direction | §6: pure decimal engine, min-max, coverage, explicit overall direction; no AI or arbitrary expressions | 05/B blueprint golden fixtures and properties; D company weighting and suppression |
| REC-01 | Deterministic recommendations over eligible aggregates | §§3, 6: rules consume approved evidence only, stable ordering, unknown input withheld, actions separate | 09/D exact boundaries, UNKNOWN/no-match, dedup/exclusivity, AR/EN evidence leakage |
| HIST-01 | Preserve instrument/scoring/population/structure history | §6: frozen snapshots, same-org equivalence classification, no respondent linking; merges/splits not automatic | 10/E incompatible/equivalent, direction, missing gaps, department changes and cross-org denial |
| REPORT-01 | Arabic/English PDF and Excel with identical privacy policy | §§3, 6: safe snapshot-only worker, private scoped download, separate named participation file | 11/E rendered Arabic/English inspection, value equality, workbook internals/injection, access revocation |
| VISIT-01 | Physical visits, consultants, notes/actions/files/follow-up and assessment relation | §3: separate confidential consulting module, same-org links, restricted scan worker | 12/F transitions, active consultant, quarantine/scan failure, file limits and cross-org access |
| I18N-01 | Arabic default RTL; English secondary LTR from foundation | §§2–3, 8: shared localization and replaceable theme variables, complete instrument languages only | 02/A lang/dir; 04 translations; 11/E Arabic output; 13/F numerals/bidi/state preservation |
| UX-01 | Mobile survey and accessible web experience | §§5, 8: truthful save/conflict/acceptance UX, section-based flow; 320px/zoom/keyboard/device plan | 07 and 13/F WCAG 2.2 AA checks and actual mobile-browser evidence, no claim from emulation alone |

## Detailed baseline obligations beyond the ID table

| Blueprint sections / obligation | Planned ownership and concrete acceptance coverage |
|---|---|
| 1–2: prohibited scope and two roles | No subscriptions, billing, client accounts/dashboards, company ranking, custom role builder, respondent login or staff raw-response tools. Access module and final G prohibited-scope inspection. |
| 3: full staff/public route inventory | 01 maps every route family into contracts; 02 auth/home/settings/profile, 03 directory, 04 builder/preview, 06 rounds/campaigns/invitations, 07 public welcome/form/resume/review/complete, 08–11 results/history/reports, 12 visits, 13 all loading/empty/error/permission/locale states. No UI created in 00. |
| 4–5: architecture/API/entity invariants | 01 owns data-model, schema draft, APIs, actual-role access matrix. Versioned safe errors, bounded lists, optimistic revisions, organization-scoped references and no generic finalization idempotency body cache. Anonymous records omit audit timestamps/actors; completion status omits per-person change timing. |
| 6–7: lifecycle and recovery | 01 specifies instrument/round/campaign/invitation/draft/publication/report state guards, cancellation and expiry; 06–07/C validates local acceptance, closed full-batch mixing, cleanup and no reopening. Archive is separate from state and erasure. |
| 8: collection type inventory | Short text, long text, multiple choice, checkboxes, dropdown, yes/no, rating 1–5, rating 1–10, matrix, bounded number, date, section content. 04/B verifies sanitized fixed-order rendering, no respondent uploads, required default and optional toggle, no content-block progress count, English completeness and unscored-only validity. |
| 9: scoring detail | 05/B verifies normalization bounds/reverse, 80% default eligible weighted coverage, 100% SUM/fixed-percentage inputs, explicit dimension orientation, all overall dimensions valid, half-open bands and decimal half-up display without reclassifying rounded values. |
| 10: rules detail | 09/D verifies bounded declarative ALL/ANY trees, stable priority/key order, exclusivity/dedup, missing/suppressed evidence UNKNOWN with no leak, frozen localized evidence and separate consultant actions. Historical rules wait for 10. |
| 11: analytics and compatibility | 08/D verifies completion denominator separates revoked outstanding, zero eligible N/A, distinct contributor denominators, no arbitrary partition/query controls or hidden chart data. 10/E verifies descriptive direction-aware point deltas, reviewed equivalence, gaps and preserved historic group labels. |
| 12: report and qualitative policy | 11/E covers report identification/methodology/eligible cells/recommendations/history/limitations/version appendix, licensed selectable Arabic fonts, long tables, all applicable seven workbook sheets. Named participation export remains separate. Raw text/exact dates withheld by default. |
| 13: consulting | 12/F covers DRAFT/SCHEDULED/IN_PROGRESS/COMPLETED/CANCELLED, reasoned cancellations and audited completed amendments; consultant assignment, action owner/due date, internal follow-up only. Files use actual-type verification, quarantine/scan, generated names, type/size limits and safe download. |
| 14: localization/accessibility | Foundation onwards: canonical locale-independent values, Arabic-Indic input normalization, Gregorian default, organization timezone, logical CSS, bidi isolation, complete English instrument content, state-preserving locale switch; 13/F real device, keyboard/screen-reader, offline/conflict and long Arabic tests. No invented branding. |
| 15: operations/security | 14–15/G verify MFA/revocation, CSRF/CORS/CSP/body limits, shared-NAT-conscious rate limits, logging exclusions, separate key/backup access, retention/tombstones, fresh/upgrade migration, load/restore/rollback evidence. Owner policy and independent review remain production gates. |
| 16–18: evidence and sequencing | Architecture §8 preserves all module acceptance categories and checkpoint order. Each future phase records actual evidence in phase status; development authorization never implies production deployment or external messages/files. |

## Reconciliation result and unresolved work

No existing module satisfies or contradicts the requirements because application implementation has not begun. Documentation-only setup is preserved; every implementation/evidence gap remains explicitly assigned above. There is no requirement waiver. Resolved development defaults and remaining production inputs are in [decisions.md](decisions.md). Phase 01 must turn the boundaries into entity, API, lifecycle and privacy contracts before Phase 02 can be considered.

## Phase 01 design evidence — 2026-09-08

The Phase 01 obligation above is now completed as design only. All binding rows remain NOT IMPLEMENTED / NOT RUNTIME VERIFIED.

| Requirements | Concrete Phase 01 contract |
|---|---|
| ORG-01, AUTH-01, PRIV-01, PRIV-02 | [Data model](data-model.md) relationship/role matrix and [proposed schema](proposed-schema.md): all 46 blueprint entities, scope-qualified keys, non-owner service identities and no final identity edge |
| SUR-01, SUR-02, SUR-03, SUR-04 | [State machines](state-machines.md) and [privacy protocol](privacy-protocol.md): frozen roster/issuance, DF1 resume, IN1 atomic acceptance, lock/time linearization and batch recovery |
| BUILD-01, SCORE-01, HIST-01 | Proposed schema instrument/scoring/compatibility definitions and state machines immutable publish/version/round guards |
| PRIV-03, PRIV-04, REC-01, REPORT-01 | Privacy protocol R1 release algorithm, snapshot/SafeCell and separate export [API contracts](api-contracts.md); full-precision approved evidence only |
| VISIT-01, I18N-01, UX-01 | API typed visit/file/locale/public flow and state-machine transitions; browser/mobile/rendering evidence remains future work |

Design review and checks are in [phase-status.md](phase-status.md). Phase 02 may proceed when requested; all later runtime and independent production gates remain pending.

## Phase 02 foundation evidence — 2026-09-08

This section supersedes earlier NOT IMPLEMENTED notes only for the foundation slices below. It does not mark entire product requirements or later checkpoints complete.

| Requirements | Implemented foundation evidence | Remaining boundary |
|---|---|---|
| AUTH-01, ORG-01 | OIDC/MFA, revocable persisted sessions, capabilities/assignments, restricted DB roles and FORCE RLS; real PostgreSQL tests plus browser denial/login tests | Real provider configuration; directory/import scoped children and Checkpoint A |
| PRIV-01, PRIV-02 | Separate staff/respondent builds; no staff auth/DB dependencies in respondent traces; staff/auth denied CONNECT to isolated empty anonymous test DB; audit contains allowlisted staff metadata only | No draft/intake/anonymous-answer processing exists; privacy protocol and deployment/key/log boundaries remain C/14/G work |
| I18N-01, UX-01 | Arabic default/RTL, complete English staff catalog, persisted direction switching, logical CSS, accessible shared controls, 320px AR/EN browser captures inspected | Respondent flow/translations, real mobile devices, zoom/screen-reader and complete accessibility acceptance |
| Foundation operational obligations | Two forward migrations including populated upgrade, safe bootstrap, lockfile/clean install, type/lint/unit/database/browser/build/boundary checks, generic readiness failure and CI configuration | Remote CI, production database patch/provider, restore/load/retention/security review and all A–G checkpoints |

See [foundation.md](foundation.md) for implemented routes and setup and [Phase 02 handoff](phase-status.md) for exact outcomes, defects/fixes and unrun checks. Phase 03 remains NOT STARTED.

## Phase 03 directory evidence — 2026-09-08–09

Directory implementation supersedes the earlier NOT STARTED note only for Phase 03. ORG-01/AUTH-01 now include scoped departments, participants, imports and error downloads, runtime FORCE RLS, foreign keys, guarded writes, current capability checks and import commit receipts. I18N-01/UX-01 now include Arabic/English directory forms, reviewed import and 320px layouts. PRIV-01/PRIV-02 are preserved: these are private directory records, with no answer/score feature or source copied to respondent builds. Archive preserves record identity; future frozen campaign/history behavior remains later-phase work.

See [directory.md](directory.md) for the bounded synchronous import implementation and [phase-status.md](phase-status.md) for actual tests and remaining gates. Checkpoint A is NOT RUN.
