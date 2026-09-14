import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

// A stand-in job for the supervisor tests. Its behaviour comes from its own
// environment file, per job: FAKE_MODE_<job with non-word characters as _>,
// else FAKE_MODE. Every start and end is appended to FAKE_LOG with the names
// (never the values) of the variables the process received.
//   ok | fail | hang | sleep:<ms> | fail-until:<n>  (fails n times, then succeeds)
const job = process.env.ORGFIT_SUPERVISED_JOB ?? "unnamed";
const mode = process.env[`FAKE_MODE_${job.replace(/\W/g, "_")}`] ?? process.env.FAKE_MODE ?? "ok";
const log = process.env.FAKE_LOG!;
const event = (name: string) =>
  appendFileSync(log, JSON.stringify({ job, event: name, at: Date.now(), pid: process.pid, keys: Object.keys(process.env).sort() }) + "\n");

event("start");
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode.startsWith("sleep:")) {
  setTimeout(() => {
    event("end");
  }, Number(mode.slice(6)));
} else if (mode.startsWith("fail-until:")) {
  const counter = `${log}.${job.replace(/\W/g, "_")}.count`;
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(n + 1));
  event("end");
  if (n < Number(mode.slice(11))) process.exitCode = 1;
} else {
  event("end");
  if (mode === "fail") process.exitCode = 1;
}
