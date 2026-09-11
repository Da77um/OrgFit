import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withGateway, inGatewayTransaction } from "./gateway-db";
import { AppError, digest, secret } from "./security";
import { tokenPattern, tokenDigest } from "./invitation-token";
import {
  inflateInstrument,
  type NodeRecord,
  type metadata as instrumentMetadata,
} from "./instrument-records";
import { validateAnswers } from "./scoring";
import { sealEnvelope, MAX_ENVELOPE_BYTES } from "./intake-envelope";
import { ScoringError } from "./scoring";

// The respondent gateway.
//
// Trust position, stated plainly: this process is inside the privacy boundary.
// It sees the invitation context and the plaintext answers transiently, in
// memory, for validation and sealing. It must never log either, never persist
// either, and never emit a correlation identifier that could later be joined to
// an anonymous response. That is an explicit trust assumption about how this
// component is operated (blueprint 6.3), not a cryptographic property.
//
// Nothing in this module reads a client-supplied organization, campaign,
// version, report group, participant or score. Every one of those is resolved
// server-side from the session.

export const SESSION_COOKIE = "orgfit-survey";
const sessionPattern = /^[A-Za-z0-9_-]{43}$/;
const b64 = z.string().max(3_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/);

const exchangeInput = z
  .object({ token: z.string().regex(tokenPattern) })
  .strict();
const draftCreateInput = z
  .object({
    handle: z.uuid(),
    cipherVersion: z.literal("DF1"),
    nonce: b64,
    ciphertext: b64,
    expectedRevision: z.literal(0),
  })
  .strict();
const draftSaveInput = z
  .object({
    handle: z.uuid(),
    cipherVersion: z.literal("DF1"),
    nonce: b64,
    ciphertext: b64,
    expectedRevision: z.number().int().min(1).max(1_000_000),
  })
  .strict();
const resumeInput = z.object({ handle: z.uuid() }).strict();
const startOverInput = z.object({ confirmDiscard: z.literal(true) }).strict();
const answersInput = z
  .object({
    answers: z.record(
      z.string().max(100),
      z.union([z.string().max(10000), z.array(z.string().max(100)).max(100)]),
    ),
  })
  .strict();

// The public error vocabulary. It is intentionally coarse: an unknown token, a
// revoked invitation, a rotated generation and a cancelled campaign all look
// identical to a link holder.
const publicStatus: Record<string, number> = {
  SESSION_REQUIRED: 401,
  COLLECTION_UNAVAILABLE: 409,
  ALREADY_ACCEPTED: 409,
  DRAFT_EXISTS: 409,
  DRAFT_CONFLICT: 409,
  DRAFT_UNAVAILABLE: 404,
  VALIDATION_FAILED: 422,
  MALFORMED: 400,
  TEMPORARILY_UNAVAILABLE: 503,
};
export function publicError(code: string) {
  return new AppError(code, publicStatus[code] ?? 503);
}
// Database routines raise bare condition names; map them without ever letting a
// driver message, SQL fragment or bind value escape to the respondent.
function translate(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : "";
  for (const code of Object.keys(publicStatus))
    if (message === code || message.endsWith(code)) return publicError(code);
  if (error instanceof ScoringError) return publicError("VALIDATION_FAILED");
  return publicError("TEMPORARILY_UNAVAILABLE");
}

// Every exported gateway operation returns the public error vocabulary. A raw
// driver error, a bare PL/pgSQL condition name or a scoring exception must never
// reach a caller, because either can quote a value or a schema detail.
const guarded =
  <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  (...args: A): Promise<R> =>
    fn(...args).catch((e: unknown) => {
      throw translate(e);
    });

const sessionValue = (raw: string | undefined) => {
  if (!raw || !sessionPattern.test(raw)) throw publicError("SESSION_REQUIRED");
  return digest(raw);
};
const call = async <T>(client: PoolClient, sqlText: string, params: unknown[]) =>
  (await client.query<{ data: T }>(sqlText, params)).rows[0].data;

