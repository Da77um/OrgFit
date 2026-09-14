// Phase 15 — release rehearsal: the production builds, in production mode,
// behind TLS, against a TLS-only database, with every process holding only its
// own environment file.
//
// Run after `npm run build`:   npx tsx tests/release/rehearsal.ts
//
// This is NOT staging. No authorized non-production environment exists (P-002),
// so the rehearsal runs on one machine: a throwaway PostgreSQL 18 cluster that
// refuses non-TLS connections, a local certificate authority, a TLS reverse
// proxy that overwrites X-Forwarded-For, the synthetic OIDC provider served over
// https, and a local S3-compatible TEST DOUBLE for private object storage. What
// it proves is that the release candidate starts, authenticates, stores, renders
// and recovers with the production code paths switched on — sslmode=verify-full,
// __Host- secure cookies, bucket storage, production CSP — and that each
// process refuses to hold another's credentials. What it cannot prove: a real
// identity provider and MFA, a real bucket's policies and lifecycle, a real
// proxy/CDN/WAF, network segmentation, provider KMS, or production hardware.
//
// Every value lives under work/release-rehearsal (ignored). Output:
// work/p15-rehearsal.json. Any failed assertion exits 1.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { join, resolve } from "node:path";
import pg from "pg";
import { chromium } from "playwright";
import { parseEnvFile } from "../../src/preflight";
import { generateCustodianKeypair } from "../../src/key-custody";
import { testProvider } from "../oidc-provider";

const ROOT = resolve("work/release-rehearsal");
const BIN = resolve(process.env.PG_BIN ?? "work/package/native/bin");
const OPENSSL = process.env.OPENSSL ?? "C:/Program Files/Git/usr/bin/openssl.exe";
const PG_PORT = 55473;
const INTERNAL = { staff: 3110, respondent: 3111, oidc: 4011, s3: 4012 };
const PUBLIC = { staff: 8443, respondent: 9443, oidc: 8444, s3: 8445 };
const STAFF = `https://127.0.0.1:${PUBLIC.staff}`;
const SURVEY = `https://localhost:${PUBLIC.respondent}`;
const ISSUER = `https://127.0.0.1:${PUBLIC.oidc}`;
const S3 = `https://127.0.0.1:${PUBLIC.s3}`;
const BUILTIN_Q = "44000000-0000-4000-8000-000000000001";
const BUILTIN_V = "44000000-0000-4000-9000-000000000001";

const results: Record<string, unknown> = { startedAt: new Date().toISOString() };
const passed: string[] = [];
const ok = (label: string) => {
  passed.push(label);
  console.log(`PASS ${label}`);
};
const children: ChildProcess[] = [];
const servers: { close: () => unknown }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function cleanup() {
  for (const c of children) c.kill();
  for (const s of servers) s.close();
  if (existsSync(join(ROOT, "pg", "postmaster.pid")))
    spawnSync(join(BIN, "pg_ctl.exe"), ["-D", join(ROOT, "pg"), "-m", "fast", "-w", "stop"], { stdio: "ignore", windowsHide: true });
}
process.on("exit", cleanup);

for (const app of ["staff", "respondent"])
  assert.ok(existsSync(resolve("apps", app, ".next", "BUILD_ID")), `build ${app} first (npm run build)`);

