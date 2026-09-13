# Checkpoint F — full functional journey

2026-09-13 to 14. Scope: the whole product as one staff journey across two organizations after Phase 13, plus the respondent journey on narrow screens in both languages, with the privacy boundary and organization scoping checked on the way.

**PASS as an implementation gate.** The full staff journey completed in two new organizations, the respondent journey completed in Arabic and English on narrow screens with keyboard, error and network cases, no cross-organization access was possible, and no privacy leak was found. Five defects were found — none a privacy leak, cross-organization access or journey failure — and each was repaired with a targeted change and re-verified.

**This is not production readiness, a privacy approval or device evidence.** CE-001 remains accepted, declared and awaiting the independent review P-008 requires. Every narrow-screen result is Chromium emulation; no real phone, Safari engine or screen reader was used. Phase 14 may proceed as development work.

## What was inspected

The Checkpoint F prompt, the Phase 13 handoff and D-107 … D-112, [respondent.md](respondent.md), [visits.md](visits.md), the staff screens each journey step uses, the history screen's review form, the report and attachment download routes, and the staff access routines (`access.has_capability`, `access.organization_access`). The working tree was clean on `2fcbbc0` when the gate began.

## How it was run

`tests/browser/checkpoint-f.spec.ts` is new and reuses no earlier spec's assertions. It is ten serial stages of **one** journey with shared state, so a failure names the stage that broke. It creates **two new synthetic organizations** (P in Arabic, Q in English) rather than using the seeded ones. Every step that has a screen was driven through that screen; the steps with no screen (a second or third round, the incompatible version) used the same staff API the screens call. Between steps the real privacy processor, publication job, report renderer and attachment scanner ran under their own credentials. Nothing was mocked.

| Stage | What was done | How |
|---|---|---|
| F-1 | Create organizations P and Q; two departments; import 12 participants from a CSV that also carries a reference written twice and an unknown department | Organizations, departments and import screens. Preview "12 valid · 3 errors"; commit refused until the review box is ticked; 12 imported |
| F-2 | Clone the built-in template into P, edit it into a scored bilingual instrument with an overall score, bands and a recommendation rule, preview the scoring, publish | Clone and publish in the builder; content via the builder's save API; the preview computes 100.0 and 0.0 with **zero** write requests; a published version refuses an edit (409) |
| F-3 | Series, round and 12-person campaign; launch; generate all 12 links by hand | Assessments and campaign screens. The start typed as a Riyadh wall-clock time; each link shown once, left-to-right, and gone after reload |
| F-4 | Respondents answer | Respondent 1: Arabic, 320 px touch phone, saves, moves to a second device with the private code and finishes **by keyboard**. Respondent 2: English, 375 px, meets the missing-answer review first, then submits. Nine more through the gateway; one person left outstanding |
| F-5 | Close, process, publish; read results | Close on the campaign screen; processor and release job; results overview (11 contributors), departments, questions and recommendations tabs; 320 px |
| F-6 | A second compatible round; a third round on a re-specified version | History screen: the identical pair is reviewed and saved; the incompatible round is shown as not comparable, the screen marks the metric not equivalent, and the server refuses an equivalence claim (422) |
| F-7 | Arabic and English PDF and XLSX | Reports panel, four requests; renderer; four downloads |
| F-8 | Field visit with a follow-up and an attachment | Visits screen; scanner; download after `CLEAN` only |
| F-9 | Below-threshold campaign in Q, in English | Three people, three submissions; nothing decrypted, release `INSUFFICIENT_DATA`, no results link, no contributor tile |
| F-10 | Organization scoping | The seeded non-admin staff member reassigned to Q only, signed in, then every P resource requested directly and by substituting Q's identifier; access restored afterwards |

The respondent journeys the prompt asks to repeat on narrow screens, in both languages, with keyboard, error and network cases, were re-run unchanged from Phase 13 in the same browser run: `journey.spec.ts` (5), `localization.spec.ts` (3) and `accessibility.spec.ts` (2).

## Privacy boundary — what was checked and held

