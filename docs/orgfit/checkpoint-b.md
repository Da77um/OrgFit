# Checkpoint B — PASS

2026-09-09. Scope: instrument versioning and scoring correctness after Phase 05. **PASS after repairing B-001 and rerunning the relevant checks.** Development gate only; Phase 06 is cleared to proceed when requested and has not started.

## Review and independent recalculation

Inspected the blueprint §§8–9, checkpoint prompt, Phase 04/05 handoffs, accepted decisions, strict instrument/answer schemas, editor/preview paths, relational flatten/inflate mapping, guarded instrument service, migrations 005–007, scoring/bounds/rational arithmetic, lockfile and existing tests. Earlier uncommitted work and the separate historical Phase 06 blocked-request record were preserved.

`tests/checkpoint-b.test.ts` calculates the blueprint examples with PostgreSQL `numeric` expressions independently of the TypeScript scoring arithmetic, then compares them to engine output. It does not use the scoring library to calculate its reference values.

| Blueprint case | Independent reference | Engine comparison |
|---|---|---|
| Reverse and equal mean | `(75 + 75 + 100) / 3 = 83.333333…` | Matches within 1e-12; existing exact/display tests also pass |
| Weighted mean | `(2×75 + 75 + 100) / 4 = 81.25` | Matches |
| Missing optional | `4/5 = 0.8`, mean `(75+50+100+75)/4 = 75`; `3/5 = 0.6` | 80% eligible; 60% yields null |
| Bounded sum | Raw `2+3+4 = 9`; `100×(9−0)/(12−0) = 75` | Raw and normalized values match |
| Fixed Yes percentage | `100×8/10 = 80` | Matches |
| Overall | `70×0.6 + 90×0.4 = 78` | Matches |
| Company | `(10×80 + 20×50)/30 = 60` | Matches; not the unweighted department mean 65 |

## Persisted type trace

The new fixture creates and publishes one instrument containing all twelve types, reloads it through an authorized staff transaction and verifies exact document equality and its canonical content hash. Both synthetic boundary answer sets pass runtime validation; all configured metrics score 0 or 100 as expected. Repeated same-input/version output is identical and inputs remain unchanged.

| Type | Persisted definition | Answer and scoring trace |
|---|---|---|
| SHORT_TEXT | question, limits/translations | Text string; required completion tracked; unscored |
| LONG_TEXT | question, limits/translations | Text string; unscored |
| MULTIPLE_CHOICE | question + question_option | Canonical option ID → bounded mapping → normalized item |
| CHECKBOXES | question + options + selection limits | Unique option IDs → attainable OPTION_SUM; selected-percentage and signed subsets covered in scoring suite |
| DROPDOWN | question + question_option | Canonical option ID → bounded mapping |
| YES_NO | question + fixed 0/1 options | Canonical option ID → mapped score; fixed denominator example independently checked |
| RATING_5 | question + scoring configuration | Integer 1–5 → min–max; reverse and 4→75 verified |
| RATING_10 | question + scoring configuration | Integer 1–10 → normalized before mixed-scale aggregation |
| MATRIX | question + matrix_row + matrix_column | Row ID → column ID; explicit row weights multiply question weight |
| NUMBER | question + bounds/precision | Bounded decimal → normalized item; numeral, range and precision failures covered |
| DATE | question + date limits | Valid ISO date string; unscored, malformed dates rejected |
| CONTENT | question with content type | No answer permitted; excluded from score, required and unscored-answer lists |

The weighted all-type fixture has ten configured weight units. Omitting a matrix row of weight two leaves exactly 80% coverage and a valid overall. Also omitting an optional rating leaves 70%, making both the dimension and overall insufficient. Omitting a mandatory unscored short-text answer independently appears in `missingRequired` without changing the score. This remains a synthetic partial-input contract; future finalization must reject incomplete required answers.

## Immutability, lineage and scope