// ---- 1. certificate authority and server certificate ----------------------------
await rm(ROOT, { recursive: true, force: true });
const CERTS = join(ROOT, "certs");
await mkdir(CERTS, { recursive: true });
const openssl = (...args: string[]) => {
  const r = spawnSync(OPENSSL, args, { cwd: CERTS, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr}`);
};
openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=OrgFit rehearsal CA", "-keyout", "ca.key", "-out", "ca.crt");
openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", "server.key", "-out", "server.csr");
await writeFile(join(CERTS, "san.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
openssl("x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "san.cnf", "-out", "server.crt");
const CA_FILE = join(CERTS, "ca.crt").replace(/\\/g, "/");
const ca = readFileSync(CA_FILE);
const tls = { key: readFileSync(join(CERTS, "server.key")), cert: readFileSync(join(CERTS, "server.crt")) };

// ---- 2. a TLS-only PostgreSQL cluster ----------------------------------------------
const PGDATA = join(ROOT, "pg");
const superPassword = randomBytes(18).toString("hex");
await writeFile(join(ROOT, "pw.txt"), superPassword);
const pgRun = (exe: string, args: string[]) => {
  const piped = exe !== "pg_ctl.exe";
  const r = spawnSync(join(BIN, exe), args, { encoding: "utf8", stdio: piped ? "pipe" : "ignore", windowsHide: true });
  if (r.status !== 0) throw new Error(`${exe} failed (${r.status})`);
};
pgRun("initdb.exe", ["-D", PGDATA, "-U", "postgres", "-A", "scram-sha-256", "--pwfile", join(ROOT, "pw.txt"), "--encoding=UTF8", "--locale=C"]);
await writeFile(join(PGDATA, "server.crt"), tls.cert);
await writeFile(join(PGDATA, "server.key"), tls.key);
await writeFile(
  join(PGDATA, "postgresql.auto.conf"),
  [
    "ssl = on",
    "ssl_cert_file = 'server.crt'",
    "ssl_key_file = 'server.key'",
    "ssl_min_protocol_version = 'TLSv1.2'",
    // retention-backup-runbook §2: no bind values or details in server logs.
    "log_statement = 'none'",
    "log_min_duration_statement = -1",
    "log_parameter_max_length = 0",
    "log_parameter_max_length_on_error = 0",
    "log_error_verbosity = terse",
    "",
  ].join("\n"),
);
await writeFile(join(PGDATA, "pg_hba.conf"), "hostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::/0 reject\nhostssl all all 127.0.0.1/32 scram-sha-256\nhostssl all all ::1/128 scram-sha-256\n");
pgRun("pg_ctl.exe", ["-D", PGDATA, "-l", join(ROOT, "postgres.log"), "-o", `-h localhost -p ${PG_PORT}`, "-w", "start"]);

const dbUrl = (role: string, pw: string, db: string) =>
  `postgresql://${role}:${pw}@localhost:${PG_PORT}/${db}?sslmode=verify-full&sslrootcert=${encodeURIComponent(CA_FILE)}`;
async function sql(url: string, text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}
const superUrl = (db = "postgres") => dbUrl("postgres", superPassword, db);
const [{ ssl_library }] = await sql(superUrl(), "select current_setting('ssl_library') ssl_library");
results.sslLibrary = ssl_library;
const plaintext = await sql(`postgresql://postgres:${superPassword}@localhost:${PG_PORT}/postgres?sslmode=disable`, "select 1").then(
  () => "accepted",
  () => "refused",
);
assert.equal(plaintext, "refused");
const wrongCa = await sql(`postgresql://postgres:${superPassword}@localhost:${PG_PORT}/postgres?sslmode=verify-full`, "select 1").then(
  () => "accepted",
  () => "refused",
);
assert.equal(wrongCa, "refused", "verify-full must refuse a server certificate it cannot verify");
ok("database: plaintext connections are refused and verify-full refuses an untrusted certificate");

// ---- 3. provisioning (what an operator does once per environment) --------------------
const roles = ["orgfit_migrator", "orgfit_staff", "orgfit_auth", "orgfit_gateway", "orgfit_processor", "orgfit_anon_migrator", "orgfit_report", "orgfit_scanner"];
const pw = Object.fromEntries(roles.map((r) => [r, randomBytes(20).toString("hex")]));
await sql(superUrl(), await readFile("db/roles.sql", "utf8"));
for (const role of roles) await sql(superUrl(), `ALTER ROLE ${role} PASSWORD '${pw[role]}'`);
await sql(superUrl(), "CREATE DATABASE orgfit");
await sql(superUrl(), "CREATE DATABASE orgfit_anonymous");
await sql(superUrl(), "REVOKE ALL ON DATABASE orgfit FROM PUBLIC");
await sql(superUrl(), "REVOKE ALL ON DATABASE orgfit_anonymous FROM PUBLIC");
await sql(superUrl(), "GRANT CONNECT ON DATABASE orgfit TO orgfit_migrator,orgfit_staff,orgfit_auth,orgfit_gateway,orgfit_processor,orgfit_report,orgfit_scanner");
await sql(superUrl(), "GRANT CREATE ON DATABASE orgfit TO orgfit_core_owner");
await sql(superUrl(), "GRANT CONNECT ON DATABASE orgfit_anonymous TO orgfit_anon_migrator,orgfit_processor");
await sql(superUrl(), "GRANT CREATE ON DATABASE orgfit_anonymous TO orgfit_anon_owner");
await sql(superUrl("orgfit"), "GRANT CREATE,USAGE ON SCHEMA public TO orgfit_core_owner");
await sql(superUrl("orgfit_anonymous"), "GRANT CREATE,USAGE ON SCHEMA public TO orgfit_anon_owner");

// ---- 4. one environment file per process ---------------------------------------------
const hex = () => randomBytes(32).toString("hex");
const custodian = await generateCustodianKeypair();
const dirs = { custody: join(ROOT, "custody"), ledger: join(ROOT, "tombstones"), backups: join(ROOT, "backups") };
for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
await writeFile(join(dirs.backups, "base-latest.marker"), "synthetic");
const keys = { import: hex(), digest: hex(), link: hex(), report: hex(), participation: hex(), attachment: hex() };
const core = (role: string) => dbUrl(role, pw[role], "orgfit");
const anonymous = (role: string) => dbUrl(role, pw[role], "orgfit_anonymous");
const bucket = (kind: string, prefix: string) => ({ [`${kind}_S3_BUCKET`]: `orgfit-${prefix}`, [`${kind}_S3_ENDPOINT`]: S3 });
const envs: Record<string, Record<string, string>> = {
  staff: {
    NODE_ENV: "production",
    STAFF_ORIGIN: STAFF,
    RESPONDENT_ORIGIN: SURVEY,
    DATABASE_URL: core("orgfit_staff"),
    AUTH_DATABASE_URL: core("orgfit_auth"),
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: "orgfit-test",
    OIDC_CLIENT_SECRET: "synthetic-oidc-test-secret",
    OIDC_MFA_ACR: "urn:test:mfa",
    IMPORT_ENCRYPTION_KEY: keys.import,
    INVITATION_DIGEST_KEY: keys.digest,
    INVITATION_DIGEST_KEY_VERSION: "rc1",
    LINK_EXPORT_ENCRYPTION_KEY: keys.link,
    CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY: custodian.publicKey,
    CAMPAIGN_KEY_CUSTODY_DIRECTORY: dirs.custody,
    REPORT_ENCRYPTION_KEY: keys.report,
    PARTICIPATION_EXPORT_ENCRYPTION_KEY: keys.participation,
    ATTACHMENT_ENCRYPTION_KEY: keys.attachment,
    AWS_REGION: "us-east-1",
    ...bucket("IMPORT", "imports"),
    ...bucket("LINK_EXPORT", "link-exports"),
    ...bucket("REPORT", "reports"),
    ...bucket("PARTICIPATION_EXPORT", "participation"),
    ...bucket("ATTACHMENT", "attachments"),
    NEXT_TELEMETRY_DISABLED: "1",
  },
  respondent: {
    NODE_ENV: "production",
    RESPONDENT_ORIGIN: SURVEY,
    GATEWAY_DATABASE_URL: core("orgfit_gateway"),
    INVITATION_DIGEST_KEY: keys.digest,
    INVITATION_DIGEST_KEY_VERSION: "rc1",
    RATE_LIMIT_CLIENT_IP_HEADER: "x-forwarded-for",
    RATE_LIMIT_TRUSTED_PROXY_HOPS: "0",
    NEXT_TELEMETRY_DISABLED: "1",
  },
  processor: {
    NODE_ENV: "production",
    PROCESSOR_DATABASE_URL: core("orgfit_processor"),
    ANONYMOUS_DATABASE_URL: anonymous("orgfit_processor"),
    CAMPAIGN_KEY_CUSTODY_SECRET_KEY: custodian.secretKey,
    CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY: custodian.publicKey,
    CAMPAIGN_KEY_CUSTODY_DIRECTORY: dirs.custody,
  },
  report: { NODE_ENV: "production", REPORT_DATABASE_URL: core("orgfit_report"), REPORT_ENCRYPTION_KEY: keys.report, AWS_REGION: "us-east-1", ...bucket("REPORT", "reports") },
  scanner: { NODE_ENV: "production", SCANNER_DATABASE_URL: core("orgfit_scanner"), ATTACHMENT_ENCRYPTION_KEY: keys.attachment, AWS_REGION: "us-east-1", ...bucket("ATTACHMENT", "attachments") },
  operator: {
    NODE_ENV: "production",
    MIGRATION_DATABASE_URL: core("orgfit_migrator"),
    ANONYMOUS_MIGRATION_DATABASE_URL: anonymous("orgfit_anon_migrator"),
    TOMBSTONE_LEDGER_DIRECTORY: dirs.ledger,
    BACKUP_DIRECTORY: dirs.backups,
    OPS_DISK_PATH: ROOT,
    CAMPAIGN_KEY_CUSTODY_DIRECTORY: dirs.custody,
    AWS_REGION: "us-east-1",
    ...bucket("ATTACHMENT", "attachments"),
    ATTACHMENT_ENCRYPTION_KEY: keys.attachment,
    BOOTSTRAP_ISSUER: ISSUER,
    BOOTSTRAP_SUBJECT: "admin",
    BOOTSTRAP_EMAIL: "admin@orgfit.test",
    BOOTSTRAP_NAME: "مسؤول التجربة",
  },
};
const envFile = (name: string) => join(ROOT, `${name}.env`);
for (const [name, env] of Object.entries(envs))
  await writeFile(envFile(name), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
// What every process gets besides its own file: the platform, the rehearsal CA
// (standing in for a public CA) and synthetic object-store credentials.
const ambient = {
  PATH: process.env.PATH ?? "",
  SystemRoot: process.env.SystemRoot ?? "",
  TEMP: process.env.TEMP ?? "",
  TMP: process.env.TMP ?? "",
  LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
  USERPROFILE: process.env.USERPROFILE ?? "",
  NODE_EXTRA_CA_CERTS: CA_FILE,
  AWS_ACCESS_KEY_ID: "rehearsal-access-key",
  AWS_SECRET_ACCESS_KEY: "rehearsal-secret-key",
};
const processEnv = (name: string) => ({ ...ambient, ...parseEnvFile(readFileSync(envFile(name), "utf8")) }) as unknown as NodeJS.ProcessEnv;
// Asynchronous on purpose: the object-store double, the identity provider and
// the TLS proxy live in THIS process, so a blocking spawn would deadlock any
// worker that talks to them.
function run(name: string, script: string, args: string[] = []): Promise<{ status: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], { env: processEnv(name), windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (status) => done({ status, out: out.trim() }));
  });
}
const expectRun = async (name: string, script: string, args: string[] = [], status = 0) => {
  const r = await run(name, script, args);
  assert.equal(r.status, status, `${script} ${args.join(" ")} exited ${r.status}: ${r.out}`);
  return r.out;
};
// ---- 5. release steps as an operator runs them ------------------------------------------
results.migrate = await expectRun("operator", "scripts/migrate.ts");
results.migrateAnonymous = await expectRun("operator", "scripts/migrate-anonymous.ts");
results.bootstrap = await expectRun("operator", "scripts/bootstrap.ts");
assert.equal((await run("operator", "scripts/bootstrap.ts")).status, 1, "a second bootstrap is refused");
results.seedInstruments = await expectRun("operator", "scripts/seed-instruments.ts");
ok("release steps: migrations, anonymous migrations and first-administrator bootstrap over verify-full; a second bootstrap is refused");

