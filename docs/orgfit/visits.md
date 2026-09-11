# Field visits and private attachments — Phase 12

2026-09-10 · Development implementation. Not a production security approval, and not a claim that uploaded files are safe.

Phase 12 adds the consulting half of OrgFit: a record of a physical visit to an organization, the actions it produced, and the files it produced. It adds nothing to the assessment pipeline, reads nothing from it, and is reachable by no capability that reaches it.

## What a visit is, and what it deliberately is not

A visit is **identified** material. It names a consultant, an owner, an organization and a date, and its notes describe people and places. That is the opposite of the anonymity property the rest of the product is built to hold, which is exactly why the two are kept apart structurally rather than by convention:

- `core.field_visit` may reference `core.assessment_round` and nothing else. There is no column anywhere in this phase that can name a response, an invitation, a participant, a draft, an intake envelope or an anonymous row, so no future query can join a visit note to an answer. `tests/visits.test.ts` check **V-12** asserts this against the live catalog — every column name and every foreign key of the three new tables — rather than against this paragraph.
- An attachment hangs off a visit and only off a visit. There is no polymorphic parent, no caller-supplied storage path, and no respondent-reachable route to one.
- Nothing in migration 015 reads publication, intake or instrument data, and nothing in publication, intake or the anonymous database learns that a visit exists.

The blueprint's instruction — "visit notes are confidential but are not anonymous survey data; never merge them into respondent records or use them to identify survey answers" — is therefore enforced by the shape of the schema.

## The lifecycle

`DRAFT → SCHEDULED → IN_PROGRESS → COMPLETED`, with `CANCELLED` reachable from the three open states and from nowhere else. Both terminal states are terminal:

| Rule | Where it lives |
|---|---|
| No state may be skipped, and a transition to the state the record is already in is refused rather than accepted as a no-op. | `core.visit_transition`, plus the `core.field_visit_lifecycle` trigger as the backstop |
| Cancelling requires a reason; a cancelled visit then changes in no way at all, including its content. | routine + `CHECK((state='CANCELLED')=(cancellation_reason IS NOT NULL))` + trigger |
| Editing a **completed** visit is an amendment: it requires an explicit reason, increments `amendment_count`, stamps `last_amended_at`, and is audited as `VISIT_AMENDED` rather than `VISIT_CHANGED`. | `core.save_visit` |
| An amendment never reopens the visit and never rewrites `completed_at`. The trigger refuses any change to a completion instant that already exists. | `core.field_visit_lifecycle` |
| Assigning, scheduling or starting a visit requires an **active** consultant who is authorized on this organization and holds `visits.manage`. | `core.visit_eligible_consultant` |

A consultant disabled *after* assignment keeps the historical assignment — the record is what happened — and the detail view reports `assignedConsultantActive: false`. What cannot happen is the visit moving forward onto that person, or being re-saved with them still on it.

## Follow-up actions

`OPEN → DONE | CANCELLED`, with an owner, a due date and optional notes; cancelling requires a closure reason. `GET O/follow-ups?status=&dueBefore=&ownerStaffId=` is the internal overdue list, and `overdue` is computed from `due_date < current_date` on an `OPEN` row.

There is no address column, no message body, no send state and no outbound anything in `core.visit_follow_up`. A follow-up date does not schedule or contact anyone, and both languages say so on the screen.

## Attachments

`UPLOADING → QUARANTINED → CLEAN | REJECTED | FAILED`, with `FAILED → QUARANTINED` as the whole retry story and `EXPIRED` as the terminal state of bytes that no longer exist. **Only `CLEAN` is downloadable**, and the download routine re-checks that rather than trusting a listing.

### Two calls, in the order that matters

1. `POST O/visits/:id/attachments` with `{filename, declaredType}` mints a row and a **generated** object name. The database refuses any storage key that is not `attachments/<org>/<attachment>.bin`, so no caller can address another module's prefix or another organization's.
2. `PUT O/visits/:id/attachments/:aid/content` streams the bytes. It authorizes and moves the row to `QUARANTINED` **first** and writes the object **second**, inside one transaction: bytes are never written for a row the caller may not touch, and a storage failure rolls the row back to `UPLOADING` — which retention sweeps — rather than leaving a quarantined row pointing at nothing.

`declared_type` and `content_type` are separate columns because the browser's claim is evidence, never authority. `CLEAN` requires the verified column, and the database refuses a clean verdict that arrives without one.

### What the scanner does, and who it is

The verdict belongs to a **separate deployment identity**, `orgfit_scanner`: a login role with no table privilege anywhere, no `CONNECT` on the anonymous database, and `EXECUTE` on three routines — `claim_attachments`, `record_scan`, `expire_attachments`. It addresses a claim, never an organization, a visit or a path it chose. Check **V-11** asserts the empty privilege set and that direct reads of `core.field_visit`, `core.attachment`, `core.participant` and `access.staff_user` all fail under that credential.

`src/attachment-scan.ts` is pure — no database, no clock, no network, no authorization — so the interesting cases are data rather than a deployment. It rejects:

