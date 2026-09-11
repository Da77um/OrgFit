import JSZip from "jszip";
import {
  ALLOWED_TYPES,
  allowedTypes,
  allowedExtensions,
  ATTACHMENT_MAX_BYTES,
  type AllowedType,
} from "./attachment-types";

export { ALLOWED_TYPES, allowedTypes, allowedExtensions, type AllowedType };

// ---------------------------------------------------------------------------
// What an attachment is allowed to be, decided by reading the bytes.
//
// Everything in this file is pure: no database, no clock, no network, no
// authorization. It is given a buffer and the name and type the browser
// claimed, and it returns a verdict. That makes the interesting cases — a
// renamed executable, an HTML page called a PDF, a macro-enabled workbook —
// testable as data rather than as a deployment.
//
// Two rules govern the whole file:
//
//   1. The declared type is EVIDENCE, never authority. A file is what its bytes
//      say it is; if the two disagree the upload is rejected rather than
//      silently relabelled, because a consultant who uploaded "report.pdf" and
//      gets back a Word document has been misled by their own tool.
//   2. Anything that can execute is rejected, including inside a container.
//      An OOXML file is a zip, and a zip can carry a macro project, a nested
//      archive or a script; the allowlist is applied to the parts as well.
// ---------------------------------------------------------------------------

export type ScanVerdict =
  | { verdict: "CLEAN"; contentType: AllowedType }
  | { verdict: "REJECTED"; code: RejectionCode };

export type RejectionCode =
  | "TYPE_NOT_ALLOWED"
  | "TYPE_MISMATCH"
  | "EXTENSION_MISMATCH"
  | "TOO_LARGE"
  | "EMPTY"
  | "ACTIVE_CONTENT"
  | "MACRO_CONTENT"
  | "NESTED_ARCHIVE"
  | "CONTAINER_UNREADABLE"
  | "MALWARE_SIGNATURE"
  | "CHECKSUM_MISMATCH";

const starts = (bytes: Buffer, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, i) => bytes[offset + i] === byte);

