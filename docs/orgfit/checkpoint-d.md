# Checkpoint D — PASS (implementation gate only)

2026-09-09. Scope: results and recommendation disclosure after Phases 08 and 09. **PASS after repairing CD-001 and CD-002 and re-running every affected check.**

This clears Phase 10 to proceed **as development work**. It does **not** clear real respondent data, deployment, or any public anonymity claim, and it is not a proof of anonymity against an adversary with outside knowledge. Those remain gated on the production prerequisites in the last section and on the residual limits stated honestly below.

## What was inspected

The Checkpoint D prompt, blueprint §§10, 11.1–11.3 and 15, the Phase 08 and Phase 09 handoffs, decisions D-058–D-071, migrations `010_publication.sql`, `011_recommendations.sql` and the repair `012_result_precision.sql`, the disclosure engine, the recommendation evaluator, the publication job, every result endpoint and view projection, the results and recommendation UI, the action write path, publication storage as actually granted, and the existing Phase 08/09 test evidence. No unrelated module was modified; earlier uncommitted work was preserved.

`tests/checkpoint-d.test.ts` is a new adversarial suite that does not reuse the Phase 08 or Phase 09 assertions. Those asked "does the engine apply its rules". This one starts from the reader's side and tries to **reconstruct a protected value** from what a staff user can actually obtain.

**18 checks, 18 pass, 0 fail** (`npm run test:checkpoint-d`), nine of them pure arithmetic attacks and nine against the real pipeline on PostgreSQL 18.4.

## Reconstruction attempts — all failed

Every dataset was built so that each protected quantity is a distinct, searchable number, then every staff-visible payload was searched for it.

| Attempt | Result |
|---|---|
| **Four contributors** | No release exists at all. The plan is refused (`BELOW_THRESHOLD`) rather than published as withheld shells, so not even a count describing those four people is created. |
| **Campaign of twenty, metric with four** | The dimension and overall cells are `INSUFFICIENT` with every field null, while the question metric that genuinely has twenty contributors is released. The campaign total is never borrowed as a denominator. |
| **Ten plus two** | Company released (`71.7`, 12 contributors); **both** departments withheld as `COMPLEMENTARY` — including the ten-person one, which alone would have been publishable. The reader is left with one equation and three unknowns: neither department mean (`79`, `35`) nor either group size (10, 2) appears anywhere in the plan, any view, the snapshot routine or the recommendations. |
| **Same case through the real pipeline** | Twelve real submissions, real gateway, real processor, real release. The two-person department's true value was recomputed independently with the scoring engine and searched for across all four views plus the raw snapshot routine: absent. So was the complementary ten-person value, so were the group sizes, and so was every respondent's free text. |
| **Sparse option bin** | The whole distribution is withheld, not the rare bar: publishing the other bars beside the denominator would restore it. No `count` field survives anywhere in the plan. |
| **Checkbox overlap** | Fifteen respondents making thirty selections publish a denominator of **fifteen**. Bins count people once each, never selections. |
| **Homogeneous endpoint** | A unanimous result is withheld for scored metrics and for choice distributions; the unanimous value appears in no cell. Band bounds elsewhere are instrument configuration and describe nobody. |
| **Recommendations as a channel** | A department-scoped rule over a withheld department is silent. A *company-scoped* rule whose condition reads the department metric is also silent, because a rule is evaluated inside one group only — even though the company cell for that metric is published. Every number in the surviving recommendation is a published cell value, verified against storage. |
| **Recommendation list as a channel** | Two datasets differing **only** in the withheld department produce the identical number, order, priority and severity of recommendations. The list itself carries no signal about the protected value. |
| **Risk badge** | Severity is the published band of the published target value; no badge outlives an unknown input. |
| **Alternate partitions and slices** | `departmentId`, `groupBy`, `partition`, `participantId`, `since`, `threshold`, `minContributors`, `includeSuppressed` and `format` are each refused with `UNSUPPORTED_FILTER` — not ignored. Undefined views, deeper paths and every write method are not routes. |
| **Successive snapshots** | Re-running the real job returns the existing release (`REUSED`). A *different* plan for the same campaign raises `RELEASE_ALREADY_PUBLISHED`. Exactly one `PUBLISHED` snapshot exists and no second one can be created to difference against. `UNIQUE(organization_id, round_id)` on `core.campaign` keeps one campaign per round. |
| **Candidate and revoked releases** | A hand-inserted `CANDIDATE` snapshot is invisible to staff: the campaign still answers `RESULTS_NOT_READY` with no numbers. |
| **Caches** | Every result and recommendation response carries `Cache-Control: no-store`. |

