# OrgFit report artifacts — Phase 11

2026-09-10 · Development implementation. Not a production privacy approval, and Checkpoint E has not run.

This records what Phase 11 actually builds: asynchronous PDF and Excel reports rendered from immutable, privacy-approved releases, a renderer identity that cannot reach a person or an answer, private expiring downloads, and a named participation export that is deliberately kept apart from all of it.

## 1. Where a report comes from

A report is a **rendering**, never a calculation. It adds no number and reaches nothing the results screen could not already show.

| Part of the document | Source | Nature |
|---|---|---|
| Organization, series, round, period, campaign | `core.*` rows, read inside `publication.report_source_payload` | existing records |
| Participation totals | `count(*)` over `core.invitation` for that campaign | **totals only** — no name, no participant id, no invitation reference |
| Overall, dimensions, departments, questions | `publication.aggregate_cell` of the round's `PUBLISHED` snapshot | already-released aggregates |
| Recommendations | `publication.recommendation_instance` frozen with the release | deterministic rule output |
| Consultant commentary | `core.recommendation_action` | human opinion, labelled as such |
| History and comparison | `seriesHistory()` / `comparisonView()`, the same functions the history screen uses | projections of published snapshots |
| Versions and hashes | the snapshot's own manifest | frozen release metadata |

## 2. The three properties that make that structural

**The job carries its own frozen source.** `core.request_report` assembles the whole render input once and stores it in `ops.report_job.source`, which a trigger makes immutable. A retry, a second worker or a re-render three days later prints the same document, and a later edit to a consultant note or a department name cannot rewrite an artifact staff already downloaded.

**The database re-checks that source before accepting it.** `publication.check_report_input` walks the entire payload — application-supplied sections included — and refuses it if:

- any cell-shaped object whose status is `SUPPRESSED`, `INSUFFICIENT`, `UNSCORED`, `NOT_COMPARABLE` or `GAP` carries a `value`, `contributorCount`, `coverage`, `distribution` or `band` (`REPORT_WITHHELD_VALUE`); or
- any trend point or comparison side quotes a number that is not the stored aggregate cell of the snapshot it claims to come from (`REPORT_VALUE_MISMATCH`).

This is the same discipline as D-060 and D-068: two implementations that do not trust each other. A defect in `src/reports.ts` cannot put a withheld number into a report, because the database will not store the document that contains one.

**The renderer holds almost nothing.** `orgfit_report` is a login role with **zero table privileges anywhere**, no `CONNECT` on the anonymous answer database, and `EXECUTE` on five job routines only. It addresses a **job**, never an organization, a campaign, a snapshot or a participant. `src/report-db.ts` additionally refuses to start if the process holds a staff, auth, migrator, processor, gateway or custody credential, or the import, link-export or participation-export encryption keys — a renderer that draws aggregates has no business being able to decrypt a file of names.

## 3. The job lifecycle

```
QUEUED ──claim──▶ RUNNING ──complete──▶ READY ──expiry──▶ EXPIRED
   ▲                  │                    │
   └──── fail ────────┘                    └──── revoke ──▶ REVOKED
      (attempt < max)
                      └── fail (attempt = max) ──▶ FAILED ──requeue──▶ QUEUED
```

`ops.report_job` allows only these transitions, and only its lifecycle columns may ever change. Two consequences worth stating:

- **Retries are idempotent** because the source is immutable and `complete_report_job` returns `REUSED` for a job that is already `READY` — a duplicated delivery keeps the bytes staff may already hold, and the worker deletes the losing copy.
- **A `READY` artifact is frozen.** There is no `READY → READY` transition, so nothing can silently replace the bytes behind a link.

A `RUNNING` job whose lease has elapsed returns to the queue on the next claim. That is the whole crash-recovery story.

## 4. The PDF

`src/report-pdf.ts` renders through a paged browser engine (Chromium via Playwright). The choice is about Arabic, and it was measured rather than assumed — see D-078. A report must shape and join Arabic, order it correctly beside Latin words and Latin digits, wrap long Arabic paragraphs, repeat table headers across pages and still hand the reader selectable text.

| Requirement | How it is met | How it is verified |
|---|---|---|
| Arabic shaping and RTL | the layout engine's own Unicode bidi and OpenType shaping | pages rendered and read back; long Arabic department labels asserted present |
| Selectable, searchable text | embedded subsets whose glyphs all map back to characters | the suite extracts text from the produced PDF and asserts **zero** unmappable glyphs |
| Licensed embedded fonts | Cairo (Arabic) and Noto Sans (Latin), both SIL OFL 1.1, inlined as data URIs | `src/report-fonts.ts`; no network request is made at all |
| Long tables with repeated headers | `<thead>` in a paged context, rows that do not split | multi-page reports rendered and page counts asserted |
| Chart labels | inline SVG bars with real text labels | a withheld metric keeps its label and gets **no bar** |
| Page numbering | the renderer's footer template, which carries its own fonts and tokens | present on every page of the rendered output |
| Replaceable theme | every colour and size is a `--report-*` token in `src/report-theme.ts` | overridable through `REPORT_THEME`, validated against a conservative value grammar |

