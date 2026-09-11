# Phase 03 directory

Organizations, departments, private participants and reviewed CSV/XLSX imports extend the Phase 02 foundation. No questionnaires, campaigns, answers, scores, reports or invitations are implemented here. Checkpoint A is a separate request.

## Screens

- `/organizations`: authorized, searchable, status-filtered, cursor-paginated list; Super Admin creation.
- `/organizations/:org/overview`: one explicitly named organization, identifying details and directory shortcuts. No pooled or assessment scores.
- `.../settings`: organization fields/contact/timezone editing; Super Admin archive.
- `.../departments`: list/search/create/edit, optional parent selector and archive. An active child or participant blocks department archive; move/archive dependants explicitly first. The selector supports search and further pages.
- `.../participants`: list/search/status/department filter and create/edit/archive; `.../participants/:id` displays private directory attributes with an invitation-status placeholder, never scores.
- `.../participants/import`: upload, field mapping, validation totals and first 20 valid rows, error download, explicit confirmation and commit receipt. Arabic defaults to RTL; English is LTR. Full navigation between organizations clears client state. Forms appear only after hydration so a native premature form submission cannot lose upload state.

## Database and authorization

Migration `003_directory.sql` adds `core.department`, `core.participant`, `core.directory_import`, scoped foreign keys/indexes, sanitized audit actions and guarded routines. All three tables have FORCE RLS and no runtime direct write grant. Reads require current assignment plus `directory.manage`; organization reads retain the foundation assignment rule. Organization creation/archive require Super Admin; organization editing requires directory management. `004_import_receipts.sql` adds commit receipts scoped to actor/organization/operation and request hash.

Every directory mutation takes the organization lock before checking current status, references or cycles. Updates require quoted numeric `If-Match`; mutations require a UUID `Idempotency-Key`. Archive retains IDs, references and unique private codes. Archived records cannot be edited or reused as new active departments. No historical campaign tables exist yet, and none are modified by directory changes.

API routes mirror the screens under `/api/v1`. Organization, department and participant GET detail/PATCH endpoints plus POST `/:id/archive` are implemented. PATCH is a full validated field replacement. Lists accept `q`, `status=ACTIVE|ARCHIVED|ALL`, `limit=1..100`, `cursor`, and participant-only `departmentId`. Default page size is 50 and default status is ACTIVE. The opaque cursor binds kind, organization and filters and is rejected when transplanted. Order is UUID ascending. Success wraps `data`; directory mutations return the DTO and ETag. All responses are private/no-store.

## Import contract and bounded synchronous implementation

Phase 01 proposed split upload and asynchronous validation. This implementation instead accepts a bounded source in one authenticated JSON upload and validates synchronously (D-038). No queue, worker, 202 response or background completion is represented as implemented. The queue default remains for future work that requires it. The operational limits are explicit: 1 MiB source, 500 data rows, 30 columns, one XLSX sheet, and at most 8 MiB expanded ZIP content/100 entries. Larger inputs are rejected, never silently truncated; directory size itself is not limited to 500 participants.

