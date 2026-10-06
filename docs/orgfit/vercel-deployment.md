# Deploying OrgFit on Vercel

Status: steps 1–2 of the Vercel plan (D-165) are implemented and tested locally. **Nothing has been deployed.** P-008 still authorizes no production deployment. The owner creates the Vercel projects and enters every secret. This guide names variables only, never values.

## The six Vercel projects

All six are made from the same Git repository. Each one holds **only** its own process's variables (`deploy/processes.json`). A project holding another process's credential is refused at runtime.

| Vercel project | Root Directory | What it runs | Cron |
|---|---|---|---|
| `orgfit-staff` | `apps/staff` | Staff website | — |
| `orgfit-respondent` | `apps/respondent` | Respondent website (the privacy gateway) | — |
| `orgfit-jobs-processor` | `apps/jobs` | `privacy:process`, `publication:release` | `apps/jobs/vercel.json` |
| `orgfit-jobs-report` | `apps/jobs` | `reports:generate`, `reports:expire` | same file |
| `orgfit-jobs-scanner` | `apps/jobs` | `attachments:scan`, `attachments:expire` | same file |
| `orgfit-jobs-operator` | `apps/jobs` | `campaigns:normalize`, `tombstones:ship`, `ops:check`, `drafts:expire`, `retention:run` | same file |

Settings for every project:
- **Framework:** Next.js.
- **Node.js:** 24.x (`package.json` engines).
- **Include files outside the Root Directory:** on. The apps import `src/`, `scripts/` and `deploy/`.
- **Region:** `hnd1` (Tokyo), set in each app's `vercel.json`, beside the core Supabase database (`ap-northeast-1`). The anonymous database is in `ap-south-1`.
- **NODE_ENV:** do not set it. Vercel runs with `production`, so every production guard applies.
- **Plan:** Vercel **Pro**. The jobs need per-minute crons and functions up to 800 s, and Hobby allows daily crons only.

## Database URLs on Vercel

Use the same URLs as `.env.staging.*`, with one change. Replace the local certificate path with the copy in the repository:

```
sslrootcert=../../deploy/certs/supabase-root-2021-ca.crt
```

Every app runs from its own folder, and `outputFileTracingIncludes` in each `next.config.ts` puts `deploy/certs/` into the build. Each URL keeps the plain role name, `options=reference=<project-ref>` and `sslmode=verify-full` (D-164).

## Variables per project

**`orgfit-staff`**
- `STAFF_ORIGIN`, `RESPONDENT_ORIGIN`: two different hostnames.
- `DATABASE_URL` (orgfit_staff), `AUTH_DATABASE_URL` (orgfit_auth).
- `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_MFA_ACR`: step 4, not chosen yet (P-005).
- `IMPORT_ENCRYPTION_KEY`, `LINK_EXPORT_ENCRYPTION_KEY`, `REPORT_ENCRYPTION_KEY`, `PARTICIPATION_EXPORT_ENCRYPTION_KEY`, `ATTACHMENT_ENCRYPTION_KEY`, `INVITATION_DIGEST_KEY`, `INVITATION_DIGEST_KEY_VERSION`.
- `CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY`, and managed custody: step 5 (P-003).
- `IMPORT_S3_BUCKET`, `LINK_EXPORT_S3_BUCKET`, `REPORT_S3_BUCKET`, `PARTICIPATION_EXPORT_S3_BUCKET`, `ATTACHMENT_S3_BUCKET`, `AWS_REGION`, and the `-staff` IAM user's `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`: step 3, `docs/orgfit/aws-storage-setup.md`.
- `RATE_LIMIT_CLIENT_IP_HEADER=x-real-ip` and `RATE_LIMIT_TRUSTED_PROXY_HOPS=0`. Vercel sets this header itself.
- `NEXT_TELEMETRY_DISABLED=1`.

**`orgfit-respondent`**
- `RESPONDENT_ORIGIN`.
- `GATEWAY_DATABASE_URL` (orgfit_gateway).
- `INVITATION_DIGEST_KEY`, `INVITATION_DIGEST_KEY_VERSION`: the same values as staff.
- `RATE_LIMIT_CLIENT_IP_HEADER=x-real-ip`, `RATE_LIMIT_TRUSTED_PROXY_HOPS=0`, `NEXT_TELEMETRY_DISABLED=1`.

