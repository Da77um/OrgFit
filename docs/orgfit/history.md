# OrgFit history and assessment comparison — Phase 10

2026-09-10 · Development implementation. Not a production privacy approval, and Checkpoint E has not run.

This records what Phase 10 actually builds: within-organization series history, an automatic company trend, and reviewed two-round comparisons over immutable published snapshots. It also records what the design refuses to do, and the one new disclosure surface it creates.

## 1. What a history is made of

| Part | Source | Nature |
|---|---|---|
| Series and rounds | `core.assessment_series`, `core.assessment_round` | existing Phase 06 records, read chronologically |
| Trend points | `publication.aggregate_cell` of each round's own snapshot, company group only | already-released aggregates |
| Compatibility | the two pinned `instrument.questionnaire_version` definitions | immutable published configuration |
| Comparison | `publication.comparison_definition` | an immutable staff **review**, not a calculation |

Nothing in the module reads a roster, an invitation, a participant or an answer, and no code path has a respondent identifier on both sides of a comparison. A history is a sequence of releases that each passed disclosure on their own.

## 2. Measurement equivalence, and how it is decided

The centre of this phase is [`src/comparison.ts`](../../src/comparison.ts), which is pure: no database, clock, authorization or network.

Every scored metric gets a **fingerprint** covering everything that determines its number — aggregation mode, coverage rule, direction, denominator, and each scored item with its weight, reverse flag, scoring mode and option score vector. The fingerprint deliberately **excludes** all translated text, so a reworded question keeps it. It equally deliberately excludes the metric's own name and identity, so a **stable key alone is never evidence of equivalence** — a dimension that keeps its key but changes an item does not match.

| Classification | Meaning | How it is established |
|---|---|---|
| `IDENTICAL` | both rounds pinned the same questionnaire version | checked in SQL against the two rounds; a reviewer cannot assert it otherwise |
| `REVIEWED_EQUIVALENT` | different versions, same measurement | a named reviewer supplies a mapping; every mapped pair must pass the fingerprint test |
| `NOT_COMPARABLE` | anything else | may be documented with a rationale; produces no number at all |

A translation-only revision is therefore reviewable as equivalent, and a re-specified item is refused as equivalent with `MEASUREMENT_NOT_EQUIVALENT` — the reviewer may still document the pair as not comparable.

**A stored review cannot manufacture a delta.** Every mapped pair is re-verified from the pinned definitions at read time, so a row claiming equivalence the instruments contradict yields `NOT_COMPARABLE` cells with both released values shown side by side and no change computed.

## 3. What a comparison shows, and what stays a gap

For each paired group and mapped metric: the earlier value, the later value, the absolute **point change**, an optional percentage change, and a **direction-aware improvement** — a fall in a `HIGH_RISK` metric is an improvement, a fall in a `HIGH_GOOD` one is not. Percentage change is undefined from a zero baseline and is `null` there rather than infinite. (In practice the disclosure engine cannot publish a company mean of zero at all: every contributor would have to answer identically, which is a homogeneous disclosure and is withheld.)

A suppressed, insufficient, unscored or absent value on either side is a **GAP** with an explicit reason (`BOTH_WITHHELD`, `EARLIER_WITHHELD`, `LATER_WITHHELD`). Gaps never become zero, never interpolate and never produce a change or an improvement.

Groups pair by **department lineage**, not by label: a renamed department still lines up, and each round keeps the name it froze. A department with no counterpart — a merger, a split, or simply a new one — is not compared, and the release says so through `GROUPS_ADDED` / `GROUPS_REMOVED`. A changed contributor count raises `CONTRIBUTORS_CHANGED`; a changed threshold, band set or questionnaire version each raise their own caveat.

The **automatic trend** is deliberately more conservative than a reviewed comparison: it plots a company metric across rounds only while the fingerprint matches the baseline round, and marks any other round as an explicit break (`MEASUREMENT_CHANGED`) or a gap (`NOT_RELEASED`). No line is drawn through either.

