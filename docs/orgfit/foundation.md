# Phase 02 foundation

This is the internal staff foundation. It contains no questionnaire, campaign, survey collection, analytics or visits implementation. See [phase-status.md](phase-status.md) for executed evidence and production gaps.

## Runtime and boundaries

- Node 24; Next.js 16.3.4; React/React DOM 19.2.8; TypeScript 6.0.3; Kysely 0.29.5; pg 8.23.0; openid-client 6.8.8; Zod 4.5.4. Exact direct and transitive versions are in `package-lock.json`.
- `apps/staff` serves internal pages and `/api/v1`. `apps/respondent` is a separate build/process with only an unavailable entry page, `/s`, and liveness. It imports presentation catalogs/theme/CSP only. It receives no staff, auth, migration, anonymous or processor credentials.
- Use different **hostnames**, not merely different ports: cookies are not port scoped. Local examples use staff `127.0.0.1:3000`, respondent `localhost:3001`. HTTPS, host-only `__Host-` cookies and verified database TLS are mandatory in production; local HTTP uses explicitly named development cookies only.
- `orgfit_staff` can read RLS-filtered organization identity and execute guarded staff functions. `orgfit_auth` can execute only OIDC-flow/session-issuance routines. `orgfit_migrator` may set the NOLOGIN owner role. Runtime roles cannot inherit either owner or executor; readiness checks reject that misconfiguration. The NOLOGIN executor owns fixed-search-path, non-dynamic SECURITY DEFINER routines and has narrow grants. Every foundation domain table has ENABLE/FORCE RLS.
- RLS resolves current identity from a 256-bit session credential's SHA-256 digest. Transaction-local digest context is set inside `withStaff`, and the database validates active membership, epoch, MFA, revocation and database-clock expiry. Caller-supplied actor UUIDs never authorize a request. Organization access and capabilities are checked from current persisted rows, including the SQL policy on organization reads.
- Migration 001 creates access, organization-boundary and sanitized audit infrastructure. Migration 002 revokes sessions for membership/status/role/issuer/subject/epoch changes, including trusted operator changes. Re-enabling an account cannot restore a prior session. Bootstrap and staff administration serialize on the same advisory lock; a last active Super Admin cannot be disabled/demoted through the staff service.
- No file or job feature needs storage/queue access in this phase. No in-memory queue, public bucket, fake storage implementation or universal worker is introduced. D-015 remains the approved pg-boss/private S3 adapter direction. Implement concrete adapters and their scoped job/run/download checks with the first owning module (imports in Phase 03); privacy queues remain a later separate credential boundary.

## Operator setup

1. Install Node 24 and PostgreSQL 18 (use the current supported patch). Run `npm ci` in the repository.
2. In a **dedicated cluster**, a database administrator applies `db/roles.sql` once. This deliberately refuses repeated role creation; inspect existing roles before applying it to any established cluster. Set each LOGIN password separately through the operator's secret manager or `psql`'s `\password`; there are no committed usable passwords.
3. Create the core database. Revoke PUBLIC CONNECT/TEMP and grant CONNECT only to the three foundation logins. Grant CREATE on that database and CREATE/USAGE on its `public` schema to `orgfit_core_owner` for migration setup. Revoke public schema CREATE. The migration then revokes all PUBLIC schema access. Never give runtime roles ownership, BYPASSRLS, SUPERUSER, or owner/executor membership. Do not grant staff/auth CONNECT to any future anonymous database. Network policy and anonymous-database provisioning remain later deployment work.
4. Copy `.env.operator.example` to ignored `.env.operator`. Supply the migration connection and the **exact approved existing provider issuer/subject**, email and name for the first admin. Run:

   ```sh
   node --env-file=.env.operator --import tsx scripts/migrate.ts
   node --env-file=.env.operator --import tsx scripts/bootstrap.ts
   ```

   Bootstrap creates one active Super Admin, only when no staff exist. It generates no password, sends no email and cannot be used to replace existing staff. Subsequent staff provisioning/access edits use the authenticated Super Admin APIs. An established installation needs a separately reviewed operator recovery action, not a repeated bootstrap.
5. Copy `.env.example` to ignored `apps/staff/.env.local` and populate staff/auth DB connections and OIDC configuration. **Do not copy the operator variables into that file or process.** Register exactly `STAFF_ORIGIN/api/v1/auth/callback` with the provider. Require MFA and configure `OIDC_MFA_ACR` to exact provider-approved ACR values (comma separated if necessary). Never infer MFA from an email domain or ordinary password login. For production all web/issuer URLs must be HTTPS and database URLs must use `sslmode=verify-full`; install the appropriate trusted CA.
6. `npm run dev` starts staff; `npm run dev:respondent` starts the separate entry app. No real IdP is assumed configured by these instructions. `npm run build` builds both independently. This is not deployment authorization.

The synthetic OIDC provider in `tests/oidc-provider.ts` serves signed RS256 tokens, JWKS, discovery and a one-use PKCE code flow. It lives only in the test harness, binds loopback, and is absent from both production applications. Its explicit test-case choices are not staff login options. Production authentication requires P-005's actual provider/MFA review.

## Authentication and implemented API surface

