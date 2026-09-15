import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import sodium from "libsodium-wrappers";
import { RuntimeGuardError } from "./runtime-guard";

// ---------------------------------------------------------------------------
// Campaign key custody.
//
// The privacy protocol requires per-campaign sealed-box key pairs whose PRIVATE
// halves live in an isolated custody service, operated separately from the core
// application, with real deletion and recovery-window semantics. That custodian
// is production input P-003 and does not exist yet.
//
// Post-Audit Repair Pass 4 puts every call behind one provider interface and
// makes the provider an explicit configuration choice
// (CAMPAIGN_KEY_CUSTODY_PROVIDER). Exactly one provider is implemented:
//
//   development-file   the local stand-in below. NOT managed custody, NOT an
//                      HSM, NO crypto-erasure. Refused in production unless a
//                      local release rehearsal explicitly acknowledges it
//                      (CAMPAIGN_KEY_CUSTODY_REHEARSAL_ONLY); release preflight
//                      fails it in production regardless.
//
// Any other name is refused (KEY_CUSTODY_PROVIDER_UNSUPPORTED) until a real
// provider adapter is written against the custodian the owner names. The plan
// for that adapter, and what it must prove before a campaign may be called
// crypto-erased, is docs/orgfit/key-custody.md. No other local implementation
// is offered as "managed".
//
// The development provider's one non-negotiable property is that the boundary
// is ONE-WAY even in development:
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
// ---------------------------------------------------------------------------
export type CampaignKey = { keyReference: string; publicKey: Buffer };

/**
 * What a provider can truthfully say about a destruction request. The
 * processor records `summary` as the campaign key's destruction evidence.
 */
export type DestructionEvidence = {
  keyReference: string;
  provider: CustodyProviderName;
  /** LOCAL_COPY_REMOVED / ALREADY_ABSENT (development), or SCHEDULED /
   *  DESTROYED as reported by a managed provider. */
  outcome: "LOCAL_COPY_REMOVED" | "ALREADY_ABSENT" | "SCHEDULED" | "DESTROYED";
  /** false unless a managed provider attests that every usable copy and
   *  wrapping key is gone. The development provider can never set it. */
  cryptoErasure: false | "PROVIDER_ATTESTED";
  /** End of the provider's recovery window, if it has one. */
  recoverableUntil: string | null;
  /** Whether copies may survive in backups, replicas or earlier snapshots. */
  backupCopiesMayExist: boolean;
  summary: string;
};

export type CustodyProviderName = "development-file";

export interface CustodyProvider {
  readonly name: CustodyProviderName;
  readonly managed: boolean;
  createCampaignKey(): Promise<CampaignKey>;
  openCampaignKey(keyReference: string): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }>;
  destroyCampaignKey(keyReference: string): Promise<DestructionEvidence>;
}

export const REHEARSAL_ACKNOWLEDGEMENT = "development-file-is-not-managed-custody";

/**
 * The provider this environment is configured for, or a fixed refusal code.
 * Outside production an unset provider means the development stand-in.
 */
export function custodyProviderName(env: Record<string, string | undefined> = process.env): CustodyProviderName {
  const production = env.NODE_ENV === "production";
  const name = env.CAMPAIGN_KEY_CUSTODY_PROVIDER || (production ? "" : "development-file");
  if (!name) throw new RuntimeGuardError("KEY_CUSTODY_PROVIDER_REQUIRED");
  if (name !== "development-file") throw new RuntimeGuardError("KEY_CUSTODY_PROVIDER_UNSUPPORTED");
  if (production && env.CAMPAIGN_KEY_CUSTODY_REHEARSAL_ONLY !== REHEARSAL_ACKNOWLEDGEMENT)
    throw new RuntimeGuardError("KEY_CUSTODY_DEVELOPMENT_IN_PRODUCTION");
  return name;
}

export function custodyProvider(env: Record<string, string | undefined> = process.env): CustodyProvider {
  custodyProviderName(env);
  return developmentFileProvider;
}

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

// --- the development-file provider --------------------------------------------------
const developmentFileProvider: CustodyProvider = {
  name: "development-file",
  managed: false,
  // Launch side. Runs inside the staff launch transaction. Returns only the
  // campaign PUBLIC key; the private half is sealed to the custodian and this
  // process cannot open it again.
  async createCampaignKey() {
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
  },
  // Processor side only. The unwrapped private key exists in the processor's
  // memory for the duration of one batch and is zeroed by its caller.
  async openCampaignKey(keyReference) {
    const s = await ready();
    const custodianPublic = keyFromEnv("CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY");
    const sealed = await readFile(custodyPath(keyReference));
    const privateKey = s.crypto_box_seal_open(
      new Uint8Array(sealed),
      custodianPublic,
      decodeKey(custodianSecret),
    );
    return { publicKey: s.crypto_scalarmult_base(privateKey), privateKey };
  },
  // Deletion of the local sealed copy. It reports the truth, including when the
  // file was already gone, and makes no claim about backups or replicas: any
  // earlier copy of the file plus the custodian secret still opens the key.
  async destroyCampaignKey(keyReference) {
    let outcome: DestructionEvidence["outcome"] = "LOCAL_COPY_REMOVED";
    try {
      await unlink(custodyPath(keyReference));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      outcome = "ALREADY_ABSENT";
    }
    return {
      keyReference,
      provider: "development-file",
      outcome,
      cryptoErasure: false,
      recoverableUntil: null,
      backupCopiesMayExist: true,
      summary: `development-file custody: sealed key file ${outcome === "LOCAL_COPY_REMOVED" ? "unlinked" : "already absent"}; not crypto-erasure; backups or copies of the custody directory may still hold it`,
    };
  },
};

// --- the calls the rest of the code makes ------------------------------------------
export const createCampaignKey = () => custodyProvider().createCampaignKey();
export const openCampaignKey = (keyReference: string) => custodyProvider().openCampaignKey(keyReference);
export const destroyCampaignKey = (keyReference: string) => custodyProvider().destroyCampaignKey(keyReference);

export async function custodyInventory() {
  return (await readdir(custodyRoot()).catch(() => [])).filter((n) =>
    /^ck_[0-9a-f]{32}\.sealed$/.test(n),
  );
}
