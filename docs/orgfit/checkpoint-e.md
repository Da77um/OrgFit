# Checkpoint E — PASS as an implementation gate, with a disclosure the owner accepted

2026-09-10. Scope: history and report consistency after Phases 10 and 11.

This gate first returned **BLOCKED** on CE-001: an individual contributor's own score is recoverable from published releases. That was not a defect with an obvious fix — every remedy changes what the product may publish — so it was escalated as **P-009** rather than decided by the implementer.

**The owner answered on 2026-09-10: option 3, accept and declare.** Successive releases of an overlapping population keep publishing as they do; the printed caveats are the control. That answer made the wording load-bearing, and the wording as it stood was not adequate — it reassured where it should have warned. It was rewritten and a targeted caveat added (D-086), and that declaration is now asserted end to end.

**PASS as an implementation gate. Phase 12 may proceed as development work.** This is not a privacy approval: the disclosure is real, it is accepted knowingly, and an independent privacy reviewer must still see and sign off CE-001 before any real respondent data is collected (P-008). CE-002 was found by looking at rendered pages and repaired.

## What was inspected

The Checkpoint E prompt, blueprint §§10–12 and 15, the Phase 10 and Phase 11 handoffs, decisions D-058–D-083, migrations `010`–`014`, the comparison engine and its fingerprints, `publication.series_history` / `comparison_context` / `comparison_side`, the report job table and its lifecycle trigger, `publication.check_report_input`, both renderers, both private stores, the download routines and the staff panel. The Checkpoint D residual limitation #3 — "cross-round differencing is untested and not yet possible… Checkpoint E must test it" — is the reason this gate exists in the form it takes.

`tests/checkpoint-e.test.ts` is a new adversarial suite that reuses none of the Phase 10 or Phase 11 assertions. **11 checks, 11 pass** (`npm run test:checkpoint-e`) — the suite passing is not the verdict; CE-001 is a check that *demonstrates* a disclosure and passes because the disclosure occurred.

### The five required cases, built as one real series

One assessment series carries all of them, so the trend has to survive a break in the middle rather than merely end at one. Every round was collected through the real gateway, mixed by the real privacy processor and released by the real publication job.

| Round | Version | Contributors | Role |
|---|---|---|---|
| R1 | V1 | 12 (departments A, B) | comparable baseline |
| R2 | V1 | 13 (A gains one person); B renamed before launch | **comparable series**, +1 contributor |
| R6 | V1 | 14 (B gains one person) | +2 from R1, +1 from R2 |
| R3 | V2 — one scored item re-specified | 13 | **incompatible series** |
| R4 | V3 — translation-only, deliberately long Arabic labels | 12 (B dropped, D added) | **department reorganization** and **long Arabic instrument** |
| R5 | V1 | 4 | **sparse campaign** |

## CE-001 — an added contributor's own score is recoverable from published releases

This is the finding the gate exists for, and it is stated as a measurement rather than as a pass or a fail.

A released cell publishes a mean **and its contributor count**. Two releases of an overlapping population therefore give a reader two equations, and the subtraction `n₂·M₂ − n₁·M₁` returns the sum of whatever the second release added. Where that is one person, it returns that person's own score.

Measured against the real pipeline, with the true individual scores recomputed independently by the scoring engine:

| Subtraction | Recovered | True | Error | Rounding bound |
|---|---|---|---|---|
| Company R1→R2 (+1 person) | 35.40 | 36.11 | 0.71 | ±1.25 |
| Company R2→R6 (+1 person) | 55.20 | 54.17 | 1.03 | ±1.35 |
| Company R1→R6 (+2 people, as a sum) | 90.60 | 90.28 | 0.32 | ±1.30 |
| **Department row of the reviewed comparison (6→7)** | **36.10** | **36.11** | **0.01** | ±0.65 |

The only thing standing between the subtraction and the exact value is the release's own one-decimal rounding, whose worst case is `(n₁+n₂)·0.05`. **Smaller groups give a tighter interval, so a department is the sharper channel, not the safer one.** At department level the recovery was exact to 0.01 of a point on a 0–100 scale.

**Two parts of this have different owners.**

- The company-level subtraction is **inherited, not new**. It needs only two results pages, which have existed since Phase 08, and it is the same property Checkpoint D recorded as residual limitation #2 ("a released mean still discloses its contributor sum"). Suppressing the comparison would not close it.
- The department-level row is **created by Phase 10**. A single row of a single artifact — printed into the PDF and the workbook — carries both values *and* both contributor counts, and additionally **certifies by lineage that the two groups are the same department**. That correspondence is exactly the assumption the attack needs, and before Phase 10 a reader had to supply it themselves.

