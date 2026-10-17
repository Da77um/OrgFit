import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import manifest from "../deploy/processes.json";
import { JOBS, executeJob, type JobDefinition } from "../src/job-run";
import {
  DAILY_ALL_SCHEDULE,
  DAILY_ALL_TICK,
  JOB_PROCESSES,
  TICKS,
  authorizeCron,
  isJobProcess,
  isTick,
  jobsForProcess,
  jobsForTick,
  tickOf,
} from "../src/vercel-cron";
import { privacyProcessJob } from "../scripts/process-campaigns";
import { publicationReleaseJob } from "../scripts/publish-campaigns";
import { reportsGenerateJob } from "../scripts/generate-reports";
import { reportsExpireJob } from "../scripts/expire-reports";
import { attachmentsScanJob } from "../scripts/scan-attachments";
import { attachmentsExpireJob } from "../scripts/expire-attachments";
import { campaignsNormalizeJob } from "../scripts/close-campaigns";
import { draftsExpireJob } from "../scripts/expire-drafts";
import { retentionRunJob } from "../scripts/retention";
import { tombstonesShipJob } from "../scripts/ship-tombstones";
import { opsCheckJob } from "../scripts/ops-check";

// D-165: scheduled jobs on Vercel Cron. No database is needed: these assert the
// schedule mapping, the cron authorization and the shared job runner's refusals.

const definitions: JobDefinition[] = [
  privacyProcessJob, publicationReleaseJob, reportsGenerateJob, reportsExpireJob,
  attachmentsScanJob, attachmentsExpireJob, campaignsNormalizeJob, draftsExpireJob,
  retentionRunJob, tombstonesShipJob, opsCheckJob,
];

test("importing a job script runs nothing, and every job has exactly one exported definition", () => {
  // Reaching this line means no import started a job (ops-check, retention and
  // ship-tombstones used to run at import time).
  assert.equal(process.exitCode ?? 0, 0);
  assert.deepEqual(definitions.map((d) => d.name).sort(), Object.keys(JOBS).sort());
});

test("every scheduled job has a Vercel tick, and the manifest lists exactly the runner's jobs", () => {
  assert.deepEqual(Object.keys(manifest.schedule.jobs).sort(), Object.keys(JOBS).sort());
  for (const job of Object.keys(manifest.schedule.jobs)) assert.ok(isTick(tickOf(job, manifest.schedule)), job);
});

test("each job runs on exactly one tick of exactly its own process", () => {
  for (const job of Object.keys(JOBS)) {
    const hits = JOB_PROCESSES.flatMap((p) =>
      (Object.keys(TICKS) as (keyof typeof TICKS)[]).filter((t) => jobsForTick(p, t, manifest.schedule).includes(job as never)).map((t) => `${p}/${t}`),
    );
    assert.deepEqual(hits, [`${JOBS[job as keyof typeof JOBS].process}/${tickOf(job, manifest.schedule)}`], job);
  }
});

test("the collection group runs the operator close first, then the processor jobs in order", () => {
  assert.deepEqual(jobsForTick("operator", "every-5-minutes", manifest.schedule), ["campaigns:normalize", "tombstones:ship"]);
  assert.deepEqual(jobsForTick("processor", "every-5-minutes-after", manifest.schedule), ["privacy:process", "publication:release"]);
  assert.deepEqual(jobsForTick("processor", "every-5-minutes", manifest.schedule), []);
});

// D-181: the owner's account is Vercel Hobby, which allows a cron job at most
// once a day (a more frequent expression fails the deployment) and functions
// of at most 300 s. vercel.json is that schedule; the Pro schedule is kept in
// vercel.pro.json, to be swapped in on a Pro plan.
test("apps/jobs/vercel.json (Hobby) runs every job of the project once a day, within Hobby's limits", () => {
  const vercel = JSON.parse(readFileSync("apps/jobs/vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] };
  assert.deepEqual(vercel.crons, [{ path: `/api/cron/${DAILY_ALL_TICK}`, schedule: DAILY_ALL_SCHEDULE }]);
  assert.match(DAILY_ALL_SCHEDULE, /^\d{1,2} \d{1,2} \* \* \*$/, "at most once a day");
  assert.equal(isTick(DAILY_ALL_TICK), false, "not one of the Pro ticks");
  // Processing before publication, in one call: a release never runs before
  // the batch it would publish.
  assert.deepEqual(jobsForProcess("processor", manifest.schedule), ["privacy:process", "publication:release"]);
  // Every job of every process runs exactly once on that one daily call.
  assert.deepEqual(
    JOB_PROCESSES.flatMap((p) => jobsForProcess(p, manifest.schedule)).sort(),
    Object.keys(JOBS).sort(),
  );
  const route = readFileSync("apps/jobs/app/api/cron/[tick]/route.ts", "utf8");
  const duration = Number(/export const maxDuration = (\d+);/.exec(route)?.[1]);
  assert.ok(duration > 0 && duration <= 300, `maxDuration ${duration} must fit Hobby's 300 s`);
});

test("apps/jobs/vercel.pro.json schedules exactly the ticks the route understands", () => {
  const vercel = JSON.parse(readFileSync("apps/jobs/vercel.pro.json", "utf8")) as { crons: { path: string; schedule: string }[] };
  assert.deepEqual(
    vercel.crons.map((c) => [c.path, c.schedule]).sort(),
    Object.entries(TICKS).map(([tick, schedule]) => [`/api/cron/${tick}`, schedule]).sort(),
  );
});

test("cron authorization: only the exact bearer secret, and never without a long secret", () => {
  const secret = "s".repeat(32) + "-cron";
  assert.equal(authorizeCron(`Bearer ${secret}`, secret), true);
  assert.equal(authorizeCron(`Bearer ${secret}x`, secret), false);
  assert.equal(authorizeCron(secret, secret), false);
  assert.equal(authorizeCron(null, secret), false);
  assert.equal(authorizeCron("Bearer short", "short"), false);
  assert.equal(authorizeCron("Bearer ", undefined), false);
  assert.equal(authorizeCron("Bearer ", ""), false);
});

test("only the four job processes are accepted as ORGFIT_JOB_PROCESS", () => {
  for (const p of ["processor", "report", "scanner", "operator"]) assert.equal(isJobProcess(p), true);
  for (const p of ["staff", "respondent", "", undefined, "Processor"]) assert.equal(isJobProcess(p), false);
});

test("executeJob refuses a foreign credential before any work and leaves the process exit status alone", async () => {
  let ran = false;
  const before = process.exitCode;
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://orgfit_staff:x@127.0.0.1:1/orgfit";
  try {
    const result = await executeJob(
      { name: "reports:expire", unavailable: "unavailable", work: async () => ((ran = true), { outcome: "SUCCESS" }) },
      { processes: manifest.processes },
    );
    assert.equal(ran, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.recorded, false);
    assert.deepEqual(result.errors, ["Refused by runtime guard: FOREIGN_CREDENTIAL:DATABASE_URL."]);
    assert.equal(process.exitCode, before);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
});
