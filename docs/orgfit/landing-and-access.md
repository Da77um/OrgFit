# Overview page, staff sign-in, invitation activation and the development administrator

This records what was built for the owner's request of 2026-09-11/13: a public overview page in the existing brand, an email/password staff sign-in, invitation-only account activation, and one seeded local Super Admin. Decisions are D-100 … D-106 in [decisions.md](decisions.md); evidence is in [phase-status.md](phase-status.md). It is **not** Phase 13 and is not a production authentication design.

## Routes

| Route | Session | What it is |
|---|---|---|
| `/` | none | Public overview page (was the workspace home). Reads no database and no configuration. |
| `/workspace` | required | The workspace home, moved unchanged from `/`. Every internal link, the app-bar lockup and the OIDC callback now point here. |
| `/login` | none | Email/password form when the local access switch is on; the identity-provider button whenever OIDC is configured; a signed-in visitor is sent to `/workspace`. `?expired=1` shows the ended-session message. |
| `/activate#<token>` | none | Invitation-only activation. The token is in the **fragment**, as the respondent link is, so it is never sent to the server as part of a page request or written to an access log. |
| `POST /api/v1/auth/password` | none | Sign-in. Same-origin + JSON checks. 401 one generic reply, 429 locked, 503 unavailable. |
| `POST /api/v1/auth/invitation` | none | Inspect a token: `VALID` (with address and role), `EXPIRED`, `CONSUMED`, `REVOKED`, `INVALID`. |
| `POST /api/v1/auth/activate` | none | `{token, displayName, password}` only. Policy re-checked on the server. |
| `GET/POST /api/v1/staff/invitations`, `POST …/:id/revoke` | Super Admin | Issue (returns the activation URL **once**), list, withdraw. Nothing is sent anywhere. |

Protected pages and every other API keep their own authorization (`withStaff` → `access.actor()`); the public page takes part in none of it. Respondent routes on the survey origin are untouched.

## The local access path and its switch

Migration `016_local_access.sql` adds `access.local_access_setting`, **created empty**. While it holds no enabled row:

- `access.password_challenge` returns no credential, `issue_password_session` refuses, `inspect_invitation`/`accept_invitation` answer `INVALID`, `create_invitation` is `FORBIDDEN`;
- `access.actor()` rejects any `PASSWORD` session, so one that already exists authorizes nothing (test A-7);
- `/login` does not render the password form.

Only `scripts/bootstrap-dev-admin.ts` writes the enabled row, and it refuses `NODE_ENV=production` and any non-loopback database host.

Local accounts use the reserved issuer `urn:orgfit:local-password` and a generated subject, so an identity-provider subject can never gain a password and a local account can never sign in through OIDC. Sessions now record `auth_method`; a password session is stored honestly as `mfa_verified = false`, and the CHECK was relaxed for that one value only. The account's `mfa_required` flag is unchanged. **A password session has satisfied no second factor. That is why the path is development-only.**

Credentials: Node's built-in scrypt (N=2^15, r=8, p=1, 16-byte salt, 64-byte key, `timingSafeEqual`), stored as a self-describing `$scrypt$…` string that a CHECK constraint enforces. An unknown address still pays the key-derivation cost and gets the same reply as a wrong password. Five failures within 15 minutes lock the **address** (stored as a digest) for 15 minutes, whether or not it belongs to anyone.

Password policy (`src/password-policy.ts`, one definition shared by form, API and bootstrap): at least 8 characters, a letter and a digit. This is a development baseline, not a claim about real staff credentials.

## Invitations

An invitation row carries the address, role, capabilities, organizations, locale and expiry (1–168 h, default 72) chosen by the issuing Super Admin. Activation reads all of these **from the row**; the request can carry only a display name and a password. Single use is a row lock plus a `consumed_at` test in one transaction; two simultaneous activations give one `ACTIVATED` and one `CONSUMED` (test A-6). An address that already has an account cannot be invited. Activation does not sign the person in.

There is no admin *screen* for issuing invitations yet — only the API. That is recorded as remaining work.

## Development administrator bootstrap

```sh
cp .env.bootstrap.example .env.bootstrap      # git ignores .env.*
# edit .env.bootstrap: DEV_ADMIN_DATABASE_URL (loopback cluster admin), DEV_ROLE_PASSWORD,
# BOOTSTRAP_ADMIN_EMAIL / _PASSWORD / _NAME
node --env-file=.env.bootstrap --import tsx scripts/provision-dev.ts
# put the migration URL from work/dev-environment.json into MIGRATION_DATABASE_URL
node --env-file=.env.bootstrap --import tsx scripts/bootstrap-dev-admin.ts
```

`provision-dev.ts` creates (never drops) a persistent `orgfit_dev` and `orgfit_dev_anonymous` on a loopback cluster, applies every migration and writes connection strings to the ignored `work/dev-environment.json`. Point `apps/staff/.env.development.local` (ignored) at the staff and auth URLs.

The bootstrap outcome is one of: **created**; **already present** (nothing changed, password not reset — even when a different password is supplied); **mismatch** (the address exists but is an identity-provider account, has no local credential, is not `SUPER_ADMIN`, or is not active — reported, never converted or elevated); **policy conflict** (reported, policy not relaxed). It prints no credential.

**Environment limitation:** the test harness (`tests/database.ts`) resets the LOGIN role passwords on the cluster it uses. When the development database shares that cluster, rerun `provision-dev.ts` with the same `DEV_ROLE_PASSWORD` after a test run to restore the development connections. The accounts themselves are unaffected.

## Overview page content rules

Copy lives in `src/landing-i18n.ts` (Arabic written first, complete English). It may describe only implemented modules, may not overclaim privacy (separation of participation from answers, aggregate-only reading, a five-contributor threshold with complementary suppression, and an explicit statement that this is **not** a guarantee of anonymity and that cross-round inference is documented and under independent review), and contains no customers, logos, testimonials, statistics, certifications, pricing, trials or contact details. Every figure is drawn SVG with invented numbers and is labelled synthetic. The footer links only to in-page sections and `/login`, because no privacy, help or contact page exists.

## Tests

- `npm run test:access` — A-0 … A-7 against a real database: hash/policy, switch off, bootstrap refusals, idempotence and mismatch, generic rejection and session labelling, lockout, invitation lifecycle and role binding and race, switch-off kill.
- `npx playwright test tests/browser/access.spec.ts` — overview page AR/EN, anchors and links, synthetic labels, FAQ, 320/375/768 overflow on `/`, `/login`, `/activate`, mobile menu and Escape focus return; sign-in validation, reveal toggle, generic error for wrong password and unknown address, 429 screen (response stubbed), success, logout, stale-session redirect; activation missing/invalid/valid/reused/expired and the activated account's scope.
