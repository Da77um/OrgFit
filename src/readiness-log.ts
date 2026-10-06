// ---------------------------------------------------------------------------
// The one line an operator gets when a readiness check fails (D-168). The
// response body still says only "unavailable"; the server log names a fixed
// code so a deployment's failure can be told apart (a missing certificate
// file, a connection timeout, a refused login, a missing variable) without a
// driver message, which can quote a value, ever being printed.
// ---------------------------------------------------------------------------

const TIMEOUTS = new Set(["timeout expired", "Connection terminated due to connection timeout"]);

/** A fixed, value-free code for a readiness failure. */
export function readinessCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    // SQLSTATE (28P01), Node errno (ENOENT, ECONNREFUSED) or an OrgFit code.
    if (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && TIMEOUTS.has(message)) return "CONNECT_TIMEOUT";
    if (message === "Unready") return "UNREADY";
    if (message === "Configuration unavailable") return "CONFIGURATION";
  }
  return "UNKNOWN";
}

export function logReadinessFailure(service: string, error: unknown) {
  console.error(`readiness failed: ${service} ${readinessCode(error)}`);
}
