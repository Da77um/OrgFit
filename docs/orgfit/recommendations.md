# OrgFit deterministic recommendations and actions — Phase 09

2026-09-09 · Development implementation. Not a production privacy approval, and
Checkpoint D has not run.

This records what Phase 09 actually builds: a versioned rule editor bound to the
questionnaire version, a pure deterministic evaluator over approved aggregate
cells, immutable recommendation instances published with their release, and a
separate staff action record. It also records what the design deliberately
refuses to do.

## 1. Three separate things

| Part | Where | Lifecycle |
|---|---|---|
| Rule (configuration) | `instrument.recommendation_rule`, a node of the questionnaire version | edited on a DRAFT only; frozen by publication; a change needs a new version |
| Instance (computed) | `publication.recommendation_instance` | written only by `publication.publish_release`, immutable afterwards |
| Action (staff workflow) | `core.recommendation_action` | editable, revision-checked, audited; never touches the instance |

Because a rule is an instrument node, it inherits the guarantees Phase 04
already established: the `draft_only` trigger refuses any write against a
published version, the rule is part of the version's content hash, and it
travels inside the pinned instrument snapshot the privacy processor carries into
the anonymous database. Publication months later evaluates the rules that were
frozen with the measurement, not whatever a questionnaire looks like today.

`intake.batch_payload` now takes its node list from `instrument.node_tables()`
so a node table can never be silently missing from a processed batch.
`intake.gateway_instrument` deliberately keeps its own explicit list: a
respondent's browser receives the questions to answer, and rule thresholds and
consulting text are staff configuration that has no business being sent there.

## 2. What a rule can express

A rule is: a target metric, a group scope, a bounded condition tree, a priority,
a dedup key, an optional exclusivity group, four localized texts, and an enabled
flag. Nothing else. There is no expression language, no code, no model call and
no free-form field that reaches the evaluator.

* **Metrics** are addressed structurally — `OVERALL`, or `DIMENSION` by
  identifier — and resolved through the pinned instrument. A rule cannot name a
  question distribution, a raw answer or an invented metric key.
* **The tree** is two levels: a top-level `ALL`/`ANY` over at most four clauses,
  each an `ALL`/`ANY` over at most six comparisons, with at most twelve
  comparisons per rule. Operators are `LT`, `LTE`, `GT`, `GTE` and `BETWEEN`;
  `BETWEEN` is half-open (`value <= score < upper`), matching band semantics.
* **Thresholds** are decimals in `[0,100]` compared at full precision with the
  exact-arithmetic `ScoreNumber`, never through display rounding.
* **Text** may substitute `{score}`, `{band}`, `{metric}` and `{group}`, all of
  which resolve to published values or configuration labels. An unrecognized
  placeholder is an editor issue.

Editor validation ([`ruleIssues`](../../src/instrument-input.ts)) reports unknown
metric references, `BETWEEN` ranges that cannot hold, conjunctions no score can
satisfy (`IMPOSSIBLE_CONDITION`), missing translations at publication, unknown
placeholders, and two enabled rules in one exclusivity group sharing a priority
(`EXCLUSIVITY_PRIORITY`, so the winner is never decided by an opaque key).

Historical-change rules are **not implemented**. They are disabled until Phase 10
provides reviewed comparison compatibility.

## 3. Evaluation, and why UNKNOWN is absorbing

[`src/recommendation-engine.ts`](../../src/recommendation-engine.ts) is pure: no
database, clock, randomness, network or authorization. Its input is the approved
release plan — the cells the disclosure engine decided to publish — and never a
response, a per-person score or a withheld cell.

Only an `AVAILABLE` cell carrying a numeric value is an input. `SUPPRESSED`,
`INSUFFICIENT`, `UNSCORED`, `NOT_COMPARABLE` and absent are one thing: UNKNOWN.

If **any** input a rule mentions is UNKNOWN, the rule does not fire — even where
a known branch of an `ANY` tree is already true. This is stricter than Kleene
logic on purpose. With `ANY(a < 40, b < 40)`, a published `a = 50` beside a
suppressed `b` would turn a displayed recommendation into the statement
"`b < 40`". The target metric is treated the same way, so no severity badge,
priority or counter survives an unknown either.

