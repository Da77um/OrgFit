import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import {
  participantInput,
  mappingInput,
  type ParticipantInput,
} from "./directory-input";
import { AppError } from "./security";
import { suggestMapping } from "./import-mapping";
export type SourceRows = { headers: string[]; rows: string[][] };

// Why an uploaded file was refused (D-193). Each is a fixed code the page
// turns into a sentence; no cell value or driver text is ever echoed.
export const FILE_REASONS = [
  "TOO_LARGE",
  "UNREADABLE",
  "ACTIVE_CONTENT",
  "NO_DATA",
  "TOO_MANY_ROWS",
  "TOO_MANY_COLUMNS",
  "MISSING_HEADER",
  "DUPLICATE_HEADER",
  "CELL_TOO_LONG",
] as const;
export type FileReason = (typeof FILE_REASONS)[number];
export class FileRejected extends AppError {
  constructor(public reason: FileReason) {
    super("VALIDATION_FAILED", 422);
  }
}
const MAX_ROWS = 500,
  MAX_COLUMNS = 30;

// One spreadsheet cell as the text a person sees in it. Nothing is evaluated
// or followed: a formula gives its stored result, a link its visible text,
// formatted text its characters, a date its calendar day.
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if (Array.isArray(v.richText))
      return (v.richText as { text?: unknown }[]).map((r) => String(r.text ?? "")).join("");
    if ("hyperlink" in v || ("text" in v && !("formula" in v)))
      return cellText(v.text as ExcelJS.CellValue);
    if ("formula" in v || "sharedFormula" in v)
      return "result" in v ? cellText(v.result as ExcelJS.CellValue) : "";
    if ("error" in v) return "";
  }
  return "";
}

function decodeCsv(bytes: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Excel on Arabic Windows saves "CSV" in Windows-1256, not UTF-8.
    return new TextDecoder("windows-1256", { fatal: true }).decode(bytes);
  }
}

export async function parseSource(
  bytes: Buffer,
  format: "CSV" | "XLSX",
): Promise<SourceRows> {
  if (bytes.length > 1024 * 1024) throw new FileRejected("TOO_LARGE");
  if (!bytes.length) throw new FileRejected("NO_DATA");
  let data: string[][] = [];
  if (format === "CSV") {
    try {
      const text = decodeCsv(bytes);
      if (text.includes("\0")) throw Error();
      data = parse(text, {
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        max_record_size: 20000,
        to: MAX_ROWS + 2,
      }) as string[][];
    } catch {
      throw new FileRejected("UNREADABLE");
    }
  } else {
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new FileRejected("UNREADABLE");
    // Check ZIP entry sizes and active content before handing XML to ExcelJS.
    // No archive is extracted to disk, and nothing is evaluated or fetched.
    const { default: JSZip } = await import("jszip");
    let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new FileRejected("UNREADABLE");
    }
    let expanded = 0,
      entries = 0;
    for (const [name, entry] of Object.entries(zip.files)) {
      if (++entries > 200 || name.includes("..")) throw new FileRejected("UNREADABLE");
      if (/vbaProject|externalLinks|embeddings|activeX/i.test(name)) throw new FileRejected("ACTIVE_CONTENT");
      if (entry.dir) continue;
      // Streaming inflation aborts before oversized XML can be accumulated.
      await new Promise<void>((resolve, reject) => {
        const stream = entry.nodeStream() as Readable;
        stream.on("data", (chunk: Buffer) => {
          expanded += chunk.length;
          if (expanded > 16 * 1024 * 1024) stream.destroy(new Error("limit"));
        });
        stream.on("error", reject);
        stream.on("end", resolve);
      });
    }
    if (!zip.file("xl/workbook.xml")) throw new FileRejected("UNREADABLE");
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(bytes as never);
    } catch {
      throw new FileRejected("UNREADABLE");
    }
    // The visible sheet whose first row looks most like participant headings
    // («الاسم», "Employee ID", …); with no such sheet, the first one holding
    // anything. Other sheets (instructions, lists, notes) are ignored.
    let best = -1;
    for (const sheet of workbook.worksheets) {
      if (sheet.state && sheet.state !== "visible") continue;
      const rows: string[][] = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        if (rows.length > MAX_ROWS + 1) return;
        const values: string[] = [];
        const last = Math.min(row.cellCount, 200);
        for (let c = 1; c <= last; c++) values.push(cellText(row.getCell(c).value));
        rows.push(values);
      });
      const first = rows.find((r) => r.some((v) => v.trim()));
      if (!first) continue;
      const score = Object.keys(suggestMapping(first.map((v) => v.trim()))).length;
      if (score > best) {
        best = score;
        data = rows;
      }
    }
  }
  // Rows with nothing in them are skipped, and so are columns: a formatted
  // but empty column beside the data is not a column.
  data = data.map((r) => r.map((v) => String(v ?? "").trim())).filter((r) => r.some((v) => v));
  if (!data.length) throw new FileRejected("NO_DATA");
  const width = data.reduce((w, r) => {
    for (let c = r.length - 1; c >= 0; c--) if (r[c]) return Math.max(w, c + 1);
    return w;
  }, 0);
  if (width > MAX_COLUMNS) throw new FileRejected("TOO_MANY_COLUMNS");
  data = data.map((r) => Array.from({ length: width }, (_, c) => r[c] ?? ""));
  const headers = data.shift()!;
  if (!data.length) throw new FileRejected("NO_DATA");
  if (data.length > MAX_ROWS) throw new FileRejected("TOO_MANY_ROWS");
  if (headers.some((v) => !v)) throw new FileRejected("MISSING_HEADER");
  if (headers.some((v) => v.length > 100) || data.some((r) => r.some((v) => v.length > 5000)))
    throw new FileRejected("CELL_TOO_LONG");
  if (new Set(headers).size !== headers.length) throw new FileRejected("DUPLICATE_HEADER");
  return { headers, rows: data };
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
