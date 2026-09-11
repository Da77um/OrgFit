# Phase 05 — Scoring and interpretation

Development implementation only. Checkpoint B remains a separate requested gate. No real response collection, staff scorecards, analytics, publication or recommendation endpoints are introduced.

## Engine contract

`scoreInstrument(definition, answers, {engineVersion, configVersion})` is the pure shared engine. Version `1.0.0` accepts the existing strict `schemaVersion=1` instrument format. Unknown versions, malformed definitions, unsupported keys, unknown answers/options, duplicate selections, invalid dates, numeric precision/range violations and formulas fail with safe issue codes. It has no database, clock, randomness, network, logging or identity input. Scoring does not mutate its arguments.

Answers are a bounded record of question IDs to decimal/text/date strings, option IDs or arrays of unique option IDs. Matrix rows use row IDs and column IDs. Arabic-Indic and Persian digits and the Arabic decimal separator normalize to canonical numeric strings. Content blocks cannot receive answers. Absent/blank/empty-selection answers are missing, including optional checkboxes; zero numeric values and mapped No remain valid answers. Free text and dates are validated but unscored.

The sandbox permits partial synthetic input. `missingRequired` is separate from scoring eligibility: a required unscored text item never changes dimension coverage. Future finalization must reject missing mandatory answers before durable acceptance; this engine is not a finalization validator or release authorization.

Outputs include each configured dimension and optional configured overall: raw value where meaningful, normalized approximation, exact rational numerator/denominator, half-up display string, coverage, VALID/INSUFFICIENT, direction, interpretation band, missing policy, engine version and caller-supplied configuration version. Insufficient raw/normalized/band values are null. Unscored questionnaires have no invented overall. Persisted processing must use the immutable instrument version ID as `configVersion`, plus its content hash and engine pin in the future processing manifest. Draft sandbox labels explicitly identify their mutable revision/unsaved state.

## Fixed semantics in engine 1.0.0

- Reverse each mapped value with `L+U-x` before min–max normalization. Rating 4 on 1–5 is 75.
- AVERAGE uses equal eligible item weights. WEIGHTED_AVERAGE uses question weight times matrix row weight. Each matrix row is a contributor to dimension coverage, never an extra respondent.
- Average coverage defaults to 0.8 in the existing editor. Coverage uses answered count for AVERAGE and answered configured weight for WEIGHTED_AVERAGE. Missing values are omitted only when the configured coverage passes.
- Nonweighted modes require question and row weights of 1, preventing silently ignored configuration. Matrix weights do not automatically divide by row count; authors explicitly set them and inspect the sandbox.
- SUM requires all inputs, coverage 1, mandatory contributors and matching declared bounds across inputs. It sums effective raw values and summed lower/upper bounds. Mixed scales may enter normalized averages, with raw mean withheld, but cannot silently enter a raw sum. Matching bounds alone does not establish scientific comparability; approved constructs remain a production input.
- PERCENTAGE is the existing explicit fixed numerator policy: count mapped Yes among the configured mandatory unreversed yes/no inputs, divided by their positive fixed count. No implicit answered-only denominator or proration. Nonunit weights and missing inputs cannot change that denominator.
- Checkbox OPTION_SUM bounds are the actual minimum/maximum subset sums across permitted nonempty selection counts, including negative mappings. SELECTED_PERCENTAGE is selected count / configured option count, subsequently min–max normalized over attainable permitted nonempty counts. Empty optional selection is missing, never a zero score. Fixed/constant attainable ranges cannot score. Numeric declared bounds must align with allowed decimal precision.
- Overall is an explicit weighted mean of all configured valid dimension scores. Every input must already share the target direction or specify the existing explicit inversion. One missing configured dimension makes overall insufficient.
- Interpretation bands cover 0–100 contiguously, use half-open intervals and include the final endpoint. Classification and coverage use exact rational arithmetic; one-decimal display uses decimal round-half-up. `74.96` remains below 75 even when shown as `75.0`. Optional absent bands mean no interpretation label.

`score-number.ts` uses reduced BigInt fractions to avoid floating-point boundary equality and intermediate rounding. Numeric output is only an approximation for consumers; use the provided exact value/display/band rather than reclassifying or re-rounding binary values. Conversion also handles the large fractions produced by 200 heterogeneous bounded items. No new dependency or cryptographic implementation is involved.

`respondentMean` is an internal arithmetic helper tested with ten scores of 80 and twenty of 50, yielding 60 with 30 contributors. It is not a staff API or release-ready result: future processing must supply one eligible score per anonymous response within an authorized organization/campaign/metric and apply disclosure controls afterwards.

## Persistence and sandbox

Migration `007_scoring_engine.sql` adds a non-null `engine_version` pin defaulted to `1.0.0`, including existing versions, without altering published definitions or hashes. The existing immutable-row trigger protects the new column. Additional database publication checks enforce decimal configuration, attainable checkbox/numeric bounds, coherent weights and common SUM bounds. Existing migrations are untouched. A future engine requires an explicit forward migration and compatibility decision; legacy invalid definitions fail closed and need a new corrected instrument version.

The same definition checks feed builder validation and server publication. The authenticated instrument version read now includes its engine pin. No score API or score storage is created.

Open a questionnaire version → Synthetic preview. Fill answers or use the lowest/highest synthetic input buttons, then Calculate synthetic scores. Results update locally when answers change. Arabic RTL is default; English preserves the answers. Clear and reload remove answers. The screen shows score, coverage, raw value, direction, precise boundary context, unscored items and missing required items. Preview answers are never posted or saved, and version revisions remain unchanged by calculations.

## Verification and next gate

Run `npm run test:scoring`, `npm run test:scoring-db`, `npm run test:instruments`, and foundation regressions against the dedicated synthetic PostgreSQL cluster; then browser/build checks. CI includes both new scoring suites. Exact executed evidence and limitations are in [phase-status.md](phase-status.md).

Next: request Checkpoint B. Independently trace persisted builder types into the engine, recalculate golden examples and review publication/lineage/isolation invariants. Do not start Phase 06 until that gate passes. Real instruments, translations, scoring/bands, privacy review and operational production inputs remain unapproved.
