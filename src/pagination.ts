import { z } from "zod";
import { AppError } from "./security";

// ---------------------------------------------------------------------------
// Opaque keyset cursors for the administration lists.
//
// A cursor is the ORDER BY key of the last row a page returned, base64url
// encoded. It is opaque to callers so that its shape can change without a
// contract change, and it is validated on the way back in: a tampered or
// malformed cursor is a 422, never a database error and never "start over".
// The database repeats every check, so a cursor that decodes cleanly still
// grants nothing the caller's role does not.
// ---------------------------------------------------------------------------

export const PAGE_DEFAULT = 25;
export const PAGE_MAX = 100;

export function encodeCursor(key: unknown): string | null {
  if (!Array.isArray(key) || key.length !== 2) return null;
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine((v) => !Number.isNaN(Date.parse(v)));

export const cursorKinds = {
  // (email, id) ascending
  staff: z.tuple([z.string().min(3).max(320), z.uuid()]),
  // (created_at | occurred_at, id) descending, at microsecond precision
  time: z.tuple([instant, z.uuid()]),
};

export function decodeCursor<T>(
  value: string | null,
  schema: z.ZodType<T>,
): T | null {
  if (value === null) return null;
  if (!/^[A-Za-z0-9_-]{1,1000}$/.test(value))
    throw new AppError("VALIDATION_FAILED", 422);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new AppError("VALIDATION_FAILED", 422);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new AppError("VALIDATION_FAILED", 422);
  return result.data;
}

/**
 * Reads a query string against an allowlist. An unknown or repeated key is
 * refused rather than ignored: a filter the server silently dropped would show
 * the reader a list they believe is narrower than it is.
 */
export function readQuery<T extends z.ZodRawShape>(
  url: URL,
  shape: T,
): z.infer<z.ZodObject<T>> {
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length)
    throw new AppError("VALIDATION_FAILED", 422);
  const raw: Record<string, string> = {};
  for (const key of keys) {
    if (!(key in shape)) throw new AppError("VALIDATION_FAILED", 422);
    const v = url.searchParams.get(key) ?? "";
    // An empty value means "no filter", the way a form submits a blank select.
    if (v !== "") raw[key] = v;
  }
  const result = z.object(shape).strict().safeParse(raw);
  if (!result.success) throw new AppError("VALIDATION_FAILED", 422);
  return result.data;
}

export const pageSize = z.coerce
  .number()
  .int()
  .min(1)
  .max(PAGE_MAX)
  .default(PAGE_DEFAULT);