const preflight: Record<string, unknown> = {};
for (const name of Object.keys(envs)) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/release-preflight.ts", "--process", name, "--env-file", envFile(name), "--production", "--check-database", "--json"], { env: ambient as unknown as NodeJS.ProcessEnv, encoding: "utf8", windowsHide: true });
  const report = JSON.parse(r.stdout);
  preflight[name] = report.findings.filter((f: { outcome: string }) => f.outcome !== "PASS");
  assert.equal(r.status, 0, `${name} preflight: ${JSON.stringify(preflight[name])}`);
  const raw = readFileSync(envFile(name), "utf8");
  for (const value of Object.values(parseEnvFile(raw)).filter((v) => v.length >= 16 && !v.startsWith("https://")))
    assert.ok(!r.stdout.includes(value), `${name} preflight printed a value`);
}
results.preflightNonPass = preflight;
// A deliberately mixed environment is refused before anything starts.
await writeFile(join(ROOT, "mixed.env"), readFileSync(envFile("staff"), "utf8") + `GATEWAY_DATABASE_URL=${core("orgfit_gateway")}\n`);
assert.equal(spawnSync(process.execPath, ["--import", "tsx", "scripts/release-preflight.ts", "--process", "staff", "--env-file", join(ROOT, "mixed.env"), "--production"], { env: ambient as unknown as NodeJS.ProcessEnv, encoding: "utf8" }).status, 1);
ok("preflight: all six processes pass in production mode with database checks; a staff environment holding the gateway credential is refused");

