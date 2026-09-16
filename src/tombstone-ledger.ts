import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { RuntimeGuardError } from "./runtime-guard";

// ---------------------------------------------------------------------------
// The external tombstone ledger (Phase 14; durable delivery in Post-Audit
// Repair Pass 4, SEC-M3).
//
// The ledger lives OUTSIDE the databases and their backups, so it survives the
// very restore it exists to correct. Its lines name objects and campaigns,
// never people: exactly {seq, class, organizationId, subjectId, recordedAt}.
//
// Every shipment is a BATCH followed by a SEAL: {from, to, count, sha256 of the
// batch's exact bytes, previous = sha256 of the previous seal, sealedAt}. The
// seals form a hash chain, so reading the ledger detects a changed, removed or
// reordered sealed batch. A hash chain is tamper EVIDENCE for a reader who can
// see the whole chain; it is not a signature, and someone able to rewrite every
// later seal can rewrite history. Tamper RESISTANCE comes from the storage:
//
//   local-file  tombstones.jsonl + seals.jsonl + cursor in a directory.
//               Development and the local drills. Append-only by convention
//               only; release preflight fails it in production.
//   s3          one object per batch and per seal under a prefix, each written
//               with a conditional create (If-None-Match: *) so nothing is ever
//               overwritten, a SHA-256 checksum the service verifies, and — when
//               TOMBSTONE_LEDGER_OBJECT_LOCK_DAYS is set — an Object Lock
//               retention in COMPLIANCE mode. Whether the bucket actually has
//               Object Lock enabled, versioning, and a policy that denies
//               deletion is provider configuration that this code cannot prove;
//               it has been exercised against a local S3 test double only.
//
// Retries: the S3 client retries each request (up to 5 attempts, with
// backoff); the job supervisor retries a failed shipment; a shipment that is
// still failing raises JOB_FAILING and the TOMBSTONE_SHIPPING_BEHIND alert.
// ---------------------------------------------------------------------------

export type Tombstone = {
  seq: number;
  class:
    | "ATTACHMENT"
    | "REPORT_ARTIFACT"
    | "PRIVATE_EXPORT"
    | "CAMPAIGN_INTAKE"
    | "CAMPAIGN_KEY"
    | "ANONYMOUS_CAMPAIGN"
    // Post-Audit Repair Pass 3 (022): a withdrawn release, subject = snapshot.
    | "RELEASE_REVOCATION"
    // Employee messages (025): a revoked organization message link, subject = link.
    | "MESSAGE_LINK";
  organizationId: string;
  subjectId: string;
  recordedAt: string;
};

export type Seal = { from: number; to: number; count: number; sha256: string; previous: string | null; sealedAt: string };

export type LedgerRead = {
  tombstones: Tombstone[];
  /** Highest sequence number covered by a verified seal. */
  sealedThrough: number;
  /** Highest sequence number present at all (sealed or not). */
  maxSeq: number;
  /** Lines written after the last seal (a shipment interrupted before its seal). */
  unsealed: number;
  lastSealHash: string | null;
};

export interface TombstoneSink {
  readonly kind: "local-file" | "s3";
  read(): Promise<LedgerRead>;
  /** Append one batch and its seal. Returns the new seal. */
  append(batch: Tombstone[], previous: string | null): Promise<Seal>;
  /** The shipping cursor: the highest sequence number durably shipped. */
  cursor(read: LedgerRead): Promise<number>;
  saveCursor(value: number): Promise<void>;
  /** Seal lines left unsealed by an interrupted shipment, before appending
   *  anything new. Returns the chain head afterwards. */
  repair(read: LedgerRead): Promise<string | null>;
}

