# OrgFit safe publication and analytics — Phase 08

2026-09-09 · Development implementation. Not a production privacy approval.

This records what Phase 08 actually builds: trusted score aggregation, an
immutable result snapshot per closed campaign, one centralized disclosure and
publication service, and a staff analytics surface that can read nothing else.
It also records precisely what the disclosure controls do and do not promise.

## 1. Where each part runs

| Component | Identity | May reach |
|---|---|---|
| [src/disclosure.ts](../../src/disclosure.ts) | none — pure function | its arguments only. No database, clock, randomness, network or authorization. |
| [src/publication.ts](../../src/publication.ts) | `orgfit_processor` | anonymous answers/scores (SELECT), `publication.publish_release`, `publication.mark_release_state`, `publication.due_campaigns`. |
| `publication` schema | `orgfit_access_executor` owns the routines | the publication tables. Nothing else writes them. |
| [src/results.ts](../../src/results.ts) | `orgfit_staff` | `publication.snapshot(campaign)` and nothing else in the schema. |

`orgfit_staff` holds **no table privilege in the `publication` schema** and no
CONNECT on the anonymous database. Its entire analytics surface is one
`SECURITY DEFINER` routine that returns the current `PUBLISHED` release. There
is no candidate view, no recalculation endpoint and no live score.

`orgfit_processor` in turn cannot read a published snapshot back through the
staff routine, and it gained no staff capability by being allowed to publish.

## 2. The release path

```
closed campaign
  → intake frozen, decrypted, mixed and committed by the privacy processor (Phase 07)
  → reconcile: accepted = processed = rows read back, or the release is BLOCKED
  → buildReleasePlan over anonymous per-response scores and answers
  → validateReleasePlan (TypeScript)
  → publication.publish_release → publication.check_plan (SQL, independent)
  → one immutable snapshot, campaign release_state PUBLISHED, round PUBLISHED
```

Two properties fall out of doing it this way:

* **One release per closed campaign.** A partial unique index allows a single
  `PUBLISHED` snapshot per campaign. Re-running the job recomputes the plan,
  the database recomputes the content hash, and an identical plan returns the
  existing snapshot (`reused`). A *different* plan for an already released
  campaign raises `RELEASE_ALREADY_PUBLISHED` rather than overwriting numbers
  staff have already seen. Corrections are a reviewed new revision; the columns
  exist (`prior_snapshot_id`, `correction_reason`) and the workflow does not.
* **Repeatable and idempotent generation.** The content hash is computed inside
  `publish_release` from the plan and the campaign's own closed period, never
  accepted from the caller. Determinism of the plan itself is asserted by
  `tests/disclosure.test.ts`.

A campaign that never reached the threshold has no plan at all — the processor
purged its intake without decrypting it — and `mark_release_state` records
`INSUFFICIENT_DATA` on the campaign and the round. No snapshot exists to
suppress.

## 3. The disclosure rules, as implemented

Threshold: `max(campaign threshold, 5)`. Five is also a hard `CHECK` on
`publication.aggregate_cell`, so a cell below it cannot be stored at all.

| Rule | Behaviour |
|---|---|
| Per-metric contributors | Every cell counts the distinct valid contributors **to that metric**. A campaign of twenty with four valid dimension scores releases nothing for that dimension. |
| Homogeneity | If every contributor holds the identical value, the cell is `SUPPRESSED/HOMOGENEOUS`: the mean would republish each individual answer. This is stricter than the blueprint's endpoint example, deliberately. |
| Company weighting | The company value is the mean of respondent-level values, never an unweighted mean of department means. |
| Department partition | Company plus one fixed flat partition. If any nonempty group cell would be withheld, the **whole** partition for that metric is withheld and only the company result is released. |
| Empty groups | A group with zero contributors to a metric is `UNSCORED/NO_VALID_SCORE`. It is an absence, not a withheld value, and does not block the partition. |
| Distributions | Company level only. Every nonempty bin must clear the threshold, or the entire distribution is withheld — never a single bar, whose complement discloses the same people. A bin holding every contributor is homogeneous and withheld. |
| Checkboxes | Bins count respondents per option; the denominator is people, so shares can sum above one. |
| Numbers | A bounded mean only. No minimum, maximum or histogram: an extreme value *is* one person's answer. |
| Free text and dates | Never released as a value, in any view, in any locale. |
| Statuses | `AVAILABLE`, `SUPPRESSED`, `INSUFFICIENT`, `UNSCORED`, `NOT_COMPARABLE` are distinct. None of them is a numeric zero. `NOT_COMPARABLE` is defined here and produced only from Phase 10. |

**Suppressed means empty in storage.** A non-`AVAILABLE` row carries NULL for
value, contributor count, coverage, distribution and band, enforced by a table
`CHECK`. There is no hidden companion column for an API, a chart payload, a
cache or an export to serialize by accident.

