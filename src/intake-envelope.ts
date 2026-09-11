import sodium from "libsodium-wrappers";
import { z } from "zod";

// IN1 acceptance envelope.
//
// Primitive: libsodium's sealed box (crypto_box_seal / crypto_box_seal_open),
// used exactly as its documentation specifies. It gives recipient-only
// decryption and ciphertext integrity; it deliberately does NOT authenticate the
// sender, because there is no sender identity we would want to keep. Sender
// authorization is the validated invitation session plus the narrow gateway
// database routine, not a signature.
//
// Nothing here invents a construction, derives a key from an identifier, or
// hashes an identity to pretend it is anonymous.
//
// The plaintext envelope IS identity-linked. That is the point: the inbox is
// temporary identity-linked staging so acceptance can be one local transaction.
// Every one of these context fields is stripped by the processor and none of
// them reaches the anonymous store.
export const IN1 = "IN1" as const;
export const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;

export const envelopeSchema = z
  .object({
    protocol: z.literal("IN1"),
    envelopeId: z.uuid(),
    organizationId: z.uuid(),
    campaignId: z.uuid(),
    invitationId: z.uuid(),
    versionId: z.uuid(),
    instrumentHash: z.string().regex(/^[a-f0-9]{64}$/),
    reportGroupId: z.uuid(),
    answers: z.record(
      z.string().max(100),
      z.union([z.string().max(10000), z.array(z.string().max(100)).max(100)]),
    ),
  })
  .strict();
export type Envelope = z.infer<typeof envelopeSchema>;

export async function ready() {
  await sodium.ready;
  return sodium;
}
export async function sealEnvelope(envelope: Envelope, publicKey: Uint8Array) {
  const s = await ready();
  const bytes = Buffer.from(JSON.stringify(envelopeSchema.parse(envelope)), "utf8");
  if (bytes.length > MAX_ENVELOPE_BYTES) throw new Error("ENVELOPE_TOO_LARGE");
  const sealed = Buffer.from(s.crypto_box_seal(new Uint8Array(bytes), publicKey));
  if (sealed.length > MAX_ENVELOPE_BYTES) throw new Error("ENVELOPE_TOO_LARGE");
  return sealed;
}
// Processor-side. A failure here blocks the whole batch rather than quietly
// discarding one person's accepted input.
export async function openEnvelope(
  ciphertext: Buffer,
  keys: { publicKey: Uint8Array; privateKey: Uint8Array },
): Promise<Envelope> {
  const s = await ready();
  const plain = s.crypto_box_seal_open(
    new Uint8Array(ciphertext),
    keys.publicKey,
    keys.privateKey,
  );
  return envelopeSchema.parse(JSON.parse(Buffer.from(plain).toString("utf8")));
}
