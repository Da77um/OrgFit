// ---------------------------------------------------------------------------
// Make sure the local development database is usable before `npm run dev`.
//
// Development sign-in kept breaking for reasons that had nothing to do with
// the sign-in code: the loopback PostgreSQL cluster (work/pg-foundation) was
// not running after a reboot or a crash, it was still in crash recovery, or
// orgfit_dev was behind the migrations the code needs. Each showed up as
// "service unavailable" on /login. This runs as `predev` and repairs what it
// safely can:
//
//   1. when apps/staff/.env.development.local points at a loopback cluster
//      that is not listening and the repository's cluster exists, starts it;
//   2. waits while the cluster finishes crash recovery;
//   3. when .env.bootstrap supplies DEV_ADMIN_DATABASE_URL, runs the
//      idempotent scripts/provision-dev.ts (role passwords + migrations);
//   4. checks that the staff and auth logins actually connect.
//
// It never drops or resets anything, prints no credential, refuses production,
// and never blocks the dev server: a problem is reported and `next dev` starts.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import pg from "pg";

const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"];

function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

function listening(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: host.replace(/^\[|\]$/g, ""), port });
    const finish = (ok: boolean) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(1500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 57P03: "the database system is starting up" (crash recovery in progress).
async function waitForConnections(url: string, limitMs: number): Promise<unknown> {
  const deadline = Date.now() + limitMs;
  let announced = false;
  for (;;) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return null;
    } catch (e) {
      const code = (e as { code?: string }).code;
      const transient = code === "57P03" || code === "ECONNREFUSED" || code === "ECONNRESET";
      if (!transient || Date.now() > deadline) return e;
      if (!announced) {
        console.log("[dev-database] Waiting for PostgreSQL to finish starting (crash recovery can take minutes)…");
        announced = true;
      }
      await sleep(2000);
    } finally {
      await client.end().catch(() => {});
    }
  }
}

async function main() {
  if (process.env.NODE_ENV === "production") return;
  const app = readEnv(resolve("apps/staff/.env.development.local"));
  if (!app.DATABASE_URL) return;
  let target: URL;
  try {
    target = new URL(app.DATABASE_URL);
  } catch {
    return;
  }
  if (!loopback.includes(target.hostname)) return;
  const port = Number(target.port || 5432);

  if (!(await listening(target.hostname, port))) {
    const cluster = resolve("work/pg-foundation");
    const pgCtl = resolve("work/package/native/bin", process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
    if (!existsSync(cluster) || !existsSync(pgCtl)) {
      console.warn(`[dev-database] Nothing is listening on ${target.hostname}:${port} and no local cluster was found to start. Sign-in will be unavailable.`);
      return;
    }
    console.log(`[dev-database] Starting the local PostgreSQL cluster on port ${port}…`);
    // -W: do not wait here; crash recovery is awaited below with progress.
    spawnSync(
      pgCtl,
      ["-D", cluster, "-l", resolve("work/postgres.log"), "-o", `-h ${target.hostname} -p ${port}`, "-W", "start"],
      { stdio: "inherit" },
    );
  }

  const failure = await waitForConnections(
    (() => {
      const u = new URL(target);
      u.pathname = "/postgres";
      return u.href;
    })(),
    15 * 60_000,
  );
  // An authentication failure is repaired by provisioning below; anything else is reported.
  if (failure && (failure as { code?: string }).code !== "28P01" && (failure as { code?: string }).code !== "3D000") {
    console.warn(`[dev-database] PostgreSQL is not accepting connections (${(failure as { code?: string }).code ?? "unknown"}). See work/postgres.log.`);
    return;
  }

  const bootstrap = readEnv(resolve(".env.bootstrap"));
  const adminUrl = bootstrap.DEV_ADMIN_DATABASE_URL;
  if (adminUrl) {
    try {
      const admin = new URL(adminUrl);
      if (loopback.includes(admin.hostname) && Number(admin.port || 5432) === port) {
        for (const key of ["DEV_ROLE_PASSWORD", "DEV_DATABASE_NAME"])
          if (bootstrap[key] && !process.env[key]) process.env[key] = bootstrap[key];
        const { provisionDev } = await import("./provision-dev");
        const { clusterRolePassword } = await import("./role-password");
        await provisionDev(adminUrl, process.env.DEV_DATABASE_NAME ?? "orgfit_dev", clusterRolePassword(adminUrl));
        console.log("[dev-database] Development database is migrated and role logins are in sync.");
      }
    } catch (e) {
      console.warn(`[dev-database] Provisioning did not complete: ${(e as Error).message}`);
    }
  }

  for (const key of ["DATABASE_URL", "AUTH_DATABASE_URL"] as const) {
    if (!app[key]) continue;
    const client = new pg.Client({ connectionString: app[key], connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
    } catch (e) {
      console.warn(`[dev-database] ${key} cannot connect (${(e as { code?: string }).code ?? "error"}). Sign-in will fail until this is fixed.`);
    } finally {
      await client.end().catch(() => {});
    }
  }
}

await main().catch((e) => console.warn(`[dev-database] ${(e as Error).message}`));
