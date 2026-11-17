// When the daily processing run starts (D-181, D-190). apps/jobs/vercel.json
// holds the same schedule ("17 3 * * *"); tests/vercel-jobs.test.ts fails if
// the two drift. Vercel Hobby fires a daily cron within the hour after it.
export const PROCESSING_UTC = { hour: 3, minute: 17 } as const;

// The next start strictly after `from`.
export function nextProcessingRun(from: Date = new Date()): Date {
  const next = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), PROCESSING_UTC.hour, PROCESSING_UTC.minute),
  );
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
