// ---------------------------------------------------------------------------
// One stable password for the OrgFit LOGIN roles on a local cluster.
//
// Roles are cluster-wide, not per database. The development app
// (apps/staff/.env.development.local) and every test run share the loopback
// cluster, so a test that set a fresh random role password silently broke
// development sign-in, and two test runs in parallel broke each other.
// Everything that sets role passwords on a local cluster now sets this one
// value instead, which makes doing so a no-op for everyone else using it.
//
// Resolution, first match wins:
//   1. TEST_ROLE_PASSWORD, then DEV_ROLE_PASSWORD, when set;
//   2. the password the development app already uses, if its DATABASE_URL
//      points at the same loopback host port as the given cluster;
//   3. a value generated once and kept in the ignored work/ directory.
// Nothing here prints a credential.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const LOGIN_ROLES = [
  "orgfit_migrator",
  "orgfit_staff",
  "orgfit_auth",
  "orgfit_gateway",
  "orgfit_processor",
  "orgfit_anon_migrator",
  "orgfit_report",
  "orgfit_scanner",
] as const;

const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"];
const portOf = (u: URL) => u.port || "5432";

function developmentPassword(cluster: URL): string | null {
  const file = resolve("apps/staff/.env.development.local");
  if (!existsSync(file)) return null;
  const line = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("DATABASE_URL="));
  if (!line) return null;
  try {
    const dev = new URL(line.slice("DATABASE_URL=".length).trim());
    if (!loopback.includes(dev.hostname) || portOf(dev) !== portOf(cluster) || !dev.password) return null;
    return decodeURIComponent(dev.password);
  } catch {
    return null;
  }
}

export function clusterRolePassword(adminUrl: string): string {
  const explicit = process.env.TEST_ROLE_PASSWORD || process.env.DEV_ROLE_PASSWORD;
  if (explicit) return explicit;
  const cluster = new URL(adminUrl);
  const dev = developmentPassword(cluster);
  if (dev) return dev;
  const file = resolve(`work/cluster-role-password-${portOf(cluster)}.txt`);
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const generated = randomBytes(24).toString("hex");
  mkdirSync(resolve("work"), { recursive: true });
  writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

// A quoted SQL literal: ALTER ROLE cannot take a bind parameter.
export const passwordLiteral = (password: string) => `'${password.replace(/'/g, "''")}'`;