- Attempted mutation of every persisted published node table (`section`, `dimension`, `question`, `question_option`, `matrix_row`, `matrix_column`, `score_definition`, `interpretation_band`) is denied by the immutable triggers. Published root English title changes are denied. Existing suites separately verify engine pin, translation/hash preservation through retirement, guarded publication and runtime DML denial.
- A new version retains every document lineage key and changes every document node ID. Editing the new draft leaves the original document and hash unchanged. Existing tests verify in-place duplication gets new keys, built-in/custom copying and source isolation.
- Existing scoring rules, orientation, coverage and interpretation bands are part of immutable content. Recommendation rules are a future Phase 09 module, not an implemented object this checkpoint can certify; unsolicited rule/expression/skip-logic fields are rejected.
- Authorized A reads succeed; substituting B context and reading an actual B instrument with A-only staff fail. Existing instrument/foundation suites exercise capability revocation, scoped FKs, RLS, nonowner credentials, concurrent saves and receipt replay.
- The browser sandbox has no answer write requests, does not change saved version revisions and clears answers on reload. No staff real-score API or storage is introduced.

## Reproducible defect and repair

**B-001 — malformed checkbox SUM definition could throw TypeError.** With two options and `minSelections=3,maxSelections=2`, attainable-bound calculation returned no endpoints. The shared validator appended that invalid bound pair before checking it, caught the first error, then crashed in the later mixed-SUM-scale comparison. Reproduction returned `TypeError: Cannot read properties of undefined (reading 'compare')` instead of the expected validation result.

Narrow repair: append the bounds only after confirming a valid increasing pair in `src/scoring-bounds.ts`. No accepted configuration, score formula, engine pin, published content or migration changed. Added unit regressions for contradictory selection counts and an empty option set; the browser suite now also checks that the authenticated malformed draft write returns 422 and leaves its saved revision unchanged.

## Executed checks

Windows ARM64, Node 24.13.1, real PostgreSQL 18.4 x64 on the retained loopback synthetic cluster, Playwright Chromium. Each database suite creates fresh synthetic databases; no reset or drop. Test processes use approved execution outside the restricted Windows process sandbox.

| Check | Actual result |
|---|---|
| New checkpoint oracle/persisted trace | 3 reported tests passed, including parent (12.4s) |
| Scoring unit/property/golden | 15 passed (0.5s), including B-001 repair; exact bands, rounding, reverse, weight scaling, optional coverage, direction, malformed definitions and deterministic output |
| Scoring database | 5 passed (12.4s); populated 006→007 upgrade/rerun and hash preservation, SQL validation, immutable engine pin |
| Builder/instrument database | 8 passed (12.7s); all-type persistence, scope, publish/copy/retire, translations, concurrency and capabilities |
| Foundation database | 8 passed (12.0s); fresh/upgraded schema, RLS/session/access/revocation/isolation/bootstrap |
| Foundation unit | 5 passed (0.4s) |
| Typecheck / lint | Both passed after the repair and test edits |
| Full browser regression | 20 passed (1.5m); all-type bilingual preview, no answer writes/reload clearing, immutability/scoped access journeys and repaired malformed-SUM HTTP 422 with unchanged revision |
| Production builds | Both independent Next builds passed after the repair |
| Compiled dependency boundary | Passed; respondent build excludes staff auth/database dependencies |
| Production smoke | Passed; missing configuration fails safely, Arabic fallback and restrictive CSP verified |
| Repository/document checks | git diff --check passed; checkpoint document fence check passed; known pre-existing Git line-ending warnings only |

New persistent regression command: `npm run test:checkpoint-b`; CI now includes it. The initial successful invocation used its equivalent `tsx --test tests/checkpoint-b.test.ts` command.

Changed files: `src/scoring-bounds.ts`, `tests/scoring.test.ts`, new `tests/checkpoint-b.test.ts`, `tests/browser/scoring.spec.ts`, `package.json`, `.github/workflows/ci.yml`, this document and phase-status/traceability documentation. No dependency, lockfile, migration, architecture, instrument content, remote publication or deployment change.

This gate does not certify scientific validity, production anonymity, real disclosure controls, backups, deployment, load or real mobile devices/screen readers. Production inputs P-001–P-008 remain open. No additional scoring feature or Phase 06 implementation is authorized by this checkpoint run itself.

No unresolved defect from these executed checks remains. The temporary PostgreSQL test process was stopped; synthetic databases/files were retained. Next step: Phase 06, using its prompt and the Phase 04/05/B handoffs. No commit or deployment was created.
