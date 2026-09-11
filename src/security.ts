import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
export const capabilities = [
  "directory.manage",
  "instruments.manage",
  "campaigns.manage",
  "participation.read",
  "participation.export",
  "results.read",
  "reports.manage",
  "visits.manage",
] as const;
export type Capability = (typeof capabilities)[number];
export const uuid = z.uuid();
export const accessInput = z
  .object({
    role: z.enum(["SUPER_ADMIN", "STAFF"]),
    status: z.enum(["ACTIVE", "DISABLED"]),
    capabilities: z
      .array(z.enum(capabilities))
      .max(8)
      .refine((a) => new Set(a).size === a.length),
    organizationIds: z
      .array(uuid)
      .max(100)
      .refine((a) => new Set(a).size === a.length),
  })
  .strict();
export const createStaffInput = accessInput.extend({
  issuer: z.url().max(500),
  subject: z.string().min(1).max(500),
  email: z.email().max(320),
  displayName: z.string().trim().min(1).max(500),
});
export class AppError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}
export const secret = () => randomBytes(32).toString("base64url");
export const digest = (token: string) =>
  createHash("sha256").update(token).digest();
export function sessionDigest(token: string | undefined) {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new AppError("SESSION_REQUIRED", 401);
  return digest(token).toString("hex");
}
// `binary` is granted to exactly one route — the visit attachment upload — and
// it relaxes the media type only. The same-origin and CSRF checks are unchanged,
// and an octet stream is still not a form post a third-party page could make.
export function checkMutation(
  request: Request,
  origin: string,
  binary = false,
) {
  if (
    request.headers.get("origin") !== origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new AppError("FORBIDDEN", 403);
  // A DELETE carries no body, so it carries no media type to check.
  if (request.method === "DELETE") return;
  const type = request.headers.get("content-type") ?? "";
  if (
    !type.startsWith("application/json") &&
    !(binary && type.startsWith("application/octet-stream"))
  )
    throw new AppError("MALFORMED", 400);
}
// Bounded binary body. Deliberately separate from jsonInput: the limit is the
// attachment ceiling rather than the JSON ceiling, and the declared length is
// checked before a byte is read as well as while reading, so a lying
// Content-Length buys nothing.
export async function binaryInput(
  request: Request,
  limit: number,
): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit)
    throw new AppError("ATTACHMENT_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("MALFORMED", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new AppError("ATTACHMENT_TOO_LARGE", 413);
    }
    chunks.push(value);
  }
  if (!size) throw new AppError("MALFORMED", 400);
  return Buffer.concat(chunks);
}
export async function jsonInput<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  const limit = 2 * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > limit)
    throw new AppError("MALFORMED", 400);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("MALFORMED", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new AppError("MALFORMED", 400);
    }
    chunks.push(value);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("MALFORMED", 400);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("VALIDATION_FAILED", 422);
  return parsed.data;
}
export function assertMfa(
  claims: { acr?: unknown; amr?: unknown },
  accepted: string,
) {
  if (
    typeof claims.acr !== "string" ||
    !accepted.split(",").includes(claims.acr)
  )
    throw new AppError("SESSION_REQUIRED", 401);
}
