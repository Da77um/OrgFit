# OrgFit — Master Product Requirements and System Blueprint

Version 1.0 · 8 September 2026 · Implementation baseline

Prepared from the full referenced OrgFit conversation and the current consolidated requirements. This document replaces the incomplete earlier blueprint. It contains no branding or design prompt. Its companion, `OrgFit-Astra-6-Implementation-Prompts.md`, provides the execution sequence.

## 1. Product contract

OrgFit is a private organizational assessment and consulting workspace operated by OrgFit personnel. Staff manage organizations, participant directories, questionnaires, campaigns, aggregate findings, recommendations, longitudinal assessments, reports, and physical field visits. Respondents use manually shared invitation links without accounts.

There are no organization accounts, customer administrators, subscriptions, billing, client dashboards, industry benchmarks, or company-to-company assessment comparisons. An organization is an internal data boundary, not a customer tenant with its own authentication system.

The core outcome is: OrgFit can identify outstanding invitations while its staff cannot retrieve an identifiable person's submitted answers. Only privacy-approved aggregate results become available to staff. A respondent can save an unfinished questionnaire, resume, review, and submit once; submitted answers are immutable.

### 1.1 Binding requirements

| ID | Requirement |
|---|---|
| ORG-01 | All organization-owned records, queries, jobs, files, and reports remain within one organization context. |
| AUTH-01 | Only OrgFit personnel authenticate. There is no public staff registration. |
| PRIV-01 | Identity/completion tracking and finalized anonymous answer storage have separate schemas, credentials, access paths, and retention policies. |
| PRIV-02 | No staff role, including Super Admin, can browse raw answer rows, respondent scorecards, or identity-to-answer mappings. |
| PRIV-03 | Minimum reportable contributor count is five, including company-level results, every dimension, question, department, export, and historical comparison. |
| PRIV-04 | Threshold checks alone are insufficient: complementary disclosure, repeated releases, demographics, text, and timestamps need controls. |
| SUR-01 | Links are random, unique, manually shared, and single-use for final submission. Opening or saving does not consume them. |
| SUR-02 | Targets can be one participant, a selected set, or one department. A one-person campaign is allowed but cannot produce identifiable individual results. |
| SUR-03 | Start date is required; end date is optional. No end date means open until manual closure. |
| SUR-04 | Save/resume works before final submission; final answers cannot be changed. |
| BUILD-01 | Full questionnaire builder, reusable starter templates, required-by-default questions, all listed question types, no conditional logic. |
| SCORE-01 | Versioned deterministic averages, weighted averages, sums, percentages, reverse scoring, dimensions, interpretations, and directionality. |
| REC-01 | Deterministic recommendations from eligible aggregate metrics; no AI dependency. |
| HIST-01 | Historical comparisons preserve original instrument, scoring, population, and organizational structure snapshots. |
| REPORT-01 | Professional Arabic/English PDF reports and Excel exports share the same suppression policy as the application. |
| VISIT-01 | Physical visit scheduling, consultant assignment, notes, findings, actions, attachments, follow-up, and assessment relationship. |
| I18N-01 | Arabic is the default, full RTL; English is secondary, LTR. Localization starts in the foundation. |
| UX-01 | Mobile survey completion is a first-class supported experience, with accessible web support. |

### 1.2 Explicit implementation decisions

These defaults resolve gaps without expanding the product. Record them as architecture decisions before coding.

1. One campaign per assessment round in v1. Multiple departments can be selected through the participant-selection mode. Repeat measurements create new rounds, never add a second submission for the same participant in a round.
2. Staff roles are Super Admin and Staff, with a small capability set and organization assignments. A one-person launch simply uses Super Admin. No complex custom role builder.
3. Completion tracking is live; answer analytics are published once after campaign closure and validation. This prevents a staff member from subtracting successive live scores to infer the latest respondent's answer. Indefinitely open campaigns must be closed to publish results.
4. Department is the only response segmentation attribute in v1. Position, job level, gender, age group, and years of service remain available in the private participant directory. Do not copy their full combination to anonymous rows. Further demographic analytics need a separate disclosure-control design.
5. Reports and exports contain aggregates, never a row per respondent. Identifiable participation exports are separate files with separate permissions.
6. All questionnaire types are supported for collection. Free text and exact dates are not automatically released as raw qualitative findings; safe publication rules appear in section 12.
7. Archive is the normal operational removal action. Erasure is a separate governed operation with retention and backup handling.
8. Starter templates are editable examples, clearly marked as illustrative and not scientifically validated instruments. OrgFit supplies approved content and interpretation thresholds before real use.

### 1.3 Privacy feasibility boundary — a release gate

“Truly anonymous” cannot honestly mean immunity to every possible inference while also retaining named completion lists, small targets, arbitrary free text, saved progress, and a service that receives a unique link. A malicious infrastructure operator could modify the survey page or capture a live request. A respondent can also identify themselves in prose. Five responses do not prove mathematical anonymity.

The concrete baseline here is **no direct identity link in the finalized answer store, no staff access to answer rows or decryptable drafts, no retained per-person submission-to-answer mapping, and controlled aggregate disclosure**. It protects against OrgFit application users, accidental joins, common logging leaks, and ordinary report differencing. It assumes a trusted, separately operated privacy processor and controlled infrastructure access.

This limitation is not permission to quietly weaken the requirement. Before production, the owner must accept this precise threat model and respondent notice. If the requirement includes anonymity against the privacy processor or colluding infrastructure operators, this baseline is insufficient: commission an independent design using an audited anonymous-credential/mix protocol and independent trust domains. Do not let Astra invent cryptography or describe ordinary database separation as a cryptographic guarantee. Implementation can proceed against the stated baseline; production anonymity claims remain gated by review.

## 2. Users, permissions, and organization boundaries

| Operation | Super Admin | Staff | Respondent |
|---|---|---|---|
| Manage staff, capabilities, assignments, system policy | Yes | No | No |
| View assigned organizations | All organizations, one context at a time | Assigned only | No |
| Edit organization, departments, directory | Yes | `directory.manage` | No |
| Create/edit/publish questionnaires and rules | Yes | `instruments.manage` | No |
| Create campaigns, generate/revoke links, close | Yes | `campaigns.manage` | No |
| See named outstanding/completed participants | Yes | `participation.read` | Own invitation status only |
| Export named participation list | Yes | `participation.export` | No |
| Read safe analytics/history/recommendations | Yes | `results.read` | No |
| Produce/download aggregate reports | Yes | `reports.manage` plus results access | No |
| Manage visits and private attachments | Yes | `visits.manage` | No |
| Read audit history | Yes | No by default | No |
| Read drafts or raw finalized answers | No | No | Own draft only; no retrieval after final |
| Lower threshold below five or bypass suppression | No | No | No |

Permissions are server-enforced on every endpoint, background job, and file download. Hiding a button is not authorization. Access to global templates does not grant access to any organization's data. Instrument editing can be global; campaign/report actions always require organization authorization as well.

Resolve organization context from an authorized route/resource and session. Never trust a client `organization_id` without checking it. Every organization-owned table uses a non-null organization ID and scoped foreign keys. Switching organizations clears prior selections, search state, cached results, and queued form context. Cross-organization administrative landing pages show operational counts and shortcuts, never blended assessment scores or company rankings.

## 3. Complete screen inventory

Routes are indicative contracts, not required framework syntax. Every screen needs Arabic/English loading, empty, validation, permission-denied, unavailable, and failure states where applicable.