// ---- 6. object storage double, identity provider and TLS proxy --------------------------
const objects = new Map<string, Buffer>();
const s3 = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body = Buffer.concat(chunks);
  // aws-chunked uploads carry chunk framing; store the decoded bytes.
  if (String(req.headers["content-encoding"] ?? "").includes("aws-chunked") || req.headers["x-amz-decoded-content-length"]) {
    const out: Buffer[] = [];
    let at = 0;
    for (;;) {
      const eol = body.indexOf("\r\n", at);
      if (eol < 0) break;
      const size = parseInt(body.subarray(at, eol).toString("latin1").split(";")[0], 16);
      if (!size) break;
      out.push(body.subarray(eol + 2, eol + 2 + size));
      at = eol + 2 + size + 2;
    }
    body = Buffer.concat(out);
  }
  const key = decodeURIComponent(new URL(req.url ?? "/", "http://s3").pathname);
  if (req.method === "PUT") {
    objects.set(key, body);
    res.writeHead(200, { ETag: `"${createHash("md5").update(body).digest("hex")}"` }).end();
  } else if (req.method === "GET" || req.method === "HEAD") {
    const found = objects.get(key);
    if (!found) res.writeHead(404, { "Content-Type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
    else res.writeHead(200, { "Content-Length": found.length, "Content-Type": "application/octet-stream" }).end(req.method === "GET" ? found : undefined);
  } else if (req.method === "DELETE") {
    objects.delete(key);
    res.writeHead(204).end();
  } else res.writeHead(405).end();
});
await new Promise<void>((r) => s3.listen(INTERNAL.s3, "127.0.0.1", r));
servers.push(s3);
servers.push(await testProvider(INTERNAL.oidc, STAFF, ISSUER));
const forwarded: string[] = [];
function proxy(publicPort: number, host: string, target: number) {
  const server = https.createServer(tls, (req, res) => {
    // The proxy OVERWRITES X-Forwarded-For with the address it saw, which is
    // what RATE_LIMIT_CLIENT_IP_HEADER requires of a trusted proxy.
    const client = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const headers = { ...req.headers, "x-forwarded-for": client, "x-forwarded-proto": "https" };
    forwarded.push(String(headers["x-forwarded-for"]));
    const upstream = http.request({ host: "127.0.0.1", port: target, method: req.method, path: req.url, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  server.listen(publicPort, host);
  servers.push(server);
}
// "::" is dual-stack, so both 127.0.0.1 and localhost (either family) arrive.
proxy(PUBLIC.staff, "::", INTERNAL.staff);
proxy(PUBLIC.respondent, "::", INTERNAL.respondent);
proxy(PUBLIC.oidc, "::", INTERNAL.oidc);
proxy(PUBLIC.s3, "::", INTERNAL.s3);

// ---- 7. the two production builds --------------------------------------------------------
const next = resolve("node_modules/next/dist/bin/next");
for (const [app, port] of [["staff", INTERNAL.staff], ["respondent", INTERNAL.respondent]] as const) {
  const child = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: resolve("apps", app),
    env: processEnv(app),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));
  child.on("exit", () => (results[`${app}ExitLog`] = log.slice(-2000)));
  children.push(child);
}

// ---- HTTPS client with a cookie jar ---------------------------------------------------------
type Reply = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; text: string; // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped API payloads in a test harness
  json: () => any };
const jars: Record<string, Map<string, string>> = {};
function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string | Buffer; jar?: string } = {}): Promise<Reply> {
  const u = new URL(url);
  const jar = options.jar ? (jars[options.jar] ??= new Map()) : undefined;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (jar?.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  if (options.body !== undefined) headers["content-length"] = String(Buffer.byteLength(options.body));
  return new Promise((resolvePromise, reject) => {
    const r = https.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: options.method ?? "GET", headers, ca, servername: u.hostname === "127.0.0.1" ? undefined : u.hostname }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        for (const c of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) {
          const [pair] = c.split(";");
          const at = pair.indexOf("=");
          if (jar) {
            if (/max-age=0|expires=thu, 01 jan 1970/i.test(c)) jar.delete(pair.slice(0, at));
            else jar.set(pair.slice(0, at), pair.slice(at + 1));
          }
        }
        const body = Buffer.concat(chunks);
        resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString("utf8"), json: () => JSON.parse(body.toString("utf8")) });
      });
    });
    r.on("error", reject);
    if (options.body !== undefined) r.write(options.body);
    r.end();
  });
}
for (let i = 0; i < 240; i++) {
  const up = await Promise.all([request(`${STAFF}/health/live`), request(`${SURVEY}/health/live`)]).then(
    (r) => r.every((x) => x.status === 200),
    () => false,
  );
  if (up) break;
  await sleep(500);
}
for (const origin of [STAFF, SURVEY]) assert.equal((await request(`${origin}/health/ready`)).status, 200, `${origin} ready: ${JSON.stringify(results)}`);
ok("production builds: both applications report ready over https with verify-full database connections");