**What is not true.** The intake boundary is intact: no raw answer, response identifier or draft is exposed anywhere, and the processor trust boundary is unchanged. The recovery is exact only under a **stable-population assumption** — that the other contributors answered the same way in both rounds. With real drift, the same subtraction returns the newcomer's score plus the net drift of everyone else. The synthetic fixture holds the population stable deliberately, because that is the worst case and because a consultant running two rounds a fortnight apart is close to it. The product offers neither a control nor a warning that a given pair of rounds is in that situation.

**Why the gate did not choose a repair.** Every available mitigation changes what the product publishes, and each has a real cost that was the owner's to weigh, not the implementer's:

1. **Refuse to release a round whose contributor set differs from a prior released round of the same series by fewer than the threshold.** This is k-anonymity applied longitudinally and is computable from rosters alone, without touching an answer. It would make an ordinary annual re-survey — two joiners, one leaver — unpublishable.
2. **Withhold the paired comparison row (and the contributor counts) where the two sides' counts differ by fewer than the threshold.** This closes the sharp department channel and the lineage certification, and leaves the blunt company one open. It is the narrowest option and the one most consistent with the existing complementary rule, but on its own it is a partial measure and must not be described as a fix.
3. **Accept and declare.** Keep the current behaviour, and treat the printed caveats as the control. Every report already prints both the differencing caveat and the changed-population caveat, in the reader's own language, and both were asserted present.

**The owner chose option 3 on 2026-09-10** (P-009 in [decisions.md](decisions.md)). No restriction was added to what a round may publish.

### What "declare" then obliged, and what was done — D-086

Choosing the caveats as the control makes their wording the whole of the control, and the wording as it stood did not carry it:

- `CONTRIBUTORS_CHANGED` **reassured**: "the difference is descriptive and does not mean the same people changed their minds." True, and useful against a different misreading, but it said nothing about an individual result being derivable.
- The standing limitation **hedged**: "may narrow what a reader can infer about the people who joined or left", where the measured truth is that one person's own score is derivable to 0.01 of a point.
- Nothing told a reader **when they were in the sharp case**.

All three were addressed. The limitation now states the consequence plainly in both languages, and a new `POPULATION_CHANGE_SMALL` caveat is raised **only** where the two rounds' contributor counts differ by fewer than the publication threshold — a caveat printed on every comparison declares nothing. It appears on the staff comparison screen and in both report formats. E-1 asserts the limitation names the consequence and that the caveat reaches both the report and the screen; E-4 asserts it is **not** raised for two equally sized rounds.

This is a disclosure statement, not a control. It does not make the inference harder.

## CE-002 — chart labels were silently clipped, and one lied — REPAIRED

Found by rasterizing the rendered Arabic pages and looking at them, not by any assertion.

In the Arabic report every bar-chart label was cut to its tail: "النتيجة العامة" rendered as "لعامة", and the long dimension name rendered as "البُعد −". Two independent causes:

1. The `<svg>` inherited `direction: rtl` from the document, so `text-anchor="end"` anchored the **logical** end — the visual left — and a label placed at the right edge grew rightwards off the viewBox. The anchors in the chart are geometric, so the drawing context must be too.
2. The track is an opaque rectangle painted **after** the label, so any label longer than its reserved space was painted over and read as a short one — a label that misidentifies which metric a bar belongs to.

Repaired in `src/report-html.ts` by drawing the chart in an explicit `direction="ltr"` coordinate space (each label is still shaped and ordered right to left by its own bidi run) and by truncating a label to 26 characters with a visible ellipsis. The full label remains in the table beneath the chart, so nothing is lost. Regression: E-8 asserts the geometric drawing context, that no chart label exceeds its budget, that a long label is visibly truncated, and that the full label is still printed in the table.

This is the same class of defect as CD-001: not a disclosure, but a report that states something untrue about a published number.

## What passed

