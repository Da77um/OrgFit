import { randomUUID, randomInt } from "node:crypto";
import pg from "pg";
import { openEnvelope, type Envelope } from "./intake-envelope";
import { openCampaignKey, destroyCampaignKey } from "./key-custody";
import {
  inflateInstrument,
  type NodeRecord,
  type metadata as instrumentMetadata,
} from "./instrument-records";
import type { Instrument, Question } from "./instrument-input";
import { scoreInstrument, ENGINE_VERSION } from "./scoring";
import { OVERALL_DEFINITION_KEY } from "./disclosure";
import { databaseUrl } from "./runtime-guard";

// ---------------------------------------------------------------------------
// The trusted privacy processor.
//
// It runs as its own operating-system and database identity. It is the ONLY
// component that can decrypt an accepted envelope, and it can do so only for a
// campaign that is CLOSED and already frozen into a batch. It holds no staff
// credential, no participant read, no draft access and no HTTP surface.
//
// Its job is a single whole-campaign transformation:
//   frozen ciphertext set  ->  decrypt in memory  ->  verify each envelope
//   against the frozen manifest  ->  discard every identity and transport field
//   ->  reduce grouping to the approved department/other group  ->  shuffle
//   ->  fresh random response IDs  ->  ONE atomic anonymous transaction that
//   includes the batch marker.
//
// What it deliberately does not do: stream partial results, keep an
// input-to-output receipt, write anything per-person into an operational log,
// or "skip the bad one". A single unexplained envelope blocks the whole batch.
//
// Honest limits: this reduces order and timing correlation. It is not a
// formally verified mix network, and it provides no protection against an
// operator who can observe this process's memory or hold both databases and the
// custody key at once. That remains blueprint 1.3 and production input P-001.
// ---------------------------------------------------------------------------

// The stable key the composite overall score is stored under. It is shared with
// the disclosure engine so publication reads back exactly what was written.
export const NIL_UUID = OVERALL_DEFINITION_KEY;
export type ProcessorOutcome = {
  campaignId: string;
  batchId: string;
  state: string;
  acceptedCount: number;
  processedCount: number | null;
  reused: boolean;
  note?: string;
};
// Named fault-injection points. Tests throw at a real boundary rather than
// replacing the database with a mock, so the recovery path being exercised is
// the production one.
export type FaultPoint =
  | "afterFreeze"
  | "afterDecrypt"
  | "duringAnonymousTransfer"
  | "afterAnonymousCommit"
  | "afterOutputCommitted"
  | "afterIntakeCleanup";
export type ProcessorOptions = {
  fault?: (point: FaultPoint) => void | Promise<void>;
  now?: () => Date;
};

// Login, password and — in production — verified TLS are checked here, before
// a pool exists, rather than only by release preflight (RC-004).
export function corePool(url = process.env.PROCESSOR_DATABASE_URL) {
  return new pg.Pool({
    connectionString: databaseUrl(url, "orgfit_processor"),
    max: 4,
    application_name: "orgfit_processor",
  });
}
export function anonymousPool(url = process.env.ANONYMOUS_DATABASE_URL) {
  return new pg.Pool({
    connectionString: databaseUrl(url, "orgfit_processor"),
    max: 4,
    application_name: "orgfit_processor_anon",
  });
}

// Fisher-Yates over a cryptographic RNG. The shuffle is what removes the
// arrival order of the frozen set from the committed output.
export function shuffle<T>(items: T[]) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// Answers arrive keyed by question id (or matrix row id). The anonymous store
// keeps the STABLE key instead, so an instrument copy cannot be used to line up
// two versions by internal identifier.
function stableKeys(document: Instrument) {
  const map = new Map<string, { key: string; question: Question }>();
  for (const q of document.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    if (q.type === "MATRIX")
      for (const row of q.rows) map.set(row.id, { key: row.key, question: q });
    else map.set(q.id, { key: q.key, question: q });
  }
  return map;
}
function typedValue(question: Question, value: string | string[]) {
  switch (question.type) {
    case "CHECKBOXES":
      return { type: "OPTION_SET", optionIds: value as string[] };
    case "MULTIPLE_CHOICE":
    case "DROPDOWN":
    case "YES_NO":
    case "MATRIX":
      return { type: "OPTION", optionId: value as string };
    case "NUMBER":
    case "RATING_5":
    case "RATING_10":
      return { type: "NUMBER", value: value as string };
    case "DATE":
      return { type: "DATE", value: value as string };
    default:
      return { type: "TEXT", value: value as string };
  }
}

