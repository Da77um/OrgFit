# Real scoring on Vercel: campaign key custody (P-003) — proposal

2026-10-16. **Decided 2026-10-17: the owner chose option C, `database-sealed` (D-180), now implemented.** Options A and B below are not implemented. Option C was presented to the owner as: keep the sealed key in the core database, free, staff still cannot open it, but answers stay recoverable from backups for their retention. It answers Cause 4 of the questionnaire pipeline repair: real responses can never be scored on Vercel.

## 1. Why real scoring stops on Vercel today

- Vercel always runs with `NODE_ENV=production`. With no `CAMPAIGN_KEY_CUSTODY_PROVIDER`, `custodyProviderName()` (`src/key-custody.ts`) refuses with `KEY_CUSTODY_PROVIDER_REQUIRED`, and the only implemented provider, `development-file`, is refused in production too (`KEY_CUSTODY_DEVELOPMENT_IN_PRODUCTION`).
- **Campaign launch** (`src/campaigns.ts`, `launchCampaign`) calls `createCampaignKey()` inside the launch transaction. On Vercel it throws, so the launch rolls back: no link can be used.
- **`privacy:process`** (`src/processor.ts`) calls `openCampaignKey()` and, after the output is committed, `destroyCampaignKey()`. On Vercel it throws the same refusal (`docs/orgfit/vercel-deployment.md`).
- Even if those refusals were lifted, `development-file` writes sealed keys to a local directory. The staff project and the processor's job project are separate Vercel deployments with separate, short-lived filesystems, so the processor could never read a key that the staff launch wrote.

These refusals are correct and stay as they are. Neither option below sets `CAMPAIGN_KEY_CUSTODY_REHEARSAL_ONLY` on Vercel, fakes `NODE_ENV`, or lets `development-file` run in production.

## 2. The property every option must keep

The boundary is one-way today, and must stay one-way:

- The staff deployment holds only `CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY`. At launch it generates the campaign's X25519 key pair, protects the private half so that only the processor can recover it, and drops the plaintext. It can never read a campaign private key back.
- Only the processor deployment can recover a campaign private key, for one batch, in memory, and it zeroes the key afterwards.
- `src/config.ts` refuses to start the staff app if it finds the custodian secret.

A process compromised **at the moment of a launch** can take that one campaign's key. No design here prevents that; it is true today. The property is about every earlier campaign: a later compromise of the staff deployment must not open any campaign's key.

## 3. Option A — managed custody on AWS KMS (recommended)

### Design

One **AWS KMS customer managed key per campaign** (symmetric, single-Region, `ap-northeast-1`, never multi-Region). It wraps that campaign's X25519 private key.

| Step | Who | What happens |
|---|---|---|
| Launch | staff (Vercel staff project) | Generates the X25519 pair. Calls `kms:CreateKey` with a fixed key policy: `kms:Encrypt` for the staff identity only; `kms:Decrypt` and `kms:ScheduleKeyDeletion` for the processor identity only. Calls `kms:Encrypt` on the private key with encryption context `{campaignId, keyReference}`, zeroes it, and registers the public key and the ciphertext in the same launch transaction (forward migration: a ciphertext column on `intake.campaign_key`). The key reference is the KMS key ARN. If any call fails, the launch rolls back. A key created before the failure is scheduled for deletion in the same error path, and a nightly check catches any left over. |
| Process | processor (`privacy:process`, jobs project) | Reads the ciphertext and calls `kms:Decrypt` with the same encryption context. The private key lives in memory for one batch and is zeroed afterwards, as today. |
| Destroy | processor (as today: after the output is committed and intake cleaned up) | Calls `kms:ScheduleKeyDeletion` with a 7-day waiting period. The evidence is `outcome: "SCHEDULED"`, `recoverableUntil` = the deletion date KMS reports, and `cryptoErasure: false`. A later run of the same job, or the existing operations check, confirms with `DescribeKey` that the key is gone. Only then does it record `DESTROYED` with `cryptoErasure: "PROVIDER_ATTESTED"`. |
| Restore and tombstones | operator | A restored database still holds the ciphertext, but its KMS key no longer exists, so it cannot be opened. Tombstone replay calls destroy again, which reports `ALREADY_ABSENT`. |

