import { sql } from "kysely";
import { z } from "zod";
import { type Tx, requireAccess, type Profile } from "./db";
import { AppError, digest, jsonInput, uuid } from "./security";
import { response } from "./http";
import { schemas, archiveInput, type DirectoryKind } from "./directory-input";
export type DirectoryRecord = {
  id: string;
  organization_id?: string;
  revision: string;
  status: string;
  code?: string;
  name_ar?: string;
  name_en?: string | null;
  private_reference?: string;
  display_name?: string;
  [key: string]: unknown;
};
export function preconditions(req: Request, update: boolean) {
  const idem = uuid.safeParse(req.headers.get("idempotency-key"));
  const revision = req.headers
    .get("if-match")
    ?.match(/^"([1-9][0-9]{0,14})"$/)?.[1];
  if (!idem.success || (update && !revision))
    throw new AppError("PRECONDITION_REQUIRED", 400);
  return { idem: idem.data, revision: revision ?? null };
}
export async function directoryGet(
  tx: Tx,
  kind: DirectoryKind,
  org: string | null,
  id: string,
) {
  if (org)
    await requireAccess(
      tx,
      org,
      kind === "organization" ? undefined : "directory.manage",
    );
  const { rows } =
    await sql<DirectoryRecord>`select * from ${sql.table("core." + kind)} where id=${id}::uuid ${kind !== "organization" ? sql`and organization_id=${org}::uuid` : sql``}`.execute(
      tx,
    );
  if (!rows.length) throw new AppError("NOT_FOUND", 404);
  const related =
    kind === "participant"
      ? rows[0].department_id
      : kind === "department"
        ? rows[0].parent_department_id
        : null;
  if (related) {
    const names = await sql<{
      name_ar: string;
      name_en: string | null;
    }>`select name_ar,name_en from core.department where organization_id=${org}::uuid and id=${String(related)}::uuid`.execute(
      tx,
    );
    rows[0].related_name_ar = names.rows[0]?.name_ar ?? null;
    rows[0].related_name_en = names.rows[0]?.name_en ?? null;
  }
  return rows[0];
}
export async function directoryList(
  tx: Tx,
  kind: DirectoryKind,
  org: string | null,
  url: URL,
) {
  if (org) await requireAccess(tx, org, "directory.manage");
  const query = z
    .object({
      cursor: z.string().max(1200).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      q: z.string().trim().max(100).default(""),
      status: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).default("ACTIVE"),
      departmentId: uuid.optional(),
    })
    .strict()
    .parse(Object.fromEntries(url.searchParams));
  if (query.departmentId && kind !== "participant")
    throw new AppError("VALIDATION_FAILED", 422);
  if (query.departmentId)
    await directoryGet(tx, "department", org, query.departmentId);
  const scope = JSON.stringify([
    kind,
    org,
    query.q,
    query.status,
    query.departmentId ?? null,
  ]);
  let after: string | null = null;
  if (query.cursor) {
    try {
      const c = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
      if (c.scope !== scope) throw Error();
      after = uuid.parse(c.id);
    } catch {
      throw new AppError("VALIDATION_FAILED", 422);
    }
  }
  const name = kind === "participant" ? "display_name" : "name_ar",
    code = kind === "participant" ? "private_reference" : "code";
  const { rows } =
    await sql<DirectoryRecord>`select * from ${sql.table("core." + kind)} where ${org ? sql`organization_id=${org}::uuid` : sql`true`} and (${after}::uuid is null or id>${after}::uuid) and (${query.status}='ALL' or status=${query.status}) and (${query.q}='' or strpos(lower(${sql.ref(name)}),lower(${query.q}))>0 or strpos(lower(${sql.ref(code)}),lower(${query.q}))>0) ${query.departmentId ? sql`and department_id=${query.departmentId}::uuid` : sql``} order by id limit ${query.limit + 1}`.execute(
      tx,
    );
  const items = rows.slice(0, query.limit);
  return {
    items,
    nextCursor:
      rows.length > query.limit
        ? Buffer.from(JSON.stringify({ scope, id: items.at(-1)!.id })).toString(
            "base64url",
          )
        : null,
  };
}
export async function saveDirectory(
  tx: Tx,
  kind: DirectoryKind,
  org: string | null,
  id: string | null,
  revision: string | null,
  body: unknown,
  idem: string,
  archive = false,
) {
  const hash = digest(
    JSON.stringify({ kind, org, id, revision, body, archive }),
  );
  const { rows } = await sql<{
    id: string;
  }>`select core.save_directory(${kind},${org}::uuid,${id}::uuid,${revision}::bigint,${JSON.stringify(body)}::jsonb,${idem}::uuid,${hash},${archive}) id`.execute(
    tx,
  );
  return directoryGet(
    tx,
    kind,
    kind === "organization" ? rows[0].id : org,
    rows[0].id,
  );
}
export async function directoryRoute(
  req: Request,
  path: string,
  tx: Tx,
  profile: Profile,
): Promise<Response | null> {
  const parts = path.split("/");
  if (parts[0] !== "organizations") return null;
  const org = parts[1] ? uuid.parse(parts[1]) : null;
  if (parts[2] === "access" || parts[2] === "imports") return null;
  const kind: DirectoryKind | undefined =
    parts.length <= 2 || parts[2] === "archive"
      ? "organization"
      : parts[2] === "departments"
        ? "department"
        : parts[2] === "participants"
          ? "participant"
          : undefined;
  if (!kind) return null;
  const id =
    kind === "organization" ? org : parts[3] ? uuid.parse(parts[3]) : null;
  const archive = parts.at(-1) === "archive";
  if (
    parts.length >
    (kind === "organization" ? (archive ? 3 : 2) : archive ? 5 : 4)
  )
    throw new AppError("NOT_FOUND", 404);
  if (org)
    await requireAccess(
      tx,
      org,
      kind === "organization" ? undefined : "directory.manage",
    );
  if (req.method === "GET")
    return response(
      id
        ? await directoryGet(tx, kind, org, id)
        : await directoryList(
            tx,
            kind,
            kind === "organization" ? null : org,
            new URL(req.url),
          ),
    );
  if (
    (req.method === "POST" && !id) ||
    (req.method === "PATCH" && id && !archive) ||
    (req.method === "POST" && id && archive)
  ) {
    if (
      kind === "organization" &&
      (!id || archive) &&
      profile.role !== "SUPER_ADMIN"
    )
      throw new AppError("FORBIDDEN", 403);
    const { idem, revision } = preconditions(req, !!id);
    const body = archive
      ? await jsonInput(req, archiveInput)
      : await jsonInput(req, schemas[kind] as z.ZodType<unknown>);
    const data = await saveDirectory(
      tx,
      kind,
      org,
      id,
      revision,
      body,
      idem,
      archive,
    );
    const res = response(data, id ? 200 : 201);
    res.headers.set("ETag", `"${data.revision}"`);
    return res;
  }
  throw new AppError("NOT_FOUND", 404);
}