type BatchInfo = {
  batchId: string;
  organizationId: string;
  campaignId: string;
  acceptedCount: number;
  manifestHash: string;
  state: string;
  leaseGeneration: string | number;
  keyReferences: string[];
  created: boolean;
};
type BatchPayload = {
  batchId: string;
  organizationId: string;
  campaignId: string;
  versionId: string;
  acceptedCount: number;
  state: string;
  manifestHash: string;
  manifest: {
    instrumentHash: string;
    versionId: string;
    allowedGroups: { id: string; kind: string; label: Record<string, string> }[];
    policy: Record<string, unknown>;
  };
  threshold: number;
  envelopes: { keyReference: string; ciphertext: string }[];
  instrument: {
    metadata: ReturnType<typeof instrumentMetadata>;
    nodes: NodeRecord[];
  };
};

const one = async <T>(db: pg.Pool | pg.PoolClient, text: string, params: unknown[]) =>
  (await db.query<{ data: T }>(text, params)).rows[0].data;

async function markerFor(anon: pg.Pool, org: string, campaign: string) {
  const { rows } = await anon.query<{
    id: string;
    response_count: number;
    manifest_hash: string;
  }>(
    `SELECT id, response_count, encode(manifest_hash,'hex') AS manifest_hash
       FROM anonymous.processed_batch WHERE organization_id=$1 AND campaign_id=$2`,
    [org, campaign],
  );
  return rows[0] ?? null;
}

