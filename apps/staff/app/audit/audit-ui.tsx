"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Profile } from "../../../../src/db";
import { adminMessages, fill, type AdminMessageKey } from "../../../../src/admin-i18n";
import { messages, type Locale } from "../../../../src/i18n";
import { Alert, Badge, EmptyState, ErrorState, LoadingState, Num, PageHeader } from "../../../../src/ui";
import { ApiError, errorText, useApi, useHydrated, utc } from "../admin-client";
import type { OrganizationOption } from "../admin-controls";
import { RequestFailure, staffRequest } from "../staff-request";

type AuditEvent = {
  id: string;
  action: string;
  fieldNames: string[];
  occurredAt: string;
  actorId: string;
  actorName: string | null;
  actorEmail: string | null;
  organizationId: string | null;
  organizationCode: string | null;
  organizationNameAr: string | null;
  organizationNameEn: string | null;
  targetId: string | null;
  targetWithheld: boolean;
  targetStaffName: string | null;
};
type Filters = {
  action: string;
  actorId: string;
  targetId: string;
  organizationId: string;
  from: string; // YYYY-MM-DD, UTC day
  to: string; // YYYY-MM-DD, UTC day, inclusive
};

// The same list as src/administration.ts; the server refuses anything else.
const ACTIONS = [
  "STAFF_CREATED", "ACCESS_CHANGED", "SESSIONS_REVOKED", "PROFILE_UPDATED", "LOGOUT", "BOOTSTRAP",
  "INVITATION_CREATED", "INVITATION_ACCEPTED", "PASSWORD_SET", "SETTINGS_CHANGED", "AUDIT_EXPORTED",
  "DIRECTORY_CHANGED", "IMPORT_CHANGED", "IMPORT_ERRORS_DOWNLOADED", "INSTRUMENT_CHANGED", "SERIES_CHANGED",
  "ROUND_CHANGED", "CAMPAIGN_CHANGED", "CAMPAIGN_LAUNCHED", "CAMPAIGN_END_DATE_CHANGED", "INVITATION_ISSUED",
  "INVITATION_ROTATED", "INVITATION_REVOKED", "LINK_EXPORT_CREATED", "LINK_EXPORT_DOWNLOADED",
  "RECOMMENDATION_ACTION_CHANGED", "COMPARISON_REVIEWED", "REPORT_REQUESTED", "REPORT_DOWNLOADED",
  "PARTICIPATION_EXPORT_CREATED", "PARTICIPATION_EXPORT_DOWNLOADED", "VISIT_CHANGED", "VISIT_TRANSITIONED",
  "VISIT_AMENDED", "FOLLOW_UP_CHANGED", "ATTACHMENT_UPLOADED", "ATTACHMENT_SCANNED", "ATTACHMENT_DOWNLOADED",
  "ATTACHMENT_DELETED",
] as const;

const day = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "");
const nextDay = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().replace(".000Z", "Z");
};

// The API's filter object: dates become a half-open UTC interval, so "to" is
// inclusive of the whole day the reader picked.
function apiFilters(f: Filters) {
  const out: Record<string, string> = {};
  if (f.action) out.action = f.action;
  if (f.actorId) out.actorId = f.actorId;
  if (f.targetId) out.targetId = f.targetId;
  if (f.organizationId) out.organizationId = f.organizationId;
  if (f.from) out.from = `${f.from}T00:00:00Z`;
  if (f.to) out.to = nextDay(f.to);
  return out;
}

