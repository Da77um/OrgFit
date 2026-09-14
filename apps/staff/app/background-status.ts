import { useEffect, useRef } from "react";

// Waiting on a background process (Post-Audit Repair Pass 2).
//
// The report renderer and the attachment scanner run every minute
// (deploy/processes.json). Work still waiting after ten minutes is therefore
// not "slow"; the process is probably not running, and the screen says so
// instead of implying the job is under way. Accepting a request is never
// presented as the job having run.
export const BACKGROUND_OVERDUE_MS = 10 * 60_000;
export const BACKGROUND_POLL_MS = 15_000;

export const minutesSince = (iso: string | null | undefined, now = Date.now()) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 60_000));
};

export const overdue = (iso: string | null | undefined, now = Date.now()) =>
  minutesSince(iso, now) * 60_000 >= BACKGROUND_OVERDUE_MS;

/**
 * Refresh while something is waiting. One refresh at a time, never after the
 * screen has gone, and not at all while nothing waits.
 */
export function usePollWhile(active: boolean, refresh: () => Promise<unknown>, every = BACKGROUND_POLL_MS) {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      try {
        await latest.current();
      } catch {
        /* The screen shows its own failure; polling simply tries again. */
      }
      if (!stopped) timer = setTimeout(tick, every);
    };
    timer = setTimeout(tick, every);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, every]);
}

export const fillText = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