**All four job projects:** `ORGFIT_JOB_PROCESS` (`processor`, `report`, `scanner` or `operator`) and `CRON_SECRET` (at least 32 characters, different per project). Vercel sends the secret with every cron call, and the route refuses anything else with 401. Then each project adds its own variables:
- **processor:** `PROCESSOR_DATABASE_URL`, `ANONYMOUS_DATABASE_URL`, and managed custody (step 5).
- **report:** `REPORT_DATABASE_URL`, `REPORT_ENCRYPTION_KEY`, `REPORT_S3_BUCKET`, `AWS_REGION`, and the `-report` user's key pair.
- **scanner:** `SCANNER_DATABASE_URL`, `ATTACHMENT_ENCRYPTION_KEY`, `ATTACHMENT_S3_BUCKET`, `AWS_REGION`, `ATTACHMENT_SCAN_ENGINE=clamd`, `ATTACHMENT_SCAN_CLAMD_ADDRESS` (step 6), and the `-scanner` user's key pair.
- **operator:** `MIGRATION_DATABASE_URL`, `ANONYMOUS_MIGRATION_DATABASE_URL`, `TOMBSTONE_LEDGER_S3_BUCKET`, `TOMBSTONE_LEDGER_OBJECT_LOCK_DAYS` (≥ 36), `ATTACHMENT_S3_BUCKET`, `AWS_REGION`, and the `-operator` user's key pair.

**Never in any Vercel project:**
- `CAMPAIGN_KEY_CUSTODY_SECRET_KEY` (development stand-in).
- `CAMPAIGN_KEY_CUSTODY_REHEARSAL_ONLY`.
- `BOOTSTRAP_ADMIN_PASSWORD`.
- Any `*_LOCAL_DIRECTORY` or `TOMBSTONE_LEDGER_DIRECTORY`: Vercel's disk does not persist.
- Another project's database URL or AWS key pair.

Migrations are not a Vercel job. Run them from the operator machine (`npm run db:migrate`, `npm run db:migrate-anonymous`) before each release.

## How the jobs run

`apps/jobs/app/api/cron/[tick]/route.ts` receives the six ticks listed in `apps/jobs/vercel.json`. It runs this project's jobs for that tick through `executeJob` (`src/job-run.ts`), which is the same path the command line and the supervisor use. Foreign credentials are refused first, and each outcome is recorded in `ops.job_run` under the job's own login.

Cadences come from `deploy/processes.json` → `schedule` (`src/vercel-cron.ts`; `tests/vercel-jobs.test.ts` fails if either side drifts). The processor's collection jobs run two minutes after the operator's campaign close, on the `every-5-minutes-after` tick. Overlapping runs are safe: work is claimed with `FOR UPDATE SKIP LOCKED` or a lease, and normalization takes an advisory lock.

## Known limits

- **Function duration.** Functions stop at 800 s. The manifest allows `privacy:process` 1800 s and `retention:run` 3600 s. A run that is cut off records no success, and `ops:check` raises it as stale. Large campaigns need load evidence before launch.
- **Report PDFs.** `reports:generate` launches Chromium through Playwright (`src/report-pdf.ts`), and Vercel functions include no browser. The job works and records its outcome, but rendering a PDF will fail on Vercel until a serverless Chromium is added or rendering moves to another host. This needs an owner decision.
- **Malware scanning.** `attachments:scan` needs a ClamAV daemon (P-010), which Vercel cannot host.
- **Recording timeout.** The job-status recorder allows a 3 s connection (`src/job-run.ts`). From a distant machine through the pooler this can expire; from `hnd1` it is expected to fit.
- **Not verified, because nothing was deployed:**
  - Vercel's install step for npm workspaces.
  - Function working directory and certificate path at runtime: verified locally with the same layout, not on Vercel.
  - Cron delivery.

  Check each on the first deploy with `/health/ready` and one manual cron run.

## Verified locally (2026-10-06)

The built jobs app was run with `next start` (`NODE_ENV=production`, as on Vercel) once per process, against the Supabase staging databases, using the relative certificate path:
- **Cron protection:** no secret or a wrong secret → 401, unknown tick → 404.
- **Jobs that ran:** `campaigns:normalize`, `drafts:expire`, `publication:release`, `reports:generate`.
- **Correct production refusals:**
  - `privacy:process` → `KEY_CUSTODY_PROVIDER_REQUIRED` (P-003).
  - `attachments:scan` → `SCAN_ENGINE_REQUIRED` (P-010).
  - `tombstones:ship` → `TOMBSTONE_LEDGER_LOCAL_IN_PRODUCTION`.
  - `reports:expire` and `attachments:expire` → local storage (step 3).
- **`ops:check`:** exit 2, reporting the critical alerts that exist.