export async function processCampaign(
  core: pg.Pool,
  anon: pg.Pool,
  campaignId: string,
  options: ProcessorOptions = {},
): Promise<ProcessorOutcome> {
  const fault = async (point: FaultPoint) => options.fault?.(point);

  // 1. Freeze, or take the lease on the batch that already exists. Never
  //    re-derive the frozen set: a second call returns the same identifier,
  //    the same count and the same assigned envelopes.
  const batch = await one<BatchInfo>(core, "SELECT intake.freeze_batch($1) AS data", [
    campaignId,
  ]);
  const lease = Number(batch.leaseGeneration);
  await fault("afterFreeze");

  const finish = (state: string, processed: number | null, note?: string) => ({
    campaignId,
    batchId: batch.batchId,
    state,
    acceptedCount: batch.acceptedCount,
    processedCount: processed,
    reused: !batch.created,
    note,
  });

  // 2. Below the threshold there is no decryption for results at all. The
  //    campaign yields a suppression state only, and the intake is purged.
  if (batch.state === "INSUFFICIENT") {
    await core.query("SELECT intake.batch_cleanup($1,$2,$3)", [
      batch.batchId,
      lease,
      "insufficient-data: purged without decryption",
    ]);
    await destroyKeys(batch);
    await core.query("SELECT intake.batch_state($1,$2,$3,$4,$5)", [
      batch.batchId,
      lease,
      "PURGED",
      0,
      null,
    ]);
    // A suppressed campaign is exactly the case the blueprint wants erased
    // soonest, so its key register must reach DESTROYED with recorded evidence
    // like any other. Skipping this left an unresolved DELETE_REQUESTED row for
    // ever. It runs after PURGED because keys_destroyed only advances a batch
    // that is still CLEANUP_PENDING, so the terminal state is preserved.
    await core.query("SELECT intake.keys_destroyed($1,$2,$3)", [
      batch.batchId,
      lease,
      "insufficient-data: sealed campaign keys destroyed without decryption",
    ]);
    return finish("PURGED", 0, "below threshold; never decrypted");
  }
  if (batch.state === "CLEANED" || batch.state === "PURGED")
    return finish(batch.state, null, "already complete");

  // 3. Crash recovery, before doing anything expensive: if the marker already
  //    exists the output is committed and only cleanup remains. Querying the
  //    marker is how an uncertain commit is resolved — never by appending.
  let marker = await markerFor(anon, batch.organizationId, campaignId);
  let processed: number | null = null;

  if (!marker) {
    await core.query("SELECT intake.batch_state($1,$2,$3,$4,$5)", [
      batch.batchId,
      lease,
      "PROCESSING",
      null,
      null,
    ]);
    const payload = await one<BatchPayload>(
      core,
      "SELECT intake.batch_payload($1,$2) AS data",
      [batch.batchId, lease],
    );
    if (payload.envelopes.length !== payload.acceptedCount)
      throw new Error("COUNT_MISMATCH");

    // The pinned instrument arrives inside the batch payload. The processor
    // holds no privilege on the instrument tables and needs none.
    const document = inflateInstrument(payload.instrument.metadata, payload.instrument.nodes);
    const keys = new Map<string, Awaited<ReturnType<typeof openCampaignKey>>>();
    let rows: AnonymousRow[];
    try {
      for (const reference of new Set(payload.envelopes.map((e) => e.keyReference)))
        keys.set(reference, await openCampaignKey(reference));
      rows = await transform(payload, document, keys);
      await fault("afterDecrypt");
    } finally {
      // The unwrapped private keys leave this scope immediately, whether the
      // batch succeeded or failed.
      for (const k of keys.values()) k.privateKey.fill(0);
      keys.clear();
    }

    await commitAnonymous(anon, payload, rows, document, fault);
    await fault("afterAnonymousCommit");
    marker = await markerFor(anon, batch.organizationId, campaignId);
    processed = rows.length;
  } else {
    // A marker whose count or manifest does not match the frozen batch is an
    // incident, not something to overwrite or reconcile silently.
    if (
      marker.id !== batch.batchId ||
      marker.response_count !== batch.acceptedCount ||
      marker.manifest_hash !== batch.manifestHash
    ) {
      await core.query("SELECT intake.batch_state($1,$2,$3,$4,$5)", [
        batch.batchId,
        lease,
        "FAILED",
        null,
        "MARKER_MISMATCH",
      ]);
      throw new Error("MARKER_MISMATCH");
    }
    processed = marker.response_count;
  }
  if (!marker) throw new Error("MARKER_MISSING");

  await core.query("SELECT intake.batch_state($1,$2,$3,$4,$5)", [
    batch.batchId,
    lease,
    "OUTPUT_COMMITTED",
    processed,
    null,
  ]);
  await fault("afterOutputCommitted");

  // 4. Only now, with the marker proven, is intake cleanup authorized.
  await core.query("SELECT intake.batch_cleanup($1,$2,$3)", [
    batch.batchId,
    lease,
    `anonymous marker ${marker.id} count ${marker.response_count}`,
  ]);
  await fault("afterIntakeCleanup");
  const evidence = await destroyKeys(batch);
  const state = await core.query<{ keys_destroyed: string }>(
    "SELECT intake.keys_destroyed($1,$2,$3) AS keys_destroyed",
    [batch.batchId, lease, evidence],
  );
  return finish(state.rows[0].keys_destroyed, processed);
}

// Destruction of the sealed private-key copies for this campaign. It is
// campaign-granular, so it never affects another campaign's material, and it
// deliberately makes no claim about backups, replicas or WAL. The evidence
// recorded is what the custody provider itself reports (Pass 4), so a local
// file removal can never be written down as crypto-erasure.
async function destroyKeys(batch: BatchInfo) {
  const summaries = new Set<string>();
  for (const reference of batch.keyReferences)
    summaries.add((await destroyCampaignKey(reference)).summary);
  return [...summaries].join(" | ") || "no campaign key references";
}