const login = await request(`${STAFF}/login`);
const csp = String(login.headers["content-security-policy"] ?? "");
assert.ok(csp.includes("'nonce-") && !csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
assert.equal(login.headers["x-frame-options"], "DENY");
assert.equal(login.headers["x-powered-by"], undefined);
assert.match(login.text, /href="\/api\/v1\/auth\/start"/, "the identity provider is offered once configured");
results.hsts = { staff: login.headers["strict-transport-security"] ?? null };

// ---- 8. staff sign-in through the identity provider over https ----------------------------
const start = await request(`${STAFF}/api/v1/auth/start`, { jar: "admin" });
assert.ok([302, 303, 307].includes(start.status), `auth/start ${start.status} ${start.text.slice(0, 200)}`);
const authorize = new URL(String(start.headers.location));
assert.equal(authorize.origin, ISSUER);
const approve = new URL(`${ISSUER}/approve`);
for (const [k, v] of authorize.searchParams) approve.searchParams.set(k, v);
approve.searchParams.set("subject", "admin");
approve.searchParams.set("mode", "normal");
const approved = await request(approve.href);
const callback = await request(String(approved.headers.location), { jar: "admin" });
assert.ok([302, 303, 307].includes(callback.status), `callback ${callback.status} ${callback.text.slice(0, 300)}`);
const sessionCookie = ([] as string[]).concat(callback.headers["set-cookie"] ?? []).find((c) => c.startsWith("__Host-orgfit-staff="));
assert.ok(sessionCookie, "a __Host- session cookie is issued over https");
assert.match(sessionCookie, /;\s*Secure/i);
assert.match(sessionCookie, /;\s*HttpOnly/i);
assert.match(sessionCookie, /;\s*Path=\//i);
assert.doesNotMatch(sessionCookie, /;\s*Domain=/i);
const profile = (await request(`${STAFF}/api/v1/profile`, { jar: "admin", headers: { Origin: STAFF } })).json().data;
assert.equal(profile.role, "SUPER_ADMIN");
ok("sign-in: OIDC over https issues a __Host- Secure HttpOnly session for the bootstrapped Super Admin");

async function api(method: string, path: string, data?: unknown, extra: Record<string, string> = {}, expected?: number) {
  const r = await request(`${STAFF}/api/v1/${path}`, {
    method,
    jar: "admin",
    headers: { Origin: STAFF, ...(method === "GET" ? {} : { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }), ...extra },
    body: method === "GET" ? undefined : JSON.stringify(data ?? {}),
  });
  if (expected !== undefined) assert.equal(r.status, expected, `${method} ${path}: ${r.text.slice(0, 400)}`);
  else assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${r.text.slice(0, 400)}`);
  return r.text ? r.json().data : undefined;
}

// ---- 9. the synthetic journey ------------------------------------------------------------------
const code = `RC${Date.now().toString(36).toUpperCase()}`;
await api("POST", "organizations", { code, nameAr: "منظمة تجربة الإصدار", nameEn: "Release rehearsal organization", timezone: "Asia/Riyadh" }, {}, 201);
const org = (await api("GET", `organizations?q=${code}`)).items.find((o: { code: string }) => o.code === code).id as string;
const dept = await api("POST", `organizations/${org}/departments`, { code: `${code}D`, nameAr: "قسم", nameEn: "Team" }, {}, 201);
const people: string[] = [];
for (let i = 0; i < 6; i++)
  people.push((await api("POST", `organizations/${org}/participants`, { privateReference: `${code}-${i}`, displayName: `مشارك ${i + 1}`, departmentId: dept.id }, {}, 201)).id);
const family = (await api("GET", `questionnaires/${BUILTIN_Q}`)).family_key;
const series = await api("POST", `organizations/${org}/assessment-series`, { nameAr: "سلسلة التجربة", purpose: "تجربة الإصدار", questionnaireFamilyId: family }, {}, 201);
const round = await api("POST", `organizations/${org}/assessments`, { seriesId: series.id, label: "RC round", periodStart: "2026-09-01", questionnaireVersionId: BUILTIN_V, populationDefinition: { schemaVersion: 1 } }, {}, 201);
const campaign = await api("POST", `organizations/${org}/campaigns`, { roundId: round.id, questionnaireVersionId: BUILTIN_V, target: { mode: "SELECTED", participantIds: people }, startsAt: new Date(Date.now() - 60_000).toISOString(), timezone: "Asia/Riyadh" }, {}, 201);
await api("POST", `organizations/${org}/campaigns/${campaign.id}/launch`, {}, { "If-Match": `"${campaign.revision}"` });
const participation = await api("GET", `organizations/${org}/campaigns/${campaign.id}/participation`);
const tokens: string[] = [];
for (const item of participation.items) {
  const issued = await api("POST", `organizations/${org}/campaigns/${campaign.id}/invitations/${item.invitationId}/issue`, { expectedGeneration: item.generation });
  assert.ok(String(issued.url).startsWith(`${SURVEY}/s#`), "links point at the https survey origin");
  tokens.push(String(issued.url).split("#")[1]);
}
ok("staff journey: organization, department, six participants, series, round, campaign launched and six links issued by hand");

// Respondent: the page itself in a real browser, Arabic at 320px, under the production CSP.
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 640 }, locale: "ar" });
  const page = await context.newPage();
  const cspErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text()) && cspErrors.push(m.text()));
  await page.goto(`${SURVEY}/s#${tokens[5]}`);
  await page.waitForLoadState("networkidle");
  assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
  await page.locator("h1").first().waitFor({ timeout: 20_000 });
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
  const cookies = await context.cookies(SURVEY);
  assert.ok(cookies.length > 0 && cookies.every((c) => c.secure), "respondent cookies are Secure");
  await page.screenshot({ path: "work/p15-rehearsal-respondent-ar-320.png", fullPage: true });
  // The staff workspace renders and hydrates under the same policy.
  const staffContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await staffContext.addCookies([{ name: "__Host-orgfit-staff", value: jars.admin.get("__Host-orgfit-staff")!, url: STAFF, secure: true, httpOnly: true, sameSite: "Lax" }]);
  const staffPage = await staffContext.newPage();
  staffPage.on("console", (m) => m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text()) && cspErrors.push(m.text()));
  await staffPage.goto(`${STAFF}/organizations/${org}/campaigns/${campaign.id}`);
  await staffPage.waitForLoadState("networkidle");
  assert.ok(!staffPage.url().includes("/login"), "the staff session is honoured by the page");
  await staffPage.screenshot({ path: "work/p15-rehearsal-staff-campaign.png", fullPage: true });
  assert.deepEqual(cspErrors, []);
  await context.close();
  await staffContext.close();
} finally {
  await browser.close();
}
ok("browser: the Arabic survey at 320px and the staff campaign screen load over https with no CSP violation; survey cookies are Secure");

