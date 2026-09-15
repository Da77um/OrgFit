import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { custodyProviderName } from "./key-custody";
import { engineFromEnvironment } from "./malware-engine";
import { trustedProxy } from "./rate-limit";
import { RuntimeGuardError } from "./runtime-guard";
import { AppError } from "./security";
import { tombstoneSinkFromEnvironment } from "./tombstone-ledger";

// ---------------------------------------------------------------------------
// Release preflight (Phase 15). Validates one process's environment against
// deploy/processes.json before that process is started, and optionally checks
// what its database credentials can see. It is an operator tool: it is never
// imported by a web application, and it NEVER prints a value — only variable
// names, check names and outcomes.
// ---------------------------------------------------------------------------

export type Outcome = "PASS" | "WARN" | "FAIL";
export type Finding = { check: string; outcome: Outcome; detail: string };

type ProcessSpec = {
  kind: "web" | "job";
  required: string[];
  recommended?: string[];
  optional?: string[];
  storage?: string[];
  forbidden: string[];
};
export type Manifest = {
  keys: { hex64: string[]; mustDiffer: string[] };
  databaseUrls: Record<string, string>;
  storage: Record<string, [bucket: string, local: string]>;
  processes: Record<string, ProcessSpec>;
};

export function loadManifest(path = resolve("deploy/processes.json")): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** KEY=VALUE lines; comments and blanks ignored; optional surrounding quotes. */
export function parseEnvFile(text: string) {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 1) continue;
    let value = line.slice(at + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    env[line.slice(0, at).trim()] = value;
  }
  return env;
}

