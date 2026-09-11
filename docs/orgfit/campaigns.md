# Assessment rounds, campaigns and secure invitation links (Phase 06)

Development scope. This module creates assessment series, rounds, one campaign
per round, frozen rosters and report groups, invitations with keyed token
digests, manual link exports, participation lists, and the respondent gateway
validation/status contract that Phase 07 will build on.

**It collects no answers.** There is no draft, no submission inbox, no campaign
encryption key, no processing batch, no anonymous store and no score anywhere in
this phase. A completed invitation status exists as a state the acceptance
transaction will set in Phase 07; nothing here can set it through an API.

## Setup

Apply migration `008_campaigns.sql` with the operator connection, then supply
two new secrets in the staff environment (see `.env.example`):

```bash
npm run db:migrate
```

| Variable | Purpose |
|---|---|
| `INVITATION_DIGEST_KEY` | 64 hex characters. Keys the HMAC-SHA256 digest of every invitation token. Separate from `IMPORT_ENCRYPTION_KEY`. Rotating it invalidates every outstanding link. |
| `INVITATION_DIGEST_KEY_VERSION` | Recorded next to each digest so a future rotation stays auditable. Defaults to `v1`. |
| `LINK_EXPORT_ENCRYPTION_KEY` | 64 hex characters. Encrypts manual link-export files at rest. Never reused from imports. |
| `LINK_EXPORT_LOCAL_DIRECTORY` / `LINK_EXPORT_S3_BUCKET` | Private storage for export files. Production requires a private bucket with a one-day lifecycle rule on `link-exports/`. |

Run the schedule normalizer on a timer (it is bookkeeping, not enforcement):

```bash
npm run campaigns:normalize
```

## Screens

Open `/organizations/:org/assessments` after staff login to create a series, a
round and a campaign, then `/organizations/:org/campaigns/:id` for the launch
review, lifecycle actions, participation lists and link issuance.

## Lifecycle

Round: `DRAFT → COLLECTING → PROCESSING`, with `CANCELLED` from `DRAFT` or
`COLLECTING`. Launch moves a round to `COLLECTING`; closure moves it to
`PROCESSING`.

Campaign: `DRAFT → SCHEDULED → OPEN → CLOSED`, or `DRAFT → OPEN` when the start
instant has already passed at launch. `DRAFT`, `SCHEDULED` and `OPEN` may become
`CANCELLED` with a reason. `CLOSED` and `CANCELLED` are terminal — there is no
reopen route, and the database trigger `core.campaign_freeze` refuses a state
change out of either, even for the operator role. `archived` is an orthogonal
visibility flag.

### Boundaries are evaluated at request time

`core.effective_state(state, starts_at, ends_at)` derives the true state from
the database clock on every read. `core.normalize_campaign` persists that
transition under the campaign row lock. A campaign is `OPEN` when
`clock >= starts_at`, and `CLOSED` at the exact instant `clock >= ends_at`.

`scripts/close-campaigns.ts` (`npm run campaigns:normalize`) only makes stored
state catch up. **A late, stopped or crashed scheduler cannot hold a campaign
open past its end**, because every request re-derives the boundary itself. The
test suite asserts this by leaving a stored `OPEN` row with a passed end and
observing that both the staff read and the gateway report `CLOSED` with no
scheduler run.

### End dates

The end date may be set, extended or removed only while the campaign is `DRAFT`,
`SCHEDULED` or `OPEN`, only if the existing end has not already passed, and never
to an instant at or before either the start or the current database clock. Every
change writes a `CAMPAIGN_END_DATE_CHANGED` audit row. Once the boundary has
passed, no extension can reopen collection.

## Targeting and the launch freeze

| Mode | Resolution |
|---|---|
| `SINGLE` | One named active participant. |
| `SELECTED` | An explicit list, deduplicated. |
| `DEPARTMENT` | The named department's own active members, resolved once at launch. Flat — descendants are never rolled up (decision D-048). |

A target containing another organization's participant, an archived person or an
unknown identifier is rejected whole; nothing is silently dropped. Duplicate
identifiers collapse to one person, and one participant receives exactly one
invitation per campaign.

Launch is the freeze point. In one transaction it resolves the target, creates
the report groups (`COMPANY`, one `DEPARTMENT` per department present, and
`OTHER` only when some target has no department), creates one unissued `READY`
invitation and one roster row per person with a private department snapshot, and
writes `frozen_manifest` — instrument hash, version identifier, allowed groups,
locales, privacy notice, policy (threshold, `FLAT_DEPARTMENT` segmentation) and
start. Later directory edits never change a launched campaign: adding a person
does not enlarge the roster, and archiving one does not remove their invitation.
The `core.campaign_freeze`, `core.invitation_freeze`, `core.roster_freeze` and
`core.group_freeze` triggers enforce this against direct SQL as well.

### Release eligibility is shown before launch

`GET .../campaigns/:id/launch-review` returns the resolved count, group shape and
whether the campaign can ever release a metric. A `SINGLE` campaign, and any
campaign with fewer invitees than its threshold, is reported as not releasable
with an explicit warning. Five valid contributors per released metric remains the
floor; this screen states the limitation rather than implying a future result.