// Six acceptances through the public gateway over https, as a browser would send them.
async function respond(token: string, jar: string) {
  const headers = { Origin: SURVEY, "Content-Type": "application/json" };
  const opened = await request(`${SURVEY}/public/v1/invitations/exchange`, { method: "POST", jar, headers, body: JSON.stringify({ token }) });
  assert.equal(opened.status, 200, opened.text);
  const access = opened.json().data.access as string;
  if (access !== "OPEN") return access;
  const doc = (await request(`${SURVEY}/public/v1/instrument`, { jar, headers: { Origin: SURVEY } })).json().data.document;
  const answers: Record<string, string | string[]> = {};
  for (const q of doc.sections.flatMap((s: { questions: unknown[] }) => s.questions) as { id: string; type: string; options: { id: string }[]; rows: { id: string }[]; columns: { id: string }[] }[]) {
    if (q.type === "CONTENT") continue;
    if (q.type === "CHECKBOXES") answers[q.id] = [q.options[0].id];
    else if (q.type === "MATRIX") for (const row of q.rows) answers[row.id] = q.columns[0].id;
    else if (["MULTIPLE_CHOICE", "DROPDOWN", "YES_NO"].includes(q.type)) answers[q.id] = q.options[0].id;
    else if (q.type === "RATING_5") answers[q.id] = "4";
    else if (q.type === "RATING_10") answers[q.id] = "7";
    else if (q.type === "NUMBER") answers[q.id] = "3";
    else if (q.type === "DATE") answers[q.id] = "2026-09-01";
    else answers[q.id] = "نص تجريبي";
  }
  const final = await request(`${SURVEY}/public/v1/finalize`, { method: "POST", jar, headers, body: JSON.stringify({ answers }) });
  assert.equal(final.status, 200, final.text);
  return final.json().data.access as string;
}
for (let i = 0; i < 6; i++) assert.equal(await respond(tokens[i], `r${i}`), "ACCEPTED");
const operatorUrl = core("orgfit_migrator");
async function ownerCount(text: string, params: unknown[]) {
  const c = new pg.Client({ connectionString: operatorUrl });
  await c.connect();
  try {
    await c.query("SET ROLE orgfit_core_owner");
    return (await c.query(text, params)).rows[0];
  } finally {
    await c.end();
  }
}
const accepted = await ownerCount("select count(*)::int n from intake.submission_inbox where campaign_id=$1", [campaign.id]);
assert.equal(accepted.n, 6);
// A consumed link, reopened in a fresh browser session, adds nothing.
assert.notEqual(await respond(tokens[0], "again"), "OPEN");
const replayFinal = await request(`${SURVEY}/public/v1/finalize`, { method: "POST", jar: "again", headers: { Origin: SURVEY, "Content-Type": "application/json" }, body: JSON.stringify({ answers: {} }) });
results.consumedFinalizeStatus = replayFinal.status;
assert.equal((await ownerCount("select count(*)::int n from intake.submission_inbox where campaign_id=$1", [campaign.id])).n, 6);
// The proxy's client address reached the per-IP bucket (SEC-M2 configured).
assert.ok((await ownerCount("select count(*)::int n from intake.rate_limit where bucket='exchange_ip'", [])).n > 0, "per-IP exchange bucket counted");
const crossOrigin = await request(`${SURVEY}/public/v1/finalize`, { method: "POST", jar: "r1", headers: { Origin: STAFF, "Content-Type": "application/json" }, body: "{}" });
assert.notEqual(crossOrigin.status, 200);
ok("respondents: six acceptances over https; a consumed link adds nothing; the per-IP bucket counts the proxy's address; a cross-origin submission is refused");

