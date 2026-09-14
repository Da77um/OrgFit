import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Supervisor, SupervisorError, type SupervisorStatus } from "../src/supervisor";
import { alertSinkFromEnvironment } from "../src/alert-delivery";

// ---------------------------------------------------------------------------
// Run OrgFit's scheduled jobs under supervision (Post-Audit Repair Pass 3).
//
//   npm run jobs:supervise -- --env-dir <dir> --state-dir <dir>
//       [--only collection,reports:generate] [--once] [--show-stderr]
//       [--interval-scale 0.05]            (nonproduction only)
//   npm run jobs:supervise -- --status --state-dir <dir>
//   npm run jobs:supervise -- --stop --state-dir <dir>
//
// <env-dir> holds processor.env, report.env, scanner.env and operator.env —
// one file per job process, exactly as release preflight validates them. This
// command never installs a service, never deploys anything and sends no alert
// unless ALERT_SINK is configured (see src/alert-delivery.ts). It runs until
// it is stopped (Ctrl+C, a STOP file, or --stop from another terminal).
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    "env-dir": { type: "string" },
    "state-dir": { type: "string" },
    only: { type: "string" },
    once: { type: "boolean" },
    "show-stderr": { type: "boolean" },
    "interval-scale": { type: "string" },
    status: { type: "boolean" },
    stop: { type: "boolean" },
  },
  strict: true,
});

const stateDir = values["state-dir"];
try {
  if (!stateDir) throw new SupervisorError("STATE_DIR_REQUIRED");
  if (values.status) {
    const status = JSON.parse(await readFile(join(resolve(stateDir), "status.json"), "utf8")) as SupervisorStatus;
    console.log(JSON.stringify(status, null, 2));
  } else if (values.stop) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(resolve(stateDir), "STOP"), "");
    console.log("Stop requested; the supervisor finishes running jobs within its grace period.");
  } else {
    if (!values["env-dir"]) throw new SupervisorError("ENV_DIR_REQUIRED");
    const supervisor = new Supervisor({
      envDir: values["env-dir"],
      stateDir,
      only: values.only?.split(",").map((s) => s.trim()).filter(Boolean),
      once: values.once,
      showStderr: values["show-stderr"],
      intervalScale: values["interval-scale"] ? Number(values["interval-scale"]) : 1,
      sink: alertSinkFromEnvironment(),
      alertRepeatSeconds: process.env.ALERT_REPEAT_SECONDS ? Number(process.env.ALERT_REPEAT_SECONDS) : undefined,
      log: (line) => console.log(`${new Date().toISOString()} ${line}`),
    });
    await supervisor.start();
  }
} catch (e) {
  if (e instanceof SupervisorError) {
    console.error(`Supervisor refused to start: ${e.code}`);
    // Names and check outcomes only; never a value.
    for (const d of e.details) console.error(`  ${d}`);
  } else if (e instanceof Error && /^ALERT_[A-Z_]+$/.test(e.message)) {
    console.error(`Supervisor refused to start: ${e.message}`);
  } else {
    console.error("Supervisor unavailable. Check the state directory and environment files.");
  }
  process.exitCode = 1;
}
