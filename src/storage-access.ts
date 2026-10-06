// ---------------------------------------------------------------------------
// Who may do what in object storage (D-166). One table, three consumers:
// deploy/aws/orgfit-storage.cfn.json grants exactly this (tests/storage-access
// .test.ts compares them), scripts/check-storage.ts proves it against the real
// buckets, and docs/orgfit/aws-storage-setup.md explains it.
//
// Every row follows a call site: staff imports, exports, downloads reports and
// handles visit attachments; the renderer writes and removes reports; the
// scanner reads and removes attachments; the operator removes expired
// attachments and appends to the tombstone ledger, which it may never delete.
// The processor and the respondent gateway touch no storage at all.
// ---------------------------------------------------------------------------

export type StorageOp = "put" | "get" | "delete";
export type StorageIdentity = "staff" | "report" | "scanner" | "operator";

/** The five prefixes of the private files bucket, one per storage adapter. */
export const FILE_PREFIXES = ["imports/", "link-exports/", "participation-exports/", "reports/", "attachments/"] as const;
export type FilePrefix = (typeof FILE_PREFIXES)[number];

export const FILE_ACCESS: Record<StorageIdentity, Partial<Record<FilePrefix, StorageOp[]>>> = {
  staff: {
    "imports/": ["put", "get"],
    "link-exports/": ["put", "get"],
    "participation-exports/": ["put", "get"],
    "reports/": ["get"],
    "attachments/": ["put", "get", "delete"],
  },
  report: { "reports/": ["put", "delete"] },
  scanner: { "attachments/": ["get", "delete"] },
  operator: { "attachments/": ["delete"] },
};

/** The tombstone ledger: its own Object Lock bucket, written by the operator only. */
export const LEDGER_PREFIX = "tombstones/";
export const LEDGER_ACCESS: Record<StorageIdentity, ("list" | "get" | "put" | "lock-config")[]> = {
  staff: [],
  report: [],
  scanner: [],
  operator: ["list", "get", "put", "lock-config"],
};

/** Lifecycle backstops. The database row is the authority; these only remove bytes it already retired. */
export const LIFECYCLE_DAYS: Record<FilePrefix, number> = {
  "imports/": 1,
  "link-exports/": 1,
  "participation-exports/": 1,
  "reports/": 1,
  // One day past ATTACHMENT_RETENTION_DAYS (365), so the database expiry always runs first.
  "attachments/": 366,
};

/** The bucket variable each identity's environment uses for each prefix. */
export const BUCKET_VARIABLE: Record<FilePrefix, string> = {
  "imports/": "IMPORT_S3_BUCKET",
  "link-exports/": "LINK_EXPORT_S3_BUCKET",
  "participation-exports/": "PARTICIPATION_EXPORT_S3_BUCKET",
  "reports/": "REPORT_S3_BUCKET",
  "attachments/": "ATTACHMENT_S3_BUCKET",
};