| Code | What it catches |
|---|---|
| `ACTIVE_CONTENT` | MZ/ELF/Mach-O/`#!`/Java class heads; HTML, SVG or `javascript:` markup wearing an image or PDF name; a `../` part inside an OOXML container |
| `MACRO_CONTENT` | `vbaProject.bin`, `vbaData.xml`, a macro-enabled content type, or any executable part inside the container |
| `NESTED_ARCHIVE` | RAR/7z/gzip/xz/CAB heads, and an archive part inside an OOXML container |
| `TYPE_MISMATCH` / `EXTENSION_MISMATCH` | permitted bytes whose declared type or file extension disagrees with them |
| `TYPE_NOT_ALLOWED` | anything outside the allowlist, including a bare zip that is not a Word or Excel document |
| `TOO_LARGE` / `EMPTY` | outside `0 < size ≤ 20 MiB`, refused at the HTTP boundary, at the storage adapter and by a table constraint |
| `MALWARE_SIGNATURE` | the EICAR test marker |
| `CHECKSUM_MISMATCH` | bytes that changed between upload and scan — the digest recorded at upload is recomputed over what actually came back |

Allowlist: PDF, PNG, JPEG, GIF, WEBP, DOCX, XLSX.

**Failure is fail-closed in both directions.** A scanner that cannot read the object records `FAILED`, which the database turns back into `QUARANTINED` until the three-attempt budget is spent; at no point in that sequence is the file downloadable, and the worker then stops claiming a row it can never read. Check **V-9** drives exactly that by deleting the object out from under a quarantined row.

### Serving a file

`GET .../download` re-authorizes against the caller's access **now** — a staff member who lost `visits.manage` or this organization after the scan cannot fetch the file — then serves it as `application/octet-stream` with a `filename*=UTF-8''` disposition, `nosniff`, `DENY`, `no-referrer`, `no-store`, and its own `Content-Security-Policy: sandbox; default-src 'none'; …`. `GET .../preview` serves images and PDFs inline under the same policy and 404s for anything else rather than quietly downloading it.

`DELETE .../attachments/:aid` retires the row to `EXPIRED` and removes the bytes. The row survives as audit: what was uploaded, by whom and when stays answerable after the content is gone.

### Retention

`core.expire_attachments` is the authority. It retires clean attachments past their retention date and rejected, failed or never-completed uploads past the orphan window, and hands back the storage keys it just retired for deletion. `scripts/expire-attachments.ts` runs it under the scanner credential. The local janitor in `attachment-storage.ts` sweeps only objects older than the **maximum** retention, so it can never remove bytes a live `CLEAN` row still points at; a bucket needs its own lifecycle rule on `attachments/`, and unlike `reports/` it is not a one-day rule.

## Authorization

Every routine begins with `core.visit_guard`: an actor, an organization the actor may see, and `visits.manage`. No other capability implies access to visit material — check **V-4** drives a staff member holding `results.read`, `campaigns.manage` and `reports.manage` on this organization and asserts `FORBIDDEN` on every visit surface. A staff member of another organization gets `NOT_FOUND`, never `FORBIDDEN`, so the wall does not confirm that a record exists.

## Surface

| Method and path | Notes |
|---|---|
| `GET O/visits?from=&to=&consultantId=&state=&limit=` | Calendar and list are the same bounded query; any other parameter is `UNSUPPORTED_FILTER` |
| `POST O/visits`, `GET/PATCH O/visits/:id` | `Idempotency-Key` on create, `If-Match` on update; a completed visit's PATCH needs `amendmentReason` |
| `POST O/visits/:id/transition` | `{target, reason?}` with `If-Match` |
| `POST O/visits/:id/follow-ups`, `PATCH .../follow-ups/:fid` | |
| `GET O/follow-ups?status=&dueBefore=&ownerStaffId=` | Internal task list |
| `GET O/visit-consultants` | Who may actually be assigned, so an assignment cannot name someone who could not open the visit |
| `POST O/visits/:id/attachments`, `PUT .../:aid/content` | See above |
| `GET .../:aid/download`, `GET .../:aid/preview`, `DELETE .../:aid` | |

Staff screens live at `/organizations/:org/visits` and `/organizations/:org/visits/:id`, Arabic-default with full RTL.

## What this phase does not claim

1. **The bundled scanner is not an antivirus engine.** It is a magic-byte type verifier, an OOXML part inspector and an EICAR marker check. It will not recognize a novel malicious PDF or a crafted image decoder exploit. Replacing it with a maintained engine is **P-010**.
2. **Attachment limits, permitted types and retention are development defaults.** The type and size allowlist is **P-007**; the 365-day retention window is **P-004**.
3. **Neither the store nor the lifecycle rule was exercised against S3.** Both ran on the local development adapter.
4. **Preview is sandboxed, not proven safe.** A browser that renders a malicious PDF is still a browser rendering a malicious PDF; the sandbox policy limits what such a file could then reach, and does not stop it being opened.
5. Attachment encryption uses a key from the environment. There is no managed key service here either — that remains **P-003**.