// Close, then the privacy processor and the publication job as their own processes.
const detail = await api("GET", `organizations/${org}/campaigns/${campaign.id}`);
await api("POST", `organizations/${org}/campaigns/${campaign.id}/close`, { reason: "اكتمال تجربة الإصدار" }, { "If-Match": `"${detail.revision}"` });
const processedOut = await expectRun("processor", "scripts/process-campaigns.ts");
assert.match(processedOut, new RegExp(`campaign=${campaign.id} .*accepted=6 processed=6`));
const publishedOut = await expectRun("processor", "scripts/publish-campaigns.ts");
assert.match(publishedOut, new RegExp(`campaign=${campaign.id} state=PUBLISHED`));
results.processor = processedOut;
results.publication = publishedOut;
const resultsPayload = await api("GET", `organizations/${org}/assessments/${round.id}/results`);
assert.ok(JSON.stringify(resultsPayload).length > 100);
for (const t of tokens) assert.ok(!JSON.stringify(resultsPayload).includes(t));
const sliced = await request(`${STAFF}/api/v1/organizations/${org}/assessments/${round.id}/results?participantId=${people[0]}`, { jar: "admin", headers: { Origin: STAFF } });
assert.ok(sliced.status >= 400 && sliced.status < 500, `individual slice ${sliced.status}`);
ok("processing and publication: processor and publication jobs ran under their own credentials (6 accepted = 6 processed, PUBLISHED); results read, individual slicing refused");