export class LedgerIntegrityError extends RuntimeGuardError {
  constructor() {
    super("TOMBSTONE_LEDGER_INTEGRITY_FAILED");
  }
}

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
/** The chain link a following seal names as `previous`. */
export const sealHash = (seal: Seal) => sha256(JSON.stringify(seal));
const batchText = (batch: Tombstone[]) => batch.map((t) => JSON.stringify(t)).join("\n") + "\n";
const LINE_KEYS = ["class", "organizationId", "recordedAt", "seq", "subjectId"];

function parseTombstone(line: string): Tombstone {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new LedgerIntegrityError();
  }
  const t = value as Tombstone;
  if (!t || typeof t !== "object" || Object.keys(t).sort().join() !== LINE_KEYS.join() || !Number.isSafeInteger(t.seq))
    throw new LedgerIntegrityError();
  return t;
}

/** Order by sequence number; drop exact repeats (a shipment retried after its
 *  batch was written but before its cursor moved). */
function normalize(lines: Tombstone[]) {
  const seen = new Map<string, Tombstone>();
  for (const t of lines) seen.set(`${t.seq}|${t.class}|${t.subjectId}`, t);
  return [...seen.values()].sort((a, b) => a.seq - b.seq);
}

/** Verify seals against batches in order. `batches[i]` is the exact text the
 *  i-th seal covers. */
function verifyChain(seals: Seal[], batches: string[]) {
  let previous: string | null = null;
  seals.forEach((seal, i) => {
    const text = batches[i];
    if (text === undefined || sha256(text) !== seal.sha256 || seal.previous !== previous) throw new LedgerIntegrityError();
    const lines = text.split("\n").filter(Boolean).map(parseTombstone);
    if (lines.length !== seal.count || lines[0]?.seq !== seal.from || lines[lines.length - 1]?.seq !== seal.to)
      throw new LedgerIntegrityError();
    previous = sha256(JSON.stringify(seal));
  });
  return previous as string | null;
}

// --- local file -------------------------------------------------------------------

