import { createHash, timingSafeEqual } from "node:crypto";
import type { JobName } from "./job-run";

// ---------------------------------------------------------------------------
// Scheduled jobs on Vercel Cron (D-165).
//
// One small app, apps/jobs, is deployed as four Vercel projects: processor,
// report, scanner and operator. Each project holds only its own process's
// environment (deploy/processes.json) plus ORGFIT_JOB_PROCESS naming that
// process, and runs only that process's jobs. Vercel calls one route per tick
// on the schedule in apps/jobs/vercel.json; every project receives every tick
// and runs the jobs of its own process whose cadence is that tick.
//
// The cadences come from deploy/processes.json → schedule, the same table the
// supervisor runs and ops.job_status (migration 023) agrees with. A group's
// jobs that follow a job of ANOTHER process run on the "-after" tick, two
// minutes later, because separate projects cannot wait for each other: the
// processor's collection jobs then see the operator's campaign closes.
//
// Overlap: a tick can start while the previous run of the same job is still
// going (the supervisor prevented that). Every job is safe to overlap: work is
// claimed with FOR UPDATE SKIP LOCKED or a lease, and campaign normalization
// holds an advisory lock.
// ---------------------------------------------------------------------------

export const JOB_PROCESSES = ["processor", "report", "scanner", "operator"] as const;
export type JobProcess = (typeof JOB_PROCESSES)[number];

/** Each tick and its cron expression. apps/jobs/vercel.json must list exactly these. */
export const TICKS = {
  "every-minute": "* * * * *",
  "every-2-minutes": "*/2 * * * *",
  "every-5-minutes": "*/5 * * * *",
  "every-5-minutes-after": "2-59/5 * * * *",
  hourly: "7 * * * *",
  daily: "17 3 * * *",
} as const;
export type Tick = keyof typeof TICKS;

const CADENCE: Record<number, Tick> = {
  60: "every-minute",
  120: "every-2-minutes",
  300: "every-5-minutes",
  3600: "hourly",
  86400: "daily",
};

export type Schedule = {
  groups: Record<string, { jobs: string[] }>;
  jobs: Record<string, { process: string; everySeconds: number; group?: string }>;
};

export const isTick = (value: string): value is Tick => Object.hasOwn(TICKS, value);
export const isJobProcess = (value: string | undefined): value is JobProcess =>
  (JOB_PROCESSES as readonly string[]).includes(value ?? "");

/** The tick a job runs on. Throws for a cadence Vercel Cron is not configured for. */
export function tickOf(job: string, schedule: Schedule): Tick {
  const spec = schedule.jobs[job];
  if (!spec) throw new Error(`UNKNOWN_JOB:${job}`);
  const base = CADENCE[spec.everySeconds];
  if (!base) throw new Error(`UNSUPPORTED_CADENCE:${job}`);
  if (!spec.group) return base;
  const order = schedule.groups[spec.group]?.jobs ?? [];
  const earlier = order.slice(0, order.indexOf(job));
  if (!earlier.some((j) => schedule.jobs[j]?.process !== spec.process)) return base;
  const after = `${base}-after`;
  if (!isTick(after)) throw new Error(`UNSUPPORTED_GROUP_CADENCE:${job}`);
  return after;
}

/** The jobs one process runs on one tick, in manifest order (a group keeps its order). */
export function jobsForTick(processName: JobProcess, tick: Tick, schedule: Schedule): JobName[] {
  const ordered = [
    ...Object.values(schedule.groups).flatMap((g) => g.jobs),
    ...Object.keys(schedule.jobs),
  ].filter((job, i, all) => all.indexOf(job) === i);
  return ordered.filter(
    (job) => schedule.jobs[job]?.process === processName && tickOf(job, schedule) === tick,
  ) as JobName[];
}

/**
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` on every cron call. An
 * unset or short secret refuses everything, so a project deployed without one
 * cannot be triggered by anyone. Compared as digests: no early exit, no length leak.
 */
export function authorizeCron(header: string | null, secret: string | undefined) {
  if (!secret || secret.length < 32 || !header) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
