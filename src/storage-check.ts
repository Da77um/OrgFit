import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { FILE_ACCESS, FILE_PREFIXES, LEDGER_ACCESS, LEDGER_PREFIX, type StorageIdentity, type StorageOp } from "./storage-access";
import { MIN_OBJECT_LOCK_DAYS } from "./tombstone-ledger";

// ---------------------------------------------------------------------------
// Proves the deployed buckets enforce src/storage-access.ts (D-166): every
// identity is tried on every prefix and operation, and must be allowed exactly
// where the table says and denied everywhere else. Run by scripts/check-storage.ts
// with each identity's own credentials; tested with an in-memory fake.
//
// Side effects, all inside the files bucket and all removed by its lifecycle
// rules: one small object per prefix under a fixed check organization (deleted
// at once where some identity may delete), and delete markers for keys that
// never existed. Nothing is ever written under the ledger prefix: a locked
// object there could not be removed for the retention period. The first
// tombstones:ship run proves ledger writes.
// ---------------------------------------------------------------------------

export const IDENTITIES = ["staff", "report", "scanner", "operator"] as const satisfies readonly StorageIdentity[];
export type S3Like = { send(command: unknown): Promise<unknown> };
export type StorageFinding = { identity: StorageIdentity | "-"; check: string; outcome: "PASS" | "FAIL"; detail: string };

/** Objects written by the check live under this organization id, which no real organization has. */
export const CHECK_ORGANIZATION = "00000000-0000-4000-8000-00000000c4ec";

type Attempt = "allowed" | "denied" | `error:${string}`;
async function attempt(fn: () => Promise<unknown>): Promise<Attempt> {
  try {
    const result = (await fn()) as { Body?: { transformToByteArray?: () => Promise<unknown> } } | undefined;
    await result?.Body?.transformToByteArray?.(); // release the connection
    return "allowed";
  } catch (e) {
    const name = (e as { name?: string; Code?: string }).name ?? (e as { Code?: string }).Code ?? "Unknown";
    // Only AccessDenied is a denial. InvalidAccessKeyId and SignatureDoesNotMatch
    // are also 403, but they mean the credential is wrong, not that policy held.
    return name === "AccessDenied" ? "denied" : `error:${name}`;
  }
}

export async function checkStorage(
  clients: Record<StorageIdentity, S3Like>,
  buckets: { files: string; ledger: string },
): Promise<StorageFinding[]> {
  const out: StorageFinding[] = [];
  const expect = (identity: StorageIdentity, check: string, got: Attempt, want: "allowed" | "denied") =>
    out.push({ identity, check, outcome: got === want ? "PASS" : "FAIL", detail: got === want ? want : `expected ${want}, got ${got}` });
  const key = (prefix: string) => `${prefix}${CHECK_ORGANIZATION}/${randomUUID()}.bin`;
  const body = Buffer.from("orgfit storage check");
  const may = (identity: StorageIdentity, prefix: (typeof FILE_PREFIXES)[number], op: StorageOp) =>
    (FILE_ACCESS[identity][prefix] ?? []).includes(op);

  for (const prefix of FILE_PREFIXES) {
    const writer = IDENTITIES.find((i) => may(i, prefix, "put"));
    let probe: string | null = null;
    if (writer) {
      const k = key(prefix);
      const got = await attempt(() => clients[writer].send(new PutObjectCommand({ Bucket: buckets.files, Key: k, Body: body })));
      expect(writer, `put ${prefix}`, got, "allowed");
      if (got === "allowed") probe = k;
    }
    for (const identity of IDENTITIES) {
      if (identity !== writer) {
        const k = key(prefix);
        const got = await attempt(() => clients[identity].send(new PutObjectCommand({ Bucket: buckets.files, Key: k, Body: body })));
        expect(identity, `put ${prefix}`, got, may(identity, prefix, "put") ? "allowed" : "denied");
      }
      if (probe) {
        const k = probe;
        const got = await attempt(() => clients[identity].send(new GetObjectCommand({ Bucket: buckets.files, Key: k })));
        expect(identity, `get ${prefix}`, got, may(identity, prefix, "get") ? "allowed" : "denied");
      } else out.push({ identity, check: `get ${prefix}`, outcome: "FAIL", detail: "not testable: no object could be written" });
      // A key that never existed: a permitted delete only leaves a delete marker.
      const missing = key(prefix);
      const got = await attempt(() => clients[identity].send(new DeleteObjectCommand({ Bucket: buckets.files, Key: missing })));
      expect(identity, `delete ${prefix}`, got, may(identity, prefix, "delete") ? "allowed" : "denied");
    }
    const deleter = IDENTITIES.find((i) => may(i, prefix, "delete"));
    if (probe && deleter) await attempt(() => clients[deleter].send(new DeleteObjectCommand({ Bucket: buckets.files, Key: probe })));
  }

  for (const identity of IDENTITIES) {
    const ledger = LEDGER_ACCESS[identity];
    expect(identity, "ledger list", await attempt(() => clients[identity].send(new ListObjectsV2Command({ Bucket: buckets.ledger, Prefix: LEDGER_PREFIX, MaxKeys: 1 }))), ledger.includes("list") ? "allowed" : "denied");
    // Writing under the ledger prefix is tried only where it must be refused.
    if (!ledger.includes("put"))
      expect(identity, "ledger put", await attempt(() => clients[identity].send(new PutObjectCommand({ Bucket: buckets.ledger, Key: `${LEDGER_PREFIX}orgfit-storage-check/${randomUUID()}`, Body: body }))), "denied");
    expect(identity, "ledger put outside prefix", await attempt(() => clients[identity].send(new PutObjectCommand({ Bucket: buckets.ledger, Key: `orgfit-storage-check/${randomUUID()}`, Body: body }))), "denied");
    expect(identity, "ledger delete", await attempt(() => clients[identity].send(new DeleteObjectCommand({ Bucket: buckets.ledger, Key: `${LEDGER_PREFIX}orgfit-storage-check-never-written` }))), "denied");
    if (ledger.includes("lock-config")) {
      try {
        const config = (await clients[identity].send(new GetObjectLockConfigurationCommand({ Bucket: buckets.ledger }))) as {
          ObjectLockConfiguration?: { ObjectLockEnabled?: string; Rule?: { DefaultRetention?: { Mode?: string; Days?: number } } };
        };
        const c = config.ObjectLockConfiguration;
        const ok = c?.ObjectLockEnabled === "Enabled" && c.Rule?.DefaultRetention?.Mode === "COMPLIANCE" && (c.Rule.DefaultRetention.Days ?? 0) >= MIN_OBJECT_LOCK_DAYS;
        out.push({ identity, check: "ledger object lock", outcome: ok ? "PASS" : "FAIL", detail: ok ? `COMPLIANCE, ${c!.Rule!.DefaultRetention!.Days} days` : `expected COMPLIANCE ≥ ${MIN_OBJECT_LOCK_DAYS} days` });
      } catch (e) {
        out.push({ identity, check: "ledger object lock", outcome: "FAIL", detail: `unreadable (${(e as { name?: string }).name ?? "Unknown"})` });
      }
    } else
      expect(identity, "ledger lock config", await attempt(() => clients[identity].send(new GetObjectLockConfigurationCommand({ Bucket: buckets.ledger }))), "denied");
  }
  return out;
}
