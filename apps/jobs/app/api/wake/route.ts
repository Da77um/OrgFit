import { after } from "next/server";
import manifest from "../../../../../deploy/processes.json";
import { executeJob } from "../../../../../src/job-run";
import { wakeDecision } from "../../../../../src/vercel-cron";
import { reportsGenerateJob } from "../../../../../scripts/generate-reports";

// Report wake-up (D-191). On Vercel Hobby the cron runs once a day, so a report
// requested now would wait until tomorrow. The staff app calls this route right
// after a report request commits. The call carries no parameter at all: it can
// only make this report project render whatever is already QUEUED, exactly as
// its cron would, under its own credential (src/job-run.ts → executeJob). The
// staff app holds the wake secret and nothing of the renderer's.
//
// The response is sent first; the render runs after it (next/server `after`),
// within this route's maxDuration.

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const noStore = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  const decision = wakeDecision(req.headers.get("authorization"), process.env);
  if (decision !== 202) return new Response(null, { status: decision, headers: noStore });
  after(async () => {
    const result = await executeJob(reportsGenerateJob, { processes: manifest.processes });
    for (const line of result.errors) console.error(`reports:generate: ${line}`);
  });
  return Response.json({ accepted: true }, { status: 202, headers: noStore });
}