| Area / route | Screens and key actions |
|---|---|
| `/login`, `/auth/*` | Staff login, MFA challenge, recovery, expired session. No sign-up. |
| `/` | Internal home: organization shortcuts, pending operational tasks, recent visits/report jobs; no pooled company assessment metric. |
| `/organizations` | Search/list/create/archive organizations; open workspace. |
| `/organizations/:org/overview` | Organization details, operational totals, latest published assessment links, next visit; selected organization always explicit. |
| `.../settings` | Edit organization identifiers, contact fields, timezone, notes; archive workflow. |
| `.../departments` | List/create/edit/archive departments, optional parent, move participants with impact preview. |
| `.../participants` | Filter directory, add/edit/archive person, select participants, privacy-controlled import and directory export. |
| `.../participants/import` | Upload CSV/XLSX, map fields, preview validation errors/duplicates, commit valid batch only after review, download error file. |
| `.../participants/:id` | Private attributes and invitation history/status only. Never an answer or score tab. |
| `/questionnaires` | Questionnaire/template library, blank creation, clone built-in or staff template, search, archive. |
| `/questionnaires/:id/versions` | Draft/published versions, change summary, clone immutable version, compare definitions. |
| `.../versions/:version/build` | Sections/questions/options/matrix editor, reorder, duplicate, required toggle, AR/EN content, validation. |
| `.../dimensions` | Dimension names, membership, scoring mode, weights, direction, coverage rules. |
| `.../interpretations` | Continuous ranges, labels, health/risk semantics, boundary preview. |
| `.../recommendations` | Versioned deterministic rule editor, action text, priority, preview matches. |
| `.../preview` | Respondent preview in Arabic/English and narrow/wide widths, synthetic score sandbox, publish checklist. Preview cannot create real invitations or results. |
| `.../assessments` | List rounds grouped by assessment series, create new round, compare eligible rounds. |
| `.../assessments/:id` | Round summary, instrument version, campaign status, publication status, related visits/reports. |
| `.../campaigns/new` | Choose assessment/version, targets, language, timing, privacy notice; validate and review frozen launch configuration. |
| `.../campaigns/:id` | Schedule/open/close/cancel, operational counts, end-date changes before closure, processing status. |
| `.../campaigns/:id/invitations` | Outstanding/completed/revoked lists, generate/copy links, manual link export, rotate unused links, revoke with reason. No answer previews. |
| `.../assessments/:id/results` | Eligible overall metric, dimensions, coverage, strengths/risks, suppression explanations. |
| `.../results/departments` | Department-vs-company bars/heatmap/table, eligible metrics only. |
| `.../results/questions` | Safe question summaries/distributions; suppressed and unscored states distinguished. |
| `.../results/recommendations` | Rule-based suggestions, rationale, priority, staff acknowledgment and action status. |
| `.../history` | Series selector, round trend, compatibility labels, score changes, population caveats. |
| `.../reports` and `.../reports/:id` | Generate language-specific PDF/XLSX, job progress, preview/download, version history, expiration, failed-job retry. |
| `.../visits` | Calendar/list, create/filter by consultant/date/status, overdue follow-ups. |
| `.../visits/:id` | Date, purpose, assigned consultant, notes, findings, recommendations, attachments, follow-up, assessment link, status history. |
| `/staff` and `/staff/:id` | Invite/disable internal staff, capabilities, assigned organizations, revoke sessions. |
| `/settings` | Arabic default, timezone defaults, retention configuration, threshold policy >=5, system status. No secrets displayed. |
| `/audit` | Filter internal administrative events, inspect sanitized changes, export authorized audit records. |
| `/profile` | Own locale, password/identity-provider settings, MFA and sessions. |
| `/s` | Invitation exchange, welcome, privacy notice, not-yet-open/expired/revoked/closed/already-submitted states. |
| `/s/form` | Section-based questionnaire, progress, save indicator, resume explanation, validation, locale switch. |
| `/s/resume` | Resume from same browser or private resume code on another device. No email/account recovery. |
| `/s/review` | Review answers and missing required items, final submit confirmation. |
| `/s/complete` | Durable acceptance confirmation, answers locked, close browser guidance; no respondent score. |

## 4. Suggested technical architecture

Use a modular application with one repository, a staff web application, a public survey application on a separate origin, a privacy gateway/processor, and background workers. Avoid a large microservice estate. The privacy boundary justifies separate deployment identity and credentials even if code is shared.

Suggested starting stack: TypeScript, React with an established server-capable framework, PostgreSQL, a mature migration/typed-query layer, private S3-compatible object storage, a durable job queue, and server-side HTML-to-PDF plus XLSX generation. Framework choice is adaptable. Astra must inspect the actual repository and verify supported dependency versions before choosing; do not replace a working stack merely to match these suggestions.

Use a pure versioned scoring library shared by trusted scoring workers and the synthetic preview sandbox. Centralize validation schemas and localization catalogs, but never ship server secrets, staff-only metadata, or private participant records into the respondent bundle.

Logical modules:

| Module | Ownership |
|---|---|
| Identity/access | Staff authentication, authorization, organization assignments. |
| Organization directory | Organizations, departments, private participants, imports. |
| Instruments | Versioned questionnaires, scoring definitions, interpretation/recommendation rules. |
| Campaign control | Targeting, scheduling, frozen roster, manually generated links. |
| Privacy intake | Link verification, encrypted drafts, validation, atomic durable acceptance and completion. |
| Privacy processing | Closed-campaign mixing, anonymous answer write, score computation, disclosure review. |
| Results | Published safe aggregate snapshots only; no direct raw-answer queries. |
| Consulting | Historical comparison, recommendation actions, visits, reports. |
| Operations | Audits, queues, backups, retention, monitoring. |

### 4.1 Data boundaries

1. **Core/identity store:** private directory, invitations, staff, configuration, encrypted intake inbox. Staff database credentials can access approved directory/status views, never the inbox or drafts.
2. **Anonymous answer store:** separate database recommended, accessible only to privacy/scoring workers. No staff application credentials. Contains coarse campaign/version/group references and immutable answers, never identity or invitation references.
3. **Publication store:** safe aggregate snapshots and report manifests in the core application. Staff analytics queries terminate here.
4. **Object storage:** separate namespaces and policies for private visit files, generated aggregate reports, short-lived link exports, and encrypted drafts if stored as objects.