// Variables every process may carry that say nothing about OrgFit.
const AMBIENT = /^(PATH|Path|SystemRoot|HOME|USERPROFILE|TEMP|TMP|TZ|LANG|LC_\w+|PORT|HOSTNAME|NODE_EXTRA_CA_CERTS|NODE_OPTIONS|PGSSLROOTCERT|AWS_\w+|npm_\w+)$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function checkEnvironment(
  processName: string,
  env: Record<string, string | undefined>,
  options: { production: boolean; manifest?: Manifest },
): Finding[] {
  const manifest = options.manifest ?? loadManifest();
  const spec = manifest.processes[processName];
  const out: Finding[] = [];
  const add = (check: string, outcome: Outcome, detail: string) => out.push({ check, outcome, detail });
  if (!spec) {
    add("process", "FAIL", `unknown process "${processName}"`);
    return out;
  }
  const present = (k: string) => env[k] !== undefined && env[k] !== "";

  // 1. Required and placeholder values.
  const missing = spec.required.filter((k) => !present(k));
  add("required", missing.length ? "FAIL" : "PASS", missing.length ? `missing: ${missing.join(", ")}` : `${spec.required.length} present`);
  const placeholders = Object.keys(env).filter((k) => /CHANGE_ME|example\.invalid/i.test(env[k] ?? ""));
  add("placeholders", placeholders.length ? "FAIL" : "PASS", placeholders.length ? `placeholder values in: ${placeholders.join(", ")}` : "none");

  // 2. Forbidden variables: holding any collapses a trust boundary.
  const forbidden = spec.forbidden.filter(present);
  add("forbidden", forbidden.length ? "FAIL" : "PASS", forbidden.length ? `must not be present: ${forbidden.join(", ")}` : "none present");

  // 3. Recommended and unknown variables.
  const notRecommended = (spec.recommended ?? []).filter((k) => !present(k));
  if (notRecommended.length) add("recommended", "WARN", `not set: ${notRecommended.join(", ")}`);
  const storageVars = (spec.storage ?? []).flatMap((kind) => manifest.storage[kind] ?? []);
  const known = new Set([...spec.required, ...(spec.recommended ?? []), ...(spec.optional ?? []), ...storageVars, ...spec.forbidden]);
  const unknown = Object.keys(env).filter((k) => present(k) && !known.has(k) && !AMBIENT.test(k));
  if (unknown.length) add("unknown", "WARN", `not in the manifest for ${processName}: ${unknown.join(", ")}`);

  // 4. NODE_ENV.
  if (options.production)
    add("node-env", env.NODE_ENV === "production" ? "PASS" : "FAIL", env.NODE_ENV === "production" ? "production" : "NODE_ENV must be production");

  // 5. Key format and separation.
  const badKeys = manifest.keys.hex64.filter((k) => present(k) && !/^[0-9a-f]{64}$/.test(env[k]!));
  add("key-format", badKeys.length ? "FAIL" : "PASS", badKeys.length ? `not 64 lowercase hex: ${badKeys.join(", ")}` : "all present keys well formed");
  const seen = new Map<string, string>();
  const reused: string[] = [];
  for (const k of manifest.keys.mustDiffer.filter(present)) {
    const d = createHash("sha256").update(env[k]!).digest("hex");
    if (seen.has(d)) reused.push(`${seen.get(d)}=${k}`);
    else seen.set(d, k);
  }
  add("key-separation", reused.length ? "FAIL" : "PASS", reused.length ? `same value reused: ${reused.join(", ")}` : "distinct");
  if (present("CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY") && !/^[A-Za-z0-9+/=_-]{40,}$/.test(env.CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY!))
    add("custody-public-key", "FAIL", "CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY is not an encoded key");
  // Post-Audit Repair Pass 4: production-security adapters. Each check uses the
  // same resolver the process itself runs at start, so preflight and runtime
  // cannot disagree about what is acceptable.
  const refusal = (fn: () => unknown) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof RuntimeGuardError ? e.code : e instanceof AppError ? "TRUSTED_PROXY_CONFIG_INVALID" : "INVALID";
    }
  };
  if (spec.required.includes("CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY")) {
    // The rehearsal acknowledgement is ignored here on purpose: no deployment
    // passes preflight with development custody (P-003, SEC-H1).
    const code = refusal(() => custodyProviderName({ ...env, CAMPAIGN_KEY_CUSTODY_REHEARSAL_ONLY: undefined }));
    if (code) add("key-custody", "FAIL", `${code}: no managed key custody provider is integrated (P-003); the file-directory stand-in has no crypto-erasure`);
    else add("key-custody", "WARN", "file-directory stand-in custody: not managed custody, no crypto-erasure (development only)");
    if (options.production && present("CAMPAIGN_KEY_CUSTODY_REHEARSAL_ONLY"))
      add("key-custody-rehearsal", "FAIL", "CAMPAIGN_KEY_CUSTODY_REHEARSAL_ONLY is for a local release rehearsal and must never be in a deployment");
  }
  if (processName === "scanner") {
    const code = refusal(() => engineFromEnvironment(env));
    if (code) add("scan-engine", "FAIL", `${code}: a maintained malware engine is required (P-010)`);
    else if (!env.ATTACHMENT_SCAN_ENGINE || env.ATTACHMENT_SCAN_ENGINE === "development-heuristic")
      add("scan-engine", "WARN", "development heuristic: recognizes the EICAR test string only; NOT a malware scan");
    else add("scan-engine", "PASS", `${env.ATTACHMENT_SCAN_ENGINE} adapter configured (engine reachability is checked by the job before each run)`);
  }
  if (processName === "staff" || processName === "respondent") {
    const code = refusal(() => trustedProxy(env));
    if (code || (options.production && !present("RATE_LIMIT_CLIENT_IP_HEADER")))
      add("trusted-proxy", "FAIL", "RATE_LIMIT_CLIENT_IP_HEADER must name the header the trusted proxy overwrites, or be `none`; hops 0–10 (SEC-M2)");
    else if (env.RATE_LIMIT_CLIENT_IP_HEADER === "none")
      add("trusted-proxy", "WARN", "no trusted proxy header: per-address limits are off; rely on edge limits (SEC-M1)");
    else if (present("RATE_LIMIT_CLIENT_IP_HEADER")) add("trusted-proxy", "PASS", "per-address limits keyed on the trusted proxy header");
  }
  if (processName === "operator") {
    const code = refusal(() => tombstoneSinkFromEnvironment(options.production ? { ...env, NODE_ENV: "production" } : env));
    if (code) add("tombstone-ledger", "FAIL", `${code}: production needs TOMBSTONE_LEDGER_S3_BUCKET with TOMBSTONE_LEDGER_OBJECT_LOCK_DAYS ≥ 36 (SEC-M3)`);
    else if (present("TOMBSTONE_LEDGER_S3_BUCKET"))
      add("tombstone-ledger", "PASS", "bucket ledger with conditional creates; Object Lock on the bucket itself is not verifiable from here");
  }

  // 6. Database URLs: identity, password, TLS.
  for (const [key, role] of Object.entries(manifest.databaseUrls)) {
    if (!present(key)) continue;
    let url: URL;
    try {
      url = new URL(env[key]!);
    } catch {
      add(`db:${key}`, "FAIL", "not a URL");
      continue;
    }
    const problems: string[] = [];
    if (!["postgres:", "postgresql:"].includes(url.protocol)) problems.push("not a PostgreSQL URL");
    if (decodeURIComponent(url.username) !== role) problems.push(`must authenticate as ${role}`);
    if (!url.password) problems.push("no password");
    if (options.production && url.searchParams.get("sslmode") !== "verify-full") problems.push("sslmode must be verify-full");
    add(`db:${key}`, problems.length ? "FAIL" : "PASS", problems.length ? problems.join("; ") : `${role}${url.searchParams.get("sslmode") ? `, sslmode=${url.searchParams.get("sslmode")}` : ""}`);
    if (options.production && LOOPBACK.has(url.hostname))
      add(`db-host:${key}`, "WARN", "loopback database host in a production-mode environment");
  }

  // pg passes an empty TLS options object for sslmode=verify-full, so Node's
  // global override would silently disable certificate verification.
  if (options.production && env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    add("tls-verification", "FAIL", "NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification");

  // 7. Origins and identity provider.
  const originOk = (k: string) => {
    if (!present(k)) return;
    try {
      const u = new URL(env[k]!);
      const problems: string[] = [];
      if (u.origin !== env[k]) problems.push("must be a bare origin");
      if (options.production && u.protocol !== "https:") problems.push("must be https");
      add(`origin:${k}`, problems.length ? "FAIL" : "PASS", problems.length ? problems.join("; ") : u.protocol);
    } catch {
      add(`origin:${k}`, "FAIL", "not a URL");
    }
  };
  originOk("STAFF_ORIGIN");
  originOk("RESPONDENT_ORIGIN");
  if (present("STAFF_ORIGIN") && present("RESPONDENT_ORIGIN")) {
    try {
      const same = new URL(env.STAFF_ORIGIN!).hostname === new URL(env.RESPONDENT_ORIGIN!).hostname;
      add("origin-separation", same ? "FAIL" : "PASS", same ? "staff and respondent must be different hosts" : "different hosts");
    } catch {
      /* reported above */
    }
  }
  if (present("OIDC_ISSUER")) {
    const https = env.OIDC_ISSUER!.startsWith("https://");
    add("oidc-issuer", options.production && !https ? "FAIL" : "PASS", https ? "https" : "http (development only)");
  }

  // 8. Private storage.
  for (const kind of spec.storage ?? []) {
    const [bucket, local] = manifest.storage[kind];
    if (present(bucket)) add(`storage:${kind}`, "PASS", "bucket");
    else if (present(local))
      add(`storage:${kind}`, options.production ? "FAIL" : "PASS", options.production ? `${local} is development-only; set ${bucket}` : "local directory (development)");
    else add(`storage:${kind}`, "FAIL", `set ${bucket}${options.production ? "" : ` or ${local}`}`);
  }
  return out;
}

