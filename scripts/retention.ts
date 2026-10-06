import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { anonymousOperatorUrl, operatorUrl, runRetention } from "../src/operations";
import { runDefinedJob, type JobDefinition } from "../src/job-run";

// Scheduled retention pass (operator credential). Prints counts only.
export const retentionRunJob: JobDefinition = {
  name: "retention:run",
  unavailable: "Retention pass failed. Inspect through the restricted operator channel.",
  work: async () => {
    const result = await runRetention(operatorUrl(), anonymousOperatorUrl());
    console.log(`Retention pass: ${JSON.stringify(result)}`);
    const removed = Object.values(result).reduce((sum, n) => sum + (Number(n) || 0), 0);
    return { outcome: "SUCCESS", counts: { removed, anonymousCampaigns: result.anonymous_campaigns ?? 0 } };
  },
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runDefinedJob(retentionRunJob);
}
