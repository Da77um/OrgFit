import test from "node:test";
import assert from "node:assert/strict";
import { FILE_ACCESS, LEDGER_ACCESS, LEDGER_PREFIX, type FilePrefix, type StorageIdentity, type StorageOp } from "../src/storage-access";
import { checkStorage, CHECK_ORGANIZATION, IDENTITIES, type S3Like } from "../src/storage-check";

// D-166: the storage checker passes a bucket that enforces the table exactly,
// and fails one that grants too much or too little. The fake is in memory and
// enforces the given policy like IAM would: AccessDenied for anything not granted.

type Policy = { files: typeof FILE_ACCESS; ledger: typeof LEDGER_ACCESS; lockDays: number };
const denied = () => Object.assign(new Error("Access Denied"), { name: "AccessDenied" });

function fakeAws(policy: Policy) {
  const objects = new Map<string, Buffer>();
  const writes: string[] = [];
  const client = (identity: StorageIdentity): S3Like => ({
    async send(command: unknown) {
      const kind = (command as object).constructor.name;
      const input = (command as { input: { Bucket: string; Key?: string; Prefix?: string; Body?: Buffer } }).input;
      const ledger = input.Bucket === "ledger";
      const path = input.Key ?? input.Prefix ?? "";
      const prefix = path.slice(0, path.indexOf("/") + 1) as FilePrefix;
      const fileOp: Record<string, StorageOp> = { PutObjectCommand: "put", GetObjectCommand: "get", DeleteObjectCommand: "delete" };
      if (ledger) {
        const ops = policy.ledger[identity];
        const inPrefix = path.startsWith(LEDGER_PREFIX);
        const ok =
          (kind === "ListObjectsV2Command" && ops.includes("list") && inPrefix) ||
          (kind === "GetObjectLockConfigurationCommand" && ops.includes("lock-config")) ||
          (kind === "PutObjectCommand" && ops.includes("put") && inPrefix) ||
          (kind === "GetObjectCommand" && ops.includes("get") && inPrefix);
        if (!ok) throw denied();
        if (kind === "PutObjectCommand") writes.push(`ledger/${path}`);
        if (kind === "GetObjectLockConfigurationCommand")
          return { ObjectLockConfiguration: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: policy.lockDays } } } };
        return {};
      }
      const op = fileOp[kind];
      if (!op || !(policy.files[identity][prefix] ?? []).includes(op)) throw denied();
      if (op === "put") {
        objects.set(path, input.Body!);
        writes.push(path);
      }
      if (op === "delete") objects.delete(path);
      if (op === "get") {
        if (!objects.has(path)) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        return { Body: { transformToByteArray: async () => objects.get(path) } };
      }
      return {};
    },
  });
  return { clients: Object.fromEntries(IDENTITIES.map((i) => [i, client(i)])) as Record<StorageIdentity, S3Like>, objects, writes };
}

const exact: Policy = { files: FILE_ACCESS, ledger: LEDGER_ACCESS, lockDays: 36 };
const buckets = { files: "files", ledger: "ledger" };
const failures = async (policy: Policy) =>
  (await checkStorage(fakeAws(policy).clients, buckets)).filter((f) => f.outcome === "FAIL").map((f) => `${f.identity} ${f.check}`);

test("a bucket that enforces the table exactly passes every check", async () => {
  const aws = fakeAws(exact);
  const findings = await checkStorage(aws.clients, buckets);
  assert.deepEqual(findings.filter((f) => f.outcome === "FAIL"), []);
  // Every identity is tried on every prefix and operation, and on the ledger.
  assert.ok(findings.length >= IDENTITIES.length * 5 * 3);
  // Nothing was written to the ledger, and every check object is under the check organization.
  assert.ok(aws.writes.every((w) => !w.startsWith("ledger/")));
  assert.ok(aws.writes.every((w) => w.includes(`/${CHECK_ORGANIZATION}/`)));
  // Objects on prefixes some identity may delete were removed again.
  assert.ok([...aws.objects.keys()].every((k) => !k.startsWith("attachments/") && !k.startsWith("reports/")));
});

test("an excess grant is reported", async () => {
  const files = { ...FILE_ACCESS, scanner: { ...FILE_ACCESS.scanner, "attachments/": ["get", "delete", "put"] as StorageOp[] } };
  assert.deepEqual(await failures({ ...exact, files }), ["scanner put attachments/"]);
  const report = { ...FILE_ACCESS, report: { ...FILE_ACCESS.report, "imports/": ["get"] as StorageOp[] } };
  assert.deepEqual(await failures({ ...exact, files: report }), ["report get imports/"]);
});

test("a missing grant is reported", async () => {
  const files = { ...FILE_ACCESS, staff: { ...FILE_ACCESS.staff, "reports/": [] as StorageOp[] } };
  assert.deepEqual(await failures({ ...exact, files }), ["staff get reports/"]);
});

test("a ledger the operator could delete from, or with too short a lock, is reported", async () => {
  const ledgerOpen = { ...LEDGER_ACCESS, report: ["list"] as (typeof LEDGER_ACCESS)["report"] };
  assert.deepEqual(await failures({ ...exact, ledger: ledgerOpen }), ["report ledger list"]);
  assert.deepEqual(await failures({ ...exact, lockDays: 30 }), ["operator ledger object lock"]);
});

test("a wrong credential is never mistaken for a policy denial", async () => {
  const aws = fakeAws(exact);
  aws.clients.report = { send: async () => { throw Object.assign(new Error("bad key"), { name: "InvalidAccessKeyId" }); } };
  const findings = await checkStorage(aws.clients, buckets);
  const reportRows = findings.filter((f) => f.identity === "report");
  // Every row fails: a refused denial check names the error, and the reads that
  // needed the report's own object are reported as not testable.
  assert.ok(reportRows.length > 0 && reportRows.every((f) => f.outcome === "FAIL"));
  assert.ok(reportRows.every((f) => f.detail.includes("InvalidAccessKeyId") || f.detail.startsWith("not testable")));
  assert.ok(reportRows.some((f) => f.check === "ledger delete" && f.detail.includes("InvalidAccessKeyId")));
});