/** The container formats an OOXML document and a zip bomb share. */
const isZip = (bytes: Buffer) =>
  starts(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
  starts(bytes, [0x50, 0x4b, 0x05, 0x06]);

/**
 * The actual format, from the leading bytes only. A zip returns `null` here and
 * is resolved by reading its parts, because DOCX and XLSX are the same magic
 * number and neither is decided by a file name.
 */
export function sniff(bytes: Buffer): AllowedType | "zip" | null {
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    starts(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    starts(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  )
    return "image/gif";
  if (
    starts(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return "image/webp";
  if (isZip(bytes)) return "zip";
  return null;
}

// Executable and active-content signatures, checked at the head of the file.
// The list is short and deliberate: it names what must never be stored, rather
// than trying to enumerate what may be.
const EXECUTABLE: { name: string; signature: number[] }[] = [
  { name: "dos", signature: [0x4d, 0x5a] }, // MZ: .exe, .dll, .sys
  { name: "elf", signature: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "macho", signature: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: "macho-fat", signature: [0xca, 0xfe, 0xba, 0xbe] },
  { name: "shebang", signature: [0x23, 0x21] }, // #!
  { name: "class", signature: [0xca, 0xfe, 0xba, 0xbf] },
];
const ARCHIVE: { name: string; signature: number[] }[] = [
  { name: "rar", signature: [0x52, 0x61, 0x72, 0x21] },
  { name: "7z", signature: [0x37, 0x7a, 0xbc, 0xaf] },
  { name: "gzip", signature: [0x1f, 0x8b] },
  { name: "xz", signature: [0xfd, 0x37, 0x7a, 0x58, 0x5a] },
  { name: "cab", signature: [0x4d, 0x53, 0x43, 0x46] },
];

// Markup that a browser would execute if it were ever served inline. An SVG or
// an HTML page renamed to .png reaches this even though it has no executable
// magic number of its own.
const ACTIVE_MARKUP =
  /<\s*(script|iframe|object|embed|svg|html|!doctype\s+html)\b|javascript:/i;

/** The EICAR anti-malware test file, used to prove the scan path actually
 * rejects rather than merely being configured. A real deployment replaces this
 * heuristic scanner with a maintained engine; that is production input P-010. */
const EICAR =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export function malwareSignature(bytes: Buffer) {
  // Bounded: the marker is 68 bytes and lives at the head of the sample.
  return bytes.subarray(0, 4096).toString("latin1").includes(EICAR);
}

function extensionOf(filename: string) {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}

// Parts inside an OOXML container that make it something other than a document.
const MACRO_PART =
  /vbaproject\.bin$|vbadata\.xml$|\.(bin|exe|dll|js|jse|vbs|vbe|wsf|ps1|bat|cmd|scr|hta|jar|lnk)$/i;
const NESTED_ARCHIVE_PART = /\.(zip|rar|7z|gz|xz|cab|tar|iso)$/i;

/**
 * Resolve a zip container to a document type by reading its parts, and refuse
 * anything that is not exactly a Word or Excel document. A macro-enabled
 * workbook is a legitimate file; it is not a legitimate attachment here.
 */
async function inspectContainer(bytes: Buffer): Promise<ScanVerdict> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { verdict: "REJECTED", code: "CONTAINER_UNREADABLE" };
  }
  const names = Object.keys(zip.files);
  if (!names.some((n) => n.toLowerCase() === "[content_types].xml"))
    return { verdict: "REJECTED", code: "TYPE_NOT_ALLOWED" };
  for (const name of names) {
    // A part named ../ escapes on extraction in some readers. The document is
    // never extracted here, but a file carrying one is not a document.
    if (name.includes("..") || name.startsWith("/"))
      return { verdict: "REJECTED", code: "ACTIVE_CONTENT" };
    if (MACRO_PART.test(name))
      return { verdict: "REJECTED", code: "MACRO_CONTENT" };
    if (NESTED_ARCHIVE_PART.test(name))
      return { verdict: "REJECTED", code: "NESTED_ARCHIVE" };
  }
  const types = await zip.file("[Content_Types].xml")?.async("string");
  if (types && /macroEnabled/i.test(types))
    return { verdict: "REJECTED", code: "MACRO_CONTENT" };
  const hasWord = names.some((n) => n.toLowerCase().startsWith("word/"));
  const hasExcel = names.some((n) => n.toLowerCase().startsWith("xl/"));
  if (hasWord && !hasExcel)
    return {
      verdict: "CLEAN",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  if (hasExcel && !hasWord)
    return {
      verdict: "CLEAN",
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  return { verdict: "REJECTED", code: "TYPE_NOT_ALLOWED" };
}

/**
 * The whole verdict for one uploaded file. Order matters: cheap structural
 * rejections happen before the container is parsed, so a hostile archive is
 * never expanded to find out that it was not allowed anyway.
 */
export async function verifyAttachment(input: {
  bytes: Buffer;
  filename: string;
  declaredType: string;
}): Promise<ScanVerdict> {
  const { bytes, filename, declaredType } = input;
  if (bytes.length === 0) return { verdict: "REJECTED", code: "EMPTY" };
  if (bytes.length > ATTACHMENT_MAX_BYTES)
    return { verdict: "REJECTED", code: "TOO_LARGE" };
  if (malwareSignature(bytes))
    return { verdict: "REJECTED", code: "MALWARE_SIGNATURE" };
  for (const { signature } of EXECUTABLE)
    if (starts(bytes, signature))
      return { verdict: "REJECTED", code: "ACTIVE_CONTENT" };
  for (const { signature } of ARCHIVE)
    if (starts(bytes, signature))
      return { verdict: "REJECTED", code: "NESTED_ARCHIVE" };
  const detected = sniff(bytes);
  if (detected === null) {
    // Nothing on the allowlist begins this way. If it also looks like markup,
    // say so precisely — that is the case a reviewer most wants named.
    return {
      verdict: "REJECTED",
      code: ACTIVE_MARKUP.test(bytes.subarray(0, 2048).toString("utf8"))
        ? "ACTIVE_CONTENT"
        : "TYPE_NOT_ALLOWED",
    };
  }
  const resolved =
    detected === "zip"
      ? await inspectContainer(bytes)
      : ({ verdict: "CLEAN", contentType: detected } as ScanVerdict);
  if (resolved.verdict === "REJECTED") return resolved;
  // The bytes are a permitted format. Now the two claims the browser made have
  // to agree with them, or the upload is refused rather than relabelled.
  if (declaredType.split(";")[0].trim().toLowerCase() !== resolved.contentType)
    return { verdict: "REJECTED", code: "TYPE_MISMATCH" };
  if (
    !(ALLOWED_TYPES[resolved.contentType] as readonly string[]).includes(
      extensionOf(filename),
    )
  )
    return { verdict: "REJECTED", code: "EXTENSION_MISMATCH" };
  return resolved;
}
