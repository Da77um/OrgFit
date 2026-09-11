import pg from "pg";
import { AppError } from "./security";

// The attachment scanner's own database identity.
//
// A raw pg pool rather than the staff Kysely instance, for the same reason the
// gateway and the renderer have one: the scanner must never import the staff
// connection, the staff query builder or a staff data module. Its credential is
// orgfit_scanner, which holds no table privilege anywhere and can execute only
// the three attachment routines of migration 015. Readiness asserts that
// against the live catalog rather than trusting the deployment to have granted
// correctly.
let pool: pg.Pool | undefined;

export function scannerUrl() {
  const value = process.env.SCANNER_DATABASE_URL;
  if (!value) throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.username !== "orgfit_scanner" ||
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

// A scanner process holding a staff, operator, processor, gateway, renderer or
// custody credential would collapse a boundary this phase rests on. It also
// must not hold the keys to private directory imports, manual link exports,
// named participation lists or rendered reports: it reads consulting files, and
// it has no business being able to decrypt anything else.
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
    "GATEWAY_DATABASE_URL",
    "REPORT_DATABASE_URL",
    "CAMPAIGN_KEY_CUSTODY_SECRET_KEY",
    "IMPORT_ENCRYPTION_KEY",
    "LINK_EXPORT_ENCRYPTION_KEY",
    "PARTICIPATION_EXPORT_ENCRYPTION_KEY",
    "REPORT_ENCRYPTION_KEY",
    "INVITATION_DIGEST_KEY",
  ])
    if (env[key]) throw new AppError("TEMPORARILY_UNAVAILABLE", 503);
}

let configured: string | undefined;
// Explicit configuration for the test harness, which necessarily drives the
// staff and scanner sides from one process. A deployed scanner never calls
// this: it reads SCANNER_DATABASE_URL and runs the assertion above.
export function configureScanner(url: string | undefined) {
  if (pool) void pool.end().catch(() => {});
  pool = undefined;
  configured = url;
}
export function scannerPool() {
  if (pool) return pool;
  if (!configured) assertNoForeignCredentials();
  pool = new pg.Pool({
    connectionString: configured ?? scannerUrl(),
    max: 4,
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
    application_name: "orgfit_scanner",
  });
  // No error object, SQL text or bind value is ever surfaced from this pool.
  pool.on("error", () => {});
  return pool;
}
export async function closeScannerPool() {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end().catch(() => {});
}

export async function scannerReadiness() {
  const { rows } = await scannerPool().query<{ safe: boolean }>(
    `SELECT current_user='orgfit_scanner' AND NOT rolsuper AND NOT rolbypassrls
      AND NOT pg_has_role(current_user,'orgfit_core_owner','MEMBER')
      AND NOT pg_has_role(current_user,'orgfit_access_executor','MEMBER')
      AND NOT pg_has_role(current_user,'orgfit_staff','MEMBER')
      AND NOT pg_has_role(current_user,'orgfit_processor','MEMBER')
      AND NOT pg_has_role(current_user,'orgfit_report','MEMBER')
      AND NOT pg_has_role(current_user,'orgfit_gateway','MEMBER') AS safe
     FROM pg_roles WHERE rolname=current_user`,
  );
  if (!rows[0]?.safe) throw new Error("Unready");
  // The scanner must not be able to touch a table directly, only its routines.
  const { rows: priv } = await scannerPool().query<{ tables: string }>(
    `SELECT count(*)::text AS tables FROM information_schema.table_privileges
      WHERE grantee='orgfit_scanner'`,
  );
  if (priv[0].tables !== "0") throw new Error("Unready");
}