| Check | Result |
|---|---|
| **E-2** a comparison adds no cell, count or partition beyond its two releases | Every value in a comparison row is a value one of the two dashboards published. A withheld side carries no value and no count; a non-comparable row carries no change. |
| **E-3** incompatible data cannot become a trend or a delta | R3 is `NOT_COMPARABLE`/`MEASUREMENT_CHANGED` with no value and no count, and the trend **resumes** at R4 — a break is not the end of a history. R5 is a `GAP`. Declaring R1↔R3 `IDENTICAL` is refused; declaring the re-specified metric `REVIEWED_EQUIVALENT` is refused with `MEASUREMENT_NOT_EQUIVALENT` by the pinned definitions rather than trusted. The incompatible round's own workbook prints the break, not a line. |
| **E-4** department reorganization | The surviving department pairs exactly once, by lineage; `GROUPS_ADDED` and `GROUPS_REMOVED` are both declared. R1 keeps the name department B had in January and R2 keeps the renamed one — the rename did not travel backwards. |
| **E-5** sparse campaign | Four contributors produce no snapshot at all: results are `RESULTS_NOT_READY`, a report request is `STATE_CONFLICT`, and a comparison against it is `STATE_CONFLICT`. Nothing about those four people is stored as an aggregate anywhere. |
| **E-6** four surfaces, one set of facts | Dashboard, history endpoint, report model and workbook agree cell for cell on value, band, direction, contributor count, status and suppression reason, and on the release date and every version string. A withheld metric is empty in the workbook and null in the model, and carries no gap. |
| **E-7** workbook internals | No chart, cached chart series, pivot cache, external link, embedding, comment, VBA project, hidden or very-hidden sheet, defined name or formula in either workbook. No participant name and no invitation reference anywhere in any part. |
| **E-8** long Arabic report | 10 pages, **zero unmappable glyphs**, more than 4 000 Arabic characters present as real text. Pages rasterized and read. No participant name in either PDF. |
| **E-9** historic edits cannot rewrite a published release | After renaming both departments, archiving one and moving a participant to another department: every published group label, every published cell and the release content hash are unchanged, and the frozen report source still renders the identical document. A published round refuses every edit with `STATE_CONFLICT`, so its period cannot be moved to reorder the trend or change the compatibility baseline. `orgfit_staff` holds `SELECT` and nothing else on `core.report_group`, so the lineage a comparison pairs on cannot be repointed after the fact. |
| **E-10** downloads | Another organization's staff is `NOT_FOUND` by either path. An expired artifact is `IMPORT_EXPIRED` and is then retired to `EXPIRED` with its storage key cleared. A capability revoked after generation makes a `READY` artifact `FORBIDDEN`, and restoring it restores the download. A release revoked after rendering makes both of its artifacts `RESULTS_UNAVAILABLE`, and the revoked round becomes a `GAP` in the trend rather than a value. |

## Artifacts actually inspected

Four PDFs and two workbooks were produced by the real renderer under the real `orgfit_report` credential and then opened:

- `work/checkpoint-e-long-arabic.pdf` — 10 pages, rasterized pages 1–3 and inspected; the chart region re-cropped at 3× before and after the CE-002 repair.
- `work/checkpoint-e-comparable.pdf` — 8 pages, rasterized and inspected.
- `work/checkpoint-e-reorganization.xlsx` — unzipped part by part.
- The incompatible round's English workbook — unzipped part by part.

## Residual limitations — stated, not resolved

1. **CE-001 is accepted, not closed.** An individual's own score remains recoverable from published releases, by the owner's explicit decision (P-009, option 3). The caveats declare it; they do not prevent it. An independent privacy reviewer has not yet seen this finding, and P-008 still requires that before real respondent data is collected.
2. **Population comparability is declared, never verified.** The comparison module cannot know who answered either round, by design, so "the same people" is always the reviewer's assertion.
3. **Equivalence is structural, not psychometric.** A matching fingerprint means the arithmetic matches, not that a reworded item measures the same construct.
4. **There is still no correction workflow for a published release.** A revoked release stops its artifacts, but nothing can issue a corrected one.
5. **The upstream trust boundary is unchanged.** The privacy processor still decrypts every accepted answer and key custody is a development stand-in.
6. **Rendering fidelity was verified on one Chromium build.** A different engine version can paginate differently; the assertions are on content and structure.
7. **P-001 through P-008 remain unapproved.** P-009 is answered.

## Verdict

**PASS as an implementation gate. Phase 12 may proceed as development work.**

Every consistency property this gate was asked to test holds: no incorrect historic delta, no incompatible round presented as a valid trend, no historic edit able to rewrite a published result, no withheld value inside any artifact, no unreadable Arabic report, and no artifact outliving its authorization. CE-002 was found by looking at the rendered pages and repaired.

CE-001 is real and remains: an individual contributor's own score is recoverable from published releases — to within a point at company level, and to 0.01 of a point from a single department row of a reviewed comparison. It does not block, because the owner examined it and **accepted it knowingly** under P-009 option 3, and because the declaration that decision made load-bearing has been rewritten to state the consequence and is asserted end to end.

**What this verdict is not.** It is not a privacy approval and not an anonymity claim. A per-person score is derivable from this product's published output, by design and with the owner's knowledge. Before any real respondent data is collected, an independent privacy reviewer must see CE-001 and sign off on it (P-008); an owner's acceptance is not a privacy review. If that reviewer disagrees, option 1 or 2 of P-009 remains available, and CE-001's measurement is already written as the regression that would prove either control works.
