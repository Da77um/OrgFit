// Report wake-up (D-191): after a report request has committed, ask the report
// job project to render the queue now instead of at its next daily cron. The
// call names nothing; a missed or failed wake-up only means the report renders
// at the next scheduled run. Unset variables (local development, or a Pro plan
// with minute ticks) skip it.
export async function wakeReportRenderer(env: Record<string, string | undefined> = process.env) {
  const url = env.REPORT_WAKE_URL,
    secret = env.REPORT_WAKE_SECRET;
  if (!url || !secret || !/^https:\/\//.test(url)) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5000),
    });
    return res.status === 202;
  } catch {
    return false;
  }
}