Why the ciphertext can stay in the core database: KMS deletes the key material irreversibly, and ciphertext under a deleted symmetric key cannot be decrypted, even by recreating a key from the same material. So once a campaign's key is deleted, every copy of its wrapped key is useless: in the live database, in WAL, in replicas and in backups. That is the crypto-erasure the plan (`key-custody.md` §3) asks for. No separate custody bucket is needed.

### What it proves, and what it does not

- **Proves (once built and tested against a staging AWS account):**
  - The one-way property: the staff identity has `kms:Encrypt` and no `kms:Decrypt`. That is enforced by IAM and by each key's own policy, not by convention.
  - Per-campaign crypto-erasure after the waiting period, attested by KMS: the key is gone, and CloudTrail records both the scheduling and the deletion.
  - Other campaigns are unaffected, because each campaign has its own key.
  - Launch and `privacy:process` work on Vercel with no local filesystem.
- **Does not prove:**
  - **Custodian independence.** Whoever administers the AWS account can cancel a scheduled deletion during the waiting period, or change a key policy. P-003 asks for a custodian separate from core operators. The clean way is a **separate AWS account for custody** (AWS Organizations, no extra cost), whose administrators are not OrgFit's core or database operators. That is a people and process decision for the owner.
  - **Trust in AWS KMS itself.** The private key passes through `kms:Encrypt` once, inside AWS's FIPS-validated HSM service.
  - **What a compromised staff deployment can do with `kms:CreateKey`.** IAM can limit the key type, but not the key policy passed to `CreateKey`. A staff deployment compromised for a time could therefore create keys it can itself decrypt, for the campaigns launched during that time. That is the same exposure as §2, since it already sees each new private key at launch. It cannot change the policy of an existing key (no `kms:PutKeyPolicy`). A stricter variant removes `CreateKey` from staff entirely: a key pool, created ahead of time by the custodian identity, from which a launch claims one key. That costs $1 per pooled key per month and adds a replenishing job.
  - **The independent review** (P-001, P-008) still has to happen before production.
- **Recovery window:** at least 7 days (KMS allows 7–30, and may add up to 24 hours). Until the window ends, a campaign is "deletion scheduled, recoverable until …", never "erased".

### Cost

AWS's published prices, checked 2026-10-16:
- $1 per key per month, prorated hourly, and **not charged while pending deletion**. A campaign open for three weeks costs about $0.70.
- Requests: 20,000 free per month, then $0.03 per 10,000 symmetric requests. Each campaign makes a handful.
- CloudTrail's first trail of management events is free.

Expect a few dollars a month at most.

### What it needs from the owner

1. **A new dependency:** `@aws-sdk/client-kms`, pinned to `3.1128.0`, the same release as the `@aws-sdk/client-s3` already in use (D-166), and passed through `audit:ci`. Project rules forbid new dependencies without approval, so this is the main decision.
2. **Two IAM identities:**
   - The staff user gains `kms:CreateKey` (limited by condition to `SYMMETRIC_DEFAULT`, `ENCRYPT_DECRYPT`, not multi-Region, with a required tag), `kms:Encrypt` and `kms:TagResource`.
   - A **new processor identity** gets `kms:Decrypt`, `kms:ScheduleKeyDeletion` and `kms:DescribeKey` on tagged keys only.
   - Today the processor holds no AWS credential (D-166), so this adds one, limited to KMS.
   - Long-lived access keys, as for S3. Vercel OIDC federation would remove them, but needs `@vercel/functions`, a separate decision.
3. **The custodian:** who administers the custody account (P-003), the waiting period (7 recommended), and the decision to record in `decisions.md`.
4. **Implementation scope:**
   - A `CustodyProvider` named `aws-kms`, accepted by `custodyProviderName()` in production. That is the named-provider path `key-custody.md` §5 already plans; it is not a loosening. `development-file` stays refused.
   - Preflight checks for its configuration (names, never values). `key-custody` passes only for `aws-kms`.
   - The forward migration for the ciphertext column.
   - Tests against an in-memory KMS fake, plus a staging run against the real account: launch, respond, process, release, destroy, and confirm that opening fails after deletion.
   - Then the restore drill and the privacy verification (`key-custody.md` §5 steps 5–7).

## 4. Option B — staging-only sealed keys in a private S3 bucket

Offered because it was asked for. It keeps the one-way property, but it is **not custody** and must never reach production.

### Design

