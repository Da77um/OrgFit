"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Locale } from "../../../../src/i18n";
import { resultsMessages } from "../../../../src/results-i18n";
import {
  Alert,
  Badge,
  EmptyState,
  Micro,
} from "../../../../src/ui";
import { formatUtc } from "../../../../src/zoned-time";
import { RequestProblem, silent, useStaffApi } from "../request-ui";
import { fillText, minutesSince, overdue, usePollWhile } from "../background-status";

// The staff report panel.
//
// It requests a rendering of the round already on screen and lists what has
// been drawn. It renders nothing itself and shows no result: a job carries a
// state, a size and an expiry, never a metric. The download is a plain link to
// the private endpoint, which re-authorizes the caller at the moment it is
// clicked — the panel's own visibility is not the permission.
//
// Post-Audit Repair Pass 2: every request is bounded; a request whose answer
// is lost is retried with the SAME idempotency key (the server answers from its
// receipt, so a second job is never queued); accepted is worded as queued, not
// as drawn; waiting jobs are refreshed and say when they are overdue.

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
const SCOPE = "report-request";

export function ReportsPanel({
  org,
  roundId,
  locale,
}: {
  org: string;
  roundId: string;
  locale: Locale;
}) {
  const m: M = resultsMessages(locale);
  const client = useStaffApi(locale);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [format, setFormat] = useState<"PDF" | "XLSX">("PDF");
  const [reportLocale, setReportLocale] = useState<Locale>(locale);
  const [comparisonId, setComparisonId] = useState("");
  const [status, setStatus] = useState("");
  const [loadProblem, setLoadProblem] = useState<unknown>(null);
  const [submitProblem, setSubmitProblem] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const root = `/api/v1/organizations/${org}`;
  const requestButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const listed = await client.read<{ items: Job[] }>(`${root}/reports?roundId=${roundId}`);
        setJobs(listed.items);
        const available = await client.read<{ items: Comparison[] }>(`${root}/comparisons`);
        setComparisons(
          available.items.filter((c) => c.leftRoundId === roundId || c.rightRoundId === roundId),
        );
        setLoadProblem(null);
        setCheckedAt(new Date().toISOString());
      } catch (e) {
        if (!silent(e)) setLoadProblem(e);
      } finally {
        setLoading(false);
      }
    },
    [client, root, roundId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const waiting = jobs.some((j) => j.state === "QUEUED" || j.state === "RUNNING");
  usePollWhile(waiting, () => load(true));

  const finish = async (work: () => Promise<unknown>) => {
    setSubmitting(true);
    setSubmitProblem(null);
    setStatus("");
    try {
      await work();
      setStatus(m.reportAccepted);
      await load(true);
    } catch (e) {
      if (!silent(e)) setSubmitProblem(e);
    } finally {
      setSubmitting(false);
    }
  };

  const submit = (body = { roundId, format, locale: reportLocale, comparisonId: comparisonId || null }) =>
    finish(() => client.mutate(SCOPE, `${root}/reports`, { method: "POST", body }));

  const unresolved = client.ledger.uncertain(SCOPE);

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
        <button
          ref={requestButton}
          onClick={() => void submit()}
          disabled={submitting || loading}
          aria-busy={submitting || undefined}
          data-testid="request-report"
        >
          {m.requestReport}
        </button>
      </div>
      <RequestProblem
        locale={locale}
        failure={submitProblem}
        busy={submitting}
        testId="report-request-problem"
        onRetrySame={unresolved ? () => void finish(() => client.retry(SCOPE)) : undefined}
        onCheck={unresolved ? () => void load() : undefined}
        onDiscard={
          unresolved
            ? () => {
                client.ledger.settle(SCOPE);
                setSubmitProblem(null);
              }
            : undefined
        }
      />
      <RequestProblem
        locale={locale}
        failure={loadProblem}
        busy={loading}
        testId="report-load-problem"
        onRetryRead={() => void load()}
      />
      <p role="status" aria-live="polite">
        {loading ? m.loading : status}
      </p>
      <div className="row row-between">
        <p className="muted">
          {checkedAt ? fillText(m.statusCheckedAt, { time: instant(checkedAt).replace(" UTC", "") }) : ""}
        </p>
        <button
          type="button"
          className="button-small button-secondary"
          disabled={loading}
          onClick={() => void load()}
        >
          {m.refreshStatus}
        </button>
      </div>
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
                <tr key={job.id} data-job-state={job.state}>
                  <td>
                    <Micro>{job.format}</Micro>
                  </td>
                  <td>{job.locale === "en" ? "English" : "العربية"}</td>
                  <td>
                    <Badge tone={jobTone(job)}>{m[job.state]}</Badge>
                    <JobNote job={job} m={m} />
                    {job.state === "FAILED" && (
                      <button
                        type="button"
                        className="button-small button-secondary"
                        disabled={submitting}
                        onClick={() => {
                          // A new, deliberate request: the form is set to the
                          // failed job's format and language and the reader
                          // confirms it (including any comparison) with the
                          // request button. The failed job stays failed.
                          setFormat(job.format);
                          setReportLocale(job.locale);
                          requestButton.current?.focus();
                        }}
                      >
                        {m.requestAgain}
                      </button>
                    )}
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
                      <>
                        <a
                          className="button button-secondary button-small"
                          href={`/api/v1/organizations/${org}/reports/${job.id}/download`}
                        >
                          {m.download}
                        </a>
                        {/* Print opens the same authorized file inline, in the
                            browser's own PDF viewer. A workbook has no view. */}
                        {job.format === "PDF" ? (
                          <>
                            {" "}
                            <a
                              className="button button-secondary button-small"
                              target="_blank"
                              rel="noreferrer noopener"
                              title={m.printHint}
                              href={`/api/v1/organizations/${org}/reports/${job.id}/view`}
                              data-testid="print-report"
                            >
                              {m.print}
                            </a>
                          </>
                        ) : null}
                      </>
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
        !loading && !loadProblem && <EmptyState title={m.noReports} />
      )}
    </section>
  );
}

function JobNote({ job, m }: { job: Job; m: M }) {
  if (job.state === "QUEUED" || job.state === "RUNNING") {
    const late = overdue(job.createdAt);
    return (
      <p className="field-hint" data-overdue={late || undefined}>
        {late
          ? fillText(m.jobOverdue, { minutes: minutesSince(job.createdAt) })
          : job.state === "QUEUED"
            ? m.jobQueuedNote
            : m.jobRunningNote}
      </p>
    );
  }
  if (job.state === "FAILED")
    return <p className="field-hint">{fillText(m.jobFailedNote, { code: job.failureCode ?? "—" })}</p>;
  return null;
}

// A rendering job's state. Only a failure is carried in the danger tone; a
// queued or running job is neutral, because waiting is not a problem — until
// it has waited far beyond the process's cadence.
function jobTone(job: Job) {
  const state = job.state;
  return state === "READY"
    ? "positive"
    : state === "FAILED"
      ? "danger"
      : state === "EXPIRED" || state === "REVOKED"
        ? "caution"
        : overdue(job.createdAt)
          ? "caution"
          : "neutral";
}
