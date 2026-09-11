import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import {
  participantInput,
  mappingInput,
  type ParticipantInput,
} from "./directory-input";
import { AppError } from "./security";
export type SourceRows = { headers: string[]; rows: string[][] };
export async function parseSource(
  bytes: Buffer,
  format: "CSV" | "XLSX",
): Promise<SourceRows> {
  if (bytes.length > 1024 * 1024 || !bytes.length)
    throw new AppError("VALIDATION_FAILED", 422);
  let data: string[][] = [];
  try {
    if (format === "CSV") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) throw Error();
      data = parse(text, {
        bom: true,
        skip_empty_lines: true,
        max_record_size: 20000,
        to: 502,
      }) as string[][];
    } else {
      if (bytes.readUInt32LE(0) !== 0x04034b50) throw Error();
      // Check ZIP entry sizes and active content before handing XML to ExcelJS.
      // No archive is extracted to disk, and nothing is evaluated or fetched.
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(bytes);
      let expanded = 0,
        entries = 0;
      for (const [name, entry] of Object.entries(zip.files)) {
        if (
          ++entries > 100 ||
          /vbaProject|externalLinks|embeddings|activeX/i.test(name) ||
          name.includes("..")
        )
          throw Error();
        if (entry.dir) continue;
        // Streaming inflation aborts before oversized XML can be accumulated.
        await new Promise<void>((resolve, reject) => {
          const stream = entry.nodeStream() as Readable;
          stream.on("data", (chunk: Buffer) => {
            expanded += chunk.length;
            if (expanded > 8 * 1024 * 1024) stream.destroy(new Error("limit"));
          });
          stream.on("error", reject);
          stream.on("end", resolve);
        });
      }
      if (!zip.file("xl/workbook.xml")) throw Error();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes as never);
      if (workbook.worksheets.length !== 1) throw Error();
      const sheet = workbook.worksheets[0];
      if (sheet.rowCount > 501 || sheet.columnCount > 30) throw Error();
      sheet.eachRow({ includeEmpty: true }, (row) => {
        const values: string[] = [];
        for (let c = 1; c <= sheet.columnCount; c++) {
          const value = row.getCell(c).value;
          if (
            value !== null &&
            typeof value !== "string" &&
            typeof value !== "number"
          )
            throw Error();
          values.push(value === null ? "" : String(value));
        }
        data.push(values);
      });
    }
    const headers = data.shift()?.map((v) => v.trim()) ?? [];
    if (
      !headers.length ||
      headers.length > 30 ||
      headers.some((v) => !v || v.length > 100) ||
      new Set(headers).size !== headers.length ||
      !data.length ||
      data.length > 500 ||
      data.some(
        (r) => r.length !== headers.length || r.some((v) => v.length > 5000),
      )
    )
      throw Error();
    return { headers, rows: data };
  } catch {
    throw new AppError("VALIDATION_FAILED", 422);
  }
}
export type ImportError = {
  row: number;
  code: "DUPLICATE_REFERENCE" | "INVALID_DEPARTMENT" | "INVALID_ROW";
};
export function validateRows(
  source: SourceRows,
  map: unknown,
  departments: { id: string; code: string }[],
  existing: Set<string>,
) {
  const mapping = mappingInput.parse(map);
  if (Object.keys(mapping).some((h) => !source.headers.includes(h)))
    throw new AppError("VALIDATION_FAILED", 422);
  const mapped = source.rows.map((row) =>
    Object.fromEntries(
      Object.entries(mapping).map(([h, t]) => [
        t,
        row[source.headers.indexOf(h)].trim(),
      ]),
    ),
  );
  const counts = new Map<string, number>();
  for (const r of mapped) {
    const ref = r.privateReference.normalize("NFC");
    counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  const valid: { row: number; data: ParticipantInput }[] = [],
    errors: ImportError[] = [];
  mapped.forEach((r, index) => {
    const row = index + 2,
      ref = r.privateReference.normalize("NFC");
    if (counts.get(ref) !== 1 || existing.has(ref)) {
      errors.push({ row, code: "DUPLICATE_REFERENCE" });
      return;
    }
    const department = r.departmentCode
      ? departments.find(
          (d) => d.code === r.departmentCode.normalize("NFC").toUpperCase(),
        )
      : null;
    if (r.departmentCode && !department) {
      errors.push({ row, code: "INVALID_DEPARTMENT" });
      return;
    }
    const { departmentCode: _departmentCode, email, phone, ...input } = r;
    void _departmentCode;
    const result = participantInput.safeParse({
      ...input,
      yearsOfService: input.yearsOfService || null,
      departmentId: department?.id ?? null,
      contact: {
        schemaVersion: 1,
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
      },
    });
    if (!result.success) errors.push({ row, code: "INVALID_ROW" });
    else valid.push({ row, data: result.data });
  });
  return { valid, errors };
}
export function errorCsv(errors: ImportError[]) {
  return (
    "\uFEFFrow,error\r\n" +
    errors.map((e) => `${e.row},${e.code}`).join("\r\n") +
    "\r\n"
  );
}