async function exchangeInner(token: string) {
  const value = secret();
  return withGateway(async (client) => {
    const context = await call<Record<string, unknown>>(
      client,
      "SELECT core.gateway_exchange($1,$2) AS data",
      [tokenDigest(token), digest(value)],
    );
    return {
      context,
      session: context.access === "UNAVAILABLE" ? null : value,
    };
  });
}
async function statusInner(sessionRaw: string | undefined) {
  const d = sessionValue(sessionRaw);
  return withGateway((client) =>
    call<Record<string, unknown>>(client, "SELECT core.gateway_status($1) AS data", [d]),
  );
}
// Refresh renews the idle window only; the absolute limit is not extendable and
// an expired absolute session requires the original link again.
async function refreshInner(sessionRaw: string | undefined) {
  const d = sessionValue(sessionRaw);
  return inGatewayTransaction(async (client) => {
    await client.query("SELECT intake.session_invitation($1,true)", [d]);
    return call<Record<string, unknown>>(
      client,
      "SELECT core.gateway_status($1) AS data",
      [d],
    );
  });
}
type InstrumentPayload = {
  versionId: string;
  instrumentHash: string;
  metadata: ReturnType<typeof instrumentMetadata>;
  nodes: NodeRecord[];
  locales: string[];
  notice: Record<string, string>;
  endsAt: string | null;
};
async function readInstrument(client: PoolClient, sessionDigest: Buffer) {
  const raw = await call<InstrumentPayload>(
    client,
    "SELECT intake.gateway_instrument($1) AS data",
    [sessionDigest],
  );
  return { raw, document: inflateInstrument(raw.metadata, raw.nodes) };
}
async function instrumentInner(sessionRaw: string | undefined) {
  const d = sessionValue(sessionRaw);
  return withGateway(async (client) => {
    const { raw, document } = await readInstrument(client, d);
    return {
      versionId: raw.versionId,
      instrumentHash: raw.instrumentHash,
      locales: raw.locales,
      notice: raw.notice,
      endsAt: raw.endsAt,
      document,
    };
  });
}
async function draftCreateInner(
  sessionRaw: string | undefined,
  body: z.infer<typeof draftCreateInput>,
) {
  const d = sessionValue(sessionRaw);
  return inGatewayTransaction((client) =>
    call<Record<string, unknown>>(
      client,
      "SELECT intake.draft_create($1,$2,$3,$4) AS data",
      [
        d,
        body.handle,
        Buffer.from(body.nonce, "base64"),
        Buffer.from(body.ciphertext, "base64"),
      ],
    ),
  );
}
async function draftSaveInner(
  sessionRaw: string | undefined,
  body: z.infer<typeof draftSaveInput>,
) {
  const d = sessionValue(sessionRaw);
  return inGatewayTransaction((client) =>
    call<Record<string, unknown>>(
      client,
      "SELECT intake.draft_save($1,$2,$3,$4,$5) AS data",
      [
        d,
        body.handle,
        Buffer.from(body.nonce, "base64"),
        Buffer.from(body.ciphertext, "base64"),
        body.expectedRevision,
      ],
    ),
  );
}
async function draftReadInner(
  sessionRaw: string | undefined,
  body: z.infer<typeof resumeInput>,
) {
  const d = sessionValue(sessionRaw);
  return withGateway((client) =>
    call<Record<string, unknown>>(
      client,
      "SELECT intake.draft_read($1,$2) AS data",
      [d, body.handle],
    ),
  );
}
async function draftStartOverInner(sessionRaw: string | undefined) {
  const d = sessionValue(sessionRaw);
  return inGatewayTransaction(async (client) => {
    await client.query("SELECT intake.draft_start_over($1)", [d]);
    return null;
  });
}
// Review is transient validation. It reserves nothing, authorizes nothing and
// persists nothing; finalization repeats every check for itself.
async function reviewInner(
  sessionRaw: string | undefined,
  body: z.infer<typeof answersInput>,
) {
  const d = sessionValue(sessionRaw);
  return withGateway(async (client) => {
    const { document } = await readInstrument(client, d);
    try {
      const { answers, missingRequired } = validateAnswers(document, body.answers);
      return {
        valid: missingRequired.length === 0,
        fieldErrors: missingRequired.map((path) => ({ path, code: "REQUIRED" })),
        answeredCount: Object.keys(answers).length,
        requiredCount: document.sections
          .flatMap((s) => s.questions)
          .filter((q) => q.type !== "CONTENT" && q.required)
          .reduce((n, q) => n + (q.type === "MATRIX" ? q.rows.length : 1), 0),
      };
    } catch (e) {
      if (e instanceof ScoringError)
        return {
          valid: false,
          fieldErrors: e.issues,
          answeredCount: 0,
          requiredCount: 0,
        };
      throw e;
    }
  });
}

