import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { z } from "zod";
import { REVOCATION_REASONS, type RevocationResult } from "../src/revocation";
import { assertProcessEnvironment, databaseUrl, guardMessage } from "../src/runtime-guard";

// ---------------------------------------------------------------------------
// Operator channel for withdrawing a published release (Post-Audit Repair
// Pass 3). The normal path is the Super Admin screen on the round's results
// page. This command exists for when no Super Admin can sign in — the identity
// provider is down during a privacy incident — and it still names the active
// Super Admin who approved the decision; the database refuses anyone else.
//
//   npm run release:revoke -- --organization <uuid> --campaign <uuid> \
//     --approver <super-admin email> --reason-code PRIVACY_INCIDENT \
//     --reason "<at least ten characters>" --incident <reference> \
//     --confirm <first 8 characters of the release content hash>
//
// It runs under the operator credential (MIGRATION_DATABASE_URL) and prints
// identifiers and counts only. Running it twice with the same decision returns
// the same revocation. It cannot recall a file that was already downloaded.
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    organizationId: z.uuid(),
    campaignId: z.uuid(),
    approverEmail: z.email().max(320),
    reasonCode: z.enum(REVOCATION_REASONS),
    reason: z.string().trim().min(10).max(2000),
    incidentReference: z.string().trim().min(1).max(200),
    confirmation: z.string().trim().regex(/^[0-9a-fA-F]{8}$/),
  })
  .strict();

export async function operatorRevokeRelease(
  url: string,
  input: z.infer<typeof inputSchema>,
): Promise<RevocationResult> {
  const parsed = inputSchema.parse(input);
  const client = new pg.Client({ connectionString: databaseUrl(url, "orgfit_migrator") });
  await client.connect();
  try {
    await client.query("SET ROLE orgfit_core_owner");
    await client.query("BEGIN");
    // The campaign's current published release (or its already revoked one,
    // for an idempotent repeat), confirmed by hash prefix exactly as on the
    // staff screen, so a mistyped campaign cannot withdraw another release.
    const { rows } = await client.query<{ id: string; prefix: string }>(
      `SELECT id, left(encode(content_hash,'hex'),8) AS prefix FROM publication.result_snapshot
        WHERE organization_id=$1 AND campaign_id=$2 AND state IN ('PUBLISHED','REVOKED')
        ORDER BY (state='PUBLISHED') DESC, release_revision DESC LIMIT 1`,
      [parsed.organizationId, parsed.campaignId],
    );
    if (!rows.length) throw new Error("STATE_CONFLICT");
    if (rows[0].prefix !== parsed.confirmation.toLowerCase()) throw new Error("CONFIRMATION_MISMATCH");
    const result = await client.query<{ data: RevocationResult }>(
      "SELECT publication.operator_revoke_release($1,$2,$3,$4,$5,$6) AS data",
      [parsed.organizationId, rows[0].id, parsed.approverEmail, parsed.reasonCode, parsed.reason, parsed.incidentReference],
    );
    await client.query("COMMIT");
    return result.rows[0].data;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end().catch(() => {});
  }
}

const KNOWN = new Set(["NOT_FOUND", "STATE_CONFLICT", "CONFIRMATION_MISMATCH", "APPROVER_REQUIRED", "RELEASE_ALREADY_REVOKED", "VALIDATION_FAILED"]);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assertProcessEnvironment("operator");
    const { values } = parseArgs({
      options: {
        organization: { type: "string" },
        campaign: { type: "string" },
        approver: { type: "string" },
        "reason-code": { type: "string" },
        reason: { type: "string" },
        incident: { type: "string" },
        confirm: { type: "string" },
      },
      strict: true,
    });
    const result = await operatorRevokeRelease(process.env.MIGRATION_DATABASE_URL ?? "", {
      organizationId: values.organization ?? "",
      campaignId: values.campaign ?? "",
      approverEmail: values.approver ?? "",
      reasonCode: (values["reason-code"] ?? "") as (typeof REVOCATION_REASONS)[number],
      reason: values.reason ?? "",
      incidentReference: values.incident ?? "",
      confirmation: values.confirm ?? "",
    });
    console.log(
      `revocation=${result.id} snapshot=${result.snapshotId} replayed=${result.replayed} reportsRevoked=${result.reportsRevoked} downloadsBefore=${result.downloadsBefore}`,
    );
    if (result.downloadsBefore > 0)
      console.log(
        `${result.downloadsBefore} download(s) of affected reports happened before this revocation. Those copies cannot be recalled.`,
      );
  } catch (e) {
    const code = e instanceof Error && KNOWN.has(e.message) ? e.message : e instanceof z.ZodError ? "VALIDATION_FAILED" : null;
    console.error(guardMessage(e) ?? (code ? `Revocation refused: ${code}.` : "Revocation failed. Nothing was changed."));
    process.exitCode = 1;
  }
}
