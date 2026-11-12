# Phase 04 — Questionnaire library and builder

Development only. This document records Phase 04; Phase 05 adds [scoring and the local sandbox](scoring.md), with migration 007 and additional validators. Campaigns, invitations and real response collection remain outside the implemented scope. Exact evidence is in phase-status.md. Phase 04 descriptions below are historical where superseded by scoring.md.

## Workflow

Open Questionnaire library from home and choose the global or an authorized organization library. Create blank, or open a built-in version and copy it. Organization content cannot be copied into another organization or into the global library. Two starter templates are explicitly illustrative and not scientifically validated.

Edit Arabic/English text, sections, questions, options, fixed matrix rows/columns, required/optional settings and input limits. Native move/duplicate buttons support keyboard operation. Dimensions, row/item weights, aggregation, coverage, direction, overall orientation and interpretation bands are editable declarations only. Duplicate items get new IDs and keys; version/library copies get new IDs and retain item lineage keys. Custom questionnaires receive a new family key. Keys alone do not prove equivalence.

Autosave runs after 1.4 seconds idle or through Save now. A draft saves while incomplete (D-175): only an unsafe or unrepresentable document stays unsaved with an error, and its checklist entries are marked "Blocks saving". While a draft is edited the full publication checklist is shown live, as what is left before publishing. Save status reflects server acknowledgement, and unload warns on unsaved changes. Stale revisions fail without overwriting. Validate for publication lists issues; Publish and lock freezes the entire version. New draft versions support further edits. Retirement and library archive retain original content/hash. Archive is offered on each custom, active entry of the library list and on the questionnaire's page. It asks first (D-173); the endpoint takes no reason. There is no delete; see [draft-delete-proposal.md](draft-delete-proposal.md).

Preview supports all twelve types, Arabic/English and narrow width. Answers stay in React memory, never post to the server, clear on leaving preview/reload, and produce no score. Content blocks do not count toward progress/mandatory items. Free-text/date collection definitions do not imply permission for raw reporting.

## Actual API

Base B is `/api/v1/questionnaires` or `/api/v1/organizations/:org/questionnaires`. Current staff session, organization access and existing mutation Origin/CSRF checks apply. Writes require instruments.manage; archived organization writes and built-in edits are denied.

| Operation | Contract |
|---|---|
| GET B | q, status=ACTIVE/ARCHIVED/ALL, optional UUID cursor; 50/page |
| POST B | `{title:{ar,en},source?:{organizationId,questionnaireId,versionId}}` → custom first draft |
| GET B/:qid | Library metadata; up to 100 version summaries |
| GET B/:qid/versions/:vid | Full definition/revision/state/hash |
| PATCH same | Entire strict Instrument definition |
| POST .../:vid/validate | `{}` → issues `{path, code, location?}` |
| POST .../:vid/publish | `{}` → immutable PUBLISHED version |
| POST .../:vid/retire | `{}` → RETIRED, unchanged content/hash |
| POST .../:vid/new-version | `{}` → copied new draft |
| POST B/:qid/archive | `{}` → archive library entry |

Mutations require UUID Idempotency-Key; existing-resource writes require quoted numeric If-Match. Different-content key reuse conflicts. Creation returns 201, writes 200; publish validation adds the same issues to errors. `path` is the stable id-based link target; `location` (D-172) adds the kind, positions, the enclosing section title / question prompt / dimension name / rule title, the field and the language, all taken from the version being checked. `NO_QUESTIONS` (publication with nothing to answer) and `QUESTION_COUNT` (more than 200 answer items) are separate codes. No response/invitation/export/score routes exist.

## Persistence and next phase

Migrations 005/006 add all Phase 04 instrument entities, scoped/versioned parent and dimension FKs, FORCE RLS, guarded writes, immutable child/version triggers, sanitized audits and database publication checks. Ordinary staff has SELECT plus guarded EXECUTE, no direct DML; auth cannot access instruments. The NOLOGIN executor uses fixed search paths.

The proposed relational topology is retained. IDs, organization/scope/version, parents, stable keys, ordering and dimension links are relational columns. Node-local translations and declarative settings use strict typed JSONB payloads; root metadata is separate. No duplicate whole-document or answer store exists. instrument-records.ts flattens/inflates losslessly; TypeScript and SQL validators reject unsupported/conditional fields and unsafe markup. Content is escaped plain text.

An organization lock and instrument advisory lock serialize version replacement; revision check, child replacement, receipt and audit commit atomically. Publication shares version locks. Canonical sorted-key JSON SHA-256 fingerprints definitions. This conservative write serialization is not load-tested. Infrastructure migration owners remain trusted.

schemaVersion=1 denotes the declarative format, not an implemented engine. SUM/PERCENTAGE require mandatory inputs/full coverage; percentage means fixed required unreversed yes/no count. Optional interpretation bands cover normalized 0–100 contiguously; only the final upper endpoint is inclusive. Phase 05 must compute attainable bounds, missing-answer behavior and numeric previews and pin actual engine versions using compatible forward migrations, without rewriting published definitions. Recommendations remain Phase 09.

After migrations run `npm run instruments:seed` with operator MIGRATION_DATABASE_URL. The idempotent seed creates only two illustrative templates and never overwrites existing/custom content. Tests seed automatically. Real content/translations/scoring approval remains required. No automatic Phase 05 start.

## Ranking questions (D-185, migration 027)

A thirteenth type, `RANKING` («ترتيب» / "Ranking"): the respondent puts every option in order of preference. The editor reuses the option list (labels only: no score field, no scoring toggle); publication needs at least two options and every option's `score` must be `null`. Ranking is **unscored**: it is ineligible for scoring (`SCORING_ELIGIBILITY`), always listed in `unscored`, never in a dimension, and the engine stays pinned at 1.0.0. Migration 027 replaces `instrument.publish_check()` with 006's definition plus RANKING on three lines (kind list; option-bearing with no option score; scoring-ineligible).

A present answer is an array of option ids that is a permutation of **all** the question's options (no duplicate, unknown or missing id). Required means a full ranking; optional means empty or full; empty is missing, as for checkboxes. The processor stores `{type:"RANKING", optionIds:[…]}` (full order, first = most preferred) in the free-jsonb `anonymous_answer.typed_value`, so the anonymous store needs no migration. Disclosure bins are the options and each response contributes its **first** choice: the released distribution is "share of respondents who ranked this option first", through the existing OPTION_SHARES unit and the unchanged threshold, sparse-bin and homogeneity rules. Reports render it through their generic bin path (`report-html.ts`, `report-xlsx.ts` do not special-case types).

The control (`src/ranking-control.tsx`, shared by the staff preview and the respondent) needs no drag: each item has move up / move down buttons with spoken names in both languages, a visible position number, ArrowUp/ArrowDown on a focused move button, focus that follows the moved item, and a polite live announcement. Targets are 44px; layout uses logical properties only. An untouched list is not an answer: the respondent moves an item or chooses «اعتماد هذا الترتيب» / "Keep this order"; «مسح الترتيب» / "Clear ranking" returns to no answer.
