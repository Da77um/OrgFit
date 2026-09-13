import { statfs, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { alertInputs, evaluateAlerts, operatorUrl } from "../src/operations";

// Alert evaluation for a scheduler or monitoring agent. Exit 2 on any critical
// alert, 1 if the check itself failed. Output carries counts and ages only.
async function newestBackupAgeHours(dir: string | undefined) {
  if (!dir) return null;
  const names = await readdir(dir).catch(() => []);
  let newest = 0;
  for (const n of names) newest = Math.max(newest, (await stat(join(dir, n))).mtimeMs);
  return newest ? (Date.now() - newest) / 3600_000 : null;
}
try {
  const input = await alertInputs(operatorUrl());
  const disk = process.env.OPS_DISK_PATH ? await statfs(process.env.OPS_DISK_PATH) : null;
  const alerts = evaluateAlerts(input, {
    backupAgeHours: await newestBackupAgeHours(process.env.BACKUP_DIRECTORY),
    freeDiskFraction: disk ? disk.bavail / disk.blocks : null,
  });
  console.log(JSON.stringify({ alerts }));
  if (alerts.some((a) => a.severity === "critical")) process.exitCode = 2;
} catch {
  console.error("Operations check failed.");
  process.exitCode = 1;
}
