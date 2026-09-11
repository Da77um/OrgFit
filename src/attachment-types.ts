// The attachment allowlist and its limits.
//
// Deliberately a module of its own with no imports at all: the browser form
// needs the permitted types and the size ceiling, and it must not pull in the
// storage adapter, the object-store client or the zip reader to get them.
export const ALLOWED_TYPES = {
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    ".docx",
  ],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
    ".xlsx",
  ],
} as const;
export type AllowedType = keyof typeof ALLOWED_TYPES;
export const allowedTypes = Object.keys(ALLOWED_TYPES) as AllowedType[];
export const allowedExtensions = Object.values(ALLOWED_TYPES).flat();

/** The blueprint's suggested ceiling. A larger file is refused at the HTTP
 * boundary, at the storage adapter and by a table constraint. */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** Attachments are consulting records, not short-lived artifacts: they are kept
 * for the engagement rather than for a day. This is a product default; the
 * operator input that fixes it for a real deployment is P-004, and the type and
 * size allowlist itself is P-007. */
export const ATTACHMENT_RETENTION_DAYS = 365;
/** Bytes that never reached a verdict, and rejected or failed ones, lose their
 * content quickly. Only the metadata row survives, as audit. */
export const ATTACHMENT_ORPHAN_HOURS = 24;

/** The formats a browser can render inline under a locked-down policy. Anything
 * else is a download. */
export const previewableType = (contentType: string | null | undefined) =>
  !!contentType &&
  /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(contentType);
