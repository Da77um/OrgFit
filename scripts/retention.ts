import { anonymousOperatorUrl, operatorUrl, runRetention } from "../src/operations";

// Scheduled retention pass (operator credential). Prints counts only.
try {
  const result = await runRetention(operatorUrl(), anonymousOperatorUrl());
  console.log(`Retention pass: ${JSON.stringify(result)}`);
} catch {
  console.error("Retention pass failed. Inspect through the restricted operator channel.");
  process.exitCode = 1;
}
