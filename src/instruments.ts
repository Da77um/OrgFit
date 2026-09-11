import { sql } from "kysely";
import { z } from "zod";
import { type Tx } from "./db";
import { AppError, digest, jsonInput, uuid } from "./security";
import { preconditions } from "./directory";
import { response } from "./http";
import {
  instrumentSchema,
  definitionIssues,
  blankInstrument,
  copyInstrument,
  type Instrument,
  canonicalJson,
} from "./instrument-input";
import {
  nodeTables,
  metadata,
  flattenInstrument,
  inflateInstrument,
  type NodeRecord,
} from "./instrument-records";

export type Version = {
  id: string;
  scope_id: string;
  questionnaire_id: string;
  organization_id: string | null;
  version_number: number;
  state: "DRAFT" | "PUBLISHED" | "RETIRED";
  revision: string;
  document: Instrument;
  schema_hash: string | null;
  engine_version: string;
};
export async function instrumentAccess(
  tx: Tx,
  org: string | null,
  write = false,
) {
  if (org) {
    const r = await sql<{
      ok: boolean;
    }>`select access.has_org(${org}::uuid) ok`.execute(tx);
    if (!r.rows[0].ok) throw new AppError("NOT_FOUND", 404);
  }
  if (write) await sql`select instrument.guard(${org}::uuid)`.execute(tx);
}
export async function getVersion(
  tx: Tx,
  org: string | null,
  qid: string,
  vid: string,
): Promise<Version> {
  await instrumentAccess(tx, org);
  const r = await sql<
    Omit<Version, "document"> & { metadata: ReturnType<typeof metadata> }
  >`select id,scope_id,questionnaire_id,organization_id,version_number,state,revision,metadata,engine_version,encode(schema_hash,'hex') schema_hash from instrument.questionnaire_version where id=${vid}::uuid and questionnaire_id=${qid}::uuid and organization_id is not distinct from ${org}::uuid`.execute(
    tx,
  );
  if (!r.rows.length) throw new AppError("NOT_FOUND", 404);
  const nodes: NodeRecord[] = [];
  for (const table of nodeTables) {
    const rows = await sql<{
      position: number;
      parent_id: string | null;
      payload: Record<string, unknown>;
    }>`select position,parent_id,payload from ${sql.table("instrument." + table)} where scope_id=${r.rows[0].scope_id}::uuid and version_id=${vid}::uuid`.execute(
      tx,
    );
    nodes.push(
      ...rows.rows.map((n) => ({
        table,
        position: n.position,
        parentId: n.parent_id,
        payload: n.payload,
      })),
    );
  }
  const { metadata: meta, ...version } = r.rows[0];
  return { ...version, document: inflateInstrument(meta, nodes) };
}
export async function saveInstrument(
  tx: Tx,
  args: {
    org: string | null;
    qid?: string | null;
    vid?: string | null;
    revision?: string | null;
    action: string;
    document?: Instrument;
    sourceId?: string | null;
    idem: string;
  },
) {
  const d = args.document;
  if (d) {
    instrumentSchema.parse(d);
    if (definitionIssues(d, args.action === "PUBLISH").length)
      throw new AppError("VALIDATION_FAILED", 422);
  }
  const result = await sql<{
    id: string;
  }>`select instrument.write_version(${args.org}::uuid,${args.qid ?? null}::uuid,${args.vid ?? null}::uuid,${args.revision ?? null}::bigint,${args.action},${JSON.stringify(d ? metadata(d) : {})}::jsonb,${JSON.stringify(d && ["CREATE", "NEW_VERSION", "SAVE"].includes(args.action) ? flattenInstrument(d) : [])}::jsonb,${d ? digest(canonicalJson(d)) : null},${args.idem}::uuid,${digest(canonicalJson(args))},${args.sourceId ?? null}::uuid) id`.execute(
    tx,
  );
  if (args.action === "ARCHIVE") return { id: result.rows[0].id };
  const q = await sql<{
    questionnaire_id: string;
  }>`select questionnaire_id from instrument.questionnaire_version where id=${result.rows[0].id}::uuid`.execute(
    tx,
  );
  return getVersion(
    tx,
    args.org,
    q.rows[0].questionnaire_id,
    result.rows[0].id,
  );
}
export async function instrumentRoute(
  req: Request,
  path: string,
  tx: Tx,
): Promise<Response | null> {
  const match = path.match(
    /^(?:organizations\/([^/]+)\/)?questionnaires(?:\/([^/]+)(?:\/(versions|archive)(?:\/([^/]+)(?:\/(publish|retire|new-version|validate))?)?)?)?$/,
  );
  if (!match) return null;
  const org = match[1] ? uuid.parse(match[1]) : null,
    qid = match[2] ? uuid.parse(match[2]) : null,
    vid = match[4] ? uuid.parse(match[4]) : null,
    action = match[5];
  await instrumentAccess(tx, org, req.method !== "GET");
  if (req.method === "GET" && !qid) {
    const query = z
      .object({
        q: z.string().max(100).default(""),
        status: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).default("ACTIVE"),
        cursor: uuid.optional(),
      })
      .strict()
      .parse(Object.fromEntries(new URL(req.url).searchParams));
    const rows =
      await sql`select id,name_ar,name_en,source,status,revision from instrument.questionnaire where organization_id is not distinct from ${org}::uuid and (${query.status}='ALL' or status=${query.status}) and (${query.cursor ?? null}::uuid is null or id>${query.cursor ?? null}::uuid) and (${query.q}='' or strpos(lower(name_ar||' '||name_en),lower(${query.q}))>0) order by id limit 51`.execute(
        tx,
      );
    return response({
      items: rows.rows.slice(0, 50),
      nextCursor:
        rows.rows.length > 50 ? (rows.rows[49] as { id: string }).id : null,
    });
  }
  if (req.method === "GET" && qid) {
    if (vid) return response(await getVersion(tx, org, qid, vid));
    const q = await sql<
      Record<string, unknown>
    >`select * from instrument.questionnaire where id=${qid}::uuid and organization_id is not distinct from ${org}::uuid`.execute(
      tx,
    );
    if (!q.rows.length) throw new AppError("NOT_FOUND", 404);
    const versions =
      await sql`select id,version_number,state,revision,metadata->'title' title from instrument.questionnaire_version where questionnaire_id=${qid}::uuid order by version_number desc limit 100`.execute(
        tx,
      );
    return response({ ...q.rows[0], versions: versions.rows });
  }
  const { idem, revision } = preconditions(req, !!qid);
  if (req.method === "POST" && !qid) {
    const body = await jsonInput(
      req,
      z
        .object({
          title: z
            .object({ ar: z.string().min(1).max(500), en: z.string().max(500) })
            .strict(),
          source: z
            .object({
              organizationId: uuid.nullable(),
              questionnaireId: uuid,
              versionId: uuid,
            })
            .strict()
            .optional(),
        })
        .strict(),
    );
    if (body.source?.organizationId && body.source.organizationId !== org)
      throw new AppError("NOT_FOUND", 404);
    const d = body.source
      ? copyInstrument(
          (
            await getVersion(
              tx,
              body.source.organizationId,
              body.source.questionnaireId,
              body.source.versionId,
            )
          ).document,
        )
      : blankInstrument();
    d.title = body.title;
    return response(
      await saveInstrument(tx, {
        org,
        action: "CREATE",
        document: instrumentSchema.parse(d),
        sourceId: body.source?.versionId,
        idem,
      }),
      201,
    );
  }
  if (req.method === "POST" && qid && match[3] === "archive") {
    await jsonInput(req, z.object({}).strict());
    return response(
      await saveInstrument(tx, { org, qid, revision, action: "ARCHIVE", idem }),
    );
  }
  if (!qid || !vid) throw new AppError("NOT_FOUND", 404);
  if (req.method === "PATCH" && !action) {
    const d = await jsonInput(req, instrumentSchema);
    return response(
      await saveInstrument(tx, {
        org,
        qid,
        vid,
        revision,
        action: "SAVE",
        document: d,
        idem,
      }),
    );
  }
  if (req.method === "POST" && action) {
    await jsonInput(req, z.object({}).strict());
    const version = await getVersion(tx, org, qid, vid);
    if (version.revision !== revision)
      throw new AppError("REVISION_CONFLICT", 409);
    if (action === "validate")
      return response({ issues: definitionIssues(version.document, true) });
    if (action === "new-version")
      return response(
        await saveInstrument(tx, {
          org,
          qid,
          revision,
          action: "NEW_VERSION",
          sourceId: vid,
          document: copyInstrument(version.document),
          idem,
        }),
        201,
      );
    if (action === "publish" && definitionIssues(version.document, true).length)
      return Response.json(
        {
          code: "VALIDATION_FAILED",
          issues: definitionIssues(version.document, true),
        },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    return response(
      await saveInstrument(tx, {
        org,
        qid,
        vid,
        revision,
        action: action === "publish" ? "PUBLISH" : "RETIRE",
        document: version.document,
        idem,
      }),
    );
  }
  throw new AppError("NOT_FOUND", 404);
}
