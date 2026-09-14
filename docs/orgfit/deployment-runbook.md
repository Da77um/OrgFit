# Deployment runbook (Phase 15)

2026-09-14. **Nothing in this runbook has been executed against a real environment.** No hosting provider, region, domain, identity provider, bucket or key service has been chosen (P-002, P-003, P-005), and no deployment is authorized (P-008). Every step below was rehearsed only on one machine by `tests/release/rehearsal.ts` — production builds, `NODE_ENV=production`, TLS, a TLS-only PostgreSQL 18 cluster with `sslmode=verify-full`, a local S3-compatible test double and the synthetic OIDC provider. Steps that the rehearsal could not exercise are marked **UNREHEARSED**.

Companion documents: [release-checklist.md](release-checklist.md) (go/no-go items), [retention-backup-runbook.md](retention-backup-runbook.md) (backups and restore), [incident-runbook.md](incident-runbook.md), [staff-operations-guide.md](staff-operations-guide.md).

## 1. What is deployed

One commit of this repository, identified by a release manifest (`npm run release:manifest`). The manifest records the commit, a digest of every tracked non-documentation file, the lockfile, the process manifest, `db/roles.sql` and every migration digest. `npm run release:manifest -- --verify <manifest>` refuses a checkout that differs from the tested one.

Build once, in a clean checkout:

```bash
git clone <repository> orgfit && cd orgfit && git checkout <release commit>
```

```bash
npm ci
```

```bash
npm run build
```

```bash
npx playwright install chromium
```

The Chromium build is needed only by the report renderer process. Node 24 and PostgreSQL 18 are required (`deploy/processes.json` → `runtime`).

## 2. Process topology

[`deploy/processes.json`](../../deploy/processes.json) is authoritative. Each process runs with **only** its own environment and database identity; holding another process's credential is refused both by the process itself and by preflight.

| Process | Runs | Database identity | Holds | Must never hold |
|---|---|---|---|---|
| staff | `npm run start -w @orgfit/staff` (web) | `orgfit_staff`, `orgfit_auth` | OIDC client, import/link/report/participation/attachment keys, digest key, custody **public** key | gateway, processor, renderer, scanner, operator credentials; custody secret |
| respondent | `npm run start -w @orgfit/respondent` (web, separate host) | `orgfit_gateway` | digest key (and the previous key during a rotation window) | every other credential and key |
| processor | `privacy:process`, `publication:release` (jobs) | `orgfit_processor` on both databases | custody **secret** key | staff/gateway/operator credentials, digest key, file keys |
| report | `reports:generate`, `reports:expire` | `orgfit_report` | report key | everything else |
| scanner | `attachments:scan`, `attachments:expire` | `orgfit_scanner` | attachment key | everything else |
| operator | migrations, `campaigns:normalize`, `drafts:expire`, `retention:run`, `tombstones:ship`, `ops:check`, `restore:reapply` | `orgfit_migrator`, `orgfit_anon_migrator` | tombstone ledger location | web credentials, custody secret |

The anonymous database accepts connections only from `orgfit_anon_migrator` and `orgfit_processor`.

### Network (UNREHEARSED beyond one host)

- Staff and respondent on **different hostnames**, each behind a TLS-terminating proxy that **overwrites** `X-Forwarded-For` (then set `RATE_LIMIT_CLIENT_IP_HEADER=x-forwarded-for` on the respondent process; SEC-M2).
- The proxy must not log request bodies, cookies or query strings. Survey links carry the token in the URL fragment, which browsers never send.
- Staff-side rate limiting (OIDC start/callback, staff API) belongs at the proxy (SEC-M1).
- Databases reachable only from their processes, with TLS certificates the processes verify (`sslmode=verify-full`, `sslrootcert` where a private CA is used).
- Only the processor reaches the key custody store.

## 3. Environment

Templates: `.env.example` (web processes), `.env.operator.example` (jobs). Keys are 64 lowercase hex characters from 32 random bytes, **each different**. Production requires:

- `NODE_ENV=production`; https origins; `OIDC_ISSUER` https;
- every database URL with `sslmode=verify-full`;
- a private **bucket** for imports, link exports, reports, participation exports and attachments (`*_S3_BUCKET`, plus `*_S3_ENDPOINT` for a non-AWS store). Local directories are refused in production. Lifecycle rules: 1 day on `imports/`, `link-exports/`, `reports/`, `participation-exports/`; the attachment retention window on `attachments/` (UNREHEARSED — the rehearsal used a test double without lifecycle or policies);
- credentials for the bucket from the platform's standard credential provider, never in a file.

Store every value in the platform's secret manager (UNREHEARSED). Then, **for every process**, before first start and after every change:

```bash
npm run release:preflight -- --process staff --env-file /secure/staff.env --production --check-database
```