// Reports: requested by staff, rendered by the renderer process, stored in the bucket.
for (const [format, locale] of [["PDF", "ar"], ["XLSX", "en"]] as const) await api("POST", `organizations/${org}/reports`, { roundId: round.id, format, locale }, {}, 202);
const rendered = await expectRun("report", "scripts/generate-reports.ts");
assert.equal((rendered.match(/state=READY/g) ?? []).length, 2, rendered);
results.reports = rendered;
const jobs = (await api("GET", `organizations/${org}/reports?roundId=${round.id}`)).items as { id: string; format: string; state: string }[];
for (const job of jobs.filter((j) => j.state === "READY")) {
  const file = await request(`${STAFF}/api/v1/organizations/${org}/reports/${job.id}/download`, { jar: "admin", headers: { Origin: STAFF } });
  assert.equal(file.status, 200);
  assert.equal(file.headers["cache-control"], "no-store");
  if (job.format === "PDF") {
    assert.equal(file.body.subarray(0, 5).toString("latin1"), "%PDF-");
    await writeFile("work/p15-rehearsal-report-ar.pdf", file.body);
  } else assert.equal(file.body.subarray(0, 2).toString("latin1"), "PK");
}
const reportObjects = [...objects.keys()].filter((k) => k.startsWith("/orgfit-reports/"));
assert.equal(reportObjects.length, 2);
for (const k of reportObjects) {
  const stored = objects.get(k)!;
  assert.ok(!stored.subarray(0, 8).toString("latin1").startsWith("%PDF") && !stored.subarray(0, 2).equals(Buffer.from("PK")), "artifacts are encrypted at rest");
}
ok("reports: an Arabic PDF and an English XLSX rendered by the renderer process into the bucket, encrypted at rest, downloaded with no-store");

// A field visit with a scanned attachment.
const visit = await api("POST", `organizations/${org}/visits`, { assignedConsultantId: profile.id, scheduledStart: "2026-10-12T06:30:00Z", timezone: "Asia/Riyadh", purpose: "زيارة بعد تجربة الإصدار", relatedRoundId: round.id }, {}, 201);
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
const begun = await api("POST", `organizations/${org}/visits/${visit.id}/attachments`, { filename: "محضر.pdf", declaredType: "application/pdf" }, {}, 201);
const put = await request(`${STAFF}${begun.contentPath}`, { method: "PUT", jar: "admin", headers: { Origin: STAFF, "Content-Type": "application/octet-stream", "Idempotency-Key": randomUUID() }, body: pdf });
assert.equal(put.status, 202, put.text);
const quarantined = await request(`${STAFF}/api/v1/organizations/${org}/visits/${visit.id}/attachments/${begun.id}/download`, { jar: "admin", headers: { Origin: STAFF } });
assert.notEqual(quarantined.status, 200, "a quarantined attachment is not downloadable");
const scanned = await expectRun("scanner", "scripts/scan-attachments.ts");
assert.match(scanned, /CLEAN=1/);
const downloaded = await request(`${STAFF}/api/v1/organizations/${org}/visits/${visit.id}/attachments/${begun.id}/download`, { jar: "admin", headers: { Origin: STAFF } });
assert.equal(downloaded.status, 200);
assert.ok(downloaded.body.equals(pdf));
assert.match(String(downloaded.headers["content-security-policy"] ?? ""), /sandbox/);
ok("visits: an attachment uploaded to the bucket stays quarantined until the scanner process marks it clean, then downloads byte-identical under a sandbox policy");

// ---- 10. operator jobs, alerts and the restore gate over TLS ---------------------------------
results.retention = await expectRun("operator", "scripts/retention.ts");
results.drafts = await expectRun("operator", "scripts/expire-drafts.ts");
results.tombstones = await expectRun("operator", "scripts/ship-tombstones.ts");
const check = await run("operator", "scripts/ops-check.ts");
const alerts = JSON.parse(check.out).alerts as { code: string; severity: string }[];
results.alerts = alerts;
assert.equal(check.status, 0, `no critical alert expected: ${check.out}`);
assert.ok(alerts.some((a) => a.code === "RETENTION_POLICY_UNAPPROVED"), "unapproved retention is still raised (P-004)");
await expectRun("operator", "scripts/restore-reapply.ts", ["--mark"]);
for (const origin of [STAFF, SURVEY]) assert.equal((await request(`${origin}/health/ready`)).status, 503, `${origin} closed while the restore gate is pending`);
assert.equal((await run("operator", "scripts/ops-check.ts")).status, 2);
results.reapply = await expectRun("operator", "scripts/restore-reapply.ts");
for (const origin of [STAFF, SURVEY]) assert.equal((await request(`${origin}/health/ready`)).status, 200);
ok("operations: retention, draft expiry, tombstone shipping and alerts run as the operator; the restore gate closes both https readiness endpoints and the replay reopens them");

// ---- 11. sign-out --------------------------------------------------------------------------------
const logout = await request(`${STAFF}/api/v1/auth/logout`, { method: "POST", jar: "admin", headers: { Origin: STAFF, "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: "{}" });
assert.ok([200, 204].includes(logout.status), `logout ${logout.status}`);
const stale = await request(`${STAFF}/api/v1/profile`, { headers: { Origin: STAFF, cookie: `__Host-orgfit-staff=${sessionCookie.split(";")[0].split("=")[1]}` } });
assert.equal(stale.status, 401);
ok("sign-out: the revoked session cookie is refused");

results.forwardedFor = [...new Set(forwarded)];
results.objectsStored = objects.size;
results.passed = passed;
results.finishedAt = new Date().toISOString();
await writeFile("work/p15-rehearsal.json", JSON.stringify(results, null, 2));
console.log(`Release rehearsal: ${passed.length} stages passed.`);
cleanup();
process.exit(0);
