import { readFileSync } from "node:fs";
import { Supervisor } from "../../src/supervisor";

// Runs a Supervisor with a test manifest in its own process, so a test can kill
// it abruptly (crash recovery). Arguments: <manifest.json> <env-dir> <state-dir>
const [manifestPath, envDir, stateDir] = process.argv.slice(2);
const supervisor = new Supervisor({
  manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
  envDir,
  stateDir,
  graceSeconds: 1,
  tickMs: 100,
  log: () => {},
});
await supervisor.start();
