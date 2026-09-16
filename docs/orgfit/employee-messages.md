# Employee messages (migration 025)

A written channel from a client organization's employees to the consultants
working on that organization. Employees have no accounts; consultants read the
messages in the staff workspace. There is no reply.

**Read [what this does not guarantee](#what-this-does-not-guarantee) before
describing it to a client.** It is not described to anyone as anonymous.

## What runs

| Part | Where | Who |
|---|---|---|
| Employee page | `apps/respondent/app/m` (`/m#<token>`) | anyone holding the organization's link |
| Public API | `POST /public/v1/messages/context`, `POST /public/v1/messages` | `orgfit_gateway`, through two `SECURITY DEFINER` routines; still zero table privileges |
| Inbox | staff workspace → organization → **Employee messages** | `messages.read` (a Super Admin holds every capability) |
| Link issue / rotate / revoke | same screen | **Super Admin only** |
| Retention and restore replay | `runRetention`, `reapplyTombstones` | operator |

## How an employee reaches it

OrgFit issues **one link per organization**. The token is 256 random bits in
the URL fragment, shown once at issue; only its keyed digest
(`INVITATION_DIGEST_KEY`, with the same previous-key rotation window as
invitations) is stored. The page reads the fragment and removes it from the
address bar before any request, so the token never reaches a server log, a
`Referer` header or history.

On the page the employee:

1. sees the organization the link belongs to — confirmed, never typed, and no
   list of organizations exists anywhere on the public side;
2. reads the notice (below), in Arabic or English;
3. chooses one of the organization's **ACTIVE** departments, or "other / not
   listed" with up to 120 characters of their own;
4. writes up to 2,000 characters and confirms in a dialog that repeats what is
   attached.

No cookie, session, local storage or analytics is used. The token is posted
with each request.

### The employee's view, screen by screen

| Moment | What the employee sees | What happens |
|---|---|---|
| Opens the link | A loading mark, then the OrgFit bar with the language switch | The fragment is read and removed from the address bar before any request |
| Page open | "This link belongs to the organization" and its name; "if this is not your organization, do not send anything" | Name and ACTIVE departments come from the link; nothing else about the organization |
| Before writing | "Before you write": company and department are attached; no name, email or device address; time kept to the day. A boxed limit: small departments, don't identify yourself, no guarantee | Same text in Arabic (default) and English |
| Form | Department picker (+ "Other / not listed" with a 120-character name field) and a message box with a live "n of 2,000" count | Nothing is saved while typing; leaving with text asks first |
| "Review and send" with something missing | The fields turn red with a sentence under each, and the caret moves to the first one | No request is sent |
| Confirmation dialog | "This message will reach OrgFit consultants with the company name and the department: X. It cannot be edited or deleted", plus the limit again | Cancel is focused; Escape closes and returns to the button |
| Sent | "Your message was received", "no reply comes through this page", "Write another message" | The text is cleared; the department stays |
| Department archived while writing | "The list of departments changed… your message is still here" | The list is read again and the stale choice cleared |
| Too many sends through this link | "Wait a minute… your message is still here and was not sent" | Per-link rate limit |
| No answer from the server | "We cannot tell whether the message was received. Send again only if you accept it may arrive twice" | Never claims success or failure it did not see |
| Link revoked, rotated, invalid, or organization archived | "This message link is not valid or is no longer available" | One answer for all of them |

### Running it locally

The respondent app must use the **same** `INVITATION_DIGEST_KEY` (and version)
as the staff app, or no link the staff app issues will resolve, and its
`GATEWAY_DATABASE_URL` must point at the same database with the
`orgfit_gateway` login. Put both in `apps/respondent/.env.development.local`
(gitignored), then `npm run dev:respondent` and open the issued link.

## What is stored

`core.employee_message`: `id` (fresh random), `organization_id`,
`department_id` **or** `other_department`, `body`, `received_on` (a **date**, in
the organization's timezone). Nothing else. Messages are immutable (trigger).

Deliberately absent: the link a message came through (a rotation would split
messages into cohorts), participant, invitation, campaign, token digest,
session, IP address, user agent, request or correlation id, locale, and any time
finer than a day. Core records when a named invitation was completed, so a
message stamped to the minute could be lined up against that record without any
key joining them; a day cannot be lined up the same way. Within a day the inbox
is ordered by the random id, i.e. not at all.

Nothing is written to the anonymous database. The feature suite asserts the
column list, that `received_on` is a `date`, that staff cannot select a link
digest, and that the anonymous schema has no message table.

## The notice

The page says, before the form and again in the confirmation dialog, that the
message is shown to OrgFit consultants **with the company and department
attached**, that no name, email or device address is kept and the time is kept
no more precisely than the day, and that **in a small department the content
alone may reveal the writer**, so nothing identifying should be written. It
states that the channel cannot guarantee the writer stays unidentified. A unit
test fails if either catalog calls the channel anonymous.

## Abuse protection (reused from the survey intake)

* the same route file, `checkOrigin` (exact respondent origin, not cross-site,
  JSON only), `no-store` and `no-referrer`, the streaming body reader — capped
  at **16 KB** for these two paths instead of 2 MB;
* strict zod inputs: unknown keys, an organization, a participant or a name are
  refused, and the body and department are bounded before any database work;
  the routine restates every bound and is the authority;
* the public error vocabulary and `guarded` translation, so no driver message
  or SQL escapes; an unknown, revoked or archived link is one answer;
* `intake.rate_hit` with window-bound HMAC keys (017), three new buckets:

| Bucket | Default / min | Env |
|---|---|---|
| `message_ip` | 60 (only with a trusted proxy header) | `RATE_LIMIT_MESSAGE_PER_IP` |
| `message_link_open` | 300 per link | `RATE_LIMIT_MESSAGE_OPEN_PER_LINK` |
| `message_link_send` | 30 per link | `RATE_LIMIT_MESSAGE_SEND_PER_LINK` |

One link serves a whole organization, often behind one office NAT, so the
buckets bound a flood rather than one person. `ops.alert_inputs` is unchanged:
the new buckets fall into its default threshold branch.

## Lifecycle

**Wired**

* retention class `employee_message`, 365 days, unapproved (P-004), removed by
  `ops.purge_employee_messages` from `runRetention` — time-based, so no
  tombstone is needed;
* tombstone class `MESSAGE_LINK` on every revocation (including the implicit
  one when a link is rotated); `reapplyTombstones` calls
  `core.reapply_message_link_revocation`, so a restore cannot reopen a closed
  channel;
* an **archived** organization's link stops resolving immediately. OrgFit has
  no organization hard-delete path; archiving is what "the client left" means,
  and the messages then age out on the retention class.

**Deliberately not wired**

* the anonymous store, `anonymous.purge_campaign` and `storeInconsistencies`:
  nothing here is campaign or anonymous data;
* per-message tombstones: no one can delete a single message;
* link rows are not purged: they hold a digest, a key version and staff ids,
  never message content;
* reading the inbox is not audited, as no other read surface is. Issuing and
  revoking a link are (`MESSAGE_LINK_ISSUED`, `MESSAGE_LINK_REVOKED`).

## What this does not guarantee

* It does not prevent a message from identifying its writer by what it says.
* It cannot prove who used a forwarded link, or stop someone outside the
  organization who holds it from writing.
* A consultant who already knows a department is tiny can guess; the schema
  cannot stop inference from content and department size.
* The received day, the department and the text are visible to every reader
  with `messages.read` on that organization.

## Tests

```bash
npm test                 # input bounds, catalogs, capability, stored columns
npm run test:messages    # real PostgreSQL: link, gateway, inbox, retention, restore replay
```
