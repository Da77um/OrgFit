import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseEnvFile } from "../src/preflight";
import { checkOidc } from "../src/oidc-check";

// Checks the staff environment's identity provider settings before anyone signs in (D-167).
//
//   npm run oidc:check -- --env-file <staff env file> [--production]
//
// Prints names and outcomes only; never a secret.

const { values } = parseArgs({ options: { "env-file": { type: "string" }, production: { type: "boolean" } }, strict: true });
try {
  if (!values["env-file"]) throw new Error("usage");
  const env = parseEnvFile(readFileSync(values["env-file"], "utf8"));
  const findings = await checkOidc(env, { production: !!values.production || env.NODE_ENV === "production" });
  for (const f of findings) console.log(`${f.outcome} ${f.check} — ${f.detail}`);
  const failed = findings.filter((f) => f.outcome === "FAIL").length;
  const warned = findings.filter((f) => f.outcome === "WARN").length;
  console.log(`oidc: ${failed ? `${failed} FAILED` : "no failures"}, ${warned} warnings`);
  process.exitCode = failed ? 1 : 0;
} catch {
  console.error("Usage: oidc:check -- --env-file <staff env file> [--production]");
  process.exitCode = 1;
}
