# Step 3: storage buckets on AWS

Status: the template, the access table and the checker are ready and tested without AWS (D-166). **No AWS account, bucket or user exists yet.** The owner creates them. Claude never enters AWS keys anywhere.

## What gets created

One CloudFormation template, `deploy/aws/orgfit-storage.cfn.json`, creates everything in one step:

| Resource | Purpose |
|---|---|
| Files bucket (`<prefix>-files-<account>`) | Imports, link exports, participation exports, reports and visit attachments. One folder per kind. Private, versioned, encrypted, TLS-only. Files expire automatically after 1 day (attachments: 366 days) as a backstop to the database's own expiry. Deleted versions are gone after 1 more day. |
| Ledger bucket (`<prefix>-ledger-<account>`) | The tombstone ledger. **Object Lock in COMPLIANCE mode, 36 days**: no one can delete or change a ledger object for 36 days, not even the AWS root account. The operator is also explicitly denied any deletion or lock change. |
| 4 IAM users: `<prefix>-staff`, `-report`, `-scanner`, `-operator` | One identity per process, each allowed only what that process does (`src/storage-access.ts`). The processor and respondent get no storage access at all. |

OrgFit already encrypts every file with its own keys before upload, so the buckets only ever hold ciphertext.

**Cost:** a few cents a month at staging volumes. IAM and CloudFormation are free.

## Steps (owner)

1. **Create or sign in to an AWS account.** Turn on MFA for the root user.
2. **Pick the region Asia Pacific (Tokyo), `ap-northeast-1`.** It is next to the core database and the Vercel functions (`hnd1`).
3. **Create the stack:**
   - Go to **CloudFormation → Create stack → With new resources**.
   - Choose **Upload a template file** and select `deploy/aws/orgfit-storage.cfn.json`.
   - Stack name: `orgfit-staging-storage`.
   - `NamePrefix`: `orgfit-staging`.
   - Tick **"I acknowledge that AWS CloudFormation might create IAM resources with custom names"**, then **Submit**.
   - Wait for **CREATE_COMPLETE**. The **Outputs** tab shows the two bucket names.
4. **Create one access key per user.** For each of the four users:
   - Go to **IAM → Users → the user → Security credentials → Create access key**.
   - Choose **"Application running outside AWS"**.
   - Copy the key id and secret. The secret is shown only once.
5. **Fill in the git-ignored settings files.** They already contain empty lines for this:

   | File | Keys from | Fill in |
   |---|---|---|
   | `.env.staging.staff` | `-staff` user | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`; all five `*_S3_BUCKET` = **FilesBucketName** |
   | `.env.staging.report` | `-report` user | the key pair; `REPORT_S3_BUCKET` = **FilesBucketName** |
   | `.env.staging.scanner` | `-scanner` user | the key pair; `ATTACHMENT_S3_BUCKET` = **FilesBucketName** |
   | `.env.staging.operator` | `-operator` user | the key pair; `ATTACHMENT_S3_BUCKET` = **FilesBucketName**; `TOMBSTONE_LEDGER_S3_BUCKET` = **LedgerBucketName** |

   `AWS_REGION=ap-northeast-1` and `TOMBSTONE_LEDGER_OBJECT_LOCK_DAYS=36` are already set. Never put one user's key in another process's file.
6. **Run the checker:**

   ```
   npm run storage:check -- --staff .env.staging.staff --report .env.staging.report --scanner .env.staging.scanner --operator .env.staging.operator
   ```

   It tries every identity on every folder and expects each attempt to be allowed or denied exactly as `src/storage-access.ts` says. It catches a permission that is missing and one that is too broad. Every line must say `PASS`.

   Side effects: a few tiny check objects under a fixed fake organization id, removed by the lifecycle rules. Nothing is written to the ledger.
7. **In Vercel**, give each project the same variables as its staging file: staff, and the report, scanner and operator job projects. Drop every `*_LOCAL_DIRECTORY` and `TOMBSTONE_LEDGER_DIRECTORY`, because a bucket replaces them.

## Know before you click

- **COMPLIANCE lock is irreversible.** Each ledger object stays for at least 36 days, and the ledger bucket cannot be deleted while it holds one. That is the point: a restore can never resurrect deleted data.
- **Access keys are long-lived.** Rotate them by creating a new key, updating the file and Vercel, then deleting the old key. A later upgrade can replace them with Vercel's OIDC federation to an AWS role (needs `@vercel/functions`, an owner decision).
- **Not verified yet:** everything here is checked by tests against the template and an in-memory fake. Only `storage:check` against the real buckets, and then a real `tombstones:ship` run, prove the AWS side.