- The saved draft is ciphertext at rest; the device keeps only handle, key and revision, never an answer.
- A payload the instrument forbids is refused by the server (422) and consumes nothing.
- Free text typed by respondents appears on **no** staff surface: results pages and every results API view, the participation projection, and all cells of both workbooks. No participant name or identifier appears in either workbook, and no invitation token appears in the participation projection.
- Results views accept no participant filter (400).
- After processing, the campaign's intake holds zero envelopes and zero drafts.
- Below the threshold nothing was decrypted and nothing was released.

The new Phase 13 behaviour opened no path around validation or to a draft: the language switch, numerals, history entries and truthful error states all sit in front of the same gateway routines.

## Findings

### CF-001 — repaired: the history screen hid comparison review from the Super Admin

`history-ui.tsx` gated the "review a new comparison" form on `capabilities.includes("instruments.manage")` alone. Every other screen, and the server's `access.has_capability`, grant every capability to a Super Admin — so the form was hidden from the one account the server always allows. A Super Admin could record a comparison only by calling the API by hand. Found when F-6 could not find the form. Repaired by adding the same `role === "SUPER_ADMIN"` clause the other screens use; no server, permission or data change.

### CF-002 — repaired: Arabic in the comparison detail was pulled apart letter by letter

The comparison's classification ("نسخة واحدة مطابقة") and the reviewer's name sat in `.result-facts dd`, the stat readout style: IBM Plex Mono and forced left-to-right. The mono face cannot set Arabic, so the letters rendered disconnected — the same class of error the design pass recorded as D-094, in a place it did not reach. Found by looking at the rendered history page, not by a test. Repaired with a `dd.fact-text` variant (the page's face and direction) on those two values only; the numeric facts keep the readout. The heading's arrow was also wrong: U+2192 is not mirrored by the bidi algorithm, so on an RTL page "الجولة الأولى → الجولة الثانية" pointed back at the earlier round. It now follows the reading direction.

### CF-003 — repaired: a round that closed below the threshold was told results "will be available"

A campaign that closed with three contributors, was processed (nothing decrypted) and ended `INSUFFICIENT_DATA` showed on its results page: "Results will be available after closure and privacy checks." Both had already happened, and results will never be published. The API code (`RESULTS_NOT_READY`) is shared with a round still collecting and is asserted by Checkpoints D and E, so the contract was left alone. The results sentence now states the rule, which is true in every not-ready case ("…publish only after collection closes and privacy checks pass, and never if fewer people than the threshold took part"), and the campaign screen — which already carries the release state — states the final outcome itself.

### CF-004 — repaired: signed numbers and dates reversed beside Arabic

In an RTL context, a value whose characters are all neutral or weak takes its order from the Arabic around it. On screen and in the Arabic PDF a negative change printed as `10.0-` and `5.7-`, a percentage as `%10.2-`, and a date beside Arabic words as `14-09-2026` — a drop reading as a rise. Found by looking at the rendered PDF and the history page. Repaired by isolating those values left-to-right: `<bdi dir="ltr">` in the comparison table, the department heat map and the comparisons list, Unicode isolates in the round selector (an `<option>` cannot hold markup), and one rule `td.num{direction:ltr;unicode-bidi:isolate}` covering all fifteen numeric report columns. The attachment size ("KB 1") was isolated the same way. `test:reports` and `test:checkpoint-e` pass after the report change, and the re-rendered Arabic PDF was inspected: `-10.0`.

### CF-005 — repaired: results tabs dropped keyboard focus while loading

Every results tab was `disabled` while a view loaded. Activating a tab with the keyboard therefore disabled the focused button and threw focus to the page body, and on a 320 px screen the scrolling tab strip had nothing a keyboard could reach — which is what axe reported, intermittently, depending on whether the audit ran during a load. Repaired: tabs stay focusable, carry `aria-disabled` while busy, and ignore activation until the view has loaded.

### Test defects found in the new spec and corrected

None of these was a product defect, and none was fixed by weakening an assertion: a duplicate-reference expectation that did not match the importer's deliberate behaviour (below); two selectors that were too loose; an XLSX render reporting `networkAttempts: null` because no browser is involved; the staff list not carrying access detail, so the original assignment is read from the database and restored; and **a race in F-7**, which checked for "at least one" pending report job, so the renderer occasionally ran before the fourth request was stored and the leftover job was rendered later inside `reports.spec.ts`, failing that unrelated spec. F-7 now waits for every request and expects exactly four `READY` outcomes.

### Observations, not defects

1. **A reference written twice in one import file refuses both rows.** This is deliberate: neither copy can be trusted over the other. The preview says so by counting both as errors.
2. **The import preview shows each row's department as its internal UUID** rather than its name or code. It is legible and correct but unfriendly; it is a presentation improvement for a later phase, not a journey failure.
3. **A campaign screen offers no "view results" link for a below-threshold round**, and its results page states that results are unavailable. That is the intended truthful state.

## Genuinely unavailable checks

- **No real iOS Safari or Android Chrome device**, no WebKit or Firefox engine, and **no screen reader**. Narrow-screen and touch results are Chromium emulation. Checkpoint F is recorded against that limitation rather than as device evidence.
- No real browser zoom; no manual keyboard pass by a person.
- Not run: `test:production`, `npm audit`, remote CI, any S3-backed store, any real antivirus engine (P-010).

## Changed files

New: `tests/browser/checkpoint-f.spec.ts`, `docs/orgfit/checkpoint-f.md`.

Modified (repairs): `apps/staff/app/organizations/history-ui.tsx` (CF-001, CF-002, CF-004), `apps/staff/app/organizations/results-ui.tsx` (CF-004, CF-005), `apps/staff/app/organizations/campaigns-ui.tsx` (CF-003), `apps/staff/app/organizations/visits-ui.tsx` (CF-004), `src/report-html.ts` (CF-004), `src/theme.css` (CF-002, CF-005), `src/results-i18n.ts` and `src/campaign-i18n.ts` (CF-003). Records: `docs/orgfit/phase-status.md`, `docs/orgfit/decisions.md`.

No migration, no schema change, no API route or contract change, no permission change. No existing test was weakened.

## Tests actually run

Local PostgreSQL 18.4 loopback cluster, Node 24.13.1, Chromium (Playwright 1.63.0), Windows 11.

| Check | Result |
|---|---|
| Full gate after CF-001: `typecheck`, `lint`, `build`, `check:boundaries` and all 22 node suites (`test`, `test:localization`, `test:integration`, `test:directory`, `test:instruments`, `test:scoring`, `test:scoring-db`, `test:checkpoint-b`, `test:campaigns`, `test:respondent`, `test:privacy`, `test:checkpoint-c`, `test:disclosure`, `test:publication`, `test:recommendations`, `test:checkpoint-d`, `test:comparison`, `test:history`, `test:reports`, `test:checkpoint-e`, `test:visits`, `test:access`) | clean; all pass (5/4/8/6/8/15/5/3/18/24/17/21/16/13/13/18/13/8/17/11/14/8) |
| Full browser suite after CF-001 | 52 passed |
| After CF-002–CF-004: `test:localization`, `test:reports`, `test:checkpoint-e`, `test:history`, `test:comparison`, `test:publication`, `test:checkpoint-d` | all pass (4/17/11/8/13/13/18) |
| Browser suite runs 2 and 3 | 51/52 — CF-005 found by axe; then 49 run, 2 failed — the F-7 race above |
| **Final: `typecheck`, `lint`, `build`, `check:boundaries` and the full browser suite (52 specs, including the 10 Checkpoint F stages, the 5 journey specs, the 3 localization specs and the 2 axe audits)** | **clean; 52 passed** |

**Artifacts inspected by eye:** the respondent at 320 px in Arabic, the participation list with one outstanding person, the results question view at 320 px, the history page before and after CF-002/CF-004, the field visit with its scanned attachment, the below-threshold results page in English, and pages 1–2 of the rendered Arabic and English PDFs before and after CF-004.

## Exact next action

**Phase 14 — security, retention, backups and resilience**, as development work only, in a fresh session. Carry forward: CE-001 and P-008; P-001 … P-008 and P-010 unapproved; the device and assistive-technology limits above, which remain for Phase 15 and Checkpoint G to close with real devices where available.
