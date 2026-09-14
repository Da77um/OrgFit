"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Profile } from "../../../../src/db";
import { adminMessages, fill, type AdminMessages } from "../../../../src/admin-i18n";
import { messages, type Locale } from "../../../../src/i18n";
import { Alert, Badge, ErrorState, LoadingState, Num, PageHeader, Tile } from "../../../../src/ui";
import { ApiError, errorText, useApi, useHydrated, utc } from "../admin-client";

type Settings = {
  revision: number;
  defaultTimezone: string;
  defaultCampaignThreshold: number;
  staffInvitationHours: number;
  changedAt: string;
  changedByName: string | null;
  thresholdFloor: number;
};
type StatusData = {
  settings: Settings;
  history: Settings[];
  status: {
    localAccessEnabled: boolean;
    readAt: string;
    alerts: {
      restoreState: string;
      countMismatch: number;
      blockedReleases: number;
      closedUnprocessedOverdue: number;
      insufficientIntakeOverdue: number;
      reportQueueOldestSeconds: number;
      reportFailedLastDay: number;
      attachmentQuarantineOldestSeconds: number;
      rateLimitedLastWindow: number;
      lastRetentionRun: string | null;
    };
    retention: {
      class: string;
      retain: string;
      basis: string;
      approved: boolean;
      approvedAt: string | null;
      approvedBy: string | null;
    }[];
  };
  authentication: { identityProvider: string; passwordPathEnabled: boolean; production: boolean };
};

// Every IANA zone the browser knows, offered as suggestions; the server checks
// the submitted name against PostgreSQL's own zone list.
const zones = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["Asia/Riyadh", "UTC"];
  }
})();

