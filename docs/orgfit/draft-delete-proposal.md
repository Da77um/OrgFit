# Proposal: deleting a never-published questionnaire draft

Status: **PROPOSED, not implemented, awaiting the owner's decision** (2026-10-12). Nothing in the code or schema deletes a questionnaire today. Archive (D-173) stays the only way to retire one.

## What would be deleted

A whole custom questionnaire, together with all its versions, only when **every** version has always been a draft. A draft version can't be deleted on its own while a published sibling exists. That case keeps today's model: archive the questionnaire, or leave the draft unpublished.

Rows removed, in one transaction, in reverse dependency order:

| Table | Why it exists |
|---|---|
| `instrument.recommendation_rule`, `interpretation_band`, `score_definition`, `matrix_column`, `matrix_row`, `question_option`, `question`, `dimension`, `section` | the draft's content (child tables of the version) |
| `instrument.questionnaire_version` | every version (all `DRAFT`) |
| `instrument.questionnaire_department` | its department targeting (020) |
| `instrument.questionnaire` | the library entry |

The `instrument_scope` row stays; it's shared by the whole organization (or the global library). Built-in templates (`source='BUILTIN'`) can never be deleted.

## How "never published and no responses" is proven

All inside the deleting function, under the same locks `write_version` takes (`pg_advisory_xact_lock(80400)` and `FOR UPDATE` on the questionnaire and every version row), so nothing can publish in between:

1. **Never published.** Every version has `state='DRAFT'` and `published_at IS NULL`, and `schema_hash IS NULL`. This is sufficient: `instrument.immutable_version()` forbids every transition out of `PUBLISHED`/`RETIRED`, so a version that was ever published can't be a draft again.
2. **No campaigns, so no invitations or responses.** Campaign rounds and campaigns may only use `PUBLISHED` versions (`008_campaigns.sql`, the `v.state<>'PUBLISHED'` checks). As a second, explicit check, the function refuses if any `core.assessment_round` or campaign row references any of the versions. The foreign keys would refuse anyway. Respondent answers live only under campaigns, so none can exist.
3. **Nothing else points at it.**
   - another questionnaire cloned from it (`questionnaire.source_template_id` foreign key): **refuse**, with a message naming the copy. The alternative, nulling the lineage, would silently rewrite another record's history.
   - an assessment series created on its `family_key` (`core.assessment_series.questionnaire_family_id`, no foreign key): **refuse**, unless another questionnaire in the same organization shares that family key, because otherwise the series would point at nothing.

Any failed check raises `STATE_CONFLICT`. Nothing is removed, and the UI says why in Arabic and English.

## The audit entry

One row in `ops.audit_log`, written in the same transaction as the delete: `action='INSTRUMENT_DELETED'` (a new value for `audit_log_action_check`, with Arabic/English labels in `admin-i18n.ts` and the audit filter), `organization_id` (null for the global library), `target_id` = the questionnaire id, `field_names=ARRAY['instrument']`. Like `INSTRUMENT_CHANGED`, it records **no content**: no title, no question text. `ops.audit_log` has no free-text column. Note that the directory archive's required reason is validated (1–500 characters) by `core.save_directory` but **not stored anywhere**: it only enters the idempotency request digest, and its audit row is `DIRECTORY_CHANGED` with no reason. Requiring a reason here would behave the same way unless a column is added to keep it. **Owner decision** (and the same question applies to the existing directory archive).

No tombstone. `ops.deletion_tombstone` exists for personal data and private artifacts (attachments, exports, campaign intake and keys), and its `organization_id` is NOT NULL, so global drafts couldn't be recorded there at all. A questionnaire draft holds no respondent data.

## What it would touch

- **Migration (new, forward-only):** `instrument.delete_draft(org, qid, expected_revision, idem, request_hash)` (SECURITY DEFINER, fixed `search_path`, the `instrument.guard(org)` capability check, the idempotency receipt like `write_version`). It also changes `immutable_version()`: today it refuses **every** DELETE, so it would allow a DELETE of a `DRAFT` version only when a transaction-local setting that only `delete_draft` sets is on. Plus the audit action value, and `EXECUTE` granted to `orgfit_staff` only. No direct DML for staff.
- **API:** `POST B/:qid/delete` with `{}` (or `{reason}`), `Idempotency-Key`, `If-Match` = questionnaire revision; `instruments.manage` capability; 200 with `{id}`.
- **UI:** a "Delete draft" action shown only for a custom, active questionnaire whose versions are all drafts, beside Archive in the library list and detail view. It asks in place and says plainly that it can't be undone; the server re-checks everything.
- **Tests:** database tests that each refusal holds (published, retired, has a campaign, cloned-from, series on its family, built-in, wrong organization, stale revision, replayed key), that a success leaves no child rows and exactly one audit row, and that ordinary staff without `instruments.manage` get 403. A browser test for the confirmation.
- **Docs:** `instruments.md`, `api-contracts.md`, `data-model.md`, `decisions.md`, `privacy-protocol.md` (stating that this deletes staff-authored configuration only).

## What could go wrong

- **Weakening the immutability trigger** is the real risk: a bug in the bypass could let a published version be deleted. Mitigation: the bypass checks `OLD.state='DRAFT'` *and* the setting; a database test tries to delete a published version with the setting on and must fail.
- **A race with Publish:** prevented by taking the same advisory and row locks as `write_version`, and covered by a test.
- **Backups:** a restore from a backup taken before the delete brings the draft back. The restore replay only re-applies tombstones, and this proposal records none. That is acceptable for configuration, but `retention-backup-runbook.md` must say so.
- **Accidental loss:** a draft can hold hours of work, and there's no trash. Mitigation: the confirmation; alternatively, require archiving first, so deletion is only offered from the archived filter (two deliberate steps).
- **Lineage and comparisons:** handled by refusing when anything points at it, never by rewriting references.
- **Audit readers** must learn a new action; the admin audit screen filter and labels need it.

## Decisions needed from the owner

1. Do it at all, or keep archive-only.
2. Offer it directly on an active draft, or only after archiving (two-step).
3. Require a typed reason, and if so, store it (new audit column) or not.
4. Refuse when a clone or a series references the draft (proposed), or allow with lineage cleared.
