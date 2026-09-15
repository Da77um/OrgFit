import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) result.push(...(await files(join(dir, e.name))));
    else if (e.name.endsWith(".nft.json")) result.push(join(dir, e.name));
  }
  return result;
}
// The respondent origin IS the privacy gateway, so from Phase 07 it legitimately
// carries a PostgreSQL driver — under the orgfit_gateway credential, which holds
// no table privilege and can execute only session-scoped routines. What it must
// never carry is a staff credential, staff authentication, the staff query
// builder, a staff data module, or the key-custody adapter.
//
// `pg` is therefore allowed and `kysely`, `openid-client` and every staff module
// are not. src/gateway-db.ts refuses to start if a staff, migrator, processor or
// custody secret is present in its environment, and src/instrument-records.ts is
// permitted because the gateway must render the pinned questionnaire.
const forbidden =
  /node_modules[/\\](kysely|openid-client|exceljs|csv-parse|jszip|playwright|playwright-core|@aws-sdk)[/\\]|src[/\\](auth|db|directory|imports|import-storage|import-parser|instruments|instrument-templates|campaigns|link-storage|key-custody|processor|publication|results|reports|report-db|report-storage|report-worker|report-pdf|report-xlsx|participation-storage|visits|attachment-storage|attachment-scan|attachment-worker|scanner-db|operations|preflight|supervisor|job-run|alert-delivery|revocation|staff-rate-limit|malware-engine|tombstone-ledger)\./;
const traces = await files(resolve("apps/respondent/.next/server"));
if (!traces.length) throw new Error("Build the respondent app first");
for (const f of traces) {
  const text = await readFile(f, "utf8");
  if (forbidden.test(text))
    throw new Error("Respondent build contains staff/database dependency");
}
const staffTraces = await files(resolve("apps/staff/.next/server"));
if (!staffTraces.length) throw new Error("Build the staff app first");
for (const f of staffTraces) {
  // The staff application must not link the processor, the gateway pool, the
  // publication writer or the report renderer. src/results.ts is the staff half
  // of Phase 08 and is permitted; src/publication.ts reads the anonymous
  // database and is not. src/reports.ts is the staff half of Phase 11 and is
  // permitted; the renderer, its credential and a browser engine are not.
  // src/visits.ts and src/attachment-storage.ts are the staff half of Phase 12
  // and are permitted; the scanner loop and its credential are not.
  const text = await readFile(f, "utf8");
  // Phase 14: the operator module (retention, tombstone replay, alerts) runs
  // under the migrator credential and must never be bundled into a web app.
  // Post-Audit Repair Pass 3: the job supervisor, the job-run recorder and the
  // alert adapter are operator tooling and never part of a web build.
  // Post-Audit Repair Pass 4: the malware engine adapter belongs to the scanner
  // and the tombstone ledger to the operator; neither is ever in a web build.
  if (/src[/\\](processor|gateway-db|respondent|publication|operations|preflight|supervisor|job-run|alert-delivery|malware-engine|tombstone-ledger)\./.test(text))
    throw new Error(
      "Staff build contains gateway, processor or publication module",
    );
  if (
    /src[/\\](report-db|report-worker|report-pdf|report-xlsx|report-html|report-fonts|scanner-db|attachment-worker)\./.test(
      text,
    ) ||
    /node_modules[/\\]playwright(-core)?[/\\]/.test(text)
  )
    throw new Error(
      "Staff build contains the report renderer, the attachment scanner or a browser engine",
    );
}
console.log(
  "Respondent build excludes staff auth, staff data modules, report modules, visit and attachment modules and key custody; staff build excludes the gateway pool, the privacy processor, the report renderer and the attachment scanner.",
);
