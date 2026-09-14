import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { corePool, anonymousPool } from "../src/processor";
import { releaseDueCampaigns } from "../src/publication";
import { runJob } from "../src/job-run";

// Operator entry point for safe publication. It runs under the privacy
// processor's identity, because building a release means reading anonymous
// answers, and no staff credential may do that.
//
// Output is campaign-level: an identifier, a release state and counts of
// metrics. It never prints a value, a cell, a group or a contributor.
export async function publishDueCampaigns(limit = 20) {
  const core = corePool(),
    anon = anonymousPool();
  try {
    return await releaseDueCampaigns(core, anon, limit);
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
    "publication:release",
    "Publication failed. Inspect release state through the restricted processor channel.",
    async () => {
      const results = await publishDueCampaigns();
      for (const r of results)
        console.log(
          `campaign=${r.campaignId} state=${r.state} snapshot=${r.snapshotId ?? "-"} contributors=${r.contributorCount ?? "-"} released=${r.metricsReleased ?? "-"}${r.note ? ` note=${r.note}` : ""}`,
        );
      const failed = results.filter((r) => r.state === "FAILED" || r.state === "BLOCKED").length;
      return {
        outcome: failed ? "FAILURE" : "SUCCESS",
        failureCode: "RELEASE_FAILED",
        counts: {
          campaigns: results.length,
          published: results.filter((r) => r.state === "PUBLISHED").length,
          failed,
        },
      };
    },
  );
}
