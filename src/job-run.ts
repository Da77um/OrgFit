import pg from "pg";
import { RuntimeGuardError, assertProcessEnvironment, databaseUrl, guardMessage } from "./runtime-guard";

// ---------------------------------------------------------------------------
// One job run, recorded by the job itself (Post-Audit Repair Pass 3).
//
// The supervisor holds no database credential, so the database learns a job's
// outcome from the job: after the work, the script records SUCCESS or FAILURE
// with a failure CODE and named counts through ops.record_job_run (023), under
// its own login, which may only write its own process's jobs.
//
// Recording is best effort and never changes the job's exit status: a job that
// cannot reach the database also cannot record that, which is exactly why the
// status screen judges staleness from the last success.
// ---------------------------------------------------------------------------

export const JOBS = {
  "privacy:process": { process: "processor", login: "orgfit_processor", url: "PROCESSOR_DATABASE_URL" },
  "publication:release": { process: "processor", login: "orgfit_processor", url: "PROCESSOR_DATABASE_URL" },
  "reports:generate": { process: "report", login: "orgfit_report", url: "REPORT_DATABASE_URL" },
  "reports:expire": { process: "report", login: "orgfit_report", url: "REPORT_DATABASE_URL" },
  "attachments:scan": { process: "scanner", login: "orgfit_scanner", url: "SCANNER_DATABASE_URL" },
  "attachments:expire": { process: "scanner", login: "orgfit_scanner", url: "SCANNER_DATABASE_URL" },
  "campaigns:normalize": { process: "operator", login: "orgfit_migrator", url: "MIGRATION_DATABASE_URL" },
  "drafts:expire": { process: "operator", login: "orgfit_migrator", url: "MIGRATION_DATABASE_URL" },
  "retention:run": { process: "operator", login: "orgfit_migrator", url: "MIGRATION_DATABASE_URL" },
  "tombstones:ship": { process: "operator", login: "orgfit_migrator", url: "MIGRATION_DATABASE_URL" },
  "ops:check": { process: "operator", login: "orgfit_migrator", url: "MIGRATION_DATABASE_URL" },
} as const;
export type JobName = keyof typeof JOBS;

export type JobOutcome = {
  outcome: "SUCCESS" | "FAILURE";
  failureCode?: string | null;
  counts?: Record<string, number> | null;
};

export async function recordJobRun(
  job: JobName,
  started: Date,
  result: JobOutcome,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const spec = JOBS[job];
  let client: pg.Client | undefined;
  try {
    client = new pg.Client({
      connectionString: databaseUrl(env[spec.url], spec.login, env),
      connectionTimeoutMillis: 3000,
      application_name: `orgfit_job_status`,
    });
    client.on("error", () => {});
    await client.connect();
    if (spec.process === "operator") await client.query("SET ROLE orgfit_core_owner");
    await client.query("SELECT ops.record_job_run($1,$2,$3,$4,$5)", [
      job,
      started.toISOString(),
      result.outcome,
      result.outcome === "FAILURE" ? (result.failureCode ?? "FAILED") : null,
      result.counts ? JSON.stringify(result.counts) : null,
    ]);
    return true;
  } catch {
    return false;
  } finally {
    await client?.end().catch(() => {});
  }
}

/**
 * The common shape of a scheduled job's entry point: refuse a foreign
 * credential before touching anything, run the work, print its safe summary,
 * record the outcome, and set the exit status. `work` returns the outcome;
 * a thrown error is recorded as UNAVAILABLE and printed as `unavailable` only,
 * because a driver message can quote a value.
 */
export async function runJob(
  job: JobName,
  unavailable: string,
  work: () => Promise<JobOutcome & { exitCode?: number }>,
) {
  const started = new Date();
  try {
    assertProcessEnvironment(JOBS[job].process);
  } catch (e) {
    console.error(guardMessage(e) ?? unavailable);
    process.exitCode = 1;
    return;
  }
  let result: JobOutcome & { exitCode?: number };
  try {
    result = await work();
  } catch (e) {
    console.error(guardMessage(e) ?? unavailable);
    process.exitCode = 1;
    // A guard refusal of the job's own URL means there is no safe URL to
    // record with either.
    if (!(e instanceof RuntimeGuardError))
      await recordJobRun(job, started, { outcome: "FAILURE", failureCode: "UNAVAILABLE" });
    return;
  }
  if (result.exitCode) process.exitCode = result.exitCode;
  else if (result.outcome === "FAILURE") process.exitCode = 1;
  if (!(await recordJobRun(job, started, result)))
    console.error("Job status could not be recorded.");
}
