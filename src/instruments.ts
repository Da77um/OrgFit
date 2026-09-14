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
// Questionnaire targeting (020). The organization always owns the
// questionnaire; a target only narrows it to some of that organization's own
// departments. Department identifiers travel, never names.
export const targetInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("ORGANIZATION") }).strict(),
  z
    .object({
      mode: z.literal("DEPARTMENTS"),
      departmentIds: z.array(uuid).min(1).max(500),
    })
    .strict(),
]);
export type TargetInput = z.infer<typeof targetInput>;
export type DepartmentOption = {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  status: "ACTIVE" | "ARCHIVED";
};
export type QuestionnaireTarget = {
  target_mode: "ORGANIZATION" | "DEPARTMENTS";
  departments: DepartmentOption[];
};
export async function departmentOptions(
  tx: Tx,
  org: string,
): Promise<DepartmentOption[]> {
  const r =
    await sql<DepartmentOption>`select id,code,name_ar,name_en,status from instrument.department_options(${org}::uuid)`.execute(
      tx,
    );
  return r.rows;
}
// Department labels for questionnaires of one organization, resolved from the
// relational target rows. Global questionnaires have no departments.
export async function targetDepartments(
  tx: Tx,
  org: string | null,
  questionnaireIds: string[],
): Promise<Map<string, DepartmentOption[]>> {
  const result = new Map<string, DepartmentOption[]>();
  if (!org || !questionnaireIds.length) return result;
  const rows = await sql<{
    questionnaire_id: string;
    department_id: string;
  }>`select questionnaire_id,department_id from instrument.questionnaire_department where organization_id=${org}::uuid and questionnaire_id = any(${questionnaireIds}::uuid[])`.execute(
    tx,
  );
  if (!rows.rows.length) return result;
  const options = new Map(
    (await departmentOptions(tx, org)).map((d) => [d.id, d]),
  );
  for (const row of rows.rows) {
    const d = options.get(row.department_id);
    if (!d) continue;
    result.set(row.questionnaire_id, [
      ...(result.get(row.questionnaire_id) ?? []),
      d,
    ]);
  }
  for (const list of result.values())
    list.sort(
      (a, b) => a.name_ar.localeCompare(b.name_ar, "ar") || a.id.localeCompare(b.id),
    );
  return result;
}
export async function saveTarget(
  tx: Tx,
  args: {
    org: string | null;
    qid: string;
    revision: string | null;
    target: TargetInput;
    idem: string;
  },
) {
  if (!args.org) throw new AppError("VALIDATION_FAILED", 422);
  const departmentIds =
    args.target.mode === "DEPARTMENTS"
      ? [...new Set(args.target.departmentIds)].sort()
      : [];
  const hash = digest(
    canonicalJson({
      org: args.org,
      qid: args.qid,
      mode: args.target.mode,
      departmentIds,
    }),
  );
  await sql`select instrument.save_target(${args.org}::uuid,${args.qid}::uuid,${args.revision}::bigint,${args.target.mode},${departmentIds}::uuid[],${args.idem}::uuid,${hash})`.execute(
    tx,
  );
}
export async function questionnaireDetail(
  tx: Tx,
  org: string | null,
  qid: string,
) {
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
  const departments = await targetDepartments(tx, org, [qid]);
  return {
    ...q.rows[0],
    departments: departments.get(qid) ?? [],
    versions: versions.rows,
  };
}
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
  // The department choices of one organization, for targeting and filtering.
  const options = path.match(/^organizations\/([^/]+)\/questionnaire-departments$/);
  if (options) {
    if (req.method !== "GET") throw new AppError("NOT_FOUND", 404);
    const org = uuid.parse(options[1]);
    await instrumentAccess(tx, org);
    return response({ items: await departmentOptions(tx, org) });
  }
  const match = path.match(
    /^(?:organizations\/([^/]+)\/)?questionnaires(?:\/([^/]+)(?:\/(versions|archive|target)(?:\/([^/]+)(?:\/(publish|retire|new-version|validate))?)?)?)?$/,
  );
  if (!match) return null;
  const org = match[1] ? uuid.parse(match[1]) : null,
    qid = match[2] ? uuid.parse(match[2]) : null,
    vid = match[4] ? uuid.parse(match[4]) : null,
    action = match[5];
  if (match[3] === "target" && vid) throw new AppError("NOT_FOUND", 404);
  await instrumentAccess(tx, org, req.method !== "GET");
  if (req.method === "GET" && !qid) {
    const query = z
      .object({
        q: z.string().max(100).default(""),
        status: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).default("ACTIVE"),
        cursor: uuid.optional(),
        departmentId: uuid.optional(),
      })
      .strict()
      .parse(Object.fromEntries(new URL(req.url).searchParams));
    const department = query.departmentId ?? null;
    // A department filter exists only beneath an organization, and only for
    // that organization's own departments.
    if (department) {
      if (!org) throw new AppError("VALIDATION_FAILED", 422);
      if (!(await departmentOptions(tx, org)).some((d) => d.id === department))
        throw new AppError("VALIDATION_FAILED", 422);
    }
    const rows = await sql<{
      id: string;
      target_mode: QuestionnaireTarget["target_mode"];
    }>`select id,name_ar,name_en,source,status,revision,target_mode from instrument.questionnaire q where organization_id is not distinct from ${org}::uuid and (${query.status}='ALL' or status=${query.status}) and (${query.cursor ?? null}::uuid is null or id>${query.cursor ?? null}::uuid) and (${query.q}='' or strpos(lower(name_ar||' '||name_en),lower(${query.q}))>0) and (${department}::uuid is null or q.target_mode='ORGANIZATION' or exists(select 1 from instrument.questionnaire_department t where t.organization_id=q.organization_id and t.questionnaire_id=q.id and t.department_id=${department}::uuid)) order by id limit 51`.execute(
      tx,
    );
    const items = rows.rows.slice(0, 50);
    const departments = await targetDepartments(
      tx,
      org,
      items.filter((i) => i.target_mode === "DEPARTMENTS").map((i) => i.id),
    );
    return response({
      items: items.map((i) => ({
        ...i,
        departments: departments.get(i.id) ?? [],
      })),
      nextCursor: rows.rows.length > 50 ? rows.rows[49].id : null,
    });
  }
  if (req.method === "GET" && qid) {
    if (match[3] === "target") throw new AppError("NOT_FOUND", 404);
    if (vid) return response(await getVersion(tx, org, qid, vid));
    return response(await questionnaireDetail(tx, org, qid));
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
          target: targetInput.optional(),
        })
        .strict(),
    );
    if (body.source?.organizationId && body.source.organizationId !== org)
      throw new AppError("NOT_FOUND", 404);
    if (body.target && !org) throw new AppError("VALIDATION_FAILED", 422);
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
    const created = (await saveInstrument(tx, {
      org,
      action: "CREATE",
      document: instrumentSchema.parse(d),
      sourceId: body.source?.versionId,
      idem,
    })) as Version;
    // Created and targeted in one transaction: a questionnaire is never left
    // behind with only half of what was asked. A replay answers both steps
    // from their receipts under the same key.
    if (body.target && body.target.mode !== "ORGANIZATION") {
      const current = await sql<{
        revision: string;
      }>`select revision from instrument.questionnaire where id=${created.questionnaire_id}::uuid`.execute(
        tx,
      );
      await saveTarget(tx, {
        org,
        qid: created.questionnaire_id,
        revision: current.rows[0].revision,
        target: body.target,
        idem,
      });
    }
    return response(created, 201);
  }
  if (req.method === "POST" && qid && match[3] === "target") {
    const target = await jsonInput(req, targetInput);
    await saveTarget(tx, { org, qid, revision, target, idem });
    return response(await questionnaireDetail(tx, org, qid));
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
