"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { ChangeProblem, silent, useStaffApi, type ChangeFailure } from "../request-ui";
import { RequestFailure } from "../staff-request";
import { useUnsavedChanges } from "../unsaved";
import type { Locale } from "../../../../src/i18n";
import { resultsMessages } from "../../../../src/results-i18n";
import { Alert, Num } from "../../../../src/ui";

// Withdrawal of a published release (Post-Audit Repair Pass 3).
//
// Every results reader sees that a release was withdrawn, when, for which
// category of reason, and how many report downloads had already happened —
// because those copies exist outside OrgFit and cannot be recalled. Only a
// Super Admin sees the written reason, the incident reference and who acted,
// and only a Super Admin is offered the form. The server decides both; the
// screen only follows `canRevoke` and the fields it was given.

type M = ReturnType<typeof resultsMessages>;
type Revocation = {
  revokedAt: string;
  reasonCode: string;
  channel: string;
  reportsRevoked: number;
  downloadsBefore: number;
  reason?: string;
  incidentReference?: string;
  revokedBy?: string | null;
};
export type ReleaseStatus = {
  campaignId: string;
  releaseState: string;
  snapshotId: string | null;
  snapshotState: string | null;
  fingerprint: string | null;
  canRevoke: boolean;
  revocation: Revocation | null;
};

const REASONS = ["PRIVACY_INCIDENT", "CORRECTNESS_ERROR", "DATA_INTEGRITY", "OWNER_DECISION"] as const;
const stamp = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));

