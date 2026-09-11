import pg from "pg";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export const ids = {
  admin: "00000000-0000-4000-8000-000000000001",
  staff: "00000000-0000-4000-8000-000000000002",
  disabled: "00000000-0000-4000-8000-000000000003",
  orgA: "10000000-0000-4000-8000-000000000001",
  orgB: "10000000-0000-4000-8000-000000000002",
};
export async function seed(url: string, issuer: string) {
  const u = new URL(url);
  if (
    process.env.NODE_ENV === "production" ||
    !u.pathname.startsWith("/orgfit_test_") ||
    u.username !== "orgfit_migrator"
  )
    throw new Error("Synthetic test database required");
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE orgfit_core_owner");
    for (const [id, sub, role, status] of [
      [ids.admin, "admin", "SUPER_ADMIN", "ACTIVE"],
      [ids.staff, "staff", "STAFF", "ACTIVE"],
      [ids.disabled, "disabled", "STAFF", "DISABLED"],
    ]) {
      await db.query(
        "INSERT INTO access.staff_user(id,issuer,provider_subject,email,display_name,role,status) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING",
        [
          id,
          issuer,
          sub,
          `${sub}@example.invalid`,
          `موظف تجريبي ${sub}`,
          role,
          status,
        ],
      );
    }
    for (const [id, code, ar, en] of [
      [ids.orgA, "SYNTHETIC_A", "منظمة تجريبية أ", "Synthetic organization A"],
      [ids.orgB, "SYNTHETIC_B", "منظمة تجريبية ب", "Synthetic organization B"],
    ])
      await db.query(
        "INSERT INTO core.organization(id,code,name_ar,name_en) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
        [id, code, ar, en],
      );
    await db.query(
      "INSERT INTO access.organization_access VALUES($1,$2) ON CONFLICT DO NOTHING",
      [ids.staff, ids.orgA],
    );
    await db.query(
      "INSERT INTO access.staff_capability VALUES($1,'directory.manage') ON CONFLICT DO NOTHING",
      [ids.staff],
    );
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    await db.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await seed(
      process.env.MIGRATION_DATABASE_URL ?? "",
      process.env.OIDC_ISSUER ?? "",
    );
    console.log("Synthetic fixtures installed.");
  } catch {
    console.error(
      "Seed refused; only named synthetic test databases are permitted.",
    );
    process.exitCode = 1;
  }
}