Each rule is evaluated per group: `COMPANY` scope reads the company cells,
`DEPARTMENT` scope reads each department's own cells. A rule never combines a
department with the company total, and never reads a second snapshot.

Ordering is priority (lower first), then the stable rule key, then the group key
— never a score. Within one group, an exclusivity group keeps its highest
priority match and a dedup key keeps its first. The same rules over the same
cells produce the same instances in the same order.

## 4. What the database enforces independently

The evaluator's conclusions are not trusted. `publication.publish_release`
validates the whole release plan and then, at insert time, a trigger checks each
stored row against the release actually written:

* the instance's own `(group, metric)` must be an `AVAILABLE` cell of that
  snapshot — `RECOMMENDATION_ON_WITHHELD_METRIC` otherwise;
* every evidence item must belong to the **same group** —
  `RECOMMENDATION_CROSS_GROUP_EVIDENCE`;
* every evidence value must equal the published cell's value numerically, so a
  rendered number cannot drift from its evidence;
* evidence may not be empty, and `(snapshot, group, dedup key)` is unique.

Instances are also inside the release content hash, so a different rule outcome
is a different release rather than a silent replacement of one staff already
read. `UPDATE` and `DELETE` raise `PUBLICATION_IMMUTABLE` even for the owning
role, and `orgfit_staff` holds no privilege on the table at all.

**Upgrade note:** because recommendations join the content hash, a campaign
released before this migration and re-released afterwards would produce a
different hash and raise `RELEASE_ALREADY_PUBLISHED` instead of `reused`. No
released development data exists that this affects; it is recorded rather than
worked around.

## 5. The staff surface

| Endpoint | Capability | Behaviour |
|---|---|---|
| `GET O/assessments/:round/results/recommendations` | `results.read` | projection of `publication.recommendations(campaign)`; `locale` is still the only accepted query parameter and any other slice is `400 UNSUPPORTED_FILTER` |
| `PATCH O/recommendation-actions/:instanceId` | `results.read` | creates or updates the action row beside one instance |

The action is addressed by the recommendation instance because it is one-to-one
with it and is created on first save. It carries status, owner, due date,
consultant notes and resolution; `DONE` and `DISMISSED` require a resolution,
updates require the current revision, and the write is idempotency-keyed and
audited as `RECOMMENDATION_ACTION_CHANGED` with the field group only — never the
note text.

The UI shows the top five findings with an explicit "show all eligible" control,
renders the computed title, body, action, rationale, evidence table and rule
reference as read-only, and puts the human follow-up in its own clearly labelled
form. Consultant notes are stored in their own column and are never merged into
the frozen computed text.

## 6. Honest limits

* This is not a proof that a recommendation cannot narrow a reader's belief
  about an individual. It proves that every input, every substituted number and
  every stored evidence row is a cell the disclosure engine already released,
  and that an unknown input stops a rule outright. Checkpoint D is the
  adversarial review of that claim.
* Rule thresholds, texts and severities in tests and fixtures are synthetic and
  illustrative. They are not validated consulting content and require P-006
  approval before real use.
* Recommendations inherit every limitation of the Phase 08 disclosure controls:
  k-thresholding with complementary and homogeneity suppression is not
  differential privacy and does not model an adversary with outside knowledge of
  a specific person.
* No production deployment, external delivery or real content approval is
  implied by this phase.

## 7. Evidence

| Check | Where |
|---|---|
| Exact boundaries, no-match, unknown/suppressed inputs, absorbing UNKNOWN, exclusivity, dedup, deterministic order, localization, rule-hash immutability, editor validation, schema bounds | `tests/recommendations.test.ts` (13 tests) |
| Release with instances, dedup/exclusivity end to end, evidence matching stored cells, repeatable release, DB refusal of withheld/cross-group/mismatched evidence, immutability, staff privilege denial, action lifecycle and organization isolation | `tests/publication.test.ts` (13 tests) |
| Rule persistence through the real editor, autosave and reload; recommendations tab wording | `tests/browser/instruments.spec.ts`, `tests/browser/results.spec.ts` |
| Every node table protected after publication, including rules | `tests/checkpoint-b.test.ts` |