export function ReleasePanel({
  org,
  roundId,
  locale,
  onChanged,
}: {
  org: string;
  roundId: string;
  locale: Locale;
  onChanged: () => void;
}) {
  const m = resultsMessages(locale);
  const client = useStaffApi(locale);
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const load = useCallback(async () => {
    try {
      setStatus(await client.read<ReleaseStatus>(`/api/v1/organizations/${org}/assessments/${roundId}/release`));
    } catch (e) {
      // The results view reports its own failure; this panel stays absent.
      if (!silent(e)) setStatus(null);
    }
  }, [client, org, roundId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!status) return null;
  if (status.revocation) return <Withdrawn m={m} revocation={status.revocation} />;
  if (status.canRevoke && status.fingerprint)
    return (
      <RevokeForm
        m={m}
        locale={locale}
        org={org}
        roundId={roundId}
        status={status}
        onDone={() => {
          void load();
          onChanged();
        }}
      />
    );
  return null;
}

function Withdrawn({ m, revocation }: { m: M; revocation: Revocation }) {
  const label = (key: string) => (m[key as keyof M] as string | undefined) ?? key;
  return (
    <Alert tone="danger" role="note">
      <strong>{m.withdrawnTitle}</strong>
      <p>
        {/* The date is its own left-to-right run: inside Arabic text a bare
            "YYYY-MM-DD HH:MM UTC" reorders into an unreadable sequence (D-135). */}
        {m.withdrawnBody.split("{date}")[0]}
        <bdi dir="ltr">{stamp(revocation.revokedAt)}</bdi>
        {m.withdrawnBody.split("{date}")[1]}
      </p>
      <dl className="facts">
        <dt>{m.withdrawnReason}</dt>
        <dd>{label(revocation.reasonCode)}</dd>
        <dt>{m.withdrawnChannel}</dt>
        <dd>{label(`channel_${revocation.channel}`)}</dd>
        {revocation.reason !== undefined && (
          <>
            <dt>{m.withdrawnReasonText}</dt>
            <dd>{revocation.reason}</dd>
            <dt>{m.withdrawnIncident}</dt>
            <dd>
              <bdi>{revocation.incidentReference}</bdi>
            </dd>
            {revocation.revokedBy && (
              <>
                <dt>{m.withdrawnBy}</dt>
                <dd>{revocation.revokedBy}</dd>
              </>
            )}
          </>
        )}
      </dl>
      <p>{fill(m.withdrawnReports, { count: revocation.reportsRevoked })}</p>
      <p>
        {revocation.downloadsBefore > 0
          ? fill(m.withdrawnDownloads, { count: revocation.downloadsBefore })
          : m.withdrawnNoDownloads}
      </p>
    </Alert>
  );
}

function RevokeForm({
  m,
  locale,
  org,
  roundId,
  status,
  onDone,
}: {
  m: M;
  locale: Locale;
  org: string;
  roundId: string;
  status: ReleaseStatus;
  onDone: () => void;
}) {
  const client = useStaffApi(locale);
  const ids = useId();
  const blank = { reasonCode: "", reason: "", incidentReference: "", confirmation: "", acknowledged: false };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<ChangeFailure | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(blank);
  // A withdrawal is never "saved and continued" from the leave dialog: it is
  // too consequential to run as a side effect of changing the language.
  useUnsavedChanges(dirty);
  const scope = `release-revocation:${status.snapshotId}`;
  const ready =
    REASONS.includes(form.reasonCode as (typeof REASONS)[number]) &&
    form.reason.trim().length >= 10 &&
    form.incidentReference.trim().length > 0 &&
    form.confirmation.trim().toLowerCase() === status.fingerprint &&
    form.acknowledged;

  const submit = async (again = false) => {
    setBusy(true);
    setNote("");
    setProblem(null);
    try {
      const result = again
        ? await client.retry<{ replayed: boolean; reportsRevoked: number }>(scope)
        : await client.mutate<{ replayed: boolean; reportsRevoked: number }>(
            scope,
            `/api/v1/organizations/${org}/assessments/${roundId}/release/revocation`,
            {
              method: "POST",
              body: {
                snapshotId: status.snapshotId,
                reasonCode: form.reasonCode,
                reason: form.reason.trim(),
                incidentReference: form.incidentReference.trim(),
                confirmation: form.confirmation.trim().toLowerCase(),
              },
            },
          );
      setForm(blank);
      setNote(result.replayed ? m.revokeReplayed : fill(m.revokeDone, { count: result.reportsRevoked }));
      onDone();
    } catch (e) {
      if (silent(e)) return;
      if (e instanceof RequestFailure && (e.uncertain || e.kind === "SESSION"))
        setProblem({ failure: e, scope, retry: () => void submit(true) });
      else if (e instanceof RequestFailure && e.code === "FORBIDDEN") setNote(m.revokeForbidden);
      else if (e instanceof RequestFailure && (e.code === "CONFIRMATION_MISMATCH" || e.code === "RELEASE_ALREADY_REVOKED"))
        setNote(m[e.code]);
      else setNote(e instanceof Error && e.message ? e.message : m.unavailable);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="panel release-revoke">
      <summary>{m.revokeTitle}</summary>
      <div className="stack">
        <p>{m.revokeLead}</p>
        <Alert tone="warning" role="note">
          {m.revokeRecall}
        </Alert>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void submit();
          }}
        >
          <label>
            {m.revokeReasonCode}
            <select
              required
              value={form.reasonCode}
              onChange={(e) => setForm({ ...form, reasonCode: e.target.value })}
            >
              <option value="" />
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {m[r]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {m.revokeReason}
            <textarea
              required
              minLength={10}
              maxLength={2000}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </label>
          <label>
            {m.revokeIncident}
            <input
              required
              maxLength={200}
              dir="auto"
              value={form.incidentReference}
              onChange={(e) => setForm({ ...form, incidentReference: e.target.value })}
            />
          </label>
          <label htmlFor={`${ids}-confirm`}>
            {fill(m.revokeConfirm, { prefix: "" })}
            <Num>{status.fingerprint}</Num>
          </label>
          <input
            id={`${ids}-confirm`}
            required
            dir="ltr"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={8}
            value={form.confirmation}
            onChange={(e) => setForm({ ...form, confirmation: e.target.value })}
          />
          <label className="row">
            <input
              type="checkbox"
              checked={form.acknowledged}
              onChange={(e) => setForm({ ...form, acknowledged: e.target.checked })}
            />
            {m.revokeAcknowledge}
          </label>
          <div className="row">
            <button type="submit" className="button-danger" disabled={!ready || busy}>
              {m.revokeSubmit}
            </button>
            <span role="status">{note}</span>
          </div>
        </form>
        <ChangeProblem
          locale={locale}
          problem={problem}
          ledger={client.ledger}
          busy={busy}
          onCheck={onDone}
          onDismiss={() => setProblem(null)}
        />
      </div>
    </details>
  );
}
