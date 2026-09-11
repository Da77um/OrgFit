// DF1 encrypted draft format.
//
// Primitive: Web Crypto AES-256-GCM with a 96-bit random nonce per encryption
// and the standard 128-bit tag. The key is generated in the respondent's
// browser by crypto.getRandomValues and is NEVER sent to the server, never
// derived from the invitation token, and never derived from a password.
//
// The consequence the blueprint asks for follows directly: an administrator who
// kept a copy of the invitation link can open a session and fetch the stored
// ciphertext, and still cannot read it, because the key exists only in the
// respondent's browser and in the private resume code they hold.
//
// This module runs unchanged in the browser and in Node (both expose the same
// Web Crypto API). It contains no server-only import for that reason.

export const CIPHER_VERSION = "DF1" as const;
export type DraftPlaintext = {
  schemaVersion: 1;
  versionId: string;
  answers: Record<string, string | string[]>;
  locale: "ar" | "en";
};
export type DraftCipher = {
  handle: string;
  nonce: string; // base64
  ciphertext: string; // base64
  revision: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromBase64(value: string) {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const toBase64Url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (value: string) =>
  fromBase64(value.replace(/-/g, "+").replace(/_/g, "/"));

// Additional authenticated data binds every ciphertext to its handle, its
// pinned questionnaire version and its revision number. A ciphertext therefore
// cannot be replayed onto a different draft, a different instrument version or
// an earlier revision without the tag check failing locally in the browser.
export function draftAad(handle: string, versionId: string, revision: number) {
  return encoder.encode(
    JSON.stringify(["OrgFit", CIPHER_VERSION, handle, versionId, revision]),
  );
}
export const newDraftKeyBytes = () => crypto.getRandomValues(new Uint8Array(32));
export const newHandle = () => crypto.randomUUID();

export async function importDraftKey(raw: Uint8Array) {
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
// A fresh random nonce for every encryption, including retries that change the
// plaintext. Re-sending byte-identical ciphertext as a transport retry is safe;
// re-using a nonce for different plaintext under the same key is not, and no
// code path here does it.
export async function encryptDraft(
  key: CryptoKey,
  handle: string,
  revision: number,
  plaintext: DraftPlaintext,
) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce as BufferSource,
        additionalData: draftAad(handle, plaintext.versionId, revision) as BufferSource,
      },
      key,
      encoder.encode(JSON.stringify(plaintext)) as BufferSource,
    ),
  );
  return { nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) };
}
// No algorithm fallback and no "try the other version" path: a failed tag check
// is a failure, reported locally, with neither the key nor the plaintext
// appearing in any error report.
export async function decryptDraft(
  key: CryptoKey,
  handle: string,
  versionId: string,
  revision: number,
  nonce: string,
  ciphertext: string,
): Promise<DraftPlaintext> {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(nonce) as BufferSource,
      additionalData: draftAad(handle, versionId, revision) as BufferSource,
    },
    key,
    fromBase64(ciphertext) as BufferSource,
  );
  const value = JSON.parse(decoder.decode(plain)) as DraftPlaintext;
  if (value.schemaVersion !== 1 || value.versionId !== versionId)
    throw new Error("DRAFT_BINDING");
  return value;
}

// The private resume code. This is an ENCODING, not encryption: the code itself
// is the secret. It is shown once to the respondent, kept by them, and cannot be
// recovered by OrgFit staff — there is no server-side copy of the key half.
const CODE_PREFIX = "DF1";
export function encodeResumeCode(handle: string, key: Uint8Array) {
  return `${CODE_PREFIX}.${handle.replace(/-/g, "")}.${toBase64Url(key)}`;
}
export function parseResumeCode(code: string) {
  const parts = code.trim().replace(/\s+/g, "").split(".");
  if (parts.length !== 3 || parts[0] !== CODE_PREFIX) return null;
  const hex = parts[1].toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const handle = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  let key: Uint8Array;
  try {
    key = fromBase64Url(parts[2]);
  } catch {
    return null;
  }
  if (key.length !== 32) return null;
  return { handle, key };
}