## Verified against the engines, not against the phase tests

- **Scoring.** Each of the twelve respondents' overall scores was recomputed directly with `scoreInstrument`, and the published company value equals the contributor-weighted mean of those respondent-level values.
- **Contributor weighting.** With eight people at 90 and five at 50, the release publishes `74.6` and not the `70.0` an unweighted mean of department means would give.
- **Frozen publication.** Renaming a department in the live directory after release does not change a single published group label.
- **No live response scores.** `orgfit_staff` is denied on `publication.aggregate_cell`, `publication.recommendation_instance`, `publication.result_snapshot`, `core.recommendation_action`, `publish_release` and `check_recommendations`, and is refused connection to the anonymous database.
- **Organization isolation.** All four views and the action write are `NOT_FOUND` for the other organization, including when the correct instance identifier is supplied.

## Defects found and repaired

**CD-001 — the worst dimension could be presented as a strength.** `rankDimensions` took the top three entries as strengths and started "areas to review" only at the fourth. With two or three released dimensions — an ordinary instrument — the weaknesses list was empty and **every** dimension appeared under "Strengths", including a `HIGH_RISK` dimension scoring 90 with a critical band. Not a disclosure leak, but a direction-aware reporting defect of exactly the kind this gate exists to catch. Repaired in `src/disclosure.ts` by splitting the ranked list at its midpoint, at most three a side: one released dimension is still a strength and nothing else, and the two lists still never overlap. Regression: `D-A9`.

**CD-002 — one published number had two representations.** `publication.snapshot` served cell values through `trim_scale`, so a released mean of exactly `60.0` reached the results view as `"60"` while the frozen recommendation citing that same cell carried `"60.0"`. Two immutable artifacts disagreed about one disclosed value, and the blueprint's "one decimal by default" was lost for whole numbers. Repaired in `db/migrations/012_result_precision.sql` by serving the stored value as released rather than re-formatting it on read: the disclosure engine already formats to the intended precision. Read path only — no stored value, no released cell and no content hash changes. Regression: the checkpoint asserts the evidence string equals the results-view string for the same cell.

Both repairs are the smallest compatible change to the module that owned the defect. No test was weakened to accommodate either.

## Tests re-run after the repairs

| Suite | Result |
|---|---|
| `npm run test:checkpoint-d` | 18 pass |
| `npm run test:disclosure`, `test:recommendations`, `npm test`, `test:scoring` | 49 pass |
| `npm run test:publication`, `test:checkpoint-c` | 34 pass |
| `npm run test:integration`, `test:directory`, `test:campaigns` (organization isolation) | 32 pass |
| `npx playwright test tests/browser/results.spec.ts` | pass |
| `npm run typecheck`, `npm run lint`, `npm run build`, `npm run check:boundaries` | clean |

Not run in this session: `test:instruments`, `test:scoring-db`, `test:checkpoint-b`, `test:respondent`, `test:privacy`, `test:production`, the remaining browser specs and `npm audit`. All of them passed earlier in the Phase 09 session; the two repairs touch the ranking helper and the snapshot read path, which those suites do not assert on.

## Residual limitations — stated, not resolved

1. **Background knowledge is outside the model.** These controls are k-thresholding with complementary, sparse-bin and homogeneity suppression. A reader who already knows what a specific colleague answered, or who knows a department's exact composition, is not defeated by them. This checkpoint tested reconstruction *from the published surface*, not against such an adversary.
2. **A released mean still discloses its contributor sum.** That is inherent to publishing a mean with a count, and it is why the threshold and the complementary rule exist rather than being a defect they failed to prevent.
3. **Cross-round differencing is untested and not yet possible.** v1 exposes no comparison surface, and one campaign per round is enforced, so no two releases of one population can be differenced through the product today. When Phase 10 adds comparison, releases of overlapping rosters *whose membership changed* become a new differencing surface — Checkpoint E must test it, and D-021's compatibility review governs it.
4. **Question analysis is company-level by design** (D-063). This gate did not find department distributions safe; they are simply not offered.
5. **The upstream trust boundary is unchanged.** The privacy processor still decrypts every accepted answer, and key custody is a development stand-in. Checkpoint C recorded this and it remains true.
6. **No production input was approved by this gate.** P-001 through P-008 remain open, including the P-006 approval that every rule text, threshold and band in the repository still requires.

## Verdict

**PASS as an implementation gate.** No suppressed value was reachable through any API, view, chart payload, recommendation, status, cache or repeated release, and no supported partition view reconstructed one. Phase 10 may proceed as development work.
