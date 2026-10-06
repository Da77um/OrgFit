import manifest from "../../../../../../deploy/processes.json";
import { executeJob, type JobDefinition, type JobName } from "../../../../../../src/job-run";
import { authorizeCron, isJobProcess, isTick, jobsForTick } from "../../../../../../src/vercel-cron";
import { privacyProcessJob } from "../../../../../../scripts/process-campaigns";
import { publicationReleaseJob } from "../../../../../../scripts/publish-campaigns";
import { reportsGenerateJob } from "../../../../../../scripts/generate-reports";
import { reportsExpireJob } from "../../../../../../scripts/expire-reports";
import { attachmentsScanJob } from "../../../../../../scripts/scan-attachments";
import { attachmentsExpireJob } from "../../../../../../scripts/expire-attachments";
import { campaignsNormalizeJob } from "../../../../../../scripts/close-campaigns";
import { draftsExpireJob } from "../../../../../../scripts/expire-drafts";
import { retentionRunJob } from "../../../../../../scripts/retention";
import { tombstonesShipJob } from "../../../../../../scripts/ship-tombstones";
import { opsCheckJob } from "../../../../../../scripts/ops-check";

// One Vercel Cron tick for this deployment's job process (D-165). The jobs run
// exactly as the command line runs them (src/job-run.ts → executeJob): foreign
// credentials refused first, outcome recorded in ops.job_run under the job's
// own login. The response names jobs and exit codes only, never a value.

const DEFINITIONS: Record<JobName, JobDefinition> = {
  "privacy:process": privacyProcessJob,
  "publication:release": publicationReleaseJob,
  "reports:generate": reportsGenerateJob,
  "reports:expire": reportsExpireJob,
  "attachments:scan": attachmentsScanJob,
  "attachments:expire": attachmentsExpireJob,
  "campaigns:normalize": campaignsNormalizeJob,
  "drafts:expire": draftsExpireJob,
  "retention:run": retentionRunJob,
  "tombstones:ship": tombstonesShipJob,
  "ops:check": opsCheckJob,
};

export const dynamic = "force-dynamic";
// The longest a Vercel Pro function may run. The manifest allows privacy:process
// 1800 s and retention:run 3600 s; a run cut short here is recorded as no
// success and raised by ops:check (see docs/orgfit/vercel-deployment.md).
export const maxDuration = 800;

const noStore = { "Cache-Control": "no-store" };

export async function GET(req: Request, ctx: { params: Promise<{ tick: string }> }) {
  if (!authorizeCron(req.headers.get("authorization"), process.env.CRON_SECRET))
    return new Response(null, { status: 401, headers: noStore });
  const { tick } = await ctx.params;
  if (!isTick(tick)) return new Response(null, { status: 404, headers: noStore });
  const processName = process.env.ORGFIT_JOB_PROCESS;
  if (!isJobProcess(processName))
    return Response.json({ error: "ORGFIT_JOB_PROCESS_INVALID" }, { status: 503, headers: noStore });

  const results = [];
  for (const job of jobsForTick(processName, tick, manifest.schedule)) {
    const result = await executeJob(DEFINITIONS[job], { processes: manifest.processes });
    for (const line of result.errors) console.error(`${job}: ${line}`);
    results.push({ job, exitCode: result.exitCode, recorded: result.recorded });
  }
  return Response.json(
    { process: processName, tick, jobs: results },
    { status: results.some((r) => r.exitCode !== 0) ? 500 : 200, headers: noStore },
  );
}
