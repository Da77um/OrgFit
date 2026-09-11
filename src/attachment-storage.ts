import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  unlink,
  readdir,
  stat,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { uuid, AppError } from "./security";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_RETENTION_DAYS,
  ATTACHMENT_ORPHAN_HOURS,
} from "./attachment-types";

export {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_RETENTION_DAYS,
  ATTACHMENT_ORPHAN_HOURS,
};

// Private visit attachments. Encrypted under their OWN key — never the import
// key, the link-export key, the report key, the participation-export key or any
// campaign intake key — and written under their own prefix, so no process that
// can decrypt an assessment artifact can decrypt a consulting file.
//
// The object name is generated from two identifiers this module is given. It is
// never derived from the uploaded filename, never supplied by a caller, and the
// database refuses to store a key of any other shape.

function key() {
  const value = process.env.ATTACHMENT_ENCRYPTION_KEY;
  if (!value || !/^[a-f0-9]{64}$/.test(value))
    throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  return Buffer.from(value, "hex");
}
export function objectKey(org: string, id: string) {
  uuid.parse(org);
  uuid.parse(id);
  return `attachments/${org}/${id}.bin`;
}
function localPath(org: string, id: string) {
  if (process.env.NODE_ENV === "production")
    throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  objectKey(org, id);
  return resolve(
    process.env.ATTACHMENT_LOCAL_DIRECTORY ?? "work/attachments",
    org,
    id + ".bin",
  );
}
function s3() {
  if (!process.env.ATTACHMENT_S3_BUCKET) return null;
  return new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.ATTACHMENT_S3_ENDPOINT,
    forcePathStyle: !!process.env.ATTACHMENT_S3_ENDPOINT,
  });
}
export async function putAttachment(org: string, id: string, body: Buffer) {
  if (body.length > ATTACHMENT_MAX_BYTES || body.length === 0)
    throw new AppError("VALIDATION_FAILED", 422);
  const name = objectKey(org, id),
    nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), nonce);
  // The object name is authenticated data, so ciphertext moved to another key
  // does not decrypt.
  cipher.setAAD(Buffer.from(name));
  const bytes = Buffer.concat([
    nonce,
    cipher.update(body),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const client = s3();
  if (client)
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.ATTACHMENT_S3_BUCKET,
        Key: name,
        Body: bytes,
        // Never the uploaded type: a stored object is opaque encrypted bytes,
        // and nothing downstream may be tempted to serve it by this header.
        ContentType: "application/octet-stream",
      }),
    );
  else {
    const path = localPath(org, id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
  }
  return name;
}
export async function getAttachment(org: string, id: string) {
  const name = objectKey(org, id),
    client = s3();
  const bytes = client
    ? Buffer.from(
        await (
          await client.send(
            new GetObjectCommand({
              Bucket: process.env.ATTACHMENT_S3_BUCKET,
              Key: name,
            }),
          )
        ).Body!.transformToByteArray(),
      )
    : await readFile(localPath(org, id));
  if (bytes.length > ATTACHMENT_MAX_BYTES + 28 || bytes.length < 28)
    throw new AppError("VALIDATION_FAILED", 422);
  const cipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(name));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([
    cipher.update(bytes.subarray(12, -16)),
    cipher.final(),
  ]);
}
export async function deleteAttachment(org: string, id: string) {
  const client = s3();
  if (client)
    await client.send(
      new DeleteObjectCommand({
        Bucket: process.env.ATTACHMENT_S3_BUCKET,
        Key: objectKey(org, id),
      }),
    );
  else
    await unlink(localPath(org, id)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
}
// Development janitor for objects with no row at all — written and then
// orphaned by a crash. The authoritative retention is core.expire_attachments,
// which retires the row and hands back the key; this sweep has no database and
// therefore uses the MAXIMUM retention as its age bound, so it can never remove
// bytes a live CLEAN row still points at. A bucket needs its own lifecycle rule
// on attachments/.
export async function cleanLocalAttachments(
  now = Date.now(),
  organization?: string,
) {
  if (process.env.NODE_ENV === "production" || process.env.ATTACHMENT_S3_BUCKET)
    throw new Error("Local development only");
  const root = resolve(
    process.env.ATTACHMENT_LOCAL_DIRECTORY ?? "work/attachments",
  );
  let removed = 0;
  if (organization) uuid.parse(organization);
  for (const org of organization
    ? [organization]
    : await readdir(root).catch(() => [])) {
    if (!uuid.safeParse(org).success) continue;
    for (const name of await readdir(join(root, org)).catch(() => [])) {
      if (!/^[a-f0-9-]{36}\.bin$/.test(name)) continue;
      const path = localPath(org, name.slice(0, -4));
      if (
        (await stat(path)).mtimeMs + ATTACHMENT_RETENTION_DAYS * 86400000 <=
        now
      ) {
        await unlink(path);
        removed++;
      }
    }
  }
  return removed;
}
