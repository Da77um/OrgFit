import { randomUUID, createHash } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { type Tx, requireAccess } from "./db";
import { AppError, jsonInput, uuid, digest } from "./security";
import { response } from "./http";
import { preconditions, saveDirectory } from "./directory";
import { mappingInput } from "./directory-input";
import { putSource, getSource } from "./import-storage";
import {
  parseSource,
  validateRows,
  errorCsv,
  type ImportError,
} from "./import-parser";
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
type ImportRecord = {
  id: string;
  organization_id: string;
  format: "CSV" | "XLSX";
  source_digest: string;
  mapping: Record<string, string>;
  revision: string;
  state: string;
  expires_at: Date;
  validation: {
    validRows: number[];
    errors: ImportError[];
    reviewDigest: string;
  };
  committed_count: number;
};
async function getImport(tx: Tx, org: string, id: string) {
  await requireAccess(tx, org, "directory.manage");
  const { rows } =
    await sql<ImportRecord>`select * from core.directory_import where organization_id=${org}::uuid and id=${id}::uuid`.execute(
      tx,
    );
  if (!rows.length) throw new AppError("NOT_FOUND", 404);
  if (new Date(rows[0].expires_at).getTime() <= Date.now())
    throw new AppError("IMPORT_EXPIRED", 409);
  return rows[0];
}
async function validate(
  tx: Tx,
  org: string,
  record: ImportRecord,
  mapping: unknown,
) {
  const bytes = await getSource(org, record.id);
  if (hash(bytes) !== record.source_digest)
    throw new AppError("VALIDATION_FAILED", 422);
  const source = await parseSource(bytes, record.format);
  const { rows: departments } = await sql<{
    id: string;
    code: string;
  }>`select id,code from core.department where organization_id=${org}::uuid and status='ACTIVE'`.execute(
    tx,
  );
  // Resolve only references present in this bounded upload, using the unique index.
  const values = source.rows.map(
    (r) =>
      r[
        source.headers.indexOf(
          Object.keys(mapping as object).find(
            (k) =>
              (mapping as Record<string, string>)[k] === "privateReference",
          ) ?? "",
        )
      ]
        ?.trim()
        .normalize("NFC") ?? "",
  );
  const { rows: existing } = await sql<{
    private_reference: string;
  }>`select private_reference from core.participant where organization_id=${org}::uuid and private_reference=any(${values}::text[])`.execute(
    tx,
  );
  return validateRows(
    source,
    mapping,
    departments,
    new Set(existing.map((p) => p.private_reference)),
  );
}
export async function importRoute(
  req: Request,
  path: string,
  tx: Tx,
): Promise<Response | null> {
  const match = path.match(
    /^organizations\/([^/]+)\/imports(?:\/([^/]+)(?:\/(validate|commit|errors))?)?$/,
  );
  if (!match) return null;
  const org = uuid.parse(match[1]),
    id = match[2] ? uuid.parse(match[2]) : null,
    action = match[3];
  await requireAccess(tx, org, "directory.manage");
  if (req.method === "POST" && !id) {
    const { idem } = preconditions(req, false);
    const body = await jsonInput(
      req,
      z
        .object({
          format: z.enum(["CSV", "XLSX"]),
          base64: z
            .string()
            .min(4)
            .max(1400000)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        })
        .strict(),
    );
    const bytes = Buffer.from(body.base64, "base64");
    if (bytes.toString("base64") !== body.base64)
      throw new AppError("VALIDATION_FAILED", 422);
    const source = await parseSource(bytes, body.format),
      sourceDigest = hash(bytes);
    await sql`select core.directory_guard(${org}::uuid)`.execute(tx);
    // Caller-provided idempotency UUID is scoped by an actor/org hash, never an object path.
    const actor = (
      await sql<{ id: string }>`select access.actor() id`.execute(tx)
    ).rows[0].id;
    const h = hash(`${org}/${actor}/${idem}`).slice(0, 32);
    const target = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20)}`;
    const { rows } =
      await sql<ImportRecord>`select * from core.directory_import where organization_id=${org}::uuid and id=${target}::uuid`.execute(
        tx,
      );
    if (rows.length) {
      if (
        rows[0].source_digest !== sourceDigest ||
        rows[0].format !== body.format
      )
        throw new AppError("IDEMPOTENCY_CONFLICT", 409);
      return response(
        { ...(await getImport(tx, org, target)), headers: source.headers },
        200,
      );
    }
    await putSource(org, target, bytes);
    await sql`select core.save_import(${org}::uuid,${target}::uuid,null,${JSON.stringify({ sourceDigest, format: body.format })}::jsonb)`.execute(
      tx,
    );
    return response(
      { ...(await getImport(tx, org, target)), headers: source.headers },
      201,
    );
  }
  if (!id) throw new AppError("NOT_FOUND", 404);
  if (req.method === "POST")
    await sql`select core.directory_guard(${org}::uuid)`.execute(tx);
  const record = await getImport(tx, org, id);
  if (req.method === "GET" && !action) {
    const source = await parseSource(await getSource(org, id), record.format);
    return response({
      ...record,
      headers: source.headers,
      preview:
        record.state === "VALIDATED"
          ? record.validation.validRows
              .slice(0, 20)
              .map((row) => ({
                row,
                data: Object.fromEntries(
                  Object.entries(record.mapping).map(([header, target]) => [
                    target,
                    source.rows[row - 2][source.headers.indexOf(header)],
                  ]),
                ),
              }))
          : source.rows.slice(0, 20),
    });
  }
  if (req.method === "GET" && action === "errors") {
    await sql`select core.import_download_audit(${org}::uuid,${id}::uuid)`.execute(
      tx,
    );
    return new Response(errorCsv(record.validation.errors ?? []), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="import-errors.csv"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (req.method === "POST" && action === "validate") {
    const { revision } = preconditions(req, true);
    const body = await jsonInput(
      req,
      z.object({ mapping: mappingInput }).strict(),
    );
    const review = await validate(tx, org, record, body.mapping);
    const validation = {
      validRows: review.valid.map((r) => r.row),
      errors: review.errors,
      reviewDigest: hash(JSON.stringify(review)),
    };
    await sql`select core.save_import(${org}::uuid,${id}::uuid,${revision}::bigint,${JSON.stringify({ state: "VALIDATED", mapping: body.mapping, validation })}::jsonb)`.execute(
      tx,
    );
    return response({
      ...(await getImport(tx, org, id)),
      preview: review.valid.slice(0, 20),
    });
  }
  if (req.method === "POST" && action === "commit") {
    const { revision, idem } = preconditions(req, true);
    const body = await jsonInput(
      req,
      z
        .object({
          sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
          validationRevision: z.string().regex(/^[1-9]\d*$/),
          confirmValidRows: z.literal(true),
        })
        .strict(),
    );
    await sql`select core.import_receipt(${org}::uuid,${id}::uuid,${idem}::uuid,${digest(JSON.stringify({ id, revision, body }))})`.execute(
      tx,
    );
    if (body.sourceDigest !== record.source_digest)
      throw new AppError("IDEMPOTENCY_CONFLICT", 409);
    if (body.validationRevision !== revision)
      throw new AppError("REVISION_CONFLICT", 409);
    if (record.state === "COMMITTED") {
      // The consumed validation revision is exactly one less than the final revision.
      if (BigInt(revision!) + 1n !== BigInt(record.revision))
        throw new AppError("REVISION_CONFLICT", 409);
      return response(record);
    }
    if (record.state !== "VALIDATED" || record.revision !== revision)
      throw new AppError("REVISION_CONFLICT", 409);
    const review = await validate(tx, org, record, record.mapping);
    if (hash(JSON.stringify(review)) !== record.validation.reviewDigest)
      throw new AppError("IMPORT_CHANGED", 409);
    if (!review.valid.length) throw new AppError("VALIDATION_FAILED", 422);
    for (const row of review.valid)
      await saveDirectory(
        tx,
        "participant",
        org,
        null,
        null,
        row.data,
        randomUUID(),
      );
    await sql`select core.save_import(${org}::uuid,${id}::uuid,${revision}::bigint,${JSON.stringify({ state: "COMMITTED", count: review.valid.length })}::jsonb)`.execute(
      tx,
    );
    return response(await getImport(tx, org, id));
  }
  throw new AppError("NOT_FOUND", 404);
}
