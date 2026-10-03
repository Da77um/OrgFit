import { spawnSync } from "node:child_process";

// The CI dependency audit (D-163). Same gate as `npm audit --audit-level=high`
// — any high or critical advisory fails — with one narrow exception mechanism:
// an advisory that has NO patched release anywhere upstream may be listed below
// while every path to it is a dev dependency. Three conditions keep an entry
// honest, and each is checked on every run rather than trusted:
//
//   * it names one advisory id, never a package or a severity;
//   * it stops applying the moment the advisory is reachable from a production
//     dependency (`npm audit --omit=dev` must not report it);
//   * it expires. Past `reviewBy` the entry fails the build until someone looks
//     at upstream again and either removes it or renews it with a reason.
//
// Exit 1 on any unexcused finding, an expired entry, or a failed audit run.

type Exception = { id: string; package: string; reason: string; reviewBy: string };

const EXCEPTIONS: Exception[] = [
  {
    id: "GHSA-vfj7-8cjw-p6xm",
    package: "braces",
    reason:
      "braces <=3.0.3 stack exhaustion on deeply nested patterns. 3.0.3 is the latest release, so no patched version exists; " +
      "the only path is @next/eslint-plugin-next > fast-glob > micromatch, a lint-time dev dependency whose patterns come " +
      "from this repository, never from users.",
    reviewBy: "2026-12-31",
  },
];

type Advisory = { source?: number; url?: string; severity?: string; title?: string; range?: string };
type Report = { vulnerabilities?: Record<string, { via: (string | Advisory)[] }> };

function audit(extra: string[]): Report {
  // Windows resolves npm.cmd only through a shell, and Node refuses argument
  // arrays with a shell, so there the fixed command is passed as one string.
  const args = ["audit", "--json", ...extra];
  const options = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 } as const;
  const run =
    process.platform === "win32"
      ? spawnSync(`npm ${args.join(" ")}`, { ...options, shell: true })
      : spawnSync("npm", args, options);
  try {
    return JSON.parse(run.stdout) as Report;
  } catch {
    console.error("npm audit did not return a report:", run.stderr.trim().slice(0, 500));
    process.exit(1);
  }
}

const idOf = (a: Advisory) => a.url?.split("/").pop() ?? `npm-${a.source}`;

// Advisory objects, not the packages that merely depend on a vulnerable one:
// those entries carry package names in `via` and are the same finding again.
function findings(report: Report) {
  const out = new Map<string, Advisory & { package: string }>();
  for (const [name, entry] of Object.entries(report.vulnerabilities ?? {}))
    for (const via of entry.via)
      if (typeof via === "object" && ["high", "critical"].includes(via.severity ?? ""))
        out.set(idOf(via), { ...via, package: name });
  return out;
}

const all = findings(audit([]));
const production = findings(audit(["--omit=dev"]));
const today = new Date().toISOString().slice(0, 10);
let failed = false;

for (const [id, f] of all) {
  const excuse = EXCEPTIONS.find((e) => e.id === id && e.package === f.package);
  if (!excuse) {
    console.error(`FAIL ${f.severity} ${id} ${f.package} ${f.range ?? ""} — ${f.title ?? ""}`);
    failed = true;
  } else if (production.has(id)) {
    console.error(`FAIL ${id} is excused only as a dev dependency, but a production dependency now reaches it.`);
    failed = true;
  } else if (today > excuse.reviewBy) {
    console.error(`FAIL ${id}: the exception expired on ${excuse.reviewBy}. Check upstream, then remove or renew it.`);
    failed = true;
  } else {
    console.log(`EXCUSED ${id} ${f.package} (dev only, review by ${excuse.reviewBy}): ${excuse.reason}`);
  }
}
// An entry nobody needs any more is removed, not left to excuse a future
// finding with the same id.
for (const e of EXCEPTIONS)
  if (!all.has(e.id)) console.log(`NOTE ${e.id} no longer reported; remove its exception.`);

if (failed) process.exit(1);
console.log(`Audit passed: ${all.size} high/critical finding(s), all excused; ${production.size} in production dependencies.`);
