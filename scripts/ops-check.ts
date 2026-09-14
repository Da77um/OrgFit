import { statfs, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { alertInputs, anonymousOperatorUrl, evaluateAlerts, jobHealth, operatorUrl, storeInconsistencies } from "../src/operations";
import { runJob } from "../src/job-run";

// Alert evaluation for a scheduler or monitoring agent. Exit 2 on any critical
// alert, 1 if the check itself failed. Output carries counts, ages and job
// names only. Since Post-Audit Repair Pass 3 it also judges whether each
// scheduled job is still succeeding (ops.job_health, migration 023).
async function newestBackupAgeHours(dir: string | undefined) {
  if (!dir) return null;
  const names = await readdir(dir).catch(() => []);
  let newest = 0;
  for (const n of names) newest = Math.max(newest, (await stat(join(dir, n))).mtimeMs);
  return newest ? (Date.now() - newest) / 3600_000 : null;
}
await runJob("ops:check", "Operations check failed.", async () => {
  const input = await alertInputs(operatorUrl());
  // Cross-store reconciliation needs the anonymous operator credential; where
  // the scheduler has it, a store restored to a different point is critical.
  if (process.env.ANONYMOUS_MIGRATION_DATABASE_URL)
    input.storeInconsistencies = (await storeInconsistencies(operatorUrl(), anonymousOperatorUrl())).length;
  input.jobs = (await jobHealth(operatorUrl())).jobs;
  const disk = process.env.OPS_DISK_PATH ? await statfs(process.env.OPS_DISK_PATH) : null;
  const alerts = evaluateAlerts(input, {
    backupAgeHours: await newestBackupAgeHours(process.env.BACKUP_DIRECTORY),
    freeDiskFraction: disk ? disk.bavail / disk.blocks : null,
  });
  console.log(JSON.stringify({ alerts }));
  const critical = alerts.filter((a) => a.severity === "critical").length;
  // The check ran; what it found is its output, not its own failure.
  return {
    outcome: "SUCCESS",
    exitCode: critical ? 2 : 0,
    counts: { critical, warning: alerts.length - critical },
  };
});
