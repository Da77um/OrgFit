# Campaign key custody — provider interface and integration plan

2026-09-15, Post-Audit Repair Pass 4 (D-158). **No managed key custody provider has been selected (P-003 open), so none is integrated.** This document records what exists, what production refuses, and exactly what a real custody adapter must do and prove. It changes nothing in the privacy protocol ([privacy-protocol.md](privacy-protocol.md) §4–5) or the service separation it depends on.

## 1. What exists today

| Item | State |
|---|---|
| Protocol | Per-campaign libsodium sealed-box key pair (IN1). Staff launch holds only the custodian public key; only the processor can open a campaign private key. Unchanged. |
| Provider interface | `CustodyProvider` in `src/key-custody.ts`: `createCampaignKey`, `openCampaignKey`, `destroyCampaignKey` → `DestructionEvidence` |
| Implemented providers | **`development-file` only.** Sealed key files in a directory; destruction unlinks the file. |
| Configuration | `CAMPAIGN_KEY_CUSTODY_PROVIDER`. Unset outside production = `development-file`. |
| Production at runtime | Unset → `KEY_CUSTODY_PROVIDER_REQUIRED`; `development-file` → `KEY_CUSTODY_DEVELOPMENT_IN_PRODUCTION`; any other name → `KEY_CUSTODY_PROVIDER_UNSUPPORTED`. Staff launch and the processor both refuse before any key is created or opened. The only exception is `CAMPAIGN_KEY_CUSTODY_REHEARSAL_ONLY=development-file-is-not-managed-custody`, used by the local TLS release rehearsal. |
| Production at preflight | `key-custody` **FAIL** for staff and processor, always, until a managed adapter exists; the rehearsal acknowledgement is itself a FAIL (`key-custody-rehearsal`). No deployment environment passes preflight today. |
| Destruction evidence | The processor records the provider's own summary in `intake.campaign_key.destruction_evidence`. The development provider always says `not crypto-erasure; backups or copies of the custody directory may still hold it`, with `cryptoErasure: false` and `backupCopiesMayExist: true`. |
| Tests | `tests/adapters.test.ts` AP-7 (resolution matrix, preflight, evidence, and a demonstration that a copy taken before destruction still opens the key); `tests/adapters-database.test.ts` AD-5 (evidence recorded by the processor) |

Nothing else was substituted: there is no second local implementation labelled "managed".

## 2. Why the development provider is not erasure

A copy of the sealed file taken before destruction — a filesystem backup, a snapshot, a replica, an operator's copy — plus the custodian secret key opens the campaign private key, and the core database's backups hold the matching encrypted intake for their retention (proposed 35 days, P-004). AP-7 shows this directly. Keeping custody backups out of the core backup set is a procedural control only.

## 3. What a managed provider adapter must do

The adapter is written against the provider the owner names; the shape below is provider-neutral and is what the code and tests will require.

1. **Creation (staff launch).** Obtain an authenticated public key record for a new campaign key from the custody service, bound to the campaign and an epoch. The campaign private key must never reach the staff process, an environment file, the core or anonymous database, or a generic backup. Many managed key services do not natively hold an X25519 sealed-box key; the likely pattern is a per-campaign **wrapping key held by the service** that protects the X25519 private key, with the wrapped blob stored outside the core backup set. Whether the chosen service supports that, and in which region, is part of P-002/P-003 and is not assumed.
2. **Opening (processor only).** Unwrap through a service identity that only the processor deployment holds, for one batch; zero the plaintext after use (the processor already does).
3. **Destruction.** Request deletion of every usable form of the campaign key: the wrapping key version(s), any wrapped copies, recoverable secret versions and replicas. Return `DestructionEvidence` with `outcome` `SCHEDULED` or `DESTROYED` as the provider reports it, `recoverableUntil` = the end of the provider's recovery or pending-deletion window, and `cryptoErasure: "PROVIDER_ATTESTED"` **only** once the provider confirms no usable copy remains.
4. **Failure.** Any custody error is a retryable failure before an invitation is consumed (launch) or before a batch is decrypted (processor). Nothing falls back to the development provider.

## 4. Deletion and recovery windows, and what they mean

These are **not known** until a provider is chosen; they must be read from that provider's documentation, recorded in `decisions.md`, and measured in staging.

| Question the owner/custodian must answer | Consequence |
|---|---|
| Minimum and maximum waiting period between a deletion request and irreversible deletion | Until it ends, the key is recoverable by whoever controls the custody account; a campaign may not be described as crypto-erased before then |
| Can a scheduled deletion be cancelled, and by whom | Cancellation rights are an access-control question for the custody operator, separate from core operators (P-003) |
| Are key versions, replicas or cross-region copies deleted together | Any surviving copy defeats erasure |
| Are custody backups taken, and with what retention | A custody backup that outlives the core backup retention reopens restored intake |
| Does the provider issue a verifiable deletion record | Needed to set `cryptoErasure: "PROVIDER_ATTESTED"` |

Backup implications, independent of provider: encrypted intake remains in core database backups for their retention; tombstone replay erases restored copies in a restored environment, never on the backup media. Crypto-erasure of backup copies holds only when every usable key copy is gone **and** the backups themselves cannot supply one.

## 5. Integration steps (once P-003 is answered)

1. Owner names the custodian (a party separate from core operators) and the provider, region and account boundary.
2. Record the provider's deletion/recovery windows and backup policy (table §4) in `decisions.md`.
3. Implement `CustodyProvider` for it; add the provider name to `custodyProviderName`; keep `development-file` refused in production.
4. Add preflight checks for the provider's own configuration (identity, region, key policy) — names only, never values.
5. Tests: create/open/destroy against the provider's staging account; destruction evidence carries the recovery window; opening after destruction fails; a restore drill with a custody snapshot older than destruction shows the key cannot be recovered after the window.
6. Re-run the privacy verification (`privacy-verification.md` §5) and the restore drill; only then may documentation describe a campaign as crypto-erased, and only after its window has passed.
7. Independent privacy/security review of the actual integration (P-001, P-008).

## 6. Missing inputs

P-003 (custodian, provider, deletion/recovery windows, backup policy), P-002 (hosting, region, network separation), P-004 (backup retention), P-001/P-008 (independent review).
