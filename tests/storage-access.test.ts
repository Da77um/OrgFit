import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FILE_ACCESS, FILE_PREFIXES, LEDGER_ACCESS, LEDGER_PREFIX, LIFECYCLE_DAYS, type StorageIdentity } from "../src/storage-access";
import { MIN_OBJECT_LOCK_DAYS } from "../src/tombstone-ledger";
import { ATTACHMENT_RETENTION_DAYS } from "../src/attachment-types";
import { REPORT_TTL_HOURS, objectKey as reportKey } from "../src/report-storage";
import { EXPORT_TTL_HOURS, objectKey as linkKey } from "../src/link-storage";
import { PARTICIPATION_EXPORT_TTL_HOURS, objectKey as participationKey } from "../src/participation-storage";
import { objectKey as attachmentKey } from "../src/attachment-storage";

// D-166: the AWS template grants exactly what src/storage-access.ts says, and
// the buckets carry the protections the runbooks require. No AWS account is
// needed; scripts/check-storage.ts proves the same against real buckets.

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Principal?: unknown; Condition?: unknown };
type Resource = { Type: string; Properties: Record<string, unknown> };
const template = JSON.parse(readFileSync("deploy/aws/orgfit-storage.cfn.json", "utf8")) as { Resources: Record<string, Resource> };
const R = template.Resources;
const list = <T>(v: T | T[]) => (Array.isArray(v) ? v : [v]);
const sub = (v: unknown) => (v as { "Fn::Sub": string })["Fn::Sub"];

const USERS: Record<StorageIdentity, string> = { staff: "StaffUser", report: "ReportUser", scanner: "ScannerUser", operator: "OperatorUser" };
const FILE_OP: Record<string, string> = { "s3:PutObject": "put", "s3:GetObject": "get", "s3:DeleteObject": "delete" };
const LEDGER_OP: Record<string, string> = {
  "s3:ListBucket": "list", "s3:GetObject": "get", "s3:PutObject": "put", "s3:PutObjectRetention": "put",
  "s3:GetBucketObjectLockConfiguration": "lock-config",
};

function granted(identity: StorageIdentity) {
  const policies = R[USERS[identity]].Properties.Policies as { PolicyDocument: { Statement: Statement[] } }[];
  const files: Record<string, Set<string>> = {};
  const ledger = new Set<string>();
  for (const s of policies.flatMap((p) => p.PolicyDocument.Statement)) {
    assert.equal(s.Effect, "Allow", `${identity}: only Allow statements in a user policy`);
    for (const resource of list(s.Resource)) {
      const arn = sub(resource);
      const m = arn.match(/^arn:\$\{AWS::Partition\}:s3:::\$\{(FilesBucket|LedgerBucket)\}(?:\/(.*))?$/);
      assert.ok(m, `${identity}: unexpected resource ${arn}`);
      const [, bucket, path] = m;
      for (const action of list(s.Action)) {
        if (bucket === "FilesBucket") {
          assert.ok(FILE_OP[action], `${identity}: unexpected files action ${action}`);
          const prefix = (path ?? "").replace(/\*$/, "");
          assert.ok((FILE_PREFIXES as readonly string[]).includes(prefix), `${identity}: files resource must be one prefix, got ${path}`);
          (files[prefix] ??= new Set()).add(FILE_OP[action]);
        } else {
          assert.ok(LEDGER_OP[action], `${identity}: unexpected ledger action ${action}`);
          if (action === "s3:ListBucket")
            assert.deepEqual(s.Condition, { StringLike: { "s3:prefix": [`${LEDGER_PREFIX}*`] } }, "ledger listing is limited to the prefix");
          else if (path !== undefined) assert.equal(path, `${LEDGER_PREFIX}*`, "ledger object access is limited to the prefix");
          ledger.add(LEDGER_OP[action]);
        }
      }
    }
  }
  return { files, ledger };
}

test("each IAM user is granted exactly the storage access in src/storage-access.ts", () => {
  for (const identity of Object.keys(USERS) as StorageIdentity[]) {
    const { files, ledger } = granted(identity);
    const want = Object.fromEntries(Object.entries(FILE_ACCESS[identity]).map(([p, ops]) => [p, [...ops].sort()]));
    const got = Object.fromEntries(Object.entries(files).map(([p, ops]) => [p, [...ops].sort()]));
    assert.deepEqual(got, want, identity);
    assert.deepEqual([...ledger].sort(), [...LEDGER_ACCESS[identity]].sort(), `${identity} ledger`);
  }
  // Only the four storage identities exist; the processor and respondent have none.
  const users = Object.entries(R).filter(([, r]) => r.Type === "AWS::IAM::User").map(([name]) => name).sort();
  assert.deepEqual(users, Object.values(USERS).sort());
});

