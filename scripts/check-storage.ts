import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { S3Client } from "@aws-sdk/client-s3";
import { parseEnvFile } from "../src/preflight";
import { BUCKET_VARIABLE, FILE_ACCESS, type FilePrefix, type StorageIdentity } from "../src/storage-access";
import { checkStorage, IDENTITIES } from "../src/storage-check";
import { MIN_OBJECT_LOCK_DAYS } from "../src/tombstone-ledger";

// Proves the real buckets enforce src/storage-access.ts (D-166).
//
//   npm run storage:check -- --staff <file> --report <file> --scanner <file> --operator <file>
//
// Each file is that process's own environment file. Each identity is given
// ONLY its own file's AWS credentials, explicitly, so the SDK never falls back
// to whatever credentials this machine holds. Prints identities, checks and
// outcomes only — never a key, a bucket name or an object.

const { values } = parseArgs({
  options: { staff: { type: "string" }, report: { type: "string" }, scanner: { type: "string" }, operator: { type: "string" } },
  strict: true,
});
const problems: string[] = [];
const envs = {} as Record<StorageIdentity, Record<string, string>>;
for (const identity of IDENTITIES) {
  const file = values[identity];
  if (!file) problems.push(`--${identity} <env file> is required`);
  else {
    try {
      envs[identity] = parseEnvFile(readFileSync(file, "utf8"));
    } catch {
      problems.push(`${identity}: environment file unreadable`);
    }
  }
}

const filesBucket = envs.staff?.ATTACHMENT_S3_BUCKET;
for (const identity of IDENTITIES) {
  const env = envs[identity];
  if (!env) continue;
  for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"]) if (!env[k]) problems.push(`${identity}: ${k} missing`);
  for (const prefix of Object.keys(FILE_ACCESS[identity]) as FilePrefix[]) {
    const v = BUCKET_VARIABLE[prefix];
    if (!env[v]) problems.push(`${identity}: ${v} missing`);
    else if (env[v] !== filesBucket) problems.push(`${identity}: ${v} names a different bucket than the staff ATTACHMENT_S3_BUCKET`);
  }
}
const ledgerBucket = envs.operator?.TOMBSTONE_LEDGER_S3_BUCKET;
if (envs.operator) {
  if (!ledgerBucket) problems.push("operator: TOMBSTONE_LEDGER_S3_BUCKET missing");
  if (!(Number(envs.operator.TOMBSTONE_LEDGER_OBJECT_LOCK_DAYS) >= MIN_OBJECT_LOCK_DAYS))
    problems.push(`operator: TOMBSTONE_LEDGER_OBJECT_LOCK_DAYS must be at least ${MIN_OBJECT_LOCK_DAYS}`);
  if (ledgerBucket && ledgerBucket === filesBucket) problems.push("operator: the ledger must be its own bucket");
}
for (const identity of ["staff", "report", "scanner"] as const)
  if (envs[identity]?.TOMBSTONE_LEDGER_S3_BUCKET) problems.push(`${identity}: must not hold TOMBSTONE_LEDGER_S3_BUCKET`);
const keys = IDENTITIES.map((i) => envs[i]?.AWS_ACCESS_KEY_ID).filter(Boolean);
if (new Set(keys).size !== keys.length) problems.push("two identities share one access key; each needs its own IAM user");

if (problems.length) {
  console.error("Storage check refused to start:");
  for (const p of problems) console.error(`  ${p}`);
  process.exitCode = 1;
} else {
  const clients = Object.fromEntries(
    IDENTITIES.map((i) => [
      i,
      new S3Client({
        region: envs[i].AWS_REGION,
        credentials: {
          accessKeyId: envs[i].AWS_ACCESS_KEY_ID,
          secretAccessKey: envs[i].AWS_SECRET_ACCESS_KEY,
          ...(envs[i].AWS_SESSION_TOKEN ? { sessionToken: envs[i].AWS_SESSION_TOKEN } : {}),
        },
        maxAttempts: 2,
      }),
    ]),
  ) as Record<StorageIdentity, S3Client>;
  try {
    const findings = await checkStorage(clients, { files: filesBucket!, ledger: ledgerBucket! });
    for (const f of findings) console.log(`${f.outcome} ${f.identity.padEnd(8)} ${f.check} — ${f.detail}`);
    const failed = findings.filter((f) => f.outcome === "FAIL").length;
    console.log(failed ? `storage: ${failed} FAILED of ${findings.length}` : `storage: all ${findings.length} checks passed`);
    process.exitCode = failed ? 1 : 0;
  } catch {
    console.error("Storage check could not complete. Check network access, regions and credentials.");
    process.exitCode = 1;
  }
}
