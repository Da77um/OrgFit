import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { uuid, AppError } from "./security";
function key() {
  const value = process.env.IMPORT_ENCRYPTION_KEY;
  if (!value || !/^[a-f0-9]{64}$/.test(value))
    throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  return Buffer.from(value, "hex");
}
function objectKey(org: string, id: string) {
  uuid.parse(org);
  uuid.parse(id);
  return `imports/${org}/${id}.bin`;
}
function localPath(org: string, id: string) {
  if (process.env.NODE_ENV === "production")
    throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  objectKey(org, id);
  return resolve(
    process.env.IMPORT_LOCAL_DIRECTORY ?? "work/imports",
    org,
    id + ".bin",
  );
}
function s3() {
  if (!process.env.IMPORT_S3_BUCKET) return null;
  return new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.IMPORT_S3_ENDPOINT,
    forcePathStyle: !!process.env.IMPORT_S3_ENDPOINT,
  });
}
export async function putSource(org: string, id: string, source: Buffer) {
  const name = objectKey(org, id),
    nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(name));
  const bytes = Buffer.concat([
    nonce,
    cipher.update(source),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const client = s3();
  if (client)
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.IMPORT_S3_BUCKET,
        Key: name,
        Body: bytes,
        ContentType: "application/octet-stream",
      }),
    );
  else {
    await cleanLocalSources(Date.now(), org);
    const path = localPath(org, id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
  }
}
export async function getSource(org: string, id: string) {
  const name = objectKey(org, id),
    client = s3();
  const bytes = client
    ? Buffer.from(
        await (
          await client.send(
            new GetObjectCommand({
              Bucket: process.env.IMPORT_S3_BUCKET,
              Key: name,
            }),
          )
        ).Body!.transformToByteArray(),
      )
    : await readFile(localPath(org, id));
  if (bytes.length > 1024 * 1024 + 28 || bytes.length < 28)
    throw new AppError("VALIDATION_FAILED", 422);
  const cipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(name));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([
    cipher.update(bytes.subarray(12, -16)),
    cipher.final(),
  ]);
}
export async function deleteSource(org: string, id: string) {
  const client = s3();
  if (client)
    await client.send(
      new DeleteObjectCommand({
        Bucket: process.env.IMPORT_S3_BUCKET,
        Key: objectKey(org, id),
      }),
    );
  else
    await unlink(localPath(org, id)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
}
// Development source janitor, including orphaned uploads. S3 requires a lifecycle
// rule on imports/ with a one-day expiration, including noncurrent versions.
export async function cleanLocalSources(
  now = Date.now(),
  organization?: string,
) {
  if (process.env.NODE_ENV === "production" || process.env.IMPORT_S3_BUCKET)
    throw new Error("Local development only");
  const root = resolve(process.env.IMPORT_LOCAL_DIRECTORY ?? "work/imports");
  const { stat } = await import("node:fs/promises");
  let removed = 0;
  if (organization) uuid.parse(organization);
  for (const org of organization
    ? [organization]
    : await readdir(root).catch(() => [])) {
    if (!uuid.safeParse(org).success) continue;
    for (const name of await readdir(join(root, org)).catch(() => [])) {
      if (!/^[a-f0-9-]{36}\.bin$/.test(name)) continue;
      const path = localPath(org, name.slice(0, -4));
      if ((await stat(path)).mtimeMs + 86400000 <= now) {
        await unlink(path);
        removed++;
      }
    }
  }
  return removed;
}
