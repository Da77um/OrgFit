"use client";
import { jsonOf, staffFetch } from "../staff-fetch";
import { useCallback, useEffect, useState } from "react";
import { messages, type Locale } from "../../../../src/i18n";
import { resultsMessages } from "../../../../src/results-i18n";
import {
  Alert,
  Badge,
  EmptyState,
  ErrorState,
  Micro,
} from "../../../../src/ui";
import { formatUtc } from "../../../../src/zoned-time";

// The staff report panel.
//
// It requests a rendering of the round already on screen and lists what has
// been drawn. It renders nothing itself and shows no result: a job carries a
// state, a size and an expiry, never a metric. The download is a plain link to
// the private endpoint, which re-authorizes the caller at the moment it is
// clicked — the panel's own visibility is not the permission.

type M = ReturnType<typeof resultsMessages>;

type Job = {
  id: string;
  roundId: string;
  format: "PDF" | "XLSX";
  locale: Locale;
  state: "QUEUED" | "RUNNING" | "READY" | "FAILED" | "EXPIRED" | "REVOKED";
  byteCount: number | null;
  pageCount: number | null;
  failureCode: string | null;
  requestedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
};
type Comparison = {
  id: string;
  leftRoundId: string;
  rightRoundId: string;
  classification: string;
  reviewedAt: string;
};

// A report job has no timezone of its own, so its times are UTC and say so.
const instant = (value: string | null) => formatUtc(value);
const kilobytes = (value: number | null) =>
  value === null ? "" : `${Math.max(1, Math.round(value / 1024))} KB`;

export function ReportsPanel({
  org,
  roundId,
  locale,
}: {
  org: string;
  roundId: string;
  locale: Locale;
}) {
  const m: M = resultsMessages(locale),
    base = messages(locale);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [format, setFormat] = useState<"PDF" | "XLSX">("PDF");
  const [reportLocale, setReportLocale] = useState<Locale>(locale);
  const [comparisonId, setComparisonId] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);

  const api = useCallback(
    async (suffix: string, init?: RequestInit) => {
      const r = await staffFetch(locale)(`/api/v1/organizations/${org}/${suffix}`, {
        ...init,
        headers: {
          "Accept-Language": locale,
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...(init?.method && init.method !== "GET"
            ? { "idempotency-key": crypto.randomUUID() }
            : {}),
        },
      });
      const json = await jsonOf(r);
      if (!r.ok) throw new Error(json.message ?? base.unavailable);
      return json.data;
    },
    [org, locale, base],
  );

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const listed = (await api(`reports?roundId=${roundId}`)) as {
        items: Job[];
      };
      setJobs(listed.items);
      const available = (await api("comparisons")) as { items: Comparison[] };
      setComparisons(
        available.items.filter(
          (c) => c.leftRoundId === roundId || c.rightRoundId === roundId,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : base.unavailable);
    } finally {
      setBusy(false);
    }
  }, [api, roundId, base]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await api("reports", {
        method: "POST",
        body: JSON.stringify({
          roundId,
          format,
          locale: reportLocale,
          comparisonId: comparisonId || null,
        }),
      });
      setStatus(m.reportRequested);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : base.unavailable);
      setBusy(false);
    }
  };

  return (
    <section className="card stack">
      <div className="card-head">
        <h2>{m.reports}</h2>
        <Micro>{jobs.length} JOBS</Micro>
      </div>
      <Alert tone="info" role="note">
        {m.reportsNote}
      </Alert>
      <div className="toolbar">
        <label>
          {m.reportFormat}
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as "PDF" | "XLSX")}
          >
            <option value="PDF">PDF</option>
            <option value="XLSX">XLSX</option>
          </select>
        </label>
        <label>
          {m.reportLocale}
          <select
            value={reportLocale}
            onChange={(e) => setReportLocale(e.target.value as Locale)}
          >
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </select>
        </label>
        <label>
          {m.includeComparison}
          <select
            value={comparisonId}
            onChange={(e) => setComparisonId(e.target.value)}
          >
            <option value="">{m.noComparisonOption}</option>
            {comparisons.map((c) => (
              <option key={c.id} value={c.id}>
                {instant(c.reviewedAt)} — {c.classification}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => void submit()} disabled={busy}>
          {m.requestReport}
        </button>
      </div>
      {error && <ErrorState title={messages(locale).errorTitle} body={error} />}
      <p role="status" aria-live="polite">
        {busy ? m.loading : status}
      </p>
      {jobs.length ? (
        // Nine columns do not fit a 320px viewport, so the table scrolls inside
        // its own box rather than making the page scroll sideways.
        <div
          className="table-wrap scroll"
          tabIndex={0}
          role="region"
          aria-label={m.reports}
        >
          <table className="result-table">
            <caption>{m.reports}</caption>
            <thead>
              <tr>
                <th>{m.reportFormat}</th>
                <th>{m.reportLocale}</th>
                <th>{m.status}</th>
                <th>{m.size}</th>
                <th>{m.pages}</th>
                <th>{m.requestedBy}</th>
                <th>{m.requestedAt}</th>
                <th>{m.expiresAt}</th>
                <th>{m.download}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <Micro>{job.format}</Micro>
                  </td>
                  <td>{job.locale === "en" ? "English" : "العربية"}</td>
                  <td>
                    <Badge tone={jobTone(job.state)}>{m[job.state]}</Badge>
                  </td>
                  <td>{kilobytes(job.byteCount)}</td>
                  <td>{job.pageCount ?? ""}</td>
                  <td>{job.requestedBy ?? ""}</td>
                  <td><bdi dir="ltr">{instant(job.createdAt)}</bdi></td>
                  <td><bdi dir="ltr">{instant(job.expiresAt)}</bdi></td>
                  <td>
                    {/* A link exists only for a rendering that exists. The
                        endpoint re-authorizes on click; the link's presence is
                        not the permission. */}
                    {job.state === "READY" ? (
                      <a
                        className="button button-secondary button-small"
                        href={`/api/v1/organizations/${org}/reports/${job.id}/download`}
                      >
                        {m.download}
                      </a>
                    ) : (
                      ""
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !busy && <EmptyState title={m.noReports} />
      )}
    </section>
  );
}

// A rendering job's state. Only a failure is carried in the danger tone; a
// queued or running job is neutral, because waiting is not a problem.
function jobTone(state: string) {
  return state === "READY"
    ? "positive"
    : state === "FAILED"
      ? "danger"
      : state === "EXPIRED" || state === "REVOKED"
        ? "caution"
        : "neutral";
}