Preflight prints names and outcomes only, never a value, and exits 1 on any failure. It checks required and forbidden variables, placeholder values, key format and reuse, database identities and TLS, origins, storage, cluster privileges of each credential, the server logging settings (SEC-M4), and for the operator the migration ledgers, restore state, retention approval and the development password switch. Expected warnings until the production inputs exist: `key-custody` (P-003), `retention-approval` (P-004).

## 4. First installation

1. **Provision PostgreSQL 18** with TLS and the logging settings in retention-backup-runbook §2. Create the two databases `orgfit` and `orgfit_anonymous` (names are free; keep them separate) and run `db/roles.sql` as the cluster administrator. Set a distinct password per login role. Grant exactly as `tests/release/rehearsal.ts` §3 does: `REVOKE ALL ... FROM PUBLIC`; `CONNECT` on `orgfit` to migrator, staff, auth, gateway, processor, report, scanner; `CONNECT` on `orgfit_anonymous` to anonymous migrator and processor; `CREATE` on each database and `CREATE, USAGE` on its `public` schema to its owner role.
2. **Migrate** with the operator environment:

   ```bash
   npm run db:migrate
   ```

   ```bash
   npm run db:migrate-anonymous
   ```

3. **Bootstrap the first Super Admin** from the approved identity provider subject (P-005). It refuses to run if any staff member exists.

   ```bash
   npm run db:bootstrap
   ```

4. Do **not** run `db:seed`, `db:provision-dev`, `db:bootstrap-dev-admin` or `showcase` in any shared environment. `instruments:seed` installs illustrative templates only (P-006).
5. **Key custody**: generate the custodian key pair once per environment (`.env.example` shows the command). The public half goes to staff; the secret half only to the processor. The file-directory custody adapter is a development stand-in (P-003, SEC-H1) — a managed key service must replace it before real data.
6. **Preflight** all six processes (§3), then start respondent and staff, then start the job supervisor (§9) or the provider's scheduler with the cadences from `deploy/processes.json` → `schedule`.
7. **Health**: `GET /health/live` (process up) and `GET /health/ready` on both hosts must return 200 before traffic is routed. Readiness fails closed on a missing configuration, a misgranted database role or a pending restore.
8. **Smoke** (§6).

## 5. Upgrading an existing installation

Migrations are forward-only and checksum-pinned: an edited migration file stops the migrator. A release that adds migrations cannot be rolled back by redeploying the previous build alone (§7).

