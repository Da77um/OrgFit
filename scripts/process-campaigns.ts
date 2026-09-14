import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { corePool, anonymousPool, processCampaign, reconcile } from "../src/processor";
import { loadCustodianSecretFromEnvironment } from "../src/key-custody";
import { runJob } from "../src/job-run";

// Operator entry point for the privacy processor. It runs under the processor's
// own credentials, which no staff or gateway process holds.
//
// Output is deliberately campaign-level: a campaign identifier, a batch
// identifier and counts. It never prints an envelope, an answer, a participant,
// an invitation or a response identifier.
export async function processDueCampaigns(limit = 20) {
  // The processor is the only component that holds the custodian secret.
  loadCustodianSecretFromEnvironment();
  const core = corePool(),
    anon = anonymousPool();
  const results: Record<string, unknown>[] = [];
  try {
    // Closed campaigns that have not reached a terminal batch state. The
    // processor holds no SELECT on core.campaign or intake.processing_batch, so
    // the queue is a routine returning campaign identifiers and nothing else.
    const due = (
      await core.query<{ due: string[] }>(
        "SELECT publication.due_campaigns('PROCESS',$1) AS due",
        [limit],
      )
    ).rows[0].due;
    for (const id of due) {
      try {
        const outcome = await processCampaign(core, anon, id);
        results.push({ ...outcome, ...(await reconcile(core, anon, id)) });
      } catch (e) {
        // The failure code is recorded on the batch; the message is not printed
        // because a driver message can quote a value.
        results.push({
          campaignId: id,
          state: "ERROR",
          failure: e instanceof Error ? e.message : "UNKNOWN",
        });
      }
    }
    return results;
  } finally {
    await core.end();
    await anon.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runJob(
    "privacy:process",
    "Privacy processing failed. Inspect batch state through the restricted processor channel.",
    async () => {
      const results = await processDueCampaigns();
      for (const r of results)
        console.log(
          `campaign=${r.campaignId} batch=${r.batchId ?? "-"} state=${r.state} accepted=${r.acceptedCount ?? "-"} processed=${r.processedCount ?? "-"} blocked=${r.blocked ?? "-"}`,
        );
      const failed = results.filter((r) => r.state === "ERROR" || r.blocked === true).length;
      return {
        outcome: failed ? "FAILURE" : "SUCCESS",
        failureCode: "CAMPAIGN_FAILED",
        counts: { campaigns: results.length, failed },
      };
    },
  );
}