1. `POST O/imports` with `{format:"CSV"|"XLSX",base64}` and Idempotency-Key parses structure, stores an encrypted source and returns ID/revision/header names. It creates no participants. Source format and content are checked; CSV is strict UTF-8 with quoted fields/BOM support. XLSX formulas, hyperlinks/object values, macros, embeddings, external-link entries, multiple sheets and oversized archives are rejected. Original filenames are not used in storage paths. Structural checks are not an antivirus certification.
2. `GET O/imports/:id` returns metadata, headers and at most 20 source rows, only after current organization/capability and expiry checks. Sources are not exposed by a public object URL.
3. `POST .../:id/validate` with `{mapping:{sourceHeader:targetField}}`, If-Match and Idempotency-Key returns a persisted review. Required targets are privateReference and displayName; optional targets include departmentCode, position, jobLevel, gender, ageGroup, yearsOfService, email and phone. Duplicate targets and unknown headers/fields fail. Department code resolution is within this organization only. All occurrences of a duplicate normalized private reference are rejected, including references already archived in this organization. Nothing is silently merged.
4. `GET .../:id/errors` is a freshly authorized, audited attachment stream with only numeric source row numbers and fixed error codes. It contains no source field values or formulas. Row 1 is the header.
5. `POST .../:id/commit` with `{sourceDigest,validationRevision,confirmValidRows:true}`, the reviewed If-Match and Idempotency-Key locks the organization and recomputes the exact review from the encrypted immutable source. A changed reference/department produces IMPORT_CHANGED with no participant writes; validate again. Exactly the reviewed valid subset is inserted together with COMMITTED state/receipt in one transaction. Duplicate/concurrent commit requests return the same committed count; no second insertion. A different request using a consumed key conflicts.

Only the temporary encrypted source contains source data. The import metadata stores mapping, row numbers, fixed error codes and a review integrity digest, not a second plaintext copy of names/contact data. Participant records are the private directory and are not anonymous data.

## Storage and expiration

Set `IMPORT_ENCRYPTION_KEY` to a securely generated random 32-byte key encoded as 64 lowercase hex characters in the staff server environment. The import adapter uses Node AES-256-GCM, a random 12-byte nonce, 16-byte authentication tag and the organization/object key as authenticated context. This is separate from all future survey draft/intake keys. Missing/invalid key configuration fails closed for imports without disabling directory CRUD. Key rotation/recovery and backup erasure still need production evidence.

Development uses private files under `IMPORT_LOCAL_DIRECTORY` (an absolute path recommended; otherwise `work/imports` under the process working directory). Give the staff process and cleanup command the same path. Files are ciphertext and are never web-served. `npm run imports:expire` removes expired local sources, including orphan uploads, without reading content. Upload also runs cleanup for its own organization. Run cleanup regularly when no upload traffic exists; merely denying an expired download is not physical deletion. Local storage is refused under NODE_ENV=production.

The S3 adapter uses `IMPORT_S3_BUCKET`, optional `IMPORT_S3_ENDPOINT`, AWS_REGION and the standard server credential provider. Configure a **private** bucket with least-privilege imports-prefix access and an enforced one-day lifecycle for current and prior versions. Sources must expire even after a failed database transaction. No bucket was provisioned or used in this phase; S3 integration, policy and lifecycle are staging/production gates. There are no signed/public source download URLs.

The database expires access after 24 hours using its recorded deadline (request checks and SQL mutation guards). COMMITTED metadata retains its safe count and history; file and review metadata retention/cleanup beyond the source TTL require the approved P-004 production schedule. The global foundation mutation receipt cleanup policy is unchanged.

## Dependencies and verification

Pinned additions: csv-parse 7.0.2, ExcelJS 4.4.0, JSZip 3.10.1, AWS S3 SDK 3.1128.0. ExcelJS's UUID dependency is overridden to compatible CommonJS-capable 11.1.1 to remove the reported buffer-bounds advisory; XLSX read/write fixtures exercise the combination. npm audit reports zero known vulnerabilities at the recorded test time. This does not imply independent source/security review. References: [CSV parser](https://csv.js.org/parse/), [ExcelJS maintainer documentation](https://github.com/exceljs/exceljs), [JSZip streaming](https://stuk.github.io/jszip/documentation/api_zipobject/node_stream.html), [AWS S3 SDK](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/).

Run `npm run test:directory` against the same dedicated loopback test cluster as foundation tests, sequentially with other DB/browser suites. It uses retained synthetic databases, never reset/drop. Run browser, type/lint, production builds, boundary and production smoke checks as recorded in phase-status. Current source limits are not evidence of the 100,000-participant capacity target; production scale, actual cloud storage, scheduled lifecycle, provider keys and contact policy remain unverified.
