import pg from "pg";
import { AppError } from "./security";

// The respondent gateway's own database identity. It is a raw pg pool rather
// than the staff Kysely instance on purpose: the gateway must never import the
// staff connection, the staff query builder or any staff data module.
//
// The credential is orgfit_gateway, which holds no table privilege anywhere and
// can execute only the session-scoped routines in migration 009. Readiness
// asserts that at runtime rather than trusting the deployment.
let pool: pg.Pool | undefined;

export function gatewayUrl() {
  const value = process.env.GATEWAY_DATABASE_URL;
  if (!value) throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.username !== "orgfit_gateway" ||
    !url.password ||
    url.password === "CHANGE_ME"
  )
    throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  if (
    process.env.NODE_ENV === "production" &&
    url.searchParams.get("sslmode") !== "verify-full"
  )
    throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  return value;
}
// A gateway process holding a processor, migrator or staff credential would
// silently collapse the trust boundary, so it refuses to start with one.
export function assertNoForeignCredentials(
  env: Record<string, string | undefined> = process.env,
) {
  for (const key of [
    "DATABASE_URL",
    "AUTH_DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "PROCESSOR_DATABASE_URL",
    "ANONYMOUS_DATABASE_URL",
    "ANONYMOUS_MIGRATION_DATABASE_URL",
    "CAMPAIGN_KEY_CUSTODY_SECRET_KEY",
  ])
    if (env[key]) throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
}
let configured: string | undefined;
// Explicit configuration for the integration test harness, which necessarily
// drives the staff, gateway and processor sides from one process. A deployed
// gateway never calls this: it reads GATEWAY_DATABASE_URL and runs the
// foreign-credential assertion, which has its own unit tests.
export function configureGateway(url: string | undefined) {
  if (pool) void pool.end().catch(() => {});
  pool = undefined;
  configured = url;
}
export function gatewayPool() {
  if (pool) return pool;
  if (!configured) assertNoForeignCredentials();
  pool = new pg.Pool({
    connectionString: configured ?? gatewayUrl(),
    max: 10,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
    application_name: "orgfit_gateway",
  });
  // No error object, SQL text or bind value is ever surfaced from this pool.
  pool.on("error", () => {});
  return pool;
}
export async function withGateway<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await gatewayPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
// One transaction per respondent mutation; acceptance depends on it.
export async function inGatewayTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withGateway(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  });
}
export async function gatewayReadiness() {
  const { rows } = await gatewayPool().query<{ safe: boolean }>(
    `SELECT current_user='orgfit_gateway' AND NOT rolsuper AND NOT rolbypassrls
      AND NOT pg_has_role(current_user,'orgfit_core_owner','MEMBER')
      AND NOT pg_has_role(current_user,'orgfit_access_executor','MEMBER')
      AND NOT pg_has_role(current_user,'orgfit_staff','MEMBER')
      AND NOT pg_has_role(current_user,'orgfit_processor','MEMBER') AS safe
     FROM pg_roles WHERE rolname=current_user`,
  );
  if (!rows[0]?.safe) throw new Error("Unready");
  // The gateway must not be able to touch a table directly, only its routines.
  const { rows: priv } = await gatewayPool().query<{ tables: string }>(
    `SELECT count(*)::text AS tables FROM information_schema.table_privileges
      WHERE grantee='orgfit_gateway'`,
  );
  if (priv[0].tables !== "0") throw new Error("Unready");
  // Phase 14: closed while a restored environment awaits its tombstone replay.
  const { rows: gate } = await gatewayPool().query<{ ready: boolean }>("SELECT ops.ready() AS ready");
  if (!gate[0]?.ready) throw new Error("Unready");
}