test("the storage adapters write under exactly the bucket's prefixes", () => {
  const org = "00000000-0000-4000-8000-000000000001", id = "00000000-0000-4000-8000-000000000002";
  const keys = [linkKey(org, id), participationKey(org, id), reportKey(org, id), attachmentKey(org, id)];
  for (const k of keys) assert.ok(FILE_PREFIXES.some((p) => k.startsWith(p)), k);
  assert.ok(readFileSync("src/import-storage.ts", "utf8").includes("`imports/${"), "imports/ prefix");
});

test("both buckets are private, versioned, encrypted and TLS-only", () => {
  for (const [bucket, policy] of [["FilesBucket", "FilesBucketPolicy"], ["LedgerBucket", "LedgerBucketPolicy"]]) {
    const p = R[bucket].Properties;
    assert.deepEqual(p.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }, bucket);
    assert.deepEqual(p.VersioningConfiguration, { Status: "Enabled" }, bucket);
    assert.ok(JSON.stringify(p.BucketEncryption).includes('"SSEAlgorithm":"AES256"'), bucket);
    const statements = (R[policy].Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    assert.ok(statements.some((s) => s.Effect === "Deny" && s.Action === "s3:*" && JSON.stringify(s.Condition) === '{"Bool":{"aws:SecureTransport":"false"}}'), `${bucket} TLS-only`);
  }
});

test("the ledger bucket has COMPLIANCE Object Lock of at least the required days, and the operator may never delete", () => {
  const p = R.LedgerBucket.Properties as { ObjectLockEnabled: boolean; ObjectLockConfiguration: { ObjectLockEnabled: string; Rule: { DefaultRetention: { Mode: string; Days: number } } } };
  assert.equal(p.ObjectLockEnabled, true);
  assert.equal(p.ObjectLockConfiguration.ObjectLockEnabled, "Enabled");
  assert.equal(p.ObjectLockConfiguration.Rule.DefaultRetention.Mode, "COMPLIANCE");
  assert.ok(p.ObjectLockConfiguration.Rule.DefaultRetention.Days >= MIN_OBJECT_LOCK_DAYS);
  const deny = (R.LedgerBucketPolicy.Properties.PolicyDocument as { Statement: Statement[] }).Statement.find((s) => s.Sid === "DenyOperatorDeletionAndLockChanges")!;
  assert.deepEqual(deny.Principal, { AWS: { "Fn::GetAtt": ["OperatorUser", "Arn"] } });
  for (const a of ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:BypassGovernanceRetention", "s3:PutBucketObjectLockConfiguration"])
    assert.ok(list(deny.Action).includes(a), a);
  assert.equal(R.LedgerBucket.Properties.LifecycleConfiguration, undefined, "no lifecycle rule ever removes ledger objects");
});

test("lifecycle rules are backstops that never run before the database expiry", () => {
  const rules = (R.FilesBucket.Properties.LifecycleConfiguration as { Rules: { Prefix?: string; ExpirationInDays?: number; NoncurrentVersionExpiration?: { NoncurrentDays: number } }[] }).Rules;
  for (const prefix of FILE_PREFIXES) {
    const rule = rules.find((r) => r.Prefix === prefix);
    assert.ok(rule, prefix);
    assert.equal(rule.ExpirationInDays, LIFECYCLE_DAYS[prefix], prefix);
    assert.equal(rule.NoncurrentVersionExpiration?.NoncurrentDays, 1, `${prefix}: deleted bytes do not linger as old versions`);
  }
  assert.ok(LIFECYCLE_DAYS["reports/"] * 24 >= REPORT_TTL_HOURS);
  assert.ok(LIFECYCLE_DAYS["link-exports/"] * 24 >= EXPORT_TTL_HOURS);
  assert.ok(LIFECYCLE_DAYS["participation-exports/"] * 24 >= PARTICIPATION_EXPORT_TTL_HOURS);
  assert.ok(LIFECYCLE_DAYS["attachments/"] > ATTACHMENT_RETENTION_DAYS);
});