export function localFileSink(dir: string): TombstoneSink {
  const root = resolve(dir);
  const ledgerFile = join(root, "tombstones.jsonl");
  const sealFile = join(root, "seals.jsonl");
  const cursorFile = join(root, "cursor");
  const text = (path: string) =>
    readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
  const appendSynced = async (path: string, content: string) => {
    const handle = await open(path, "a");
    try {
      await handle.write(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  return {
    kind: "local-file",
    async read() {
      const lineTexts = (await text(ledgerFile)).split("\n").filter((l) => l.trim());
      const seals = (await text(sealFile)).split("\n").filter((l) => l.trim()).map((l) => {
        try {
          return JSON.parse(l) as Seal;
        } catch {
          throw new LedgerIntegrityError();
        }
      });
      // Seals cover the ledger's lines in file order, batch by batch. A
      // ledger written before seals existed has none: all of it is unsealed.
      const batches: string[] = [];
      let offset = 0;
      for (const seal of seals) {
        if (offset + seal.count > lineTexts.length) throw new LedgerIntegrityError();
        batches.push(lineTexts.slice(offset, offset + seal.count).join("\n") + "\n");
        offset += seal.count;
      }
      const lastSealHash = verifyChain(seals, batches);
      const all = lineTexts.map(parseTombstone);
      const tombstones = normalize(all);
      return {
        tombstones,
        sealedThrough: seals.length ? Math.max(...seals.map((s) => s.to)) : 0,
        maxSeq: tombstones.length ? tombstones[tombstones.length - 1].seq : 0,
        unsealed: lineTexts.length - offset,
        lastSealHash,
      };
    },
    async append(batch, previous) {
      await mkdir(root, { recursive: true });
      const body = batchText(batch);
      await appendSynced(ledgerFile, body);
      const seal: Seal = {
        from: batch[0].seq,
        to: batch[batch.length - 1].seq,
        count: batch.length,
        sha256: sha256(body),
        previous,
        sealedAt: new Date().toISOString(),
      };
      await appendSynced(sealFile, JSON.stringify(seal) + "\n");
      return seal;
    },
    async cursor() {
      return Number((await text(cursorFile)).trim() || "0");
    },
    async saveCursor(value) {
      await mkdir(root, { recursive: true });
      await writeFile(cursorFile + ".tmp", String(value));
      await rename(cursorFile + ".tmp", cursorFile);
    },
    async repair(read) {
      if (!read.unsealed) return read.lastSealHash;
      // The tail is the last `unsealed` lines in file order. It was written
      // from the database by an earlier shipment; it is sealed as it stands.
      const lineTexts = (await text(ledgerFile)).split("\n").filter((l) => l.trim());
      const tail = lineTexts.slice(lineTexts.length - read.unsealed);
      const parsed = tail.map(parseTombstone);
      const body = tail.join("\n") + "\n";
      const seal: Seal = {
        from: parsed[0].seq,
        to: parsed[parsed.length - 1].seq,
        count: parsed.length,
        sha256: sha256(body),
        previous: read.lastSealHash,
        sealedAt: new Date().toISOString(),
      };
      await appendSynced(sealFile, JSON.stringify(seal) + "\n");
      return sha256(JSON.stringify(seal));
    },
  };
}

// --- S3-compatible object storage -------------------------------------------------

export type S3SinkOptions = {
  bucket: string;
  prefix?: string;
  endpoint?: string;
  region?: string;
  objectLockDays?: number | null;
  client?: S3Client;
};

const pad = (n: number) => String(n).padStart(20, "0");

export function s3Sink(options: S3SinkOptions): TombstoneSink {
  const prefix = options.prefix ?? "tombstones/";
  const client =
    options.client ??
    new S3Client({
      region: options.region ?? "us-east-1",
      endpoint: options.endpoint,
      forcePathStyle: !!options.endpoint,
      maxAttempts: 5,
    });
  const list = async (under: string) => {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: options.bucket, Prefix: prefix + under, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  };
  const get = async (key: string) =>
    Buffer.from(
      await (await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }))).Body!.transformToByteArray(),
    ).toString("utf8");
  // Never overwrite. A conflict on retry is accepted only if the stored object
  // is byte-identical to what this shipment would have written.
  const create = async (key: string, body: string, contentType: string) => {
    const checksum = createHash("sha256").update(body).digest("base64");
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          IfNoneMatch: "*",
          ChecksumSHA256: checksum,
          ...(options.objectLockDays
            ? {
                ObjectLockMode: "COMPLIANCE" as const,
                ObjectLockRetainUntilDate: new Date(Date.now() + options.objectLockDays * 86400_000),
              }
            : {}),
        }),
      );
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 412 && status !== 409) throw e;
      if ((await get(key)) !== body) throw new LedgerIntegrityError();
    }
  };
  return {
    kind: "s3",
    async read() {
      const sealKeys = await list("seals/");
      const batchKeys = new Set(await list("batches/"));
      const seals: Seal[] = [];
      const batches: string[] = [];
      for (const key of sealKeys) {
        let seal: Seal;
        try {
          seal = JSON.parse(await get(key)) as Seal;
        } catch {
          throw new LedgerIntegrityError();
        }
        const name = `${pad(seal.from)}-${pad(seal.to)}`;
        if (key !== `${prefix}seals/${name}.json`) throw new LedgerIntegrityError();
        const batchKey = `${prefix}batches/${name}.jsonl`;
        if (!batchKeys.has(batchKey)) throw new LedgerIntegrityError();
        seals.push(seal);
        batches.push(await get(batchKey));
      }
      const lastSealHash = verifyChain(seals, batches);
      // A batch object with no seal: a shipment interrupted between the two
      // writes. Its lines are used (they came from the database) and sealed by
      // the next shipment.
      const sealedBatchKeys = new Set(seals.map((s) => `${prefix}batches/${pad(s.from)}-${pad(s.to)}.jsonl`));
      const unsealedTexts: string[] = [];
      for (const key of [...batchKeys].sort()) if (!sealedBatchKeys.has(key)) unsealedTexts.push(await get(key));
      const unsealedLines = unsealedTexts.flatMap((t) => t.split("\n").filter(Boolean)).map(parseTombstone);
      const tombstones = normalize([...batches.flatMap((t) => t.split("\n").filter(Boolean)).map(parseTombstone), ...unsealedLines]);
      return {
        tombstones,
        sealedThrough: seals.length ? Math.max(...seals.map((s) => s.to)) : 0,
        maxSeq: tombstones.length ? tombstones[tombstones.length - 1].seq : 0,
        unsealed: unsealedLines.length,
        lastSealHash,
      };
    },
    async append(batch, previous) {
      const body = batchText(batch);
      const name = `${pad(batch[0].seq)}-${pad(batch[batch.length - 1].seq)}`;
      await create(`${prefix}batches/${name}.jsonl`, body, "application/x-ndjson");
      const seal: Seal = {
        from: batch[0].seq,
        to: batch[batch.length - 1].seq,
        count: batch.length,
        sha256: sha256(body),
        previous,
        sealedAt: new Date().toISOString(),
      };
      await create(`${prefix}seals/${name}.json`, JSON.stringify(seal), "application/json");
      return seal;
    },
    // The bucket is the durable record: the cursor is the end of its sealed
    // chain, so losing the operator host loses nothing, and a batch left
    // unsealed by an interrupted shipment is shipped (identically) again.
    async cursor(read) {
      return read.sealedThrough;
    },
    async saveCursor() {},
    async repair(read) {
      return read.lastSealHash;
    },
  };
}