1. Verify the candidate: `npm run release:manifest -- --verify <manifest>`.
2. **Take a backup** of both databases and confirm WAL archiving is current; ship tombstones (`npm run tombstones:ship`).
3. Stop the jobs (`npm run jobs:supervise -- --stop --state-dir <dir>`, or the provider's scheduler). Web processes may stay up for additive migrations; if the release notes say otherwise, drain them.
4. Run `db:migrate` and `db:migrate-anonymous`.
5. Preflight the operator process with `--check-database` — the ledgers must equal the release's migrations.
6. Deploy the new web builds, then restart the jobs.
7. Smoke (§6) and `npm run ops:check`.

The candidate `orgfit-0.3.0-rc.1` adds **no migration** over Phase 14 (`b8d1bab`). Over the Checkpoint F schema (`59c99e3`) it adds core 017, 018 and anonymous 002; that upgrade was exercised on a database populated by the Checkpoint F code itself (`tests/release-upgrade.test.ts`).

## 6. Post-deployment smoke

Performed by a Super Admin with a **synthetic** organization, never real people:

1. Both `/health/ready` return 200 over https.
2. Sign in through the identity provider with MFA; the session cookie is `__Host-`, `Secure`, `HttpOnly`.
3. Create an organization with six synthetic participants; launch a campaign on a published illustrative questionnaire; issue six links.
4. Submit all six from a phone-sized browser in Arabic; reopen one link — it reports the answers as received.
5. Close; after the processor and publication jobs run, results appear; request an Arabic PDF and download it.
6. Record a visit with a PDF attachment; it downloads only after the scanner marks it clean.
7. `npm run ops:check` exits 0 (warnings for unapproved retention are expected until P-004).
8. Archive the synthetic organization.

## 7. Rollback

| Situation | Action |
|---|---|
| The new build misbehaves and the release added **no migration** | Redeploy the previous build. The schema is identical; preflight on the operator confirms the ledgers still match. |
| The release **added migrations** | Do not run the old build against the new schema: preflight reports `applied but not in this release` and must be treated as a stop. Fix forward, or restore both databases to the pre-upgrade backup (retention-backup-runbook §3) and then redeploy the previous build. |
| Data corruption or loss | Restore per retention-backup-runbook §3 — isolate, `restore:reapply -- --mark`, restore, `restore:reapply`, `privacy:process`, `ops:check`, then route traffic. |

What a rollback or restore **cannot** do, demonstrated by `tests/ops/rollback-drill.ts` on real physical restores:

- **reopen a consumed invitation** — an invitation accepted before the restore point stays accepted and adds no submission;
- **duplicate an accepted submission** — a submission lost with the restore point makes its invitation usable exactly once more; the processor refuses a campaign whose anonymous output disagrees with the core (`MARKER_MISMATCH`) rather than appending;
- **lose committed intake silently** — intake erased after its output was committed to an anonymous store the restore no longer has is an incident that keeps both readinesses closed; the two stores restored to different points are reported in both directions by the replay and by `ops:check` (`ANONYMOUS_STORE_INCONSISTENT`);
- **expose expired data** — a deletion shipped to the tombstone ledger is replayed before opening, and anything whose expiry time passed is expired again by the retention pass inside the replay.

The limit that remains: a deletion made **after the last tombstone ship** is not in the ledger and can be revived by a restore until its own expiry (SEC-M3). Ship tombstones at least as often as the backup RPO.

## 8. After a failed deployment

If a readiness endpoint stays 503: run preflight for that process with `--check-database` — it names the failing check without printing a value. A web process refuses to start its data paths when it finds a foreign credential; remove the variable rather than widening the manifest.
## 9. Scheduled jobs under supervision (Post-Audit Repair Pass 3)

**Rehearsed locally only** (`tests/supervisor.test.ts`, one Windows machine, loopback PostgreSQL 18, local directories instead of buckets, no TLS). Nothing below has run on a provider, and no operating-system service was installed.

The jobs of `deploy/processes.json` → `schedule` run under a supervisor that holds **no database credential and no key**:

```bash
npm run jobs:supervise -- --env-dir /secure/orgfit-jobs --state-dir /var/lib/orgfit-supervisor
```

- `/secure/orgfit-jobs` holds exactly `processor.env`, `report.env`, `scanner.env` and `operator.env` — the same files release preflight validates (§3). The supervisor validates each with the preflight rules and refuses to start on any FAIL, printing check names only. Each job starts as `node --env-file=<that file> --import tsx <script>`; no job receives another process's file.
- The supervisor's own environment may hold only alert settings (`ALERT_SINK`, `ALERT_FILE`, `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_TOKEN`, `ALERT_DELIVERY_ENABLED`, `ALERT_REPEAT_SECONDS`). It refuses to start if it finds a database URL, an encryption or digest key, the custody secret or the OIDC client secret.
- Order: `campaigns:normalize → privacy:process → publication:release` every 5 minutes as one group; reports and attachment scans every minute; expiries hourly; retention daily; tombstone shipping every 5 minutes; `ops:check` every 2 minutes.
- Safety: no job overlaps itself; one supervisor per state directory (lock file); failed jobs retry after 15 s, 30 s, 60 s, then return to their cadence and are reported `FAILING`; a job past its timeout is terminated; the routines underneath are overlap-safe even if two supervisors were started by mistake.
- Status: `npm run jobs:supervise -- --status --state-dir <dir>` prints `status.json` (last start/success/failure, reason, exit code, duration, consecutive failures, next run). The database view — last success per job and the backlog each drains — is on the Super Admin **Settings** screen and in `ops:check`.
- Stop: Ctrl+C (SIGINT), SIGTERM, or `npm run jobs:supervise -- --stop --state-dir <dir>`. Running jobs get 30 s, then are interrupted and recorded `INTERRUPTED`.
- Output: job stdout (identifiers, counts, codes) is forwarded; job stderr is counted and suppressed. Use `--show-stderr` only interactively on a machine whose terminal output is not collected.

**Provider wiring still required (P-002, RC-003):** run exactly one supervisor per environment under the platform's process manager with automatic restart; place the four environment files in the platform's secret manager (mounted read-only, owner-only) instead of a directory; persist the state directory; send the supervisor's stdout to the log pipeline; alternatively replace the supervisor with the platform's own scheduler reading the same `schedule` section, preserving per-process secrets, the group order and single-instance execution. On Linux, a killed supervisor's jobs keep running and the next supervisor waits for them; on Windows they end with it — both were exercised.

**Alert delivery (SEC-L3, D11):** `ALERT_SINK=none` is the default. `file` writes JSON lines for a local agent; `webhook` requires `ALERT_DELIVERY_ENABLED=true` and an https URL. No destination, credential or paging rota has been provided; nothing has been sent to an external service. Before production: choose the destination, store its token in the supervisor's secret, and drill a critical alert end to end.

## 10. Runtime guards that no longer depend on preflight

The processor, publication, operator, migration, restore and revocation entry points now refuse, before connecting: a production database URL without `sslmode=verify-full` (or with TLS verification disabled), a wrong login, a placeholder password, and any variable the manifest forbids for their process (RC-004 closed in code; D-151). Preflight is still required: it checks cluster privileges, logging settings, ledgers, storage and more than a single process can see.