type AnonymousRow = {
  responseId: string;
  reportGroupId: string;
  answers: { questionKey: string; typedValue: unknown }[];
  scores: {
    definitionKey: string;
    raw: number | null;
    normalized: number | null;
    coverage: number;
    status: string;
  }[];
};

async function transform(
  payload: BatchPayload,
  document: Instrument,
  keys: Map<string, Awaited<ReturnType<typeof openCampaignKey>>>,
) {
  const allowed = new Map(payload.manifest.allowedGroups.map((g) => [g.id, g.kind]));
  const keyed = stableKeys(document);
  const seen = new Set<string>();
  const rows: AnonymousRow[] = [];

  for (const item of payload.envelopes) {
    const key = keys.get(item.keyReference);
    if (!key) throw new Error("KEY_MISSING");
    let envelope: Envelope;
    try {
      envelope = await openEnvelope(Buffer.from(item.ciphertext, "base64"), key);
    } catch {
      // Never quietly drop a person's accepted input.
      throw new Error("ENVELOPE_UNREADABLE");
    }
    // The envelope's own context is compared with the frozen manifest, which
    // catches an accidental ciphertext substitution between invitations or
    // campaigns before anything is written.
    if (
      envelope.organizationId !== payload.organizationId ||
      envelope.campaignId !== payload.campaignId ||
      envelope.versionId !== payload.versionId ||
      envelope.instrumentHash !== payload.manifest.instrumentHash
    )
      throw new Error("ENVELOPE_CONTEXT_MISMATCH");
    const kind = allowed.get(envelope.reportGroupId);
    if (!kind || kind === "COMPANY") throw new Error("ENVELOPE_GROUP_INVALID");
    // One envelope per invitation is a database constraint; this is the second
    // check, and it is the last point at which invitationId is looked at at all.
    if (seen.has(envelope.invitationId)) throw new Error("DUPLICATE_ENVELOPE");
    seen.add(envelope.invitationId);

    const result = scoreInstrument(document, envelope.answers, {
      engineVersion: ENGINE_VERSION,
      configVersion: payload.manifest.instrumentHash,
    });
    if (result.missingRequired.length) throw new Error("ENVELOPE_INCOMPLETE");

    const answers = Object.entries(envelope.answers).map(([id, value]) => {
      const entry = keyed.get(id);
      if (!entry) throw new Error("ENVELOPE_UNKNOWN_ANSWER");
      return {
        questionKey: entry.key,
        typedValue: typedValue(entry.question, value),
      };
    });
    const scores = Object.entries(result.dimensions).map(([dimensionId, metric]) => ({
      definitionKey:
        document.dimensions.find((d) => d.id === dimensionId)?.key ?? NIL_UUID,
      raw: metric.raw,
      normalized: metric.normalized,
      coverage: metric.coverage,
      status: metric.status,
    }));
    if (result.overall)
      scores.push({
        definitionKey: NIL_UUID,
        raw: result.overall.raw,
        normalized: result.overall.normalized,
        coverage: result.overall.coverage,
        status: result.overall.status,
      });

    // THIS is the strip. Everything from the envelope other than the coarse
    // report group and the answers is dropped here and never leaves the loop:
    // envelopeId, organizationId's link to a person, invitationId, and every
    // transport attribute the request ever carried.
    rows.push({
      responseId: randomUUID(),
      reportGroupId: envelope.reportGroupId,
      answers,
      scores,
    });
  }
  if (rows.length !== payload.acceptedCount) throw new Error("COUNT_MISMATCH");
  return shuffle(rows);
}