## Invitations and links

* Tokens are 256 random bits (`randomBytes(32)`, base64url). The raw value exists
  only in memory and in the single response that reveals it.
* Only an HMAC-SHA256 keyed digest and its `digest_key_version` are stored.
  `orgfit_staff` has **no column privilege** on `token_digest` or
  `digest_key_version`; a staff query for them is denied by PostgreSQL.
* `display_reference` (`INV-` plus 16 hex characters) is an opaque operational
  label with its own uniqueness. It is not a credential and cannot authenticate.
* The link is `RESPONDENT_ORIGIN/s#<token>` — the fragment keeps the credential
  out of server logs, Referer headers and proxy query strings.
* Issuance is generation `0 → 1`, once. A retry at the old generation, or a
  replayed idempotency key, returns `409 TOKEN_ALREADY_ISSUED` and the current
  generation — never old plaintext. A lost unused link is recovered by rotation,
  not retrieval.
* Rotation increments the generation, replaces the digest and deletes the
  invitation's sessions. Revocation nulls the digest entirely, marks the roster
  row `REVOKED` and deletes its sessions.
* A `COMPLETED` invitation cannot be rotated or revoked. One person's unknown
  anonymous response can never be removed by an administrative action.
* There is **no impersonation route and no staff view of a respondent draft.**

### Manual link export

`POST .../campaigns/:id/link-exports` takes the invitation identifiers, the
generation the operator expects for each, and `confirmRotation`. The plan is
applied atomically in identifier order: any unexpected generation, foreign
invitation or completed invitation aborts the whole plan and issues nothing.
Re-issuing already-issued invitations requires `confirmRotation: true` and
invalidates the previous links. The result is one private file encrypted under
`LINK_EXPORT_ENCRYPTION_KEY`, expiring in 24 hours, downloadable only with
`campaigns.manage` or `participation.export` inside the owning organization.
CSV cells are quoted and leading formula characters neutralized.

**Nothing is ever sent automatically.** OrgFit does not email, message or
otherwise deliver an invitation. A link is a bearer credential: whoever holds it
can answer, and the service cannot prove which human used it. That limitation is
stated on the screen, not hidden.

## Participation and denominators

`GET .../campaigns/:id/participation` requires `campaigns.manage` or
`participation.read` and returns named lists plus totals:

| Field | Definition |
|---|---|
| `invited` | Frozen roster size. |
| `completed` | Invitations in `COMPLETED`. |
| `revoked` | Invitations in `REVOKED`. |
| `outstanding` | `invited − completed − revoked`. |
| `eligible` | `invited − revoked`. |
| `rate` | `completed / eligible`, or `null` when `eligible` is zero. |

Each row carries only invitation identifier, participant identifier, display
reference, display name, status, whether a link was issued, the generation and
the report group. There is no answer, no response identifier, no score, no
completion timestamp and no per-person export.

## Gateway contract handed to Phase 07

`core.gateway_exchange(token_digest, session_digest)` and
`core.gateway_status(session_digest)` are the validation and status contract,
wrapped by `src/gateway.ts`. Neither is granted to `orgfit_staff`, and neither is
wired to an HTTP route in this phase.

* Opening never consumes an invitation and never sets completion.
* Status precedence: `COMPLETED → ACCEPTED` even after closure; revoked,
  unknown, malformed or stale-generation → the same generic `UNAVAILABLE`;
  cancelled → `UNAVAILABLE`; otherwise `NOT_YET_OPEN`, `OPEN` or `CLOSED`.
* The context carries campaign identifier, version identifier, locales, the
  frozen notice and the end instant. It carries no participant identity, name,
  organization name, answer or score.
* Sessions bind to `token_generation`, so a replayed cookie cannot outlive its
  token even if a delete were missed.

Phase 07 delivered all of this — the respondent HTTP surface on its own origin,
a dedicated gateway credential, browser-encrypted drafts, the submission inbox,
campaign keys and the acceptance transaction. See [respondent.md](respondent.md).

One change reaches back into this module: **launch now provisions a per-campaign
sealed-box key inside the launch transaction**, so a campaign can never open for
answers with nothing to seal an acceptance to. If key custody is unavailable the
whole launch rolls back and the campaign stays `DRAFT`. Set
`CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY` and `CAMPAIGN_KEY_CUSTODY_DIRECTORY` in the
staff environment before launching; the matching secret key belongs only to the
privacy processor.

## Tests

```bash
npm run test:campaigns
npx playwright test tests/browser/campaigns.spec.ts
```

Run the campaign suite against the dedicated PostgreSQL test cluster. It creates
fresh synthetic databases and never resets or drops an existing one.

## Limitations

The five-contributor threshold is a floor, not an anonymity guarantee; the
blueprint's disclosure controls are Phase 08 work. Retention values (24-hour
export TTL) are development defaults pending P-004. Instruments remain
illustrative pending P-006. Lock-order choices are correctness-first and
unmeasured for capacity. Nothing here is production readiness.