// ---------------------------------------------------------------------------
// Finalization.
//
// Order of operations matters and is deliberate:
//   1. resolve the session, the pinned version and the frozen report group
//      entirely server-side;
//   2. validate the complete answer payload against that frozen instrument —
//      an invalid payload throws HERE, before anything is locked or written, so
//      it can never consume the invitation;
//   3. fetch the campaign's ACTIVE public key and seal the envelope;
//   4. call intake.accept, which takes the campaign lock then the invitation
//      lock, re-checks state/time/generation against the database clock, and
//      writes the envelope plus COMPLETED plus the draft deletion in ONE
//      transaction that must commit durably before this function returns.
// ---------------------------------------------------------------------------
async function finalizeInner(
  sessionRaw: string | undefined,
  body: z.infer<typeof answersInput>,
) {
  const d = sessionValue(sessionRaw);
  return inGatewayTransaction(async (client) => {
    const context = await call<{
      organizationId: string;
      campaignId: string;
      invitationId: string;
      versionId: string;
      instrumentHash: string;
      reportGroupId: string;
      keyReference: string;
      publicKey: string;
    }>(client, "SELECT intake.finalization_context($1) AS data", [d]);
    const { document } = await readInstrument(client, d);

    // Validation happens before any lock and before any write. An invalid
    // payload leaves the invitation READY and the campaign untouched.
    const { answers, missingRequired } = validateAnswers(document, body.answers);
    if (missingRequired.length) throw publicError("VALIDATION_FAILED");

    const sealed = await sealEnvelope(
      {
        protocol: "IN1",
        envelopeId: randomUUID(),
        organizationId: context.organizationId,
        campaignId: context.campaignId,
        invitationId: context.invitationId,
        versionId: context.versionId,
        instrumentHash: context.instrumentHash,
        reportGroupId: context.reportGroupId,
        answers,
      },
      Buffer.from(context.publicKey, "base64"),
    );
    if (sealed.length > MAX_ENVELOPE_BYTES)
      throw publicError("VALIDATION_FAILED");
    return call<{ access: string; duplicate: boolean }>(
      client,
      "SELECT intake.accept($1,$2,$3) AS data",
      [d, context.keyReference, sealed],
    );
  });
}

export const respondentInput = {
  exchangeInput,
  draftCreateInput,
  draftSaveInput,
  resumeInput,
  startOverInput,
  answersInput,
};
export { translate as translateRespondentError };

export const exchange = guarded(exchangeInner);
export const status = guarded(statusInner);
export const refresh = guarded(refreshInner);
export const instrument = guarded(instrumentInner);
export const draftCreate = guarded(draftCreateInner);
export const draftSave = guarded(draftSaveInner);
export const draftRead = guarded(draftReadInner);
export const draftStartOver = guarded(draftStartOverInner);
export const review = guarded(reviewInner);
export const finalize = guarded(finalizeInner);