`GET /api/v1/auth/start` and `callback` implement OIDC state, nonce, S256 PKCE, verified issuer/audience/expiry/authentication age, explicit asymmetric signature checks and an allowlisted MFA ACR. Only pre-provisioned ACTIVE subjects get a session. No registration route exists. OIDC secrets expire in five minutes and are consumed once, including failed callbacks. Session idle TTL is 30 minutes and absolute TTL 12 hours. No IdP access/refresh token is persisted. Sessions/expired flows are opportunistically pruned; periodic retention belongs to Phase 14.

| Endpoint | Implemented authority/behavior |
|---|---|
| `GET /api/v1/profile`, `/home` | Current active session; safe own identity, role, locale, capabilities and assignments |
| `PATCH /api/v1/profile` | Own locale only, strict `{locale:"ar"|"en"}`; persists preference and host-only cookie |
| `POST /api/v1/locale` | Pre-login locale cookie only; no identity or access change |
| `POST /api/v1/auth/logout` | Revokes current persisted session and expires cookie |
| `GET /api/v1/organizations` | RLS-filtered identity list (foundation bound 100); no CRUD or result data |
| `GET /api/v1/organizations/:org/access` | Foundation capability probe: assigned org plus directory.manage; foreign org 404, missing capability 403 |
| `GET /api/v1/staff` | Super Admin safe list, bounded 100 |
| `POST /api/v1/staff` | Super Admin provisioning of an existing issuer/subject, strict input and UUID Idempotency-Key |
| `PATCH /api/v1/staff/:id` | Super Admin full access replacement `{role,status,capabilities,organizationIds}`; quoted numeric If-Match and UUID Idempotency-Key; immediate revocation |
| `GET /api/v1/audit` | Super Admin, latest 100 allowlisted audit records |
| `/health/live`, `/health/ready` | Coarse liveness / config+DB-role+schema readiness, no credentials or diagnostics |

Dedicated revoke-sessions HTTP endpoint, full staff editor screens and cursor pagination are not claimed implemented. A complete access replacement currently revokes sessions; the guarded SQL revoke routine also exists for future authorized integration. Own-locale preference is an idempotent metadata replacement without revision/idempotency headers. The general Phase 01 CRUD contracts apply when those remaining endpoints are implemented. Lists are foundation previews bounded at 100; Phase 03 must implement honest cursor pagination for its organization list rather than copying the preview response unchanged.

Cookie mutations require exact configured Origin, reject cross-site Fetch Metadata, and require JSON. Bodies are streamed with a 2 MiB limit; Zod rejects unknown fields and disallowed capabilities. All database inputs are parameterized. Exceptions become allowlisted localized error codes, never SQL, input echoes or stack traces. OIDC callback failures return generic 401. Production nonce CSP excludes unsafe-inline/eval; development eval is limited to Next's local development requirement. No third-party analytics, body logging, URL logging or error tracker is configured. The reverse proxy must independently disable sensitive URL/body/network metadata capture; application settings do not prove infrastructure logging safety.

Audit records currently use the narrowed `ops.audit_log` physical name: action enum, actor/target UUID, optional org, time and allowlisted field names. There are no freeform before/after bodies, respondent events or public correlation IDs. This is the Phase 02 implementation of the design's audit_event family; later extensions need deliberate schema evolution and retention policy. Application roles have no update/delete audit grant.

## Verification and continuity

```sh
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
npm run check:boundaries
npm run test:production
npm run test:e2e
npm audit --audit-level=high
```

Integration/browser tests require `TEST_ADMIN_DATABASE_URL` for a **dedicated loopback synthetic PostgreSQL cluster**. The harness creates randomly named `orgfit_test_*` databases, installs 001, seeds synthetic rows, upgrades to 002, then tests runtime logins. It never resets or drops a database. It changes the three test LOGIN passwords in that dedicated cluster; never aim it at an operator or production cluster. Run integration and browser suites sequentially. Generated fixture credentials and captures stay under ignored `work/`. Bootstrap has a separate empty-database test.

For Windows without Docker, Phase 02 downloaded the npm `@embedded-postgres/windows-x64` 18.4.0-beta.17 package into ignored `work/` and inspected its native `postgres --version`: **PostgreSQL 18.4** (not a prerelease server). `scripts/local-postgres.ps1` starts/stops that isolated cluster on 127.0.0.1:55432. Initialize with a generated random password in ignored `work/pg-password.txt`; do not print it. This is a test-only binary workaround, not a production version recommendation. CI specifies PostgreSQL 18.6 but remote CI has not run.

Migrations run in one transaction under an advisory lock, record SHA-256 checksums and refuse modified applied files. They never reset/drop data. Revert an unapplied migration during development if needed; once applied in a retained deployment, repair with a new forward migration. No destructive rollback script is supplied. Production restore, backup verification, network separation, readiness restriction, key custody, file/job authorization and A–G evidence remain explicitly unverified.

Arabic is default; staff English catalog is complete. Language persists across login/reload, root lang/dir changes, labels use logical layout and identifiers use bidi isolation. English organization titles fall back to Arabic with an Arabic boundary. Theme tokens are replaceable neutral development surfaces, not branding. The available respondent entry is Arabic only; respondent locale selection belongs with complete published instrument translations in its owning phase.
