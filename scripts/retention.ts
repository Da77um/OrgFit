import { anonymousOperatorUrl, operatorUrl, runRetention } from "../src/operations";
import { runJob } from "../src/job-run";

// Scheduled retention pass (operator credential). Prints counts only.
await runJob("retention:run", "Retention pass failed. Inspect through the restricted operator channel.", async () => {
  const result = await runRetention(operatorUrl(), anonymousOperatorUrl());
  console.log(`Retention pass: ${JSON.stringify(result)}`);
  const removed = Object.values(result).reduce((sum, n) => sum + (Number(n) || 0), 0);
  return { outcome: "SUCCESS", counts: { removed, anonymousCampaigns: result.anonymous_campaigns ?? 0 } };
});
