import { readFileSync } from "node:fs";
import { checkDatabases, checkEnvironment, parseEnvFile, type Finding } from "../src/preflight";

// Release preflight for one process (Phase 15).
//
//   npm run release:preflight -- --process staff --env-file /secure/staff.env --production --check-database
//
// Without --env-file it reads its own environment. It prints variable and check
// names only — never a value — and exits 1 if any check FAILs.
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const processName = option("process");
if (!processName) {
  console.error("Usage: release-preflight --process <staff|respondent|processor|report|scanner|operator> [--env-file path] [--production] [--check-database] [--json]");
  process.exit(1);
}
try {
  const file = option("env-file");
  const env: Record<string, string | undefined> = file ? parseEnvFile(readFileSync(file, "utf8")) : { ...process.env };
  const production = flag("production") || env.NODE_ENV === "production";
  const findings: Finding[] = checkEnvironment(processName, env, { production });
  if (flag("check-database")) findings.push(...(await checkDatabases(processName, env, { production })));
  if (flag("json")) console.log(JSON.stringify({ process: processName, production, findings }));
  else for (const f of findings) console.log(`${f.outcome.padEnd(4)} ${f.check} — ${f.detail}`);
  const failed = findings.filter((f) => f.outcome === "FAIL").length;
  if (!flag("json")) console.log(`${processName}: ${failed ? `${failed} FAILED` : "no failures"}, ${findings.filter((f) => f.outcome === "WARN").length} warnings`);
  if (failed) process.exitCode = 1;
} catch {
  console.error("Preflight could not run. Check the manifest path and the environment file.");
  process.exitCode = 1;
}