export function AuditBrowser({ profile, initial }: { profile: Profile; initial: Record<string, string> }) {
  const locale: Locale = profile.locale;
  const a = adminMessages(locale);
  const m = messages(locale);
  const api = useApi(locale);
  const hydrated = useHydrated();
  const start: Filters = {
    action: initial.action ?? "",
    actorId: initial.actorId ?? "",
    targetId: initial.targetId ?? "",
    organizationId: initial.organizationId ?? "",
    from: day(initial.from),
    to: day(initial.to),
  };
  const [draft, setDraft] = useState<Filters>(start);
  const [applied, setApplied] = useState<Filters>(start);
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [exportState, setExportState] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});

  const query = useMemo(() => apiFilters(applied), [applied]);

  const fetchPage = useCallback(
    async (after: string | null) => {
      setBusy(true);
      setError("");
      try {
        const params = new URLSearchParams(query);
        params.set("limit", "50");
        if (after) params.set("cursor", after);
        const page = await api<{ items: AuditEvent[]; nextCursor: string | null }>(`audit?${params}`);
        setItems((old) => (after ? [...old, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setNames((old) => {
          const next = { ...old };
          for (const e of page.items) {
            if (e.actorName) next[e.actorId] = e.actorName;
            if (e.targetId && e.targetStaffName) next[e.targetId] = e.targetStaffName;
          }
          return next;
        });
      } catch (e) {
        setError(errorText(e, m.unavailable));
      } finally {
        setBusy(false);
      }
    },
    [api, query, m.unavailable],
  );

  useEffect(() => {
    void fetchPage(null);
  }, [fetchPage]);

  useEffect(() => {
    api<{ items: OrganizationOption[] }>("staff/organizations")
      .then((d) => setOrganizations(d.items))
      .catch(() => {
        /* The organization filter falls back to "all". */
      });
  }, [api]);

  // Keep the address in step, so a reload or a shared link shows the same view.
  const apply = (next: Filters) => {
    setApplied(next);
    // The address carries the reader's own days, not the API interval, so a
    // reload does not move the inclusive end date forward.
    const params = new URLSearchParams(Object.entries(next).filter(([, v]) => v));
    history.replaceState(null, "", params.size ? `/audit?${params}` : "/audit");
  };

  async function exportSelection() {
    setExporting(true);
    setExportState(null);
    try {
      // Bounded like every staff request, including the file body. An export
      // is not keyed and is itself audited, so a lost answer is never replayed
      // automatically; exporting again is the reader's own decision.
      let r;
      try {
        r = await staffRequest(locale, "/api/v1/audit/exports", {
          method: "POST",
          body: { filters: query },
          read: "blob",
          timeoutMs: 60_000,
        });
      } catch (e) {
        if (e instanceof RequestFailure && e.kind === "SESSION") return location.assign("/login?expired=1");
        throw e;
      }
      const blob = r.blob!;
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "orgfit-audit.csv";
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      setExportState({ tone: "success", text: a.exported });
    } catch (e) {
      setExportState({
        tone: "danger",
        text: e instanceof ApiError && e.code === "EXPORT_TOO_LARGE" ? a.exportTooLarge : errorText(e, m.unavailable),
      });
    } finally {
      setExporting(false);
    }
  }

  if (!hydrated) return <LoadingState label={a.loading} />;

  const orgName = (e: { organizationNameAr: string | null; organizationNameEn: string | null }) =>
    locale === "en" && e.organizationNameEn ? e.organizationNameEn : e.organizationNameAr;
  const label = (action: string) => {
    const key = `a_${action}` as AdminMessageKey;
    return key in a ? a[key] : action;
  };
  const chip = (key: "actorId" | "targetId", template: string) =>
    applied[key] && (
      <li>
        <button
          type="button"
          className="button-small button-secondary"
          aria-label={fill(a.removeFilter, { v: fill(template, { v: names[applied[key]] ?? applied[key] }) })}
          onClick={() => {
            const next = { ...applied, [key]: "" };
            setDraft(next);
            apply(next);
          }}
        >
          {fill(template, { v: names[applied[key]] ?? applied[key] })} <span aria-hidden="true">×</span>
        </button>
      </li>
    );

  return (
    <>
      <PageHeader title={a.auditTitle} sub={a.auditLead} />
      <form
        className="toolbar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          apply(draft);
        }}
      >
        <label htmlFor="audit-action">
          {a.action}
          <select id="audit-action" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
            <option value="">{a.anyAction}</option>
            {ACTIONS.map((x) => (
              <option key={x} value={x}>{label(x)}</option>
            ))}
          </select>
        </label>
        <label htmlFor="audit-org">
          {a.organization}
          <select id="audit-org" value={draft.organizationId} onChange={(e) => setDraft({ ...draft, organizationId: e.target.value })}>
            <option value="">{a.anyOrganization}</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {locale === "en" && o.name_en ? o.name_en : o.name_ar} ({o.code})
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="audit-from">
          {a.from}
          <input id="audit-from" type="date" dir="ltr" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label htmlFor="audit-to">
          {a.to}
          <input id="audit-to" type="date" dir="ltr" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <div className="row">
          <button type="submit">{a.apply}</button>
          <button
            type="button"
            className="button-quiet"
            onClick={() => {
              const blank: Filters = { action: "", actorId: "", targetId: "", organizationId: "", from: "", to: "" };
              setDraft(blank);
              apply(blank);
            }}
          >
            {a.clear}
          </button>
        </div>
      </form>
      {(applied.actorId || applied.targetId) && (
        <ul className="filter-chips">
          {chip("actorId", a.byActor)}
          {chip("targetId", a.byTarget)}
        </ul>
      )}
      <div className="row row-between">
        <p className="field-hint">{a.timesUtc} {a.exportNote}</p>
        <button type="button" className="button-secondary" disabled={exporting || busy || !!error} onClick={exportSelection}>
          {exporting ? a.exporting : a.exportCsv}
        </button>
      </div>
      {exportState && <Alert tone={exportState.tone} role={exportState.tone === "danger" ? "alert" : "status"}>{exportState.text}</Alert>}
      {error && <ErrorState title={m.errorTitle} body={error} action={<button type="button" onClick={() => void fetchPage(null)}>{m.retry}</button>} />}
      {!error && !busy && items.length === 0 && <EmptyState title={m.emptyTitle} body={a.noEvents} />}
      {items.length > 0 && (
        <div className="table-wrap" tabIndex={0} role="region" aria-label={a.auditCaption}>
          <table className="result-table admin-table">
            <caption className="visually-hidden">{a.auditCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{a.when}</th>
                <th scope="col">{a.action}</th>
                <th scope="col">{a.actor}</th>
                <th scope="col">{a.organization}</th>
                <th scope="col">{a.target}</th>
                <th scope="col">{a.fields}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <th scope="row"><Num>{utc(e.occurredAt, locale)}</Num></th>
                  <td>
                    {label(e.action)}
                    <br />
                    <bdi dir="ltr" className="muted">{e.action}</bdi>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button-quiet button-small"
                      aria-label={fill(a.filterByActor, { v: e.actorName ?? e.actorId })}
                      onClick={() => {
                        const next = { ...applied, actorId: e.actorId };
                        setDraft(next);
                        apply(next);
                      }}
                    >
                      {e.actorName ?? e.actorId}
                    </button>
                    {e.actorEmail && (
                      <>
                        <br />
                        <bdi dir="ltr" className="muted">{e.actorEmail}</bdi>
                      </>
                    )}
                  </td>
                  <td>
                    {e.organizationId ? (
                      <>
                        {orgName(e)} <bdi dir="ltr" className="muted">{e.organizationCode}</bdi>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {e.targetWithheld ? (
                      <Badge tone="neutral" title={a.withheldHint}>{a.withheld}</Badge>
                    ) : e.targetStaffName ? (
                      <a href={`/staff/${e.targetId}`}>{e.targetStaffName}</a>
                    ) : (
                      <bdi dir="ltr" className="muted wrap-anywhere">{e.targetId}</bdi>
                    )}
                  </td>
                  <td><bdi dir="ltr">{e.fieldNames.join(", ")}</bdi></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row row-between">
        <p role="status" aria-live="polite" className="muted">
          {busy ? a.loading : `${fill(a.shownCount, { n: items.length })}${!cursor && items.length ? ` · ${a.endOfList}` : ""}`}
        </p>
        {cursor && (
          <button type="button" className="button-secondary" disabled={busy} onClick={() => void fetchPage(cursor)}>
            {a.loadMore}
          </button>
        )}
      </div>
    </>
  );
}