PostgreSQL row security is defense in depth, not the only barrier. Use non-owner application roles without `BYPASSRLS`, appropriate `FORCE ROW LEVEL SECURITY`, scoped foreign keys, and service authorization. Database superusers can bypass row policies, so infrastructure access is a separate trust boundary. [PostgreSQL row security documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

### 4.2 API contracts and transaction boundaries

Use a versioned API with one consistent error envelope: `code`, localized safe `message`, optional field errors, and an administrative correlation ID only for staff operations. Public errors must not contain identity, internal storage IDs, or trace identifiers propagated into anonymous processing. Typical statuses: 400 malformed input, 401 no valid session, 403 unauthorized staff action, 404 absent/inaccessible staff resource, 409 revision/state conflict, 422 valid structure with invalid answers, 429 temporary rate limit, 503 retryable infrastructure failure. Public invitation states may use a generic status response without disclosing participant details.

| Endpoint family | Contract |
|---|---|
| `GET/POST /api/v1/organizations` | Authorized organization list/create; never return blended assessment data. |
| `/api/v1/organizations/:org/departments` and `/participants` | Scoped CRUD and paginated filtering; updates require expected revision; imports use separate validate/commit operations with idempotency key. |
| `/api/v1/questionnaires/:id/versions/:version` | Draft editor reads/writes; publish is an explicit guarded transition; expected revision prevents lost edits. |
| `POST /api/v1/organizations/:org/campaigns` | Round/version, target definition, start/end/timezone; launch is a separate operation freezing roster and configuration. |
| `POST .../campaigns/:id/launch`, `/close`, `/cancel` | Server state/time checks and audit; close shares the intake campaign lock protocol. |
| `POST .../invitations/:id/rotate`, `/revoke` | Capability checked, unused invitation only, expected generation; never returns an old stored plaintext token. |
| `GET .../campaigns/:id/participation` | Private named statuses with approved pagination; no answers or exact completion timestamps. |
| `POST /public/v1/invitations/exchange` | Bearer token in POST body; returns short-lived session cookie and public campaign/instrument context, no participant profile. |
| `POST/PUT /public/v1/draft` | Session plus opaque draft handle, authenticated ciphertext, cipher version and expected revision; no plaintext/decryption secret. |
| `POST /public/v1/resume` | Valid invitation session and matching draft handle; returns ciphertext only. Private resume secret stays in browser memory/local storage according to the client security design. |
| `POST /public/v1/finalize` | Session, pinned instrument version and typed answers; ignores client scores/org/group; returns generic durable accepted status, never a response ID. |
| `GET /public/v1/status` | Current invitation access/completion state only; cannot retrieve submitted answers. |
| `GET .../assessments/:id/results` | Published release-approved snapshot only; reject unsupported slice/filter parameters rather than silently applying them. |
| `POST .../reports` and `GET .../reports/:id/download` | Approved snapshot/locale/format, deduplicated job; fresh authorization for private download. |
| `/api/v1/organizations/:org/visits` | Scoped visit operations with revision and transition checks; attachment uploads use quarantine and a completion/scan workflow. |

List APIs have bounded page sizes and allowlisted sorting. Generic staff mutation idempotency records must not store respondent finalization payloads. Public finalization uses invitation state/uniqueness rather than a generic request-response cache that would preserve an identity-to-answer bridge. Respondent clients never access databases directly.

## 5. Domain model and database specification

### 5.1 Conventions

Use random UUIDs; avoid time-ordered response IDs. Core mutable records have `id`, `created_at`, `updated_at`, `revision`, and administrative actor IDs where meaningful. Anonymous records explicitly do **not** inherit these audit fields. Use UTC `timestamptz` for operational instants, IANA timezone names for scheduling, `date` for questionnaire date answers, decimal for scores, and typed validated JSON only where noted. Never use floating-point equality for interpretation boundaries.

Invitation completion is also exempt from generic per-person update timestamps and automatic change-event capture. Keep issue/rotation/revocation administration metadata separately; the completion transition must not expose a new `updated_at`, completion event time, per-person webhook, or generic ORM history entry to staff. Infrastructure transaction timing remains within the documented privileged-operator trust boundary.

All organization-owned core records include `organization_id`. Composite `(organization_id,id)` uniqueness supports scoped foreign keys. Enumerations are validated in application and database. Referential deletion defaults to RESTRICT for historic/configuration data; use documented cascades only for unpublished drafts or retention purges.

### 5.2 Core and identity entities

| Entity | Principal fields, relationships, constraints |
|---|---|
| `staff_user` | `id`, auth-provider subject UNIQUE, email, display name, role SUPER_ADMIN/STAFF, status ACTIVE/DISABLED, locale, MFA policy. No respondent accounts. |
| `staff_capability` | `staff_user_id`, capability code; UNIQUE pair. Optional grants beyond role defaults. |
| `organization_access` | `staff_user_id`, `organization_id`; UNIQUE pair. Super Admin authorized globally through policy. |
| `organization` | `id`, code UNIQUE, name_ar, name_en nullable, industry descriptive only, contact fields optional, timezone, notes, status ACTIVE/ARCHIVED. |
| `department` | organization, code, name_ar/en, parent_department_id nullable scoped FK, status; UNIQUE org/code; prohibit cycles. |
| `participant` | organization, private reference UNIQUE per org, display_name, department_id, position, job_level, gender nullable, age_group nullable, years_of_service decimal nullable >=0, optional contact, status. No response relationship. |
| `directory_import` | organization, uploaded_by, file reference, mapping JSON, status, valid/error counts, committed_at; encrypted temporary source with expiration. |
| `assessment_series` | organization, name_ar/en, purpose, questionnaire_family_id, status. Groups repeated measurements of one construct. |
| `assessment_round` | organization, series_id, label, period_start/end, questionnaire_version_id, status, notes, population_definition, compatibility_group. Exactly one campaign in v1. |
| `campaign` | organization, round_id UNIQUE, version_id, state, starts_at, ends_at nullable, timezone, target_mode SINGLE/SELECTED/DEPARTMENT, requested_target JSON private, roster_frozen_at, privacy_policy_version, threshold >=5, closed_at, close_reason, release_state. |
| `report_group` | organization, campaign_id, random id, kind COMPANY/DEPARTMENT/OTHER, department_id nullable, label snapshot. Server-selected approved coarse segmentation; contains no participants. |
| `campaign_roster` | organization, campaign_id, participant_id, invitation_id, department/attribute snapshot private, report_group_id, eligibility ACTIVE/REVOKED; UNIQUE campaign/participant. Roster is private and frozen at launch. |
| `invitation` | organization, campaign_id, participant_id, opaque display reference, token_digest UNIQUE, token_generation, status READY/COMPLETED/REVOKED, issued_at; NO anonymous_response_id, answer checksum, or final-answer timestamp. Completion state update audit must not capture a respondent request ID. |
| `submission_inbox` | Restricted intake schema: random envelope_id, invitation_id UNIQUE, campaign_id, validated encrypted payload, encryption-key reference, batch assignment nullable. Temporary identity-linked **ciphertext**, not claimed anonymous. No staff SELECT access. Removed after verified batch commit and retention-safe key destruction. |
| `draft_blob` | Restricted schema: random handle, private invitation binding, encrypted payload, cipher version, optimistic revision, expires_at. Decryption secret belongs to respondent; server stores no usable draft key. No staff retrieval endpoint. |
| `publication_job` | organization, campaign_id UNIQUE per release revision, batch_id, state, attempt count, aggregate counts, error code; no envelope-to-response mapping. |
| `audit_event` | staff actor, organization optional, action, object_type/id, time, sanitized change summary, administrative request ID. Never survey answers, tokens, draft keys, or a bridge to responses. |

### 5.3 Instrument entities

| Entity | Fields and relationships |
|---|---|
| `questionnaire` | id, family_key, name_ar/en, source BUILTIN/CUSTOM, source_template_id nullable, owner scope GLOBAL or organization, status. Global is OrgFit-owned reusable content. |
| `questionnaire_version` | questionnaire_id, version_number UNIQUE within questionnaire, state DRAFT/PUBLISHED/RETIRED, locales, title/introduction/privacy text translations, schema_hash, scoring_version, recommendation_set_id, published_at; immutable after publication. |
| `section` | version_id, stable_key, position, title_ar/en, content_ar/en sanitized. |
| `question` | version_id, section_id, stable_key, position, type, prompt/help translations, required default true, validation_config JSON, scoring_config JSON, dimension_id nullable; unique stable key per version. |
| `question_option` | question_id, stable_key, position, label_ar/en, numeric_score nullable; scoped to version through question. |
| `matrix_row` | question_id, stable_key, position, label_ar/en, scoring weight optional; each row is a scoring item. |
| `matrix_column` | question_id, stable_key, position, label_ar/en, numeric_score nullable. |
| `dimension` | version_id, stable_key, name_ar/en, description, aggregation mode, min_coverage default 0.8, direction HIGH_GOOD/HIGH_RISK, overall_weight nullable. |
| `score_definition` | version_id, target OVERALL or dimension_id, mode, input domain, normalization method, missing policy, coverage threshold, explicit eligible item keys/weights, direction. Declarative schema, no executable code. |
| `interpretation_band` | score_definition_id, lower inclusive, upper exclusive except final endpoint inclusive, label_ar/en, severity, health/risk semantic code; must cover entire valid score domain without overlap/gaps. |
| `recommendation_set` | versioned immutable rule collection, status, content hash. |
| `recommendation_rule` | set_id, stable_key, target metric key, condition tree of allowlisted comparisons, priority, dedup_key, exclusivity_group nullable, title/body/action translations, rationale template, enabled. |

Question and option stable keys survive compatible copies for comparison, but are not proof of measurement equivalence. Published definitions are never edited in place, including translations and recommendation rules.

### 5.4 Anonymous and publication entities

| Entity | Fields and relationships |
|---|---|
| `anonymous_campaign_manifest` | campaign_id, organization_id, instrument snapshot/hash, allowed report groups, policy/version; copied by trusted worker, no roster. No cross-database foreign key to participants. |
| `anonymous_response` | random response_id, organization_id, campaign_id, questionnaire_version_id, report_group_id, validity VALID; NO participant, invitation, token, draft, envelope, session, IP, user agent, client timestamp, precise submission time, or per-response audit actor. |
| `anonymous_answer` | response_id, question stable key, typed value (text/number/date/option IDs/matrix map), validity; UNIQUE response/question. Values validated against pinned instrument. Access only inside privacy boundary. |
| `response_score` | response_id, definition key, scoring engine version, raw value nullable, normalized value nullable, coverage, status VALID/INSUFFICIENT/UNSCORED. Never exposed to staff. |
| `processed_batch` | batch_id UNIQUE, campaign_id, response_count, manifest hash, engine version. Records batch completion, never an envelope-to-row table. |
| `result_snapshot` | organization, campaign_id, revision, state CANDIDATE/PUBLISHED/REVOKED, instrument/scoring/rules/privacy versions, closed-period metadata, generated_at, content hash. Immutable published content. |
| `aggregate_cell` | snapshot_id, group_key, metric_key, contributor_count nullable if suppressed, value nullable, distribution JSON of eligible cells, status AVAILABLE/SUPPRESSED/INSUFFICIENT/UNSCORED/NOT_COMPARABLE, reason_code, direction, coverage. No hidden raw value for suppressed cells in staff-accessible storage. |
| `recommendation_instance` | snapshot_id, group/metric, rule version/id, priority, frozen explanatory text and evidence from released metrics, dedup_key. |
| `recommendation_action` | organization, instance_id, owner_staff_id nullable, status, due_date, staff_notes, resolution. Kept separate from immutable computed recommendation. |
| `comparison_definition` | organization, series_id, left/right round IDs, dimension mapping, classification IDENTICAL/REVIEWED_EQUIVALENT/NOT_COMPARABLE, rationale, reviewed_by. |
| `report_artifact` | organization, snapshot_id, comparison IDs optional, locale, format PDF/XLSX, status, storage_key, checksum, generated_by, expires_at, content/version manifest. |

### 5.5 Consulting and operations entities

| Entity | Fields and relationships |
|---|---|
| `field_visit` | organization, related_round_id nullable scoped FK, assigned_consultant_id staff FK, scheduled_start/end, timezone, purpose, notes, findings, recommendations, follow_up_date, status DRAFT/SCHEDULED/IN_PROGRESS/COMPLETED/CANCELLED, completed_at. |
| `visit_follow_up` | organization, visit_id, title, owner_staff_id, due_date, status OPEN/DONE/CANCELLED, notes; supports several actions per visit. |
| `attachment` | organization, visit_id, original_name, storage_key, content_type, size, checksum, scan_status, uploaded_by, retention expiry. Never attach a participant response. |
| `job_run` | kind, organization, safe resource ID, status, retry_count, started/finished, sanitized failure code, dedup key. No raw survey payload in generic queue messages. |
| `retention_policy` | version, record class, retention duration, deletion method, effective date, owner. |
| `system_setting` | key, validated value, version; threshold can increase but cannot fall below five. Secrets live in a secret manager. |

### 5.6 Structural invariants

- Organization → departments/participants/series/visits; series → rounds; round → one campaign; campaign → private roster and invitations.
- Questionnaire → immutable versions → sections/questions/options/dimensions/scoring/rules; campaign pins one version.
- Anonymous campaign → anonymous responses → answers/scores, with **no edge back to invitations or participants**.
- Published snapshot → aggregate cells → recommendations/reports. Staff analytics cannot query response tables.
- Composite org foreign keys prevent attaching an organization A visit/report/participant to organization B records, even with guessed valid UUIDs.
- Index all scoped foreign keys, campaign/status invitation queries, series/period round queries, and result snapshot/group/metric keys. Add database checks for timing, weights, ranges, and uniqueness; application validation supplies usable errors.

## 6. Anonymity, completion tracking, and saved progress

### 6.1 Why simple designs fail

Do not create `response.participant_id`, `response.invitation_id`, a shared submission UUID, a hashed participant reference, token hash, or a completion timestamp copied into response rows. Hashing identity does not make it anonymous. Separate tables with a shared join key are still linkable. Separate databases do not solve shared logs or exact timestamps.

A server-side draft stored against an invitation as readable JSON exposes answers before final submission. Reusing the invitation link as the only draft decryption secret also fails against an administrator who generated or copied that link.

### 6.2 Invitation and resume contract

1. Generate at least 256 random token bits using a cryptographic RNG. Display the token/link only when generated; store only a keyed digest with key version, not the raw token. A human-friendly invitation reference is not an authentication secret.
2. Use a dedicated public survey origin. Prefer a fragment-carried token exchanged via POST, immediately removed from browser history with `replaceState`; verify hosting logs never receive secrets. Issue a short-lived HttpOnly/Secure session credential. Use `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, no third-party scripts, and no respondent analytics/session replay.
3. Opening shows status without consuming the invitation. On initial draft creation, the browser generates an independent high-entropy resume secret and uses vetted authenticated encryption to encrypt the draft. A random server handle and secret form the private resume code. The server binds the handle to the invitation but has no stored decryption key.
4. Same-device resume uses the locally protected resume material; explain shared-device risks. Cross-device resume requires the private resume code. OrgFit staff cannot recover it. A lost code permits starting over before final submission, with explicit confirmation and invalidation of the old draft. Never reveal the previous draft through the original invitation link alone.
5. A bearer link can be forwarded or copied; the service cannot prove which human used it without adding identity verification. State this limitation. Link rotation invalidates earlier invitation sessions as well as tokens. No staff impersonation route or “open respondent draft” feature.

### 6.3 Final submission and consistency

The gateway is a trusted privacy service. It sees the invitation context and plaintext answers transiently for validation; it must never log either payload or a mapping. This is an explicit trust assumption, not a claim of cryptographic unlinkability.

On final POST:

1. Authenticate the current invitation session; resolve frozen campaign/version/group on the server. Ignore client-supplied organization, group, score, and completion status.
2. Acquire a campaign state lock compatible with the closure operation, then an invitation lock. Use one consistent lock order. Recheck `starts_at <= database_now` and `(ends_at IS NULL OR database_now < ends_at)`, state OPEN, token generation, and invitation READY under the lock.
3. Validate complete payload, question/option membership, size/type/range constraints, and all mandatory items. No invalid submission consumes the link.
4. Encrypt the validated answer envelope for the isolated privacy processor using a vetted library/protocol and managed keys. Store the encrypted envelope in the restricted inbox and mark invitation COMPLETED in **one local database transaction**. Delete the encrypted draft in that transaction where colocated, or mark it inaccessible with retryable cleanup when object storage is used.
5. Commit durably before returning success. “Completed” means a valid immutable submission was durably accepted, even if aggregate processing is pending. On retry, return the same generic accepted status for that invitation, without returning any answer ID or comparing submitted answer bodies. Never overwrite the first accepted payload.
6. A crash before commit leaves both operations uncommitted. A crash after commit is resolved by checking invitation completion. The UNIQUE inbox invitation constraint plus row lock enforces one accepted final payload. Do not implement an unreliable “write one database, then mark the other” sequence.

The inbox is explicitly temporary identity-linked encrypted staging. It is not the finalized anonymous answer store. Its decryption keys and backups must be inaccessible to ordinary staff and core application operators.

### 6.4 Closed-campaign processing

After closure, freeze the complete accepted inbox set. Do not stream individual responses into staff-visible analytics. For fewer than five accepted responses, publish only the suppression state; retain encrypted intake only for the approved short retention window, then crypto-erase/purge. Do not decrypt these campaigns for staff results.

For eligible campaigns, the dedicated processor decrypts in isolated memory, strips all identity/transport metadata, reduces grouping to the approved department group, randomly shuffles the complete set, and assigns fresh random response IDs. It commits the whole campaign batch plus `processed_batch(batch_id)` atomically in the anonymous database. For larger datasets, staging must remain inaccessible until one atomic batch-publication marker; retries must not append duplicate responses.

After confirmed commit, remove all intake envelopes and draft remnants and destroy the temporary batch decryption material under a documented backup-safe key lifecycle. Retain only a campaign/batch-level processing count, never the mapping between an input envelope and an output response. The campaign-level batch ID is acceptable because it does not distinguish an individual.

If the worker crashes after answer-store commit but before inbox cleanup, `processed_batch` proves the batch is already committed and cleanup can resume. If commit is uncertain, query the batch marker before retrying. Never mark an invitation incomplete to compensate for an infrastructure failure. Block publication and alert operators if accepted and processed counts disagree.

This mix step reduces timing/order correlation; it is not a formally verified mix network. The cryptographic library, key custody, transient staging, WAL/backups, and crash behavior require independent review before a public anonymity claim.

### 6.5 Output and inference controls

- No staff raw-answer endpoint, respondent list of scores, answer search, token lookup to answers, or unrestricted database console.
- No response timestamps, browser metadata, draft handles, or reusable pseudonyms in the answer store. No cross-round respondent linking.
- Live named completion status is permitted; live answer charts are not. Do not expose precise per-person completion times or durations.
- Frozen roster prevents changing an individual department mid-campaign to create a one-person analytical group. Department hierarchy rollups and demographic intersections are disabled initially.
- Publish one fixed, reviewed result snapshot after closure. Reopening a closed campaign is prohibited. New data requires a new assessment round.
- No arbitrary participant filters, date-of-submission filters, drill-through to response rows, or user-defined audience slices.
- Prevent duplicate/overlapping campaigns within the same assessment round. Across rounds, privacy review must consider near-identical populations and external knowledge; do not promise that k-thresholding eliminates all longitudinal inference.
- Changing a privacy policy cannot reveal a previously suppressed result automatically. Stronger policies revoke/regenerate old downloads as feasible; already downloaded copies cannot be recalled.

## 7. State machines and lifecycle

### 7.1 Questionnaire/template

`DRAFT → PUBLISHED → RETIRED`.

Drafts support full editing/deletion and validation. Publication freezes questionnaire content, scoring, bands, translations, and rules with a content hash. Retiring prevents new campaigns but leaves historic rendering/scoring intact. Editing a published version creates a new draft version. Copying a built-in template creates a custom questionnaire lineage; upgrades never overwrite custom copies.

### 7.2 Assessment and campaign

Assessment round: `DRAFT → COLLECTING → PROCESSING → PUBLISHED → ARCHIVED`, with `CANCELLED` from DRAFT or COLLECTING and `INSUFFICIENT_DATA` after closure where appropriate. Published indicates successful approved release, not necessarily that every metric is visible.

Campaign: `DRAFT → SCHEDULED → OPEN → CLOSED`, or `DRAFT → OPEN` if launch time has arrived. `DRAFT/SCHEDULED/OPEN → CANCELLED` requires reason. Scheduled opens automatically; end date closes automatically. Manual close is permitted from OPEN. No reopening of CLOSED or CANCELLED. Archive is an orthogonal visibility flag, not permission to accept submissions.

Launch freezes targets, instrument, group assignments, notice, locale availability, and threshold. Resolve a department to actual active participants at launch; later additions do not silently enter the campaign. Target lists must be nonempty and deduplicated. A participant can receive only one invitation per campaign/round.

Before closure, authorized staff may extend/set/remove the end date with an audit event; no date may precede the start or current accepted collection period. Once the end boundary has passed, extension must not reopen the campaign even if a scheduler has not yet updated state. Request-time checks are authoritative.

Revoking an outstanding invitation records a reason and makes it ineligible. A completed invitation cannot be revoked to remove one person's unknown anonymous response. Replace an outstanding token by rotation, not by adding another invitation.

### 7.3 Invitation and draft

Invitation: `READY → COMPLETED` or `READY → REVOKED`. “Not yet open,” “expired,” and “closed” are derived campaign-access conditions, not overwritten completion states. “Outstanding” means active roster invitation not completed or revoked; revoked counts remain separately visible.

Draft: `ABSENT → SAVED ↔ SAVED(new revision) → DELETED`, where deletion follows final submission, explicit start-over, expiry, or campaign retention cleanup. Saving cannot set invitation completed. Concurrent saves use revision checks and present a conflict instead of silently overwriting.

### 7.4 Publication/report

Release: `NOT_READY → QUEUED → PROCESSING → PRIVACY_CHECK → PUBLISHED`, with retryable `FAILED`, `INSUFFICIENT_DATA`, and `REVOKED`. Publish only after counts, scoring, suppression, and manifests pass. Reprocessing uses a new internal revision; changing released numeric results requires a correction record and disclosure review, not silent replacement.

Report job: `QUEUED → RUNNING → READY` or `FAILED`; READY may become `EXPIRED/REVOKED`. Source snapshot is immutable; job retry is idempotent.

## 8. Questionnaire builder specification

### 8.1 Shared editor behavior

Create blank or clone template; edit Arabic first with English alongside or through a locale toggle. Add/reorder sections and questions using keyboard-accessible controls as well as drag/drop. Duplicate an item with new keys. Autosave draft definitions with optimistic concurrency; warn on stale edits. Required is true for all answer-bearing questions by default. Section headings/content have no answer and never participate in required counts.

No conditional visibility, skip logic, expression scripting, or branching. All enabled questions are shown in fixed order. Preview runs with synthetic answers in an isolated context and cannot enter production metrics.

### 8.2 Type contracts

| Type | Input/validation | Scoring behavior |
|---|---|---|
| Short text | Unicode string, trim for blank test, default max 500 chars, configurable bounded limit | Unscored; privacy-sensitive. |
| Long text | Multiline Unicode, default max 5,000 chars | Unscored; privacy-sensitive. |
| Multiple choice | Exactly one option ID, >=2 options | Optional explicit bounded numeric option mapping. |
| Checkboxes | Unique option IDs, min/max selections, required means min >=1 | Unscored by default; explicit normalized sum or selected-count percentage with fixed attainable bounds if enabled. |
| Dropdown | Single option ID | Same as multiple choice. |
| Yes/no | Boolean or two canonical option IDs; do not rely on translated labels | Explicit score mapping, e.g. no=0/yes=1. |
| Rating 1–5 | Integer 1..5, translated endpoint labels | Numeric, optional reverse, normalized to 0..100. |
| Rating 1–10 | Integer 1..10 | Numeric, optional reverse, normalized to 0..100. |
| Matrix | Fixed rows and single-select columns per row; required matrix requires every row | Each row is a separate item; explicit row weights prevent accidental over-weighting. No freeform/dynamic rows. |
| Number | Finite decimal, min/max/precision configured; reject NaN and infinity | Optional bounded numeric score; unbounded numbers cannot be normalized/scored. |
| Date | Valid ISO date, optional range, no timezone conversion | Unscored; exact dates withheld from staff analytics by default. |
| Section heading/content | Sanitized text/limited markup, no inputs | Unscored and excluded from progress denominator. |

No respondent uploads in v1. No HTML/script execution in prompts, content, help text, or answers. Stable IDs, not labels, are submitted for options/matrix columns.

### 8.3 Publication validation

Require nonempty Arabic title and prompts/options; English completeness is required if the campaign offers English. Validate at least one answer question, unique keys/order, section membership, type limits, bounded payload size, coherent required/min-selection settings, scoring eligibility, positive weights, coverage, bands, dimension direction, and rule references. Reject any conditional-logic configuration.

Every scored item belongs to at most one primary dimension in v1. Matrix rows inherit the dimension but retain explicit weights. Unscored demographic or text items must not accidentally affect scores. Provide a calculated preview with boundary cases and a list of what is unscored. An unscored-only questionnaire is valid, but no overall score may be invented.

## 9. Scoring and interpretation engine

### 9.1 Deterministic contract

Input: pinned questionnaire/scoring definition and a valid anonymous answer set. Output per response: raw metric where meaningful, normalized value, coverage, direction, status, engine version. No network calls, arbitrary JavaScript, SQL expressions, or AI. Validate definitions at publish time and inputs at runtime.

For bounded item `x` in `[L,U]`, with `U > L`:

`reversed = L + U - x` when reverse scoring is enabled; otherwise use `x`.

`normalized = 100 × (effective_x - L) / (U - L)`.

Thus rating 1–5 value 4 is **75**, not 80, under this chosen min–max normalization. The old `(x / 5) × 100` convention is not used. Never switch normalization silently between versions.

### 9.2 Supported operators

| Mode | Definition / constraints |
|---|---|
| AVERAGE | Arithmetic mean of eligible normalized item values, equal item weight. Raw mean available only for homogeneous scales. |
| WEIGHTED_AVERAGE | `sum(w_i × n_i) / sum(w_i)` over answered eligible items after coverage check; weights strictly positive. |
| SUM | Sum raw mapped values; raw range is sum of item minima/maxima. Normalize from those bounds for comparison. Require all contributing items answered in v1; no denominator change or proration. |
| PERCENTAGE | `100 × numerator / denominator`, with explicitly defined numerator and positive fixed denominator (e.g. yes count / required yes/no items). All contributors required in v1 unless a clearly defined answered-only policy is explicitly versioned. No ambiguous “percentage” setting. |
| REVERSE | Item transformation before aggregation, not a separate dimension average. |

Dimension coverage for equal weights is answered eligible item count / total eligible item count. For weighted dimensions it is answered eligible weight / configured eligible weight. Default minimum is 80%. Below it: value null, status INSUFFICIENT. Optional unanswered questions are missing, never zero. For SUM/fixed-denominator percentage require 100% of their contributing inputs. Mandatory collection requirements and scoring eligibility are separate concepts.

Overall score is an explicit weighted mean of dimension normalized scores with the **same semantic direction**, or an explicitly configured orientation transformation `100 - score` into one common health direction. Require all configured overall dimensions to be valid in v1; otherwise overall is INSUFFICIENT. Do not average unrelated constructs into a company “health” score unless configured and explained.

Group/company score is the arithmetic mean of valid respondent-level scores for that metric, giving each respondent equal weight. It is not an unweighted average of department means. Count eligible contributors separately for each metric; apply privacy thresholds after eligibility checks.

### 9.3 Worked examples

**Reverse and average:** rating answers Q1=4, Q2=2 reversed, Q3=5. Q2 becomes 4. Normalized values =75,75,100. Equal mean=83.333333; display 83.3/100.

**Weighted:** values 75,75,100 with weights 2,1,1 → `(150+75+100)/4 = 81.25`; display 81.3.

**Missing optional:** five equal-weight items, four answered 75,50,100,75 → coverage 80%, score 75. Three answered gives 60% coverage and no score. A missing high-weight item may fail weighted coverage even with four of five items answered.

**Sum:** three required items scored 0..4, answers 2,3,4 → raw sum 9/12, normalized 75. For items bounded 1..5, use summed lower bounds too; do not divide by summed maximum alone.

**Percentage:** eight yes responses among ten required 0/1 items →80%. A zero denominator is invalid configuration, not a zero score.

**Overall:** Health-oriented dimensions 70 and 90, weights 0.6/0.4 →78. A risk-oriented dimension must first be explicitly converted if used in this health overall.

**Company weighting:** department A has ten valid respondents averaging 80; B has twenty averaging 50. Company mean=`(10×80+20×50)/30=60`, not 65. Department-vs-company gaps are +20 and -10 points, subject to disclosure review.

### 9.4 Bands, labels, and rounding

Use continuous half-open bands, for example HIGH_RISK: `[0,25)` Healthy, `[25,50)` Moderate, `[50,75)` High risk, `[75,100]` Critical. These are illustrative configuration defaults, not validated clinical thresholds. HEALTH direction uses appropriately reversed semantics.

Interpret using full internal precision; round only for display/export using decimal round-half-up consistently across UI/PDF/XLSX. Show one decimal by default. A score 74.96 remains in `[50,75)` even if displayed as 75.0; include precise threshold explanations or extra precision at boundaries to avoid confusion. Bands must cover all valid values exactly once. Labels, severity and direction are stored separately from color/theme choices.

Reject out-of-range scores, negative/zero weights, zero denominators, missing referenced keys, circular overall dependencies, mixed units without normalization, incomplete bands, and a scored item without an attainable bound. Property tests should prove normalization endpoints, reverse involution, weight-scale invariance, and deterministic results.

## 10. Rule-based recommendations

Recommendations consume **published, privacy-approved aggregate cells**, never participant records or private response scores. Rules belong to the questionnaire version and retain their version in each generated result.

A rule consists of target metric/group scope, a bounded `ALL`/`ANY` tree of comparisons (`<`, `<=`, `>`, `>=`, `BETWEEN`) against known metric keys, priority, optional exclusivity group, dedup key, localized title/action/rationale, and enabled state. Maximum tree depth and condition count are bounded; no arbitrary expression evaluation.

Evaluation:

1. Resolve only available metrics in the same snapshot and group. A suppressed, missing, or not-comparable input yields UNKNOWN; a rule needing it does not fire. Do not treat unavailable as zero or infer it through a complementary rule.
2. Evaluate numeric conditions using full precision and explicit direction.
3. Sort matches by priority then stable rule key. Within an exclusivity group retain the highest-priority match. Deduplicate by dedup key.
4. Persist the rule version, safe evidence, and frozen localized recommendation. Limit initial display to top five; retain a “show all eligible” action.
5. Staff can add separately labeled consultant notes and track action status, but cannot edit the frozen rule-derived evidence or relabel a manual opinion as an automatic result.

Example: if published `burnout >=75`, suggest reviewing workload distribution and recovery practices; rationale “Burnout score is {score}, within {band}.” If `support <40 AND workload >70`, suggest a manager-support and workload review. These are consulting suggestions, not diagnoses. A suppressed burnout score generates neither the recommendation nor a hidden risk badge.

Historical-change rules are disabled until comparison compatibility is implemented. When introduced, require both snapshots eligible and comparable; improvement direction must be explicit. Validate rule references, impossible conditions, contradictory exclusive rules, missing translations, deterministic ordering, and no-match behavior in the editor.

## 11. Analytics, disclosure control, and historical comparisons

### 11.1 Two independent read models

**Operational participation:** frozen invited count, active eligible invitations, completed, outstanding, revoked, and completion rate. `rate = completed / (frozen invited - revoked outstanding) ×100`. Show original invited and revoked separately; denominator changes must be visible. Zero eligible gives “Not applicable.” Never quietly erase non-completers to improve the rate.

**Assessment results:** closed, privacy-approved immutable snapshot. Overall configured score, dimensions, department comparisons, question analysis, bands, strengths/weaknesses, recommendations, and trends. While collecting, display “Results will be available after closure and privacy checks.”

### 11.2 Threshold policy

Count distinct valid contributing responses for **each** result, not invitations, total campaign submissions, answered matrix cells, or total option selections. Five campaign responses do not justify a dimension with only four valid contributors.

At count <5, return status/reason and null value; no hidden numeric field, count tooltip, chart coordinate, recommendation, CSV cell, or downloadable underlying series. Use “Results withheld to protect participant privacy / حُجبت النتائج حفاظًا على خصوصية المشاركين”. Distinguish suppression from “Not scored” and “Insufficient answers.” Staff may already know completion counts; the analytics service still must not expose protected metric contributors through accidental metadata.

Question distributions require protection per bin as well as per question. Rare bins are combined only into predetermined, semantically meaningful groups with at least five contributors; otherwise suppress bins and complementary totals as needed, or withhold the entire distribution. Checkboxes use respondent counts per option, not total selections as the privacy denominator. Exact numeric/date values cannot become histogram labels that identify a person. Suppress homogeneous sensitive outputs where the statistic would reveal every member's answer (for example all at an endpoint); the disclosure review must test this explicitly.

**Complementary suppression:** suppose company N=12, department A N=10, department B N=2. Publishing the company and A's precise totals/means permits recovery of B. Keep the company result and suppress A's result as well, or withhold the entire department breakdown. Use a conservative default: if any nonempty department cell for a metric has fewer than five eligible contributors, publish company-only for that metric. The same policy applies to nested/unknown department categories, omitted values, and differences against company means. More permissive release needs a tested disclosure algorithm, not UI-only hiding.

Allow only company plus one disjoint flat department partition. No simultaneous hierarchy rollups, arbitrary intersections, participant exclusions, or alternate partitions. Precompute a release plan across the whole report; evaluate reconstruction risks across all released totals, dimensions, distributions, and previous snapshot revisions. If uncertain, suppress the breakdown. K-thresholding does not establish formal differential privacy or immunity to background knowledge.

### 11.3 Visual and numerical contracts

| View | Contents / constraints |
|---|---|
| Overview | Configured overall score, scale/direction, contributor eligibility, publication period; no fabricated universal health index. |
| Dimensions | Bar/radar with fixed 0–100 scale, direction labels, accessible table; unscored/suppressed axes must not appear as zero. |
| Departments | Bar/table/heatmap, department metric vs overall company metric from same snapshot; gap in score points. No cross-company comparisons. |
| Questions | Safe option shares or bounded numeric summaries; denominators and missingness only where release-approved. |
| Strengths/weaknesses | Rank eligible dimensions after consistent orientation; ties deterministic; withheld dimensions do not enter ranking. |
| Trends | Round-based line/table; missing/suppressed points are gaps, not zero or interpolated values. |

No significance, causation, diagnostic validity, or industry benchmark claims. Differences are descriptive. Chart colors and appearance use replaceable tokens; accessibility includes labels and patterns, not color alone.

### 11.4 Historical model

An assessment series represents one organization and construct. Each round retains the original instrument hash, score engine/configuration, bands/rules, roster snapshot, group labels, collection period, publication snapshot, and privacy policy. Participant attributes at invitation time determine grouping; current directory edits never rewrite historic department results.

Compare only within the same organization. Default numeric trends require identical scoring semantics, item/option mappings, scale direction, and compatible dimension definitions. Translation-only edits can be marked equivalent after review. A changed instrument is NOT_COMPARABLE unless an explicit reviewed mapping explains why selected metrics remain equivalent. Stable question keys alone are insufficient.

Show absolute score-point difference, earlier/later values, collection dates, coverage and known population/department changes. Percentage change is optional and undefined from zero; point change is the default. Lower burnout may mean improvement while higher engagement means improvement. Do not join respondents across rounds or produce individual longitudinal profiles.

Department renames preserve an internal lineage with frozen labels. Mergers/splits are structurally changed and not automatically comparable. A historical chart can show the organization's overall series while withholding invalid department comparisons. Re-scoring old answers is a separately versioned analysis with compatibility/privacy review; it never replaces the original published result silently.

## 12. Reports, exports, and qualitative answers

Generate reports from the immutable publication snapshot using the same result API/data contract as the dashboard. The report worker has no private directory or raw-answer access. Report specification: organization and assessment identification, collection period, executive summary, methodology/scales, participation summary without names, eligible overall/dimension results, safe department comparisons, strengths/risks, automatic recommendations, separately labeled consultant commentary, eligible history, limitations/suppression note, and appendix with instrument/scoring/rule versions.

PDF: selectable Arabic text, correct shaping/RTL, embedded appropriate licensed fonts, flowing tables, page numbers, repeated headers, chart labels, no clipped content, clear report version/date. Produce Arabic or English as selected; mixed-language content must render correctly. No brand identity is prescribed. Use centralized report theme settings.

XLSX: sheets for Summary, Dimensions, Departments, Questions, Recommendations, History, and Methodology as applicable. Numeric metrics stay numeric; suppressed values are blank with a separate status/reason column, never hidden in a sheet or formula. Include units/direction and permitted denominator metadata. No hidden raw response sheet. Neutralize spreadsheet formula injection for all user-supplied strings and verify Arabic text and worksheet direction. Participation export is a separate clearly named private workbook/file containing invitation reference, participant name and status; never include answer metrics or a joinable response identifier.

Downloads use short-lived authorized URLs or authenticated streaming. Recheck current organization access at download time, not only job creation. Reports are private by default; producing a file does not send it to anyone. Audit generation/download events without recording file contents. Signed URL scope cannot cross organizations.

**Text/date policy:** collect the requested question types, but do not automatically expose raw prose or exact dates. A name, incident description, rare job title, or birth date can identify someone without an ID. Default v1 qualitative output is withheld; optionally enable a separate privacy-review workflow operated within the trusted privacy boundary to produce redacted, aggregated themes for sufficiently large groups. Never claim automated PII detection guarantees anonymization. Do not show verbatim quotes by default. This is a deliberate privacy restriction on reporting, not removal of these question types from the builder.

## 13. Field visits

Visits are internal consulting records for physical visits. Require organization, scheduled date/time, assigned active OrgFit consultant, and purpose. Permit optional same-organization assessment link, notes, findings, recommendations, attachments, and follow-up date. Separate action items allow owner, due date, completion status, and notes.

Workflow: `DRAFT → SCHEDULED → IN_PROGRESS → COMPLETED`; cancel from draft/scheduled/in-progress with reason. Completed content can be amended with an audited revision; keep original completion event. Follow-up reminders appear in the internal task list; email/calendar integration is out of scope. A follow-up date does not automatically schedule or contact anyone.

Attachments accept a bounded allowlist (initially PDF, common image formats, DOCX/XLSX if scanning is available), enforce configurable size limits (suggested 20 MB), verify actual type, quarantine and scan, use generated object names, and serve as attachment/sandboxed preview. Block executables, active HTML, and unsupported archives. Visit notes are confidential but are not anonymous survey data; never merge them into respondent records or use them to identify survey answers.

## 14. Arabic, English, RTL, and mobile behavior

Arabic is the initial locale for staff and respondent pages; staff preference can override it. English is available only when that instrument version has complete English respondent content. Switching locale preserves answers, validation state, progress, and route. Store canonical values independent of translated labels.

Use `lang` and `dir` at document/component boundaries, logical spacing/alignment, bidi isolation around emails/IDs/URLs, and locale-aware numbers/dates. Store UTC instants but show the organization's configured timezone; do not infer Gregorian/Hijri requirements from Arabic. Gregorian display is the default until explicitly changed. Normalize Arabic-Indic and Latin numeral input safely for numeric questions. Avoid layout rules tied to left/right unless semantically necessary.

Mobile survey requirements: usable at 320 CSS px and 200% zoom, no page-wide horizontal overflow, 44px preferred touch targets, properly labeled controls, visible focus, keyboard access, error summary linked to fields, screen-reader announcements for save/submit status, and adequate contrast under every theme. WCAG 2.2 AA is the accessibility target; 44px is a product target, not a claim that AA universally requires that size. [WCAG 2.2](https://www.w3.org/TR/WCAG22/).

Use section-based pages, clear answered/total progress excluding content blocks, large controls for rating scales, and matrix rows stacked as labeled mobile cards preserving row/column meaning. Keep back/next available without losing input. Scroll/focus to the first error on review. Final submission has one clear confirmation and a pending state that tolerates retry.

Autosave is debounced and visibly distinguishes Saving, Saved, Offline/not saved, and Conflict. Support local encrypted draft continuity and retry after reconnection; full offline final submission is out of scope. Never display “Saved” before persistence acknowledgment. Test browser refresh, back navigation, multi-tab edits, expired sessions, interrupted final submission, iOS Safari and Android Chrome, keyboard obstruction, and long Arabic labels.

Styling uses centralized semantic theme variables for spacing, typography, surfaces, borders, focus, chart palettes and status. No rigid brand palette, logo, or visual identity is part of this specification.

## 15. Security, privacy operations, and production readiness

### 15.1 Application controls

- Staff MFA; no public registration; mature authentication library/provider; disabled staff sessions revoked promptly; session inactivity and absolute expiry documented.
- Secure/HttpOnly/SameSite cookies, CSRF protection for cookie-authenticated mutations, restrictive CORS, origin validation, content security policy, output escaping, parameterized queries, and request body/collection size limits.
- Public token exchange, draft operations and final submission independently rate-limited. Suggested initial policy: token exchange 30/minute per transient edge IP bucket and 10/minute per token digest; draft writes 30/minute per session; final attempts 5/minute per session. Tune for shared office NAT and accessibility; never permanently consume a valid invitation because of a rate-limit event.
- IP-based abuse state has a short TTL and is not copied to response records or long-lived correlation logs. No device fingerprinting. Generic public errors avoid participant/organization enumeration.
- Token rotation invalidates prior sessions; compare digests safely; secrets in managed storage; TLS in transit and encryption at rest; key rotation and recovery rehearsed.
- Server validates every answer against the pinned instrument and selects group identity from frozen server data. Reject unknown question/option IDs, duplicate options, oversized strings, malformed dates, invalid JSON, and client-computed scores.
- File quarantine/scanning, private buckets, path-safe filenames, expiring access, no raw file paths supplied by users.

### 15.2 Logs and audit

Administrative audit records track staff access changes, directory mutations, imports, template publication, campaign launch/closure/revocation, report access, visit changes and retention actions. Avoid raw before/after copies of sensitive fields; store field names and justified sanitized summaries.

Public survey observability records aggregate request/latency/error counters and campaign processing totals, not per-response distributed traces. Disable request/response body capture, SQL bind-parameter logging, crash breadcrumbs with form state, URL token logging, and analytics/session replay. Never propagate a request ID from identity intake into anonymous processing or results. OWASP specifically identifies access tokens and sensitive personal data as values requiring exclusion or appropriate protection in logs. [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).

Operational infrastructure can retain network metadata independently; document who can access it and its retention. Do not claim that omitting application logs eliminates traffic correlation.

### 15.3 Retention and backups

Proposed configurable starting schedule, requiring owner approval before production: encrypted drafts deleted on submission or within seven days after closure; temporary manual-link exports expire within 24 hours; processed intake purged immediately after verified transfer; insufficient-data intake purged within 30 days of closure; anonymous answer storage retained 12 months for verified recalculation then purged; published aggregate snapshots/consulting records retained according to an approved business schedule; security/audit logs 12 months; encrypted rolling backups 35 days. No indefinite retention by accident.

Backups must preserve recoverability without silently restoring a deleted identity-to-ciphertext bridge or expired decryption key. Use separate key access and backup policies for identity, drafts/intake and anonymous stores; document crypto-erasure limits and the precise KMS deletion/recovery window. Restore procedures reapply deletion tombstones and retention jobs before restored environments are accessible. Production datasets never enter development or demos.

Suggested recovery objectives: RPO <=15 minutes, RTO <=4 hours, subject to actual hosting support. Validate with a timed restore exercise, including invitation completion/inbox consistency, anonymous batch marker recovery, and missing key behavior. An unrecoverable accepted payload is a data incident; never pretend it was successfully analyzed.

Erase/archive requests cannot use a participant ID to find and delete an individual finalized anonymous response because that link intentionally does not exist. Explain this before submission. Directory erasure and invitation-retention cleanup remain possible; approved whole-campaign erasure can remove the entire anonymous set. Do not introduce a hidden reverse lookup “for compliance.” Legal retention/residency requirements must be confirmed for the actual operator and deployment jurisdiction; this blueprint makes no certification claim.

### 15.4 Deployment and operations

Separate local/staging/production environments; synthetic staging data; pinned lockfile; repeatable migrations; secret scanning, dependency scanning and build checks; separate service accounts; least-privilege network/database policies. Migration role is never the runtime role. Test schema creation and upgrades from the previous release; use expand/migrate/contract for destructive changes. A rollback plan must not discard accepted submissions or violate the one-use invariant.

Jobs use durable retries, deduplication keys, bounded backoff and dead-letter inspection without exposing payloads. Closure remains enforced at request time during scheduler outages. Health/readiness endpoints reveal no secrets. Alert on intake/processed-count mismatch, queue backlog, failed publication, export errors, backup failure, low disk/storage capacity, and abnormal token abuse.

Capacity baseline for acceptance, subject to measured adjustment: organization directory up to 100,000 participants; campaigns up to 10,000 invitees and 200 answer-bearing items; 200 concurrent respondent sessions. Target p95 normal page/API interactions under two seconds, final durable acceptance under three seconds excluding network latency, and report generation under two minutes for the agreed fixture. State hardware/data conditions when reporting results; these are test targets, not guaranteed performance claims.

Production release requires a configured domain/TLS, secret/key inventory, successful restore rehearsal, privacy review, accessible Arabic respondent flow, real approved questionnaire content, verified report rendering, support/runbook ownership, and no unresolved critical/high security or privacy defects. Build readiness is not proof of production readiness.

## 16. Tests and module acceptance criteria

| Module | Required evidence / pass condition |
|---|---|
| Access and isolation | Two organizations with overlapping participant codes; all API reads/writes/jobs/files deny cross-org access. Staff capability revocation takes effect. Runtime DB role cannot bypass policy. |
| Directory | Import rejects/flags duplicate references and invalid departments; dry run creates nothing; commit is idempotent; archive keeps historical snapshots. |
| Builder | All types round-trip; required defaults correct; no branching; invalid definitions cannot publish; published content immutable; copy/edit does not change source. |
| Scoring | Golden fixtures match examples exactly; boundaries, reverse, missing/weighted coverage, matrix weights, mixed direction and invalid denominator cases pass. |
| Campaign | Target modes work/deduplicate; frozen roster stable; one invitation per round; no-end campaigns remain open; exact end boundary denies; manual close racing final submit has deterministic lock behavior. |
| Links/drafts | Rotation/revocation invalidates tokens/sessions; original link cannot decrypt existing draft; same/cross-device resume works; stale revisions conflict; final deletes/inaccessibilizes draft. |
| Intake | 100 concurrent final attempts for one invitation produce one accepted immutable payload; before/after-commit failures and dropped success response recover correctly. |
| Privacy processing | No forbidden fields/mappings in finalized store/logs/exports; shuffled batch retry writes once; crash after output commit resumes cleanup; sub-five campaign cannot release answers. |
| Analytics | n=4 suppressed, n=5 eligible subject to other rules; metric n=4 suppressed even if campaign n=20; 10+2 complementary case blocked; sparse bins and homogeneous endpoints tested; no live-score differencing. |
| Recommendations | Threshold edges, unknown/suppressed evidence, conflict resolution, dedup and AR/EN explanations deterministic; manual notes do not alter computed evidence. |
| History | Incompatible versions blocked; direction-correct point changes; department move/rename does not rewrite old results; missing rounds remain gaps. |
| Reports | Dashboard/PDF/XLSX safe values agree; suppressed values absent from hidden data; RTL pages and charts visually inspected; formula injection neutralized; unauthorized downloads denied. |
| Visits | Same-org relation enforced; invalid status changes denied; attachment quarantine/scan/access works; follow-up list correct. |
| Localization/mobile | Full Arabic path and English path, long text, bidi IDs, numeric normalization, 320px/zoom, keyboard/screen-reader and real mobile browser smoke tests. |
| Operations | Fresh and upgrade migrations, restore timing, key custody/erasure checks, job recovery, monitoring alerts, measured load targets and rollback rehearsal documented. |

Testing layers: pure unit/property tests for math and state rules; real-PostgreSQL integration tests for locks, constraints and access; API negative tests; browser end-to-end tests; rendered PDF/XLSX checks; privacy adversarial fixtures; load/failure-injection tests; and independent production privacy/security review. Do not substitute mocked authorization or SQLite tests for database-specific isolation/race guarantees.

## 17. Implementation order and checkpoints

| Phase | Scope | Gate |
|---|---|---|
| 00 | Repository inspection, requirements reconciliation, architecture/threat-model analysis; no coding | Written decisions and unresolved release assumptions. |
| 01 | Logical/physical schema, data flow, state/API contracts; no application coding | Privacy/database design review. |
| 02 | Foundation, staff auth, access boundaries, localization/theme infrastructure | Foundation tests. |
| 03 | Organizations, departments, participants/import | Checkpoint A: isolation and directory. |
| 04 | Questionnaire library/builder/versioning | Immutable publish and all-type coverage. |
| 05 | Scoring/interpretation engine and sandbox | Checkpoint B: instrument/scoring. |
| 06 | Assessments, campaigns, invitation tokens, schedule | Boundary/race contracts ready. |
| 07 | Anonymous survey flow, encrypted drafts, intake, batch transfer | Checkpoint C: privacy/concurrency; blocks downstream real data. |
| 08 | Publication/disclosure engine and analytics | Suppression and reconstruction fixtures. |
| 09 | Deterministic recommendations/actions | Checkpoint D: safe results and rules. |
| 10 | Historical comparisons | Compatibility and frozen-history proof. |
| 11 | PDF/XLSX reports/exports | Checkpoint E: history/report consistency. |
| 12 | Field visits/files/follow-ups | Same-org and attachment tests. |
| 13 | Arabic/English/mobile/accessibility refinement | Checkpoint F: full user journey. |
| 14 | Security, retention, backups, load/failure testing | Production gap list with evidence. |
| 15 | Final release candidate, staging rehearsal, production readiness | Checkpoint G: go/no-go evidence; deploy only when explicitly authorized. |

Each phase begins by inspecting existing code/database and prior phase evidence. Each finishes with an implementation summary, changed files/migrations, tests and actual results, known risks, and a next-phase handoff. Fix regressions in scope before proceeding. Do not rewrite completed modules, switch frameworks, introduce new features, or run destructive migrations without a concrete requirement and impact analysis.

## 18. Decisions required before a real deployment

The baseline allows development without repeated clarification. Before production, record: approved privacy threat model and respondent notice; ownership of isolated processing/key access; actual hosting region/provider; retention policy and recovery objectives; first staff accounts/capabilities; approved questionnaires, translations and scoring/rules; import fields/contact policy; and treatment of qualitative outputs. These are specific deployment inputs, not grounds to postpone architecture or foundation work.

The companion prompt pack translates this specification into bounded Astra 6 work orders and repair checkpoints. Use one phase prompt at a time; do not ask the implementation agent to build the whole system in one turn.