A provider named `s3-sealed-staging`. It is `development-file` with S3 in place of the directory:
- Launch (staff) seals the campaign private key to the custodian public key exactly as today, and writes `custody/ck_….sealed` with `s3:PutObject` only. The staff identity has no `GetObject` on that prefix.
- `privacy:process` (processor) gets the object, opens it with `CAMPAIGN_KEY_CUSTODY_SECRET_KEY`, which stays in the processor project only, and then deletes the object and every version.

### What it proves

That the whole pipeline (launch, respondent links, `privacy:process`, publication) runs across separate Vercel projects. Nothing about erasure: any earlier copy of the object (a version, a replica, an operator's download), plus the custodian secret, still opens the key. The evidence says so: `cryptoErasure: false`, `backupCopiesMayExist: true`.

### What it would change, stated plainly

- To run on Vercel at all, `custodyProviderName()` must accept this name while `NODE_ENV=production`. I would gate it behind an explicit acknowledgement, `CAMPAIGN_KEY_CUSTODY_STAGING_ONLY=s3-sealed-is-not-managed-custody`. That is a **new accepted path in the runtime guard**, so you should treat it as a change to the guard, not as "no change".
- `release:preflight` would **FAIL** `key-custody` for it in production, always, exactly as it does for `development-file`.
- The processor would need S3 read and delete on the custody prefix. That changes D-166's rule that the processor has no storage access.

### Cost

S3 at staging volumes: cents a month.

### Assessment

Option B needs the same AWS account and IAM work as Option A, adds a guard path that exists only to be refused later, and proves nothing about erasure. For about a dollar per campaign, Option A gives staging the real design. **I recommend Option A, used in staging first, and not building Option B.** Option B is worth building only if the owner wants the pipeline demonstrable before deciding on KMS and the custodian.

## 5. Considered and not proposed

- **Secrets Manager** ($0.40 per secret per month; 7–30 day recovery window, or immediate forced deletion). It works the same way, but it encrypts under a KMS key that is not deleted with the secret, so its deletion is weaker evidence of erasure than deleting a per-campaign KMS key.
- **One shared KMS key with per-campaign wrapped blobs.** Deleting a blob is not erasure, because backups keep it and the key still opens it.
- **Asymmetric (RSA) KMS keys,** where staff encrypts locally with the public key. This avoids sending the private key to KMS, but those requests are outside the free tier, and AWS warns that deleted asymmetric encryption keys keep accepting new ciphertext from copies of the public key without any error. Not worth the risk here.

## 6. For the client: why a test campaign shows no grades until it has five responses / لماذا لا تظهر الدرجات قبل خمس إجابات

**العربية.** تحمي المنصة هوية من يجيب. لذلك لا تُنشر أي درجة لمجموعة يقل عدد من أجابوا فيها عن خمسة (الحد الأدنى في إعداد الحملة خمسة، ولا يمكن خفضه: `threshold min(5)` في `src/campaign-input.ts`). وإن أُغلقت حملة بأقل من خمس إجابات مقبولة فلا تُفك إجاباتها أصلاً، وتُسجَّل «بيانات غير كافية» فقط. ويطبَّق الحد على كل مجموعة تُعرض: الشركة وكل قسم. فقسم أجاب فيه ثلاثة لا تظهر له درجة حتى لو ظهرت درجة الشركة. وتُحجب أيضاً المجموعة التي تتطابق إجاباتها كلها، لأن متوسطها يكشف إجابة كل فرد. **لذا تحتاج حملة الاختبار الحقيقية إلى خمس إجابات مكتملة على الأقل في كل مجموعة تريد رؤية درجتها.** هذا مقصود وليس عطلاً. أما لتجربة الدرجات دون حملة، فاستخدم «إرسال الإجابات التجريبية» في المعاينة: تظهر الدرجات فوراً ولا يُحفظ أو يُرسل شيء.

**English.** The platform protects who answered what. No score is published for any group with fewer than five respondents (the campaign threshold is at least five and cannot be lowered: `threshold min(5)` in `src/campaign-input.ts`). A campaign that closes with fewer than five accepted responses is never decrypted at all; it is recorded only as "insufficient data". The rule applies to every group shown, the company and each department, so a department with three respondents shows no score even when the company does. A group whose answers are all identical is withheld too, because its average would reveal everyone's answer. **A real test campaign therefore needs at least five completed responses in every group whose grade you want to see.** That is intended, not a fault. To try scores without a campaign, use "Submit test answers" in the preview: scores appear at once, and nothing is saved or sent.
