import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { anonymousOperatorUrl, eraseCampaignIntake, operatorUrl } from "../src/operations";
import { tombstoneSinkFromEnvironment } from "../src/tombstone-ledger";
import { assertProcessEnvironment, guardMessage } from "../src/runtime-guard";

// ---------------------------------------------------------------------------
// Whole-campaign intake erasure for an APPROVED restore incident (Post-Audit
// Repair Pass 4, SEC-M6). incident-runbook.md §10 says when this may be used.
//
//   npm run intake:erase -- --organization <uuid> --campaign <uuid> \
//     --approver <super-admin email> --incident <reference> \
//     --reason "<at least ten characters>" --expected-envelopes <n>
//
// It refuses unless the restore replay reports, right now and from the
// verified ledger, ANONYMOUS_OUTPUT_MISSING_FOR_ERASED_INTAKE for exactly this
// campaign; the environment is still closed (REAPPLY_PENDING); the campaign is
// CLOSED; the approver is an active Super Admin; and the envelope count equals
// --expected-envelopes. It deletes that campaign's encrypted envelopes, drafts
// and respondent sessions — the accepted answers they hold are then gone for
// good — writes an immutable erasure record and an INTAKE_ERASED audit row, and
// keeps the CAMPAIGN_INTAKE tombstone. It prints identifiers and counts only.
// Running it again with the same incident reference returns the same record.
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    organizationId: z.uuid(),
    campaignId: z.uuid(),
    approverEmail: z.email().max(320),
    incidentReference: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(10).max(2000),
    expectedEnvelopes: z.coerce.number().int().min(0).max(1_000_000),
  })
  .strict();

const KNOWN = new Set([
  "NOT_A_RESTORE_INCIDENT",
  "RESTORE_INCIDENT_REQUIRED",
  "APPROVER_REQUIRED",
  "CONFIRMATION_MISMATCH",
  "STATE_CONFLICT",
  "NOT_FOUND",
  "VALIDATION_FAILED",
]);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assertProcessEnvironment("operator");
    const { values } = parseArgs({
      options: {
        organization: { type: "string" },
        campaign: { type: "string" },
        approver: { type: "string" },
        incident: { type: "string" },
        reason: { type: "string" },
        "expected-envelopes": { type: "string" },
      },
      strict: true,
    });
    const input = inputSchema.parse({
      organizationId: values.organization ?? "",
      campaignId: values.campaign ?? "",
      approverEmail: values.approver ?? "",
      incidentReference: values.incident ?? "",
      reason: values.reason ?? "",
      expectedEnvelopes: values["expected-envelopes"] ?? "",
    });
    const core = operatorUrl();
    const anonymous = anonymousOperatorUrl();
    const result = await eraseCampaignIntake(core, anonymous, tombstoneSinkFromEnvironment(), input);
    console.log(
      `erasure=${result.id} campaign=${result.campaignId} replayed=${result.replayed} envelopes=${result.envelopesErased} drafts=${result.draftsErased} sessions=${result.sessionsErased}`,
    );
    console.log("Run npm run restore:reapply again; the environment opens only when no incident remains.");
  } catch (e) {
    const code = e instanceof Error && KNOWN.has(e.message) ? e.message : e instanceof z.ZodError ? "VALIDATION_FAILED" : null;
    console.error(guardMessage(e) ?? (code ? `Intake erasure refused: ${code}.` : "Intake erasure failed. Nothing was changed."));
    process.exitCode = 1;
  }
}