## 4. The staff surface

| Endpoint | Capability | Behaviour |
|---|---|---|
| `GET O/history` | `results.read` | series list; released rounds are counted from the campaign release state, because staff hold no privilege on publication storage |
| `GET O/history/:series` | `results.read` | chronological rounds plus the automatic trend |
| `GET O/comparisons[?seriesId=]` | `results.read` | reviewed comparisons |
| `GET O/comparisons/:id` | `results.read` | the full comparison, recomputed from both snapshots |
| `GET O/comparisons/proposal?left=&right=` | `instruments.manage` | the review aid: which metrics still measure the same thing, with no cell or value in it |
| `POST O/comparisons` | `instruments.manage` | records an immutable review |

Reading a history needs `results.read`. Declaring that two measurements are the same is an **instrument** judgement and additionally needs `instruments.manage`; a results reader is refused both the review and the review aid. `locale` and `seriesId` are the only accepted query parameters; any other slice is `400 UNSUPPORTED_FILTER`, exactly as on the results surface.

Comparisons are immutable (`PUBLICATION_IMMUTABLE` on update or delete, even for the owning role), `orgfit_staff` holds no table privilege on them, and re-submitting the same review returns the same row rather than a second opinion of record.

## 5. Deliberately not built

* **Historical-change recommendation rules stay disabled.** Phase 09 deferred them until comparison compatibility existed; it now does, but Checkpoint D identified cross-round differencing as a **new** disclosure surface that Checkpoint E has not yet attacked. Enabling delta rules would add a derived channel on top of an untested one. When they are enabled they must require available comparable metrics from **both** snapshots and apply the existing disclosure policy unchanged (D-074).
* **Re-scoring historic answers.** A published result is never recomputed, replaced or silently re-versioned.
* **Cross-organization or cross-series comparison**, individual longitudinal profiles, and any participant-level link across rounds. The database refuses the first two; the second two have no code path at all.

## 6. Honest limits

1. **Cross-round differencing is a real surface, and this phase creates it.** Two releases of overlapping populations, subtracted, can narrow what a reader believes about the people who joined or left between them — particularly when a roster changed by a small number. Each release passed disclosure independently, and the subtraction is arithmetic a reader could do by hand from two published pages; the comparison view makes it convenient and declares the population caveats, but it does not defeat that inference. **Checkpoint E must attack it directly**, including rounds that differ by one or two contributors.
2. **Equivalence is structural, not psychometric.** A matching fingerprint means the arithmetic is the same. It is not evidence that a reworded question measures the same construct to a respondent; that judgement is the reviewer's, which is why a rationale and a named reviewer are mandatory and stored.
3. **Population comparability is declared, not verified.** The module cannot know who answered either round — by design — so it reports contributor counts and group changes rather than claiming a stable panel.
4. Differences are descriptive. No significance, causation, diagnosis or benchmark is implied anywhere in the surface or the wording.
5. Everything upstream is unchanged: the Phase 07 processor trust boundary, development key custody, and P-001–P-008 all remain as recorded.

## 7. Evidence

| Check | Where |
|---|---|
| Fingerprints: translation-only equivalence, weight/reverse/option-score/coverage/direction changes refused, stable key insufficient | `tests/comparison.test.ts` (13 checks) |
| Point change, percentage, direction-aware improvement, zero baseline, one- and two-sided gaps, forged review refused, NOT_COMPARABLE documentation, department rename lineage, merger/split blocking, population caveats, trend breaks | same suite |
| Two real released rounds: chronological history, connected trend, unreleased round as a gap, IDENTICAL deltas against published values, translation-only review, re-specified version refused as equivalent then documented, reversed chronology / self-comparison / unreleased / cross-organization refusals, capability separation, immutability and staff table denial | `tests/history.test.ts` (8 checks, real gateway → processor → release) |
| History page: series list, trend table, caveat wording, no participant text | `tests/browser/results.spec.ts` |
