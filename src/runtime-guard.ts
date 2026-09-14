import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Runtime safeguards for the job and operator entry points (Post-Audit Repair
// Pass 3, RC-004).
//
// The web processes, the renderer and the scanner already refuse a production
// database URL without verified TLS and refuse foreign credentials when they
// start. The processor, publication, operator and migration entry points
// checked only the login name and left TLS to release preflight — a control
// that works only if someone remembers to run it. These two functions move the
// same checks into the entry points themselves.
//
// Errors carry a fixed code, never a value: a URL holds a password.
// ---------------------------------------------------------------------------

export class RuntimeGuardError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/**
 * A database URL for one login role, checked before any connection is opened:
 * PostgreSQL scheme, the expected login, a password that is not a placeholder,
 * and in production `sslmode=verify-full` (certificate chain AND host name).
 * Nonproduction keeps plain loopback connections for local clusters and tests.
 */
export function databaseUrl(
  value: string | undefined,
  role: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!value) throw new RuntimeGuardError("DATABASE_URL_MISSING");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeGuardError("DATABASE_URL_INVALID");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new RuntimeGuardError("DATABASE_URL_INVALID");
  if (decodeURIComponent(url.username) !== role)
    throw new RuntimeGuardError("DATABASE_ROLE_MISMATCH");
  if (!url.password || /CHANGE_ME/i.test(decodeURIComponent(url.password)))
    throw new RuntimeGuardError("DATABASE_PASSWORD_MISSING");
  if (env.NODE_ENV === "production") {
    // pg reads these from the URL. Anything short of verify-full either skips
    // the certificate or skips the host name, and a libpq-style override that
    // disables verification is refused outright.
    if (url.searchParams.get("sslmode") !== "verify-full")
      throw new RuntimeGuardError("DATABASE_TLS_REQUIRED");
    if (url.searchParams.has("ssl") && url.searchParams.get("ssl") !== "true")
      throw new RuntimeGuardError("DATABASE_TLS_REQUIRED");
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
      throw new RuntimeGuardError("DATABASE_TLS_REQUIRED");
  }
  return value;
}

type ManifestProcess = { forbidden: string[] };
let manifestCache: Record<string, ManifestProcess> | undefined;
function manifestProcesses() {
  manifestCache ??= (
    JSON.parse(readFileSync(resolve("deploy/processes.json"), "utf8")) as {
      processes: Record<string, ManifestProcess>;
    }
  ).processes;
  return manifestCache;
}

/**
 * Refuse to run a job whose environment holds a variable its process must
 * never hold (deploy/processes.json → `forbidden`). Names are reported, values
 * never. A supervisor passing one combined environment to every worker would
 * be stopped here even if it skipped its own check.
 */
export function assertProcessEnvironment(
  processName: string,
  env: Record<string, string | undefined> = process.env,
  processes: Record<string, ManifestProcess> = manifestProcesses(),
) {
  const spec = processes[processName];
  if (!spec) throw new RuntimeGuardError("UNKNOWN_PROCESS");
  const held = spec.forbidden.filter((k) => env[k] !== undefined && env[k] !== "");
  if (held.length)
    throw new RuntimeGuardError(`FOREIGN_CREDENTIAL:${held.join(",")}`);
}

/** The message an entry point prints for a guard refusal: code and names only. */
export function guardMessage(error: unknown) {
  return error instanceof RuntimeGuardError ? `Refused by runtime guard: ${error.code}.` : null;
}