// ---- database checks ---------------------------------------------------------

export function migrationDigests(dir: string) {
  return readdirSync(resolve(dir))
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort()
    .map((name) => ({
      name,
      digest: createHash("sha256").update(readFileSync(resolve(dir, name), "utf8")).digest("hex"),
    }));
}

async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

// Server settings that keep bind values and constraint details out of logs
// (retention-backup-runbook §2). SEC-M4: documented in Phase 14, checked here.
export const REQUIRED_LOG_SETTINGS: Record<string, string> = {
  log_statement: "none",
  log_min_duration_statement: "-1",
  log_parameter_max_length: "0",
  log_parameter_max_length_on_error: "0",
  log_error_verbosity: "terse",
};

export async function checkDatabases(
  processName: string,
  env: Record<string, string | undefined>,
  options: { production: boolean; manifest?: Manifest },
): Promise<Finding[]> {
  const manifest = options.manifest ?? loadManifest();
  const spec = manifest.processes[processName];
  const out: Finding[] = [];
  const add = (check: string, outcome: Outcome, detail: string) => out.push({ check, outcome, detail });
  if (!spec) return out;
  const keys = Object.keys(manifest.databaseUrls).filter(
    (k) => env[k] && (spec.required.includes(k) || (spec.optional ?? []).includes(k)),
  );
  for (const key of keys) {
    try {
      await withClient(env[key]!, async (c) => {
        const who = (
          await c.query(
            `SELECT current_user AS u, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
                    coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()), false) AS ssl
               FROM pg_roles r WHERE r.rolname=current_user`,
          )
        ).rows[0];
        const privileged = who.rolsuper || who.rolbypassrls || who.rolcreaterole || who.rolcreatedb;
        add(`role:${key}`, privileged ? "FAIL" : "PASS", privileged ? `${who.u} holds a cluster-level privilege` : `${who.u}, no superuser/bypassrls/createrole/createdb`);
        add(`tls:${key}`, who.ssl ? "PASS" : options.production ? "FAIL" : "WARN", who.ssl ? "connection encrypted" : "connection not encrypted");
        const settings: string[] = [];
        for (const [name, expected] of Object.entries(REQUIRED_LOG_SETTINGS)) {
          const value = await c
            .query("SELECT current_setting($1) AS v", [name])
            .then((r) => String(r.rows[0].v))
            .catch(() => null);
          if (value === null) settings.push(`${name} unreadable`);
          else if (value !== expected) settings.push(`${name} is not ${expected}`);
        }
        add(`log-settings:${key}`, settings.length ? (options.production ? "FAIL" : "WARN") : "PASS", settings.length ? settings.join("; ") : "bind values and details kept out of server logs");
      });
    } catch {
      add(`connect:${key}`, "FAIL", "could not connect with this credential");
    }
  }

  // Operator: the migration ledgers must equal this release's migration files,
  // the environment must not be waiting for a tombstone replay, and retention
  // approval is reported.
  if (processName === "operator" && env.MIGRATION_DATABASE_URL) {
    try {
      await withClient(env.MIGRATION_DATABASE_URL, async (c) => {
        await c.query("SET ROLE orgfit_core_owner");
        const ledger = (await c.query("SELECT name, digest FROM public.orgfit_migrations ORDER BY name")).rows as { name: string; digest: string }[];
        add("migrations:core", ...compareLedger(ledger, migrationDigests("db/migrations")));
        const state = (await c.query("SELECT state FROM ops.restore_state")).rows[0]?.state as string | undefined;
        add("restore-state", state === "NORMAL" ? "PASS" : "FAIL", `restore state ${state ?? "unknown"}`);
        const unapproved = (await c.query("SELECT count(*)::int AS n FROM ops.retention_policy WHERE NOT approved")).rows[0].n as number;
        add("retention-approval", unapproved ? "WARN" : "PASS", unapproved ? `${unapproved} retention classes unapproved (P-004)` : "all approved");
        const local = (await c.query("SELECT count(*)::int AS n FROM access.local_access_setting WHERE enabled")).rows[0].n as number;
        add("local-password-path", local && options.production ? "FAIL" : local ? "WARN" : "PASS", local ? "development password sign-in is switched on" : "switched off");
      });
    } catch {
      add("migrations:core", "FAIL", "could not read the core migration ledger");
    }
  }
  if (processName === "operator" && env.ANONYMOUS_MIGRATION_DATABASE_URL) {
    try {
      await withClient(env.ANONYMOUS_MIGRATION_DATABASE_URL, async (c) => {
        await c.query("SET ROLE orgfit_anon_owner");
        const ledger = (await c.query("SELECT name, digest FROM public.orgfit_anonymous_migrations ORDER BY name")).rows as { name: string; digest: string }[];
        add("migrations:anonymous", ...compareLedger(ledger, migrationDigests("db/anonymous")));
      });
    } catch {
      add("migrations:anonymous", "FAIL", "could not read the anonymous migration ledger");
    }
  }
  return out;
}

export function compareLedger(
  ledger: { name: string; digest: string }[],
  files: { name: string; digest: string }[],
): [Outcome, string] {
  const byName = new Map(ledger.map((l) => [l.name, l.digest]));
  const pending = files.filter((f) => !byName.has(f.name)).map((f) => f.name);
  const changed = files.filter((f) => byName.has(f.name) && byName.get(f.name) !== f.digest).map((f) => f.name);
  const foreign = ledger.filter((l) => !files.some((f) => f.name === l.name)).map((l) => l.name);
  if (changed.length || foreign.length)
    return ["FAIL", [changed.length && `digest differs: ${changed.join(", ")}`, foreign.length && `applied but not in this release: ${foreign.join(", ")}`].filter(Boolean).join("; ")];
  if (pending.length) return ["FAIL", `not applied: ${pending.join(", ")}`];
  return ["PASS", `${files.length} applied, digests equal this release`];
}