// --- configuration --------------------------------------------------------------------

/** Minimum Object Lock retention: the tombstone must outlive the oldest
 *  restorable backup (35-day proposal, P-004) by a day. */
export const MIN_OBJECT_LOCK_DAYS = 36;

/**
 *   TOMBSTONE_LEDGER_S3_BUCKET (+ _S3_ENDPOINT, _S3_PREFIX, _OBJECT_LOCK_DAYS)
 *   or TOMBSTONE_LEDGER_DIRECTORY (nonproduction only).
 * In production the bucket and an Object Lock retention of at least 36 days
 * are required; a local directory is refused.
 */
export function tombstoneSinkFromEnvironment(env: Record<string, string | undefined> = process.env): TombstoneSink {
  const production = env.NODE_ENV === "production";
  if (env.TOMBSTONE_LEDGER_S3_BUCKET) {
    const raw = env.TOMBSTONE_LEDGER_OBJECT_LOCK_DAYS;
    const days = raw ? Number(raw) : null;
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650))
      throw new RuntimeGuardError("TOMBSTONE_LEDGER_OBJECT_LOCK_INVALID");
    if (production && (days === null || days < MIN_OBJECT_LOCK_DAYS))
      throw new RuntimeGuardError("TOMBSTONE_LEDGER_OBJECT_LOCK_REQUIRED");
    const prefix = env.TOMBSTONE_LEDGER_S3_PREFIX || "tombstones/";
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/$/.test(prefix)) throw new RuntimeGuardError("TOMBSTONE_LEDGER_PREFIX_INVALID");
    return s3Sink({
      bucket: env.TOMBSTONE_LEDGER_S3_BUCKET,
      prefix,
      endpoint: env.TOMBSTONE_LEDGER_S3_ENDPOINT || undefined,
      region: env.AWS_REGION,
      objectLockDays: days,
    });
  }
  if (env.TOMBSTONE_LEDGER_DIRECTORY) {
    if (production) throw new RuntimeGuardError("TOMBSTONE_LEDGER_LOCAL_IN_PRODUCTION");
    return localFileSink(env.TOMBSTONE_LEDGER_DIRECTORY);
  }
  throw new RuntimeGuardError("TOMBSTONE_LEDGER_REQUIRED");
}
