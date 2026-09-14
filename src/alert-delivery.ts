import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Alert delivery adapter (Post-Audit Repair Pass 3).
//
// ops:check evaluates alerts and prints them as JSON; the supervisor hands that
// output, plus its own job-failure alerts, to one sink. No monitoring
// destination has been chosen (P-002), so the adapter is deliberately small:
//
//   none     (default) nothing leaves the process; alerts stay in status.json
//   console  one JSON line on the supervisor's own output
//   file     appended JSON lines, for a local agent to pick up
//   webhook  an HTTPS POST — only when ALERT_DELIVERY_ENABLED=true, and only to
//            an https URL in production. Its bearer token is read from the
//            environment and never logged. Nothing in this repository enables
//            it; it was exercised against a loopback test server only.
//
// A payload carries alert codes, severities, job names and counts. It never
// carries an identifier of a campaign, report, person or file, and no message
// text from a job.
// ---------------------------------------------------------------------------

export type DeliveredAlert = { code: string; severity: "critical" | "warning"; value: number | string };
export type AlertPayload = {
  source: "ops:check" | "supervisor";
  environment: string;
  at: string;
  alerts: DeliveredAlert[];
};
export interface AlertSink {
  readonly kind: string;
  deliver(payload: AlertPayload): Promise<void>;
}

const SAFE_VALUE = /^[A-Za-z0-9:_.\- ]{0,80}$/;
/** Drops anything that does not look like a code, a job name or a number. */
export function sanitizeAlerts(alerts: unknown): DeliveredAlert[] {
  if (!Array.isArray(alerts)) return [];
  return alerts.flatMap((a) => {
    if (typeof a !== "object" || a === null) return [];
    const { code, severity, value } = a as Record<string, unknown>;
    if (typeof code !== "string" || !/^[A-Z][A-Z_]{0,79}$/.test(code)) return [];
    if (severity !== "critical" && severity !== "warning") return [];
    const safe =
      typeof value === "number" && Number.isFinite(value)
        ? value
        : typeof value === "string" && SAFE_VALUE.test(value)
          ? value
          : "";
    return [{ code, severity, value: safe }];
  });
}

export class ConsoleSink implements AlertSink {
  readonly kind = "console";
  constructor(private write: (line: string) => void = (l) => console.log(l)) {}
  async deliver(payload: AlertPayload) {
    this.write(JSON.stringify({ alert: payload }));
  }
}

export class FileSink implements AlertSink {
  readonly kind = "file";
  constructor(private path: string) {}
  async deliver(payload: AlertPayload) {
    await mkdir(dirname(resolve(this.path)), { recursive: true });
    await appendFile(resolve(this.path), JSON.stringify(payload) + "\n", { mode: 0o600 });
  }
}

export class WebhookSink implements AlertSink {
  readonly kind = "webhook";
  constructor(
    private url: string,
    private token: string | undefined,
    private timeoutMs = 5000,
  ) {}
  async deliver(payload: AlertPayload) {
    let lastError: unknown;
    // Bounded: three attempts, then the failure is the caller's to record.
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
          redirect: "error",
        });
        if (res.ok) return;
        lastError = new Error(`ALERT_WEBHOOK_HTTP_${res.status}`);
        if (res.status < 500 && res.status !== 429) break;
      } catch (e) {
        lastError = e;
      } finally {
        clearTimeout(timer);
      }
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    throw new Error(
      lastError instanceof Error && /^ALERT_WEBHOOK_HTTP_\d+$/.test(lastError.message)
        ? lastError.message
        : "ALERT_WEBHOOK_UNREACHABLE",
    );
  }
}

export class NoSink implements AlertSink {
  readonly kind = "none";
  async deliver() {}
}

/** Build the sink from the supervisor's own environment; refuses an unsafe one. */
export function alertSinkFromEnvironment(env: Record<string, string | undefined> = process.env): AlertSink {
  const kind = env.ALERT_SINK ?? "none";
  if (kind === "none") return new NoSink();
  if (kind === "console") return new ConsoleSink();
  if (kind === "file") {
    if (!env.ALERT_FILE) throw new Error("ALERT_FILE_REQUIRED");
    return new FileSink(env.ALERT_FILE);
  }
  if (kind === "webhook") {
    if (env.ALERT_DELIVERY_ENABLED !== "true") throw new Error("ALERT_DELIVERY_NOT_ENABLED");
    let url: URL;
    try {
      url = new URL(env.ALERT_WEBHOOK_URL ?? "");
    } catch {
      throw new Error("ALERT_WEBHOOK_URL_INVALID");
    }
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.hash) throw new Error("ALERT_WEBHOOK_URL_INVALID");
    if (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && loopback && url.protocol === "http:"))
      throw new Error("ALERT_WEBHOOK_URL_INVALID");
    return new WebhookSink(url.href, env.ALERT_WEBHOOK_TOKEN);
  }
  throw new Error("ALERT_SINK_UNKNOWN");
}

/**
 * Deliver only when something changed, or a critical alert is still open after
 * the repeat interval. An unchanged warning is not re-sent every two minutes.
 */
export class AlertDeduplicator {
  private last = "";
  private lastSentAt = 0;
  constructor(private repeatMs = 3600_000) {}
  shouldSend(alerts: DeliveredAlert[], now = Date.now()) {
    const key = alerts
      .map((a) => `${a.severity}:${a.code}:${a.value}`)
      .sort()
      .join("|");
    const changed = key !== this.last;
    const repeat = alerts.some((a) => a.severity === "critical") && now - this.lastSentAt >= this.repeatMs;
    if (!changed && !repeat) return false;
    this.last = key;
    this.lastSentAt = now;
    return true;
  }
}