**The plan is validated whole, not card by card.** Both `validateReleasePlan`
and `publication.check_plan` reject a partial partition, a released partition
without its company cell, a below-threshold available cell, a sparse released
bin and a withheld cell carrying a value. Neither implementation trusts the
other.

## 4. Staff analytics

`GET /api/v1/organizations/:org/assessments/:round/results[/departments|/questions]`,
capability `results.read`. Three fixed views, each a projection of already
approved cells:

* **overview** — overall and dimension bars, a radar over released dimensions
  only, bands, strengths and areas to review ranked from released cells with
  direction applied, coverage and status explanations, and an accessible data
  table.
* **departments** — department versus company for scored metrics as a table and
  heatmap, with the score-point gap computed only where both cells are
  released. The shade is redundant with the printed number.
* **questions** — released option shares and bounded numeric summaries, company
  level, with an explanation for everything withheld.

`locale` is the only accepted query parameter. A department filter, participant
exclusion, submission-time slice, demographic intersection or alternate
partition is refused with `400 UNSUPPORTED_FILTER` rather than ignored. Before
release the endpoint answers `409 RESULTS_NOT_READY`; a revoked release answers
`409 RESULTS_UNAVAILABLE`. Neither carries a number.

Live operational participation (Phase 06) stays a separate read model on a
separate endpoint. Nothing on the results surface reads it, and closing a
campaign does not merge the two.

## 5. Evidence

| Claim | Where |
|---|---|
| n=4 releases nothing; n=5 releases a company result | `tests/disclosure.test.ts` |
| campaign n=20 with a metric n=4 withholds that metric | same |
| 10+2 departments force company-only for that metric | same |
| balanced partition released; company mean is contributor-weighted (10×80, 20×50 → 60) | same |
| sparse bins, checkbox respondent counts, homogeneous endpoints | same |
| missing is not zero; free text never serialized | same |
| no withheld cell carries a value anywhere in the serialized plan | same |
| plan generation is deterministic | same |
| whole-plan validation rejects tampered cells and partial partitions | same |
| an open campaign yields no metrics and `RESULTS_NOT_READY` | `tests/publication.test.ts` |
| below-threshold campaign records an outcome and creates no snapshot | same |
| release is idempotent; a second run reuses the snapshot | same |
| staff denied on every publication table and write routine; denied CONNECT to the anonymous database | same |
| published rows immutable; storage-level suppression invariant holds on real rows | same |
| SQL repeats the joint check independently; an open campaign cannot be published | same |
| unsupported filters refused; cross-organization isolation | same |
| full browser journey, Arabic RTL, 320px, suppression wording, accessible tables | `tests/browser/results.spec.ts` |

## 6. Honest limits

1. **This is k-thresholding with complementary and homogeneity controls, not
   differential privacy.** It does not model an adversary who already knows a
   specific person's answer, and a released mean always discloses the
   contributor sum.
2. **Question analysis is company-level.** That is a deliberate narrowing, not a
   proof that department-level distributions would be unsafe.
3. **No correction workflow exists.** The schema supports a superseding
   revision; nothing issues one, and a changed plan for a released campaign is
   refused rather than reconciled.
4. **`REVOKED` is a state the schema and the read path handle; no endpoint
   produces it yet.**
5. **Values are published at one decimal place.** That is a product precision
   choice, not a disclosure-limitation technique.
6. **Everything upstream still rests on the Phase 07 trust boundary.** The
   privacy processor decrypts every accepted answer, and the key custody
   adapter is a development stand-in. P-001 through P-008 remain unapproved and
   this phase does not touch them.
7. **Checkpoint D has not run.** The adversarial reconstruction review is a
   separate gate. Passing the tests above is not a proof that no suppressed
   value is reachable.

## 7. Phase 07 defects repaired here

* The processor wrote the batch *manifest* into
  `anonymous_campaign_manifest.instrument_snapshot` rather than the pinned
  questionnaire. Publication must resolve dimension names, option labels and
  bands long after the intake is purged, so the column now holds
  `{manifest, instrument}` as the blueprint's "instrument snapshot/hash" always
  intended. `manifest_hash` is unaffected.
* `scripts/process-campaigns.ts` selected due campaigns with a direct
  `SELECT` on `core.campaign` and `intake.processing_batch`, which the
  processor credential is not granted and never was. Both operator scripts now
  take their queue from `publication.due_campaigns`, which returns campaign
  identifiers and nothing else.
* `tests/campaigns.test.ts` set a past end date as `clock_timestamp() - 1s` on a
  campaign whose start was two seconds old, which violates
  `ends_at > starts_at` whenever the preceding steps run quickly. It now offsets
  from `starts_at`. The assertion is unchanged.