export function SettingsScreen({ profile }: { profile: Profile }) {
  const locale: Locale = profile.locale;
  const a = adminMessages(locale);
  const m = messages(locale);
  const api = useApi(locale);
  const hydrated = useHydrated();
  const [data, setData] = useState<StatusData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "danger"; text: string; conflict?: boolean } | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());

  const load = useCallback(async () => {
    setLoadError("");
    try {
      setData(await api<StatusData>("settings/status"));
    } catch (e) {
      setLoadError(errorText(e, m.unavailable));
    }
  }, [api, m.unavailable]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!hydrated || (!data && !loadError)) return <LoadingState label={a.loading} />;
  if (!data)
    return (
      <>
        <PageHeader title={a.settingsTitle} />
        <ErrorState title={m.errorTitle} body={loadError} action={<button type="button" onClick={() => void load()}>{m.retry}</button>} />
      </>
    );

  const { settings, status, authentication } = data;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setResult(null);
    try {
      await api("settings", {
        method: "PATCH",
        revision: settings.revision,
        idempotencyKey: key,
        body: {
          defaultTimezone: String(f.get("defaultTimezone") ?? "").trim(),
          defaultCampaignThreshold: Number(f.get("defaultCampaignThreshold")),
          staffInvitationHours: Number(f.get("staffInvitationHours")),
        },
      });
      setKey(crypto.randomUUID());
      setResult({ tone: "success", text: a.defaultsSaved });
      await load();
    } catch (err) {
      const conflict = err instanceof ApiError && err.code === "REVISION_CONFLICT";
      setResult({ tone: "danger", text: conflict ? a.conflictReload : errorText(err, m.unavailable), conflict });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title={a.settingsTitle} sub={a.settingsLead} />

      <form className="panel stack" onSubmit={save} aria-labelledby="defaults-heading" key={settings.revision}>
        <div className="card-head">
          <h2 id="defaults-heading">{a.defaultsTitle}</h2>
          <span>
            {a.revision} <Num>{settings.revision}</Num>
          </span>
        </div>
        <p className="field-hint">{a.defaultsLead}</p>
        <div className="form-grid">
          <label htmlFor="set-zone">
            {a.defaultTimezone}
            <input
              id="set-zone"
              name="defaultTimezone"
              dir="ltr"
              list="set-zone-list"
              required
              maxLength={100}
              defaultValue={settings.defaultTimezone}
              aria-describedby="set-zone-hint"
            />
            <span id="set-zone-hint" className="field-hint">{a.timezoneHint}</span>
            <datalist id="set-zone-list">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </label>
          <label htmlFor="set-threshold">
            {a.defaultThreshold}
            <input
              id="set-threshold"
              name="defaultCampaignThreshold"
              type="number"
              min={settings.thresholdFloor}
              max={1000}
              step={1}
              required
              dir="ltr"
              defaultValue={settings.defaultCampaignThreshold}
              aria-describedby="set-threshold-hint"
            />
            <span id="set-threshold-hint" className="field-hint">{a.thresholdHint}</span>
          </label>
          <label htmlFor="set-hours">
            {a.invitationHours}
            <input
              id="set-hours"
              name="staffInvitationHours"
              type="number"
              min={1}
              max={168}
              step={1}
              required
              dir="ltr"
              defaultValue={settings.staffInvitationHours}
              aria-describedby="set-hours-hint"
            />
            <span id="set-hours-hint" className="field-hint">{a.invitationHoursHint}</span>
          </label>
        </div>
        {result && (
          <Alert tone={result.tone} role={result.tone === "danger" ? "alert" : "status"}>
            {result.text}{" "}
            {result.conflict && (
              <button type="button" className="button-small button-secondary" onClick={() => void load()}>
                {a.reload}
              </button>
            )}
          </Alert>
        )}
        <button type="submit" disabled={busy}>{busy ? a.saving : a.saveDefaults}</button>
      </form>

      <section className="card stack" aria-labelledby="policy-heading">
        <h2 id="policy-heading">{a.policyTitle}</h2>
        <dl className="facts">
          <dt>{a.policyLanguage}</dt>
          <dd>{a.policyLanguageValue}</dd>
          <dt>{a.policyFloor}</dt>
          <dd>{a.policyFloorValue}</dd>
        </dl>
      </section>

      <section className="card stack" aria-labelledby="auth-heading">
        <h2 id="auth-heading">{a.authTitle}</h2>
        {authentication.production && authentication.passwordPathEnabled && (
          <Alert tone="danger" role="alert">{a.passwordPathProduction}</Alert>
        )}
        <dl className="facts">
          <dt>{a.identityProvider}</dt>
          <dd><bdi dir="ltr">{authentication.identityProvider}</bdi></dd>
          <dt>{a.passwordPath}</dt>
          <dd>
            <Badge tone={authentication.passwordPathEnabled ? "caution" : "neutral"}>
              {authentication.passwordPathEnabled ? a.passwordPathOn : a.passwordPathOff}
            </Badge>
            {authentication.passwordPathEnabled && <p className="field-hint">{a.passwordPathOnNote}</p>}
          </dd>
        </dl>
        <p className="field-hint">{a.mfaByProvider} {a.operatorManaged}</p>
      </section>

      <StatusSection a={a} locale={locale} status={status} />

      <section className="stack" aria-labelledby="retention-heading">
        <h2 id="retention-heading">{a.retentionTitle}</h2>
        <p className="page-sub">{a.retentionLead}</p>
        <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="retention-heading">
          <table className="result-table admin-table">
            <thead>
              <tr>
                <th scope="col">{a.retentionClass}</th>
                <th scope="col">{a.retentionPeriod}</th>
                <th scope="col">{a.retentionBasis}</th>
                <th scope="col">{a.approval}</th>
              </tr>
            </thead>
            <tbody>
              {status.retention.map((p) => (
                <tr key={p.class}>
                  <th scope="row"><bdi dir="ltr">{p.class}</bdi></th>
                  <td><Num>{p.retain}</Num></td>
                  <td><bdi dir="ltr" lang="en">{p.basis}</bdi></td>
                  <td>
                    {p.approved ? (
                      <Badge tone="positive">
                        {fill(a.approvedBy, { who: p.approvedBy ?? "" })} · {utc(p.approvedAt, locale)}
                      </Badge>
                    ) : (
                      <Badge tone="caution">{a.unapproved}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack" aria-labelledby="history-heading">
        <h2 id="history-heading">{a.historyTitle}</h2>
        <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="history-heading">
          <table className="result-table admin-table">
            <thead>
              <tr>
                <th scope="col">{a.revision}</th>
                <th scope="col">{a.changedAt}</th>
                <th scope="col">{a.changedBy}</th>
                <th scope="col">{a.defaultTimezone}</th>
                <th scope="col">{a.defaultThreshold}</th>
                <th scope="col">{a.invitationHours}</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((h) => (
                <tr key={h.revision}>
                  <th scope="row"><Num>{h.revision}</Num></th>
                  <td><Num>{utc(h.changedAt, locale)}</Num></td>
                  <td>{h.changedByName ?? a.initialVersion}</td>
                  <td><bdi dir="ltr">{h.defaultTimezone}</bdi></td>
                  <td><Num>{h.defaultCampaignThreshold}</Num></td>
                  <td><Num>{h.staffInvitationHours}</Num></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="field-hint">{a.timesUtc}</p>
      </section>
    </>
  );
}

function StatusSection({
  a,
  locale,
  status,
}: {
  a: AdminMessages;
  locale: Locale;
  status: StatusData["status"];
}) {
  const s = status.alerts;
  const secs = (n: number) => fill(a.seconds, { n });
  return (
    <section className="stack" aria-labelledby="status-heading">
      <div className="card-head">
        <h2 id="status-heading">{a.statusTitle}</h2>
        <Num>{utc(status.readAt, locale)} UTC</Num>
      </div>
      <p className="page-sub">{a.statusLead}</p>
      <div className="tiles">
        <Tile
          label={a.restoreState}
          numeric={false}
          accent={s.restoreState !== "NORMAL"}
          value={s.restoreState === "NORMAL" ? a.NORMAL : a.REAPPLY_PENDING}
        />
        <Tile label={a.lastRetentionRun} numeric={!!s.lastRetentionRun} value={s.lastRetentionRun ? utc(s.lastRetentionRun, locale) : a.never} />
        <Tile label={a.reportQueueAge} numeric value={secs(s.reportQueueOldestSeconds)} />
        <Tile label={a.reportFailures} value={s.reportFailedLastDay} accent={s.reportFailedLastDay > 0} />
        <Tile label={a.quarantineAge} numeric value={secs(s.attachmentQuarantineOldestSeconds)} />
        <Tile label={a.blockedReleases} value={s.blockedReleases} accent={s.blockedReleases > 0} />
        <Tile label={a.processingOverdue} value={s.closedUnprocessedOverdue} accent={s.closedUnprocessedOverdue > 0} />
        <Tile label={a.insufficientOverdue} value={s.insufficientIntakeOverdue} accent={s.insufficientIntakeOverdue > 0} />
        <Tile label={a.countMismatch} value={s.countMismatch} accent={s.countMismatch > 0} />
        <Tile label={a.rateLimited} value={s.rateLimitedLastWindow} />
      </div>
    </section>
  );
}
