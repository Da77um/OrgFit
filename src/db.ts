import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import { readConfig } from "./config";
import { AppError, sessionDigest, type Capability } from "./security";
import type { Locale } from "./i18n";

interface Database {
  "core.organization": {
    id: string;
    code: string;
    name_ar: string;
    name_en: string | null;
    status: string;
    timezone: string;
  };
}
export type Tx = Transaction<Database>;
export type Profile = {
  id: string;
  displayName: string;
  email: string;
  role: "SUPER_ADMIN" | "STAFF";
  locale: Locale;
  revision: number;
  capabilities: Capability[];
  organizationIds: string[];
};
let staffDb: Kysely<Database> | undefined;
let authDb: Kysely<Database> | undefined;
function database(kind: "staff" | "auth") {
  const config = readConfig();
  const existing = kind === "staff" ? staffDb : authDb;
  if (existing) return existing;
  const pool = new pg.Pool({
    connectionString:
      kind === "staff" ? config.DATABASE_URL : config.AUTH_DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    application_name: `orgfit_${kind}`,
  });
  // Deliberately exclude error objects, SQL and binds from application output.
  pool.on("error", () => {
    /* Request readiness supplies the coarse failure signal. */
  });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  if (kind === "staff") staffDb = db;
  else authDb = db;
  return db;
}
export async function withStaff<T>(
  token: string | undefined,
  fn: (tx: Tx, profile: Profile) => Promise<T>,
): Promise<T> {
  const hash = sessionDigest(token);
  return database("staff")
    .transaction()
    .execute(async (tx) => {
      await sql`select set_config('orgfit.session_digest',${hash},true)`.execute(
        tx,
      );
      const { rows } = await sql<{
        profile: Profile;
      }>`select access.profile() as profile`.execute(tx);
      return fn(tx, rows[0].profile);
    });
}
export async function requireAccess(tx: Tx, org: string, cap?: Capability) {
  const result = await sql<{
    allowed: boolean;
    capable: boolean;
  }>`select access.has_org(${org}::uuid) as allowed, access.has_capability(${cap ?? ""}) as capable`.execute(
    tx,
  );
  if (!result.rows[0].allowed) throw new AppError("NOT_FOUND", 404);
  if (cap && !result.rows[0].capable) throw new AppError("FORBIDDEN", 403);
}
export const authDatabase = () => database("auth");
export async function readiness() {
  for (const kind of ["staff", "auth"] as const) {
    const { rows } = await sql<{
      safe: boolean;
    }>`select current_user=${`orgfit_${kind}`} and not rolsuper and not rolbypassrls and not pg_has_role(current_user,'orgfit_core_owner','MEMBER') and not pg_has_role(current_user,'orgfit_access_executor','MEMBER') as safe from pg_roles where rolname=current_user`.execute(
      database(kind),
    );
    if (!rows[0]?.safe) throw new Error("Unready");
  }
  await sql`select access.actor()`.execute(database("staff"));
  const { rows } = await sql<{
    ready: boolean;
  }>`select to_regclass('core.participant') is not null and to_regclass('core.department') is not null and to_regprocedure('core.import_receipt(uuid,uuid,uuid,bytea)') is not null and to_regclass('instrument.questionnaire_version') is not null as ready`.execute(
    database("staff"),
  );
  if (!rows[0]?.ready) throw new Error("Unready");
  // A restored environment stays unready until its deletion tombstones have
  // been replayed (scripts/restore-reapply.ts), so a load balancer never routes
  // traffic to data that was deleted after the backup was taken.
  const gate = await sql<{ ready: boolean }>`select ops.ready() as ready`.execute(
    database("staff"),
  );
  if (!gate.rows[0]?.ready) throw new Error("Unready");
}
