import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import sodium from "libsodium-wrappers";

// ---------------------------------------------------------------------------
// DEVELOPMENT KEY CUSTODY STAND-IN.
//
// The privacy protocol requires per-campaign sealed-box key pairs whose PRIVATE
// halves live in an isolated custody service, operated separately from the core
// application, with real deletion and recovery-window semantics. That custodian
// is production input P-003 and does not exist yet.
//
// This module is the honest local substitute. Its one non-negotiable property
// is that the boundary is ONE-WAY even in development:
//
//   * the launching (staff) process holds only CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY.
//     It generates a campaign key pair, seals the campaign PRIVATE key to the
//     custodian's public key with libsodium's sealed box, writes that sealed
//     file, and drops the plaintext. It cannot read back anything it wrote.
//   * only the processor holds CAMPAIGN_KEY_CUSTODY_SECRET_KEY, and only the
//     processor can unseal a campaign private key.
//
// Both directions use crypto_box_seal exactly as documented. Nothing here is a
// new construction.
//
// What this is NOT: an HSM, a managed KMS, or backup-safe crypto-erasure. A
// filesystem backup taken before destruction still holds the sealed file, and
// whoever holds the custodian secret key can open it. Do not describe a
// campaign as crypto-erased on the strength of this adapter.
// ---------------------------------------------------------------------------
export type CampaignKey = { keyReference: string; publicKey: Buffer };

export async function ready() {
  await sodium.ready;
  return sodium;
}
// Generated once by the operator; the public half is safe to give the staff
// deployment, the secret half must reach only the processor deployment.
export async function generateCustodianKeypair() {
  const s = await ready();
  const pair = s.crypto_box_keypair();
  return {
    publicKey: Buffer.from(pair.publicKey).toString("base64"),
    secretKey: Buffer.from(pair.privateKey).toString("base64"),
  };
}
function decodeKey(value: string | undefined) {
  if (!value) throw new Error("Key custody is unavailable");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) throw new Error("Key custody is unavailable");
  return new Uint8Array(bytes);
}
const keyFromEnv = (name: string) => decodeKey(process.env[name]);

// The custodian SECRET is an explicit input to the opening side, never ambient
// state that a process could acquire by accident. A deployed processor sets it
// once at start-up from its own environment; the staff process has no call site
// for it at all, and src/config.ts refuses to start if the variable is present.
let custodianSecret: string | undefined;
export function setCustodianSecret(value: string | undefined) {
  custodianSecret = value;
}
export function loadCustodianSecretFromEnvironment() {
  setCustodianSecret(process.env.CAMPAIGN_KEY_CUSTODY_SECRET_KEY);
}
function custodyRoot() {
  const dir = process.env.CAMPAIGN_KEY_CUSTODY_DIRECTORY;
  if (!dir) throw new Error("Key custody is unavailable");
  return resolve(dir);
}
function custodyPath(keyReference: string) {
  if (!/^ck_[0-9a-f]{32}$/.test(keyReference))
    throw new Error("Key custody is unavailable");
  return resolve(custodyRoot(), `${keyReference}.sealed`);
}

// Launch side. Runs inside the staff launch transaction. Returns only the
// campaign PUBLIC key; the private half is sealed to the custodian and this
// process cannot open it again.
export async function createCampaignKey(): Promise<CampaignKey> {
  const s = await ready();
  const custodian = keyFromEnv("CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY");
  const reference = `ck_${randomBytes(16).toString("hex")}`;
  const pair = s.crypto_box_keypair();
  const sealed = Buffer.from(s.crypto_box_seal(pair.privateKey, custodian));
  const path = custodyPath(reference);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, sealed, { mode: 0o600, flag: "wx" });
  pair.privateKey.fill(0);
  return { keyReference: reference, publicKey: Buffer.from(pair.publicKey) };
}
// Processor side only. The unwrapped private key exists in the processor's
// memory for the duration of one batch and is zeroed by its caller.
export async function openCampaignKey(keyReference: string) {
  const s = await ready();
  const custodianPublic = keyFromEnv("CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY");
  const sealed = await readFile(custodyPath(keyReference));
  const privateKey = s.crypto_box_seal_open(
    new Uint8Array(sealed),
    custodianPublic,
    decodeKey(custodianSecret),
  );
  return { publicKey: s.crypto_scalarmult_base(privateKey), privateKey };
}
// Deletion of the local sealed copy. It reports the truth, including when the
// file was already gone, and makes no claim about backups or replicas.
export async function destroyCampaignKey(keyReference: string) {
  try {
    await unlink(custodyPath(keyReference));
    return { keyReference, removed: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { keyReference, removed: false };
    throw e;
  }
}
export async function custodyInventory() {
  return (await readdir(custodyRoot()).catch(() => [])).filter((n) =>
    /^ck_[0-9a-f]{32}\.sealed$/.test(n),
  );
}
