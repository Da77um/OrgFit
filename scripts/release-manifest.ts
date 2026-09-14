import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { migrationDigests } from "../src/preflight";

// Release candidate manifest (Phase 15).
//
//   npm run release:manifest -- --id orgfit-0.3.0-rc.1 --out work/release/manifest.json
//   npm run release:manifest -- --verify work/release/manifest.json
//
// The manifest pins what was tested: the commit, a digest of every tracked
// file outside the documentation, the lockfile, the process manifest, the roles
// script and each migration's digest (the same digest the migration ledgers
// store). --verify recomputes all of it from the current checkout, so a
// candidate that differs from the tested one — a changed migration, an edited
// source file, a new dependency — is refused. Later documentation-only commits
// do not change the source digest.
const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8" }).trim();
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
// Text files are hashed with LF line endings, so a Windows checkout (autocrlf)
// and a Linux checkout of the same commit produce the same manifest.
const textSha = (path: string) => sha(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
const isDocumentation = (path: string) => path.startsWith("docs/") || /^[^/]+\.md$/.test(path);

export function computeManifest(id: string) {
  const tree = git("ls-tree", "-r", "HEAD")
    .split("\n")
    .filter((line) => !isDocumentation(line.split("\t")[1] ?? ""))
    .join("\n");
  const dirty = git("status", "--porcelain")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((p) => !isDocumentation(p));
  const buildId = (app: string) => {
    const f = resolve("apps", app, ".next", "BUILD_ID");
    return existsSync(f) ? readFileSync(f, "utf8").trim() : null;
  };
  return {
    releaseId: id,
    commit: git("rev-parse", "HEAD"),
    sourceDigest: sha(tree),
    uncommittedSourceChanges: dirty,
    packageVersion: JSON.parse(readFileSync("package.json", "utf8")).version as string,
    node: process.version,
    npm: execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).trim(),
    lockfileSha256: textSha("package-lock.json"),
    processManifestSha256: textSha("deploy/processes.json"),
    rolesSha256: textSha("db/roles.sql"),
    migrations: { core: migrationDigests("db/migrations"), anonymous: migrationDigests("db/anonymous") },
    builds: { staff: buildId("staff"), respondent: buildId("respondent") },
    createdAt: new Date().toISOString(),
  };
}

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
try {
  const verify = option("verify");
  if (verify) {
    const expected = JSON.parse(readFileSync(verify, "utf8"));
    const actual = computeManifest(expected.releaseId);
    const problems: string[] = [];
    for (const key of ["sourceDigest", "lockfileSha256", "processManifestSha256", "rolesSha256", "packageVersion"])
      if (expected[key] !== (actual as Record<string, unknown>)[key]) problems.push(`${key} differs`);
    if (JSON.stringify(expected.migrations) !== JSON.stringify(actual.migrations)) problems.push("migrations differ");
    if (actual.uncommittedSourceChanges.length) problems.push(`uncommitted source changes: ${actual.uncommittedSourceChanges.join(", ")}`);
    console.log(
      JSON.stringify(
        {
          releaseId: expected.releaseId,
          testedCommit: expected.commit,
          currentCommit: actual.commit,
          sameCommit: expected.commit === actual.commit,
          matches: problems.length === 0,
          problems,
        },
        null,
        2,
      ),
    );
    if (problems.length) process.exitCode = 1;
  } else {
    const id = option("id");
    if (!id || !/^[a-z0-9][a-z0-9.+-]{2,80}$/.test(id)) throw new Error("--id required");
    const manifest = computeManifest(id);
    if (manifest.uncommittedSourceChanges.length && !args.includes("--allow-dirty"))
      throw new Error("uncommitted source changes");
    const out = option("out") ?? `work/release/${id}/manifest.json`;
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Release manifest written: ${out} (commit ${manifest.commit.slice(0, 12)}, source ${manifest.sourceDigest.slice(0, 12)})`);
  }
} catch (e) {
  console.error(`Release manifest failed: ${e instanceof Error ? e.message : "unknown"}`);
  process.exitCode = 1;
}