The render context is sealed: the document is loaded with `setContent` rather than a URL, JavaScript is disabled, the context is offline, and **every** network request is aborted and counted. A render whose attempt count is not zero is failed rather than stored — a report that fetched something is a report that leaked a reference to it.

A withheld metric is never drawn as a zero-length bar. A bar of length zero is a claim about a number.

## 5. The workbook

`src/report-xlsx.ts` writes seven sheets — Summary, Dimensions, Departments, Questions, Recommendations, Round history, Methodology — from the **same document model** the PDF prints, so the two cannot disagree about a value, a status or a suppression reason.

- Released values are written as **numbers**, with percentage formats where they apply.
- A withheld cell is **empty**: not a zero, not a dash, not a note, not a comment. Its `status` and `reason` are separate columns, which is where a reader learns why.
- The workbook contains **no chart, no cached chart series, no pivot cache, no external link, no defined name, no hidden or very-hidden sheet and no formula**. None of those parts is ever created, so there is nowhere for a value to hide. The suite unzips the produced file and asserts each of those absences against the raw parts.
- Strings that a spreadsheet could re-read as a formula are neutralized with a leading apostrophe, the same convention the Phase 06 link export uses.
- The Arabic workbook sets `rightToLeft` on every sheet; the English one does not.
- Excel reserves the sheet name "History" for its own change-tracking sheet, so the English trend sheet is named "Round history".
- Consultant commentary occupies its own labelled columns with its own disclaimer row, and is never merged into the computed finding text.

## 6. Named participation lists

These are staff identity material and are kept structurally apart:

| | Assessment report | Named participation list |
|---|---|---|
| Path | `POST /organizations/:org/reports` | `POST /organizations/:org/participation-exports` |
| Capability | `results.read` **and** `reports.manage` | `participation.export` |
| Record | `ops.report_job` | `ops.private_export` kind `PARTICIPATION` |
| Storage prefix | `reports/` | `participation-exports/` |
| Encryption key | `REPORT_ENCRYPTION_KEY` | `PARTICIPATION_EXPORT_ENCRYPTION_KEY` |
| Module | `src/report-storage.ts` | `src/participation-storage.ts` |
| Contents | aggregates, no name anywhere | names and completion status, no response identifier, score or result |

`participation.export` does not grant a report, and `reports.manage` does not grant a name. The renderer imports neither the participation module nor its key, so the process that draws a report cannot produce or read a file of names, and the two kinds of file can never end up in the same object.

## 7. Downloads

Every download is re-authorized **at download time** against the caller's current organization access and capability — never against what the requester held when the job was created. `core.report_download` additionally refuses an expired artifact (`IMPORT_EXPIRED`) and one whose release has since been revoked (`RESULTS_UNAVAILABLE`), and audits every success. Artifacts are encrypted at rest under their own key, expire after 24 hours, and are served with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

**Nothing is ever sent anywhere.** The only outputs of the renderer are an encrypted private object and a row. There is no mail, no share link, no external integration and no automatic delivery.

## 8. The staff surface

The results page gains a **Reports** tab beside Overview, Departments, Question analysis and Recommendations. It offers the format, the report language and any reviewed comparison of the round on screen, and lists what has been drawn with its state, size, page count, requester and expiry. The panel renders nothing and shows no metric: a job row carries a state and a size, never a value. The download is a plain link to the private endpoint, so the panel's own visibility is not the permission — the endpoint re-authorizes the caller at the moment it is clicked.

`tests/browser/reports.spec.ts` drives that journey in the real application: request a report in Arabic, render it under the real `orgfit_report` credential in a separate process, reload, download, and assert the bytes are a PDF served with `no-store` and an attachment disposition. It repeats the panel in English and checks that a 320px viewport does not scroll the page sideways.

## 9. Operating it

```bash
npm run reports:generate   # claim and render due jobs (orgfit_report credential)
npm run reports:expire     # retire expired artifacts and delete their bytes
npm run test:reports       # the Phase 11 suite
```

The renderer needs a Chromium build: `npx playwright install chromium`. Apply `db/roles.sql` before migration 014 — it refuses to run without the `orgfit_report` role — and grant that role `CONNECT` on the core database only.

## 10. Honest limits

- **The report inherits every limit of the release it renders.** k-thresholding with complementary and homogeneity suppression is not differential privacy and is not proof against a reader with outside knowledge of a specific person. Every report states this in its own limitations section, in both languages.
- **Cross-round differencing is still untested.** A report may now carry a trend and a two-round comparison into a portable file that leaves the platform. Each release passed disclosure independently and the caveats are printed, but Checkpoint E must attack this directly, including rounds that differ by one or two contributors.
- **The font choice is a development default, not an approval.** Cairo and Noto Sans are OFL 1.1, which permits embedding. P-007 still owns the final family and the confirmation of its license.
- **Report and recommendation wording is synthetic and illustrative.** P-006/P-007 own the approved text.
- **Page counts and rendering fidelity were verified on this machine's Chromium build.** A different engine version can paginate differently; the assertions are on content and structure, not on an exact page count.