// One anonymous transaction. Manifest, groups, responses, answers, scores and
// the batch marker commit together or not at all. There is no visible staging.
async function commitAnonymous(
  anon: pg.Pool,
  payload: BatchPayload,
  rows: AnonymousRow[],
  document: Instrument,
  fault: (point: FaultPoint) => Promise<void>,
) {
  const client = await anon.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO anonymous.anonymous_campaign_manifest
       (id,organization_id,questionnaire_version_id,instrument_snapshot,instrument_hash,policy_snapshot,manifest_hash,threshold)
       VALUES($1,$2,$3,$4,decode($5,'hex'),$6,sha256(convert_to($7,'UTF8')),$8)
       ON CONFLICT (id) DO NOTHING`,
      [
        payload.campaignId,
        payload.organizationId,
        payload.versionId,
        // The pinned questionnaire travels with the batch. Publication has to
        // resolve dimension names, option labels and bands months later, when
        // the intake it came from has been purged, and the anonymous store must
        // not depend on a live read of a core instrument table to do it. The
        // document is configuration, identical for every respondent.
        JSON.stringify({ manifest: payload.manifest, instrument: document }),
        payload.manifest.instrumentHash,
        JSON.stringify(payload.manifest.policy),
        JSON.stringify(payload.manifest),
        payload.threshold,
      ],
    );
    for (const group of payload.manifest.allowedGroups)
      await client.query(
        `INSERT INTO anonymous.anonymous_group(id,organization_id,campaign_id,kind,label)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [
          group.id,
          payload.organizationId,
          payload.campaignId,
          group.kind,
          JSON.stringify(group.label),
        ],
      );
    await fault("duringAnonymousTransfer");
    for (const row of rows) {
      await client.query(
        `INSERT INTO anonymous.anonymous_response
         (id,organization_id,campaign_id,questionnaire_version_id,report_group_id)
         VALUES($1,$2,$3,$4,$5)`,
        [
          row.responseId,
          payload.organizationId,
          payload.campaignId,
          payload.versionId,
          row.reportGroupId,
        ],
      );
      for (const answer of row.answers)
        await client.query(
          `INSERT INTO anonymous.anonymous_answer
           (organization_id,campaign_id,response_id,question_key,typed_value)
           VALUES($1,$2,$3,$4,$5)`,
          [
            payload.organizationId,
            payload.campaignId,
            row.responseId,
            answer.questionKey,
            JSON.stringify(answer.typedValue),
          ],
        );
      for (const score of row.scores)
        await client.query(
          `INSERT INTO anonymous.response_score
           (organization_id,campaign_id,response_id,definition_key,engine_version,raw_value,normalized_value,coverage,status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            payload.organizationId,
            payload.campaignId,
            row.responseId,
            score.definitionKey,
            ENGINE_VERSION,
            score.raw,
            score.normalized,
            score.coverage,
            score.status,
          ],
        );
    }
    // The marker's UNIQUE(organization_id,campaign_id) is the last duplicate
    // guard: a stale worker delivering the same batch again fails here and
    // rolls back its entire transaction rather than appending a second copy.
    await client.query(
      `INSERT INTO anonymous.processed_batch
       (id,organization_id,campaign_id,response_count,manifest_hash,engine_version)
       VALUES($1,$2,$3,$4,decode($5,'hex'),$6)`,
      [
        payload.batchId,
        payload.organizationId,
        payload.campaignId,
        rows.length,
        payload.manifestHash,
        ENGINE_VERSION,
      ],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
// Campaign-level release readiness. Every field here is a count or a status;
// none of it distinguishes an individual.
export type Readiness = {
  campaignId: string;
  organizationId: string;
  campaignState: string;
  threshold: number;
  acceptedCount: number;
  batchState: string | null;
  batchAcceptedCount: number | null;
  processedCount: number | null;
  countsAgree: boolean;
  releasable: boolean;
};
// Reconciliation for operators and for Phase 08's release gate.
export async function reconcile(core: pg.Pool, anon: pg.Pool, campaignId: string) {
  const readiness = await one<Readiness>(
    core,
    "SELECT core.release_readiness($1) AS data",
    [campaignId],
  );
  const marker = await markerFor(anon, readiness.organizationId, campaignId);
  const anonymousCount = marker?.response_count ?? null;
  return {
    ...readiness,
    anonymousCount,
    // Counts that disagree block publication. This is reported, never repaired
    // by adjusting a count or by marking anyone incomplete.
    blocked:
      readiness.releasable !== true ||
      anonymousCount === null ||
      anonymousCount !== readiness.acceptedCount,
  };
}
