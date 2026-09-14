/* Full document navigation keeps each staff record's state separate. */
/* eslint-disable @next/next/no-html-link-for-pages */
"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Profile } from "../../../../src/db";
import { adminMessages, fill, type AdminMessages } from "../../../../src/admin-i18n";
import { messages, type Locale } from "../../../../src/i18n";
import {
  Alert,
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  Num,
  PageHeader,
} from "../../../../src/ui";
import { ApiError, errorText, useApi, useHydrated, utc } from "../admin-client";
import {
  AccessFields,
  ConfirmAction,
  roleTone,
  statusTone,
  type AccessValue,
  type OrganizationOption,
} from "../admin-controls";

type StaffItem = {
  id: string;
  email: string;
  displayName: string;
  role: "SUPER_ADMIN" | "STAFF";
  status: "ACTIVE" | "DISABLED";
  authMethod: "OIDC" | "PASSWORD";
  capabilities: string[];
  organizationIds: string[];
  activeSessions: number;
  revision: number;
};
type StaffRecord = StaffItem & {
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  updatedByName: string | null;
  issuer: string | null;
  subject: string | null;
  isSelf: boolean;
  lastSeenAt: string | null;
  otherActiveSuperAdmins: number;
  locale: Locale;
};
type Invitation = {
  id: string;
  email: string;
  role: "SUPER_ADMIN" | "STAFF";
  state: "PENDING" | "EXPIRED" | "CONSUMED" | "REVOKED";
  createdAt: string;
  expiresAt: string;
  createdByName: string | null;
};
type Page<T> = { items: T[]; nextCursor: string | null };

const blankAccess = (): AccessValue => ({ role: "STAFF", capabilities: [], organizationIds: [] });

// A refusal worded for what the administrator can do about it.
function refusal(e: unknown, a: AdminMessages, fallback: string) {
  if (e instanceof ApiError) {
    if (e.code === "LAST_ADMIN") return a.lastAdmin;
    if (e.code === "REVISION_CONFLICT") return a.conflictReload;
  }
  return errorText(e, fallback);
}

function useOrganizations(locale: Locale) {
  const api = useApi(locale);
  const [state, setState] = useState<{ items: OrganizationOption[]; truncated: boolean }>({
    items: [],
    truncated: false,
  });
  useEffect(() => {
    let live = true;
    api<{ items: OrganizationOption[]; truncated: boolean }>("staff/organizations")
      .then((d) => live && setState(d))
      .catch(() => {
        /* The access editor still shows existing assignments by count. */
      });
    return () => {
      live = false;
    };
  }, [api]);
  return state;
}

// A keyset list: the first page, then "Show more" appends the next one using
// the server's cursor. Changing a filter starts again from the first page.
function useKeysetList<T>(locale: Locale, endpoint: string, query: Record<string, string>) {
  const api = useApi(locale);
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const key = JSON.stringify(query);
  const fetchPage = useCallback(
    async (after: string | null, reset: boolean) => {
      setBusy(true);
      setError("");
      try {
        const params = new URLSearchParams(
          Object.entries(JSON.parse(key) as Record<string, string>).filter(([, v]) => v),
        );
        params.set("limit", "25");
        if (after) params.set("cursor", after);
        const page = await api<Page<T>>(`${endpoint}?${params}`);
        setItems((old) => (reset ? page.items : [...old, ...page.items]));
        setCursor(page.nextCursor);
      } catch (e) {
        setError(errorText(e, messages(locale).unavailable));
      } finally {
        setBusy(false);
      }
    },
    [api, endpoint, key, locale],
  );
  useEffect(() => {
    void fetchPage(null, true);
  }, [fetchPage]);
  return {
    items,
    busy,
    error,
    hasMore: cursor !== null,
    more: () => fetchPage(cursor, false),
    reload: () => fetchPage(null, true),
  };
}

function MoreButton({
  a,
  count,
  hasMore,
  busy,
  onMore,
}: {
  a: AdminMessages;
  count: number;
  hasMore: boolean;
  busy: boolean;
  onMore: () => void;
}) {
  return (
    <div className="row row-between">
      <p role="status" aria-live="polite" className="muted">
        {fill(a.shownCount, { n: count })}
        {!hasMore && count > 0 ? ` · ${a.endOfList}` : ""}
      </p>
      {hasMore && (
        <button type="button" className="button-secondary" disabled={busy} onClick={onMore}>
          {busy ? a.loading : a.loadMore}
        </button>
      )}
    </div>
  );
}

export function StaffAdmin({
  profile,
  localAccessEnabled,
  invitationHours,
  issuer,
  production,
}: {
  profile: Profile;
  localAccessEnabled: boolean;
  invitationHours: number;
  issuer: string;
  production: boolean;
}) {
  const locale = profile.locale;
  const a = adminMessages(locale);
  const m = messages(locale);
  const hydrated = useHydrated();
  const [draft, setDraft] = useState({ q: "", role: "", status: "" });
  const [query, setQuery] = useState({ q: "", role: "", status: "" });
  const list = useKeysetList<StaffItem>(locale, "staff", query);
  const organizations = useOrganizations(locale);
  const [inviteState, setInviteState] = useState({ q: "", state: "" });
  const invitations = useKeysetList<Invitation>(locale, "staff/invitations", inviteState);

  if (!hydrated) return <LoadingState label={a.loading} />;

  return (
    <>
      <PageHeader title={a.staffTitle} sub={a.staffLead} />

      <section className="stack" aria-labelledby="staff-list-heading">
        <h2 id="staff-list-heading">{a.staffListCaption}</h2>
        <form
          className="toolbar"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(draft);
          }}
        >
          <label htmlFor="staff-q">
            {a.staffSearch}
            <input
              id="staff-q"
              type="search"
              maxLength={200}
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          </label>
          <label htmlFor="staff-role">
            {a.role}
            <select id="staff-role" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
              <option value="">{a.all}</option>
              <option value="SUPER_ADMIN">{a.SUPER_ADMIN}</option>
              <option value="STAFF">{a.STAFF}</option>
            </select>
          </label>
          <label htmlFor="staff-status">
            {a.status}
            <select id="staff-status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
              <option value="">{a.all}</option>
              <option value="ACTIVE">{a.ACTIVE}</option>
              <option value="DISABLED">{a.DISABLED}</option>
            </select>
          </label>
          <div className="row">
            <button type="submit">{a.search}</button>
            <button
              type="button"
              className="button-quiet"
              onClick={() => {
                const blank = { q: "", role: "", status: "" };
                setDraft(blank);
                setQuery(blank);
              }}
            >
              {a.clear}
            </button>
          </div>
        </form>
        {list.error && <ErrorState title={m.errorTitle} body={list.error} action={<button type="button" onClick={list.reload}>{m.retry}</button>} />}
        {!list.error && !list.busy && list.items.length === 0 && <EmptyState title={m.emptyTitle} body={a.noStaff} />}
        {list.items.length > 0 && (
          <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="staff-list-heading">
            <table className="result-table admin-table table-sticky">
              <caption className="visually-hidden">{a.staffListCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{a.displayName}</th>
                  <th scope="col">{a.role}</th>
                  <th scope="col">{a.status}</th>
                  <th scope="col">{a.authMethod}</th>
                  <th scope="col">{a.orgCount}</th>
                  <th scope="col">{a.activeSessions}</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((s) => (
                  <tr key={s.id}>
                    <th scope="row">
                      <a href={`/staff/${s.id}`}>{s.displayName}</a>
                      <br />
                      <bdi dir="ltr" className="muted">{s.email}</bdi>
                    </th>
                    <td><Badge tone={roleTone(s.role)}>{a[s.role]}</Badge></td>
                    <td><Badge tone={statusTone(s.status)}>{a[s.status]}</Badge></td>
                    <td>{a[s.authMethod]}</td>
                    <td><Num>{s.role === "SUPER_ADMIN" ? "—" : s.organizationIds.length}</Num></td>
                    <td><Num>{s.activeSessions}</Num></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <MoreButton a={a} count={list.items.length} hasMore={list.hasMore} busy={list.busy} onMore={list.more} />
      </section>

      <section className="stack" aria-labelledby="add-staff-heading">
        <h2 id="add-staff-heading">{a.addStaff}</h2>
        <div className="grid grid-even">
          <RegisterForm a={a} locale={locale} issuer={issuer} organizations={organizations} onDone={list.reload} />
          {localAccessEnabled ? (
            <InvitationForm
              a={a}
              locale={locale}
              hours={invitationHours}
              production={production}
              organizations={organizations}
              onDone={invitations.reload}
            />
          ) : (
            <div className="panel stack">
              <h3>{a.newInvitation}</h3>
              <Alert tone="info" role="note">{a.invitationsOff}</Alert>
            </div>
          )}
        </div>
      </section>

      <section className="stack" aria-labelledby="invitations-heading">
        <h2 id="invitations-heading">{a.invitationsTitle}</h2>
        <p className="page-sub">{a.invitationsLead}</p>
        <div className="toolbar">
          <label htmlFor="inv-state">
            {a.state}
            <select
              id="inv-state"
              value={inviteState.state}
              onChange={(e) => setInviteState({ ...inviteState, state: e.target.value })}
            >
              <option value="">{a.all}</option>
              {(["PENDING", "EXPIRED", "CONSUMED", "REVOKED"] as const).map((s) => (
                <option key={s} value={s}>{a[s]}</option>
              ))}
            </select>
          </label>
        </div>
        {invitations.error && <ErrorState title={m.errorTitle} body={invitations.error} />}
        {!invitations.error && !invitations.busy && invitations.items.length === 0 && (
          <EmptyState title={m.emptyTitle} body={a.noInvitations} />
        )}
        {invitations.items.length > 0 && (
          <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="invitations-heading">
            <table className="result-table admin-table">
              <caption className="visually-hidden">{a.invitationCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{a.email}</th>
                  <th scope="col">{a.role}</th>
                  <th scope="col">{a.state}</th>
                  <th scope="col">{a.expiresAt}</th>
                  <th scope="col">{a.createdBy}</th>
                  <th scope="col"><span className="visually-hidden">{a.withdraw}</span></th>
                </tr>
              </thead>
              <tbody>
                {invitations.items.map((i) => (
                  <InvitationRow key={i.id} i={i} a={a} locale={locale} onChanged={invitations.reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <MoreButton
          a={a}
          count={invitations.items.length}
          hasMore={invitations.hasMore}
          busy={invitations.busy}
          onMore={invitations.more}
        />
      </section>
    </>
  );
}

function InvitationRow({
  i,
  a,
  locale,
  onChanged,
}: {
  i: Invitation;
  a: AdminMessages;
  locale: Locale;
  onChanged: () => void;
}) {
  const api = useApi(locale);
  const [error, setError] = useState("");
  const tone = i.state === "PENDING" ? "caution" : i.state === "CONSUMED" ? "positive" : "neutral";
  return (
    <tr>
      <th scope="row"><bdi dir="ltr">{i.email}</bdi></th>
      <td>{a[i.role]}</td>
      <td><Badge tone={tone}>{a[i.state]}</Badge></td>
      <td><Num>{utc(i.expiresAt, locale)}</Num></td>
      <td>{i.createdByName ?? ""}</td>
      <td>
        {i.state === "PENDING" && (
          <ConfirmAction
            a={a}
            label={a.withdraw}
            confirmLabel={a.withdrawConfirm}
            onConfirm={async () => {
              try {
                await api(`staff/invitations/${i.id}/revoke`, { method: "POST" });
                onChanged();
              } catch (e) {
                setError(errorText(e, messages(locale).unavailable));
              }
            }}
          />
        )}
        {error && <p role="alert" className="field-error">{error}</p>}
      </td>
    </tr>
  );
}

function RegisterForm({
  a,
  locale,
  issuer,
  organizations,
  onDone,
}: {
  a: AdminMessages;
  locale: Locale;
  issuer: string;
  organizations: { items: OrganizationOption[]; truncated: boolean };
  onDone: () => void;
}) {
  const api = useApi(locale);
  const [access, setAccess] = useState<AccessValue>(blankAccess);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  // One key per form fill, so a double submit or a retry after a timeout
  // replays instead of registering twice.
  const [key, setKey] = useState(() => crypto.randomUUID());
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError("");
    setNote("");
    try {
      const created = await api<{ id: string }>("staff", {
        method: "POST",
        idempotencyKey: key,
        body: {
          issuer,
          subject: String(f.get("subject") ?? "").trim(),
          email: String(f.get("email") ?? "").trim(),
          displayName: String(f.get("displayName") ?? "").trim(),
          status: "ACTIVE",
          ...access,
        },
      });
      form.reset();
      setAccess(blankAccess());
      setKey(crypto.randomUUID());
      setNote(a.registered);
      onDone();
      return created;
    } catch (e) {
      setError(refusal(e, a, messages(locale).unavailable));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel stack" onSubmit={submit} aria-labelledby="register-heading">
      <h3 id="register-heading">{a.registerTitle}</h3>
      <p className="field-hint">{a.registerLead}</p>
      <dl className="facts">
        <dt>{a.issuer}</dt>
        <dd><bdi dir="ltr">{issuer}</bdi></dd>
      </dl>
      <div className="form-grid">
        <label htmlFor="reg-email">
          {a.email} *
          <input id="reg-email" name="email" type="email" dir="ltr" autoComplete="off" required maxLength={320} />
        </label>
        <label htmlFor="reg-name">
          {a.displayName} *
          <input id="reg-name" name="displayName" required maxLength={500} />
        </label>
        <label htmlFor="reg-subject">
          {a.subject} *
          <input id="reg-subject" name="subject" dir="ltr" required maxLength={500} aria-describedby="reg-subject-hint" />
          <span id="reg-subject-hint" className="field-hint">{a.subjectHint}</span>
        </label>
      </div>
      <AccessFields
        a={a}
        locale={locale}
        idPrefix="reg"
        value={access}
        onChange={setAccess}
        organizations={organizations.items}
        organizationsTruncated={organizations.truncated}
      />
      {error && <Alert tone="danger" role="alert">{error}</Alert>}
      {note && <Alert tone="success">{note}</Alert>}
      <button type="submit" disabled={busy}>{busy ? a.saving : a.register}</button>
    </form>
  );
}

function InvitationForm({
  a,
  locale,
  hours,
  production,
  organizations,
  onDone,
}: {
  a: AdminMessages;
  locale: Locale;
  hours: number;
  production: boolean;
  organizations: { items: OrganizationOption[]; truncated: boolean };
  onDone: () => void;
}) {
  const api = useApi(locale);
  const [access, setAccess] = useState<AccessValue>(blankAccess);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<{ url: string | null; replayed: boolean } | null>(null);
  const [copy, setCopy] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const resultHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (issued) resultHeading.current?.focus();
  }, [issued]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError("");
    setIssued(null);
    setCopy("");
    try {
      const result = await api<{ url: string | null; replayed: boolean }>("staff/invitations", {
        method: "POST",
        idempotencyKey: key,
        body: {
          email: String(f.get("email") ?? "").trim(),
          locale: String(f.get("locale") ?? "ar"),
          expiresInHours: Number(f.get("expiresInHours")),
          ...access,
        },
      });
      setIssued(result);
      form.reset();
      setAccess(blankAccess());
      setKey(crypto.randomUUID());
      onDone();
    } catch (e) {
      setError(refusal(e, a, messages(locale).unavailable));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel stack" onSubmit={submit} aria-labelledby="invite-heading">
      <h3 id="invite-heading">{a.newInvitation}</h3>
      <Alert tone={production ? "danger" : "warning"} role="note">{a.invitationsDevOnly}</Alert>
      {issued && (
        <div className="stack stack-tight">
          <h4 ref={resultHeading} tabIndex={-1}>{issued.url ? a.linkOnceTitle : a.replayedTitle}</h4>
          {issued.url ? (
            <>
              <p>{a.linkOnceBody}</p>
              <label htmlFor="invite-link" className="visually-hidden">{a.linkOnceTitle}</label>
              <input
                id="invite-link"
                className="once-value"
                readOnly
                value={issued.url}
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="row">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(issued.url!);
                      setCopy(a.copied);
                    } catch {
                      setCopy(a.copyFailed);
                    }
                  }}
                >
                  {a.copyLink}
                </button>
                <span role="status" aria-live="polite">{copy}</span>
              </div>
            </>
          ) : (
            <Alert tone="warning" role="note">{a.replayedBody}</Alert>
          )}
        </div>
      )}
      <div className="form-grid">
        <label htmlFor="inv-email">
          {a.email} *
          <input id="inv-email" name="email" type="email" dir="ltr" autoComplete="off" required maxLength={320} />
        </label>
        <label htmlFor="inv-locale">
          {a.invitationLocale}
          <select id="inv-locale" name="locale" defaultValue="ar">
            <option value="ar" lang="ar">العربية</option>
            <option value="en" lang="en">English</option>
          </select>
        </label>
        <label htmlFor="inv-hours">
          {a.expiresInHours}
          <input id="inv-hours" name="expiresInHours" type="number" min={1} max={168} step={1} required defaultValue={hours} />
        </label>
      </div>
      <AccessFields
        a={a}
        locale={locale}
        idPrefix="inv"
        value={access}
        onChange={setAccess}
        organizations={organizations.items}
        organizationsTruncated={organizations.truncated}
      />
      {error && <Alert tone="danger" role="alert">{error}</Alert>}
      <button type="submit" disabled={busy}>{busy ? a.saving : a.issue}</button>
    </form>
  );
}

export function StaffRecordView({ profile, id }: { profile: Profile; id: string }) {
  const locale = profile.locale;
  const a = adminMessages(locale);
  const m = messages(locale);
  const api = useApi(locale);
  const hydrated = useHydrated();
  const organizations = useOrganizations(locale);
  const [record, setRecord] = useState<StaffRecord | null>(null);
  const [access, setAccess] = useState<AccessValue>(blankAccess);
  const [loadError, setLoadError] = useState<{ text: string; missing: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await api<StaffRecord>(`staff/${id}`);
      setRecord(r);
      setAccess({ role: r.role, capabilities: r.capabilities, organizationIds: r.organizationIds });
      setConflict(false);
    } catch (e) {
      setLoadError({
        text: errorText(e, m.unavailable),
        missing: e instanceof ApiError && e.status === 404,
      });
    }
  }, [api, id, m.unavailable]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!hydrated || (!record && !loadError)) return <LoadingState label={a.loading} />;
  if (loadError || !record)
    return (
      <>
        <p><a href="/staff">{a.back}</a></p>
        <h1 className="page-title">{loadError?.missing ? a.staffNotFound : m.errorTitle}</h1>
        <ErrorState title={loadError?.missing ? a.staffNotFound : m.errorTitle} body={loadError?.text} />
      </>
    );

  const lastAdmin =
    record.role === "SUPER_ADMIN" && record.status === "ACTIVE" && record.otherActiveSuperAdmins === 0;

  async function save(body: AccessValue & { status: "ACTIVE" | "DISABLED" }, done: string) {
    if (!record) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api(`staff/${record.id}`, { method: "PATCH", revision: record.revision, body });
      setNote(done);
      await load();
    } catch (e) {
      setConflict(e instanceof ApiError && e.code === "REVISION_CONFLICT");
      setError(refusal(e, a, m.unavailable));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p><a href="/staff">{a.back}</a></p>
      <PageHeader
        title={record.displayName}
        sub={<bdi dir="ltr">{record.email}</bdi>}
        meta={
          <div className="row">
            <Badge tone={roleTone(record.role)}>{a[record.role]}</Badge>
            <Badge tone={statusTone(record.status)}>{a[record.status]}</Badge>
            <Badge>{a[record.authMethod]}</Badge>
          </div>
        }
      />
      {error && (
        <Alert tone="danger" role="alert">
          {error}{" "}
          {conflict && (
            <button type="button" className="button-small button-secondary" onClick={() => void load()}>
              {a.reload}
            </button>
          )}
        </Alert>
      )}
      {note && <Alert tone="success">{note}</Alert>}

      <section className="card stack" aria-labelledby="identity-heading">
        <h2 id="identity-heading">{a.identity}</h2>
        <dl className="facts">
          <dt>{a.authMethod}</dt>
          <dd>{a[record.authMethod]}</dd>
          {record.issuer && (
            <>
              <dt>{a.issuer}</dt>
              <dd><bdi dir="ltr">{record.issuer}</bdi></dd>
              <dt>{a.subject}</dt>
              <dd><bdi dir="ltr">{record.subject}</bdi></dd>
            </>
          )}
          <dt>{a.createdAt}</dt>
          <dd><Num>{utc(record.createdAt, locale)}</Num> {record.createdByName ? `· ${record.createdByName}` : ""}</dd>
          <dt>{a.updatedAt}</dt>
          <dd><Num>{utc(record.updatedAt, locale)}</Num> {record.updatedByName ? `· ${record.updatedByName}` : ""}</dd>
          <dt>{a.lastSeen}</dt>
          <dd>{record.lastSeenAt ? <Num>{utc(record.lastSeenAt, locale)}</Num> : a.never}</dd>
          <dt>{a.revision}</dt>
          <dd><Num>{record.revision}</Num></dd>
        </dl>
        <p className="field-hint">{a.timesUtc}</p>
        <p><a href={`/audit?targetId=${record.id}`}>{a.viewAudit}</a></p>
      </section>

      <form
        className="panel stack"
        aria-labelledby="access-heading"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ ...access, status: record.status }, a.accessSaved);
        }}
      >
        <h2 id="access-heading">{a.accessTitle}</h2>
        <Alert tone="warning" role="note">{record.isSelf ? a.accessSelf : a.accessSignsOut}</Alert>
        {lastAdmin && <Alert tone="info" role="note">{a.lastAdmin}</Alert>}
        <AccessFields
          a={a}
          locale={locale}
          idPrefix="edit"
          value={access}
          onChange={setAccess}
          organizations={organizations.items}
          organizationsTruncated={organizations.truncated}
          roleLocked={lastAdmin}
        />
        <button type="submit" disabled={busy}>{busy ? a.saving : a.saveAccess}</button>
      </form>

      <section className="card stack" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">{a.sessionsTitle}</h2>
        <p>
          {a.activeSessions}: <Num>{record.activeSessions}</Num>
        </p>
        <ConfirmAction
          a={a}
          label={a.revokeSessions}
          confirmLabel={a.revokeSessionsConfirm}
          body={a.revokeSessionsBody}
          disabled={busy}
          onConfirm={async () => {
            setBusy(true);
            setError("");
            setNote("");
            try {
              await api(`staff/${record.id}/revoke-sessions`, { method: "POST" });
              setNote(a.sessionsRevoked);
              await load();
            } catch (e) {
              setError(refusal(e, a, m.unavailable));
            } finally {
              setBusy(false);
            }
          }}
        />
        {record.status === "ACTIVE" ? (
          !lastAdmin && (
            <ConfirmAction
              a={a}
              label={a.disableAccount}
              confirmLabel={a.disableConfirm}
              body={a.disableBody}
              disabled={busy}
              onConfirm={() =>
                save(
                  {
                    role: record.role,
                    capabilities: record.capabilities,
                    organizationIds: record.organizationIds,
                    status: "DISABLED",
                  },
                  a.saved,
                )
              }
            />
          )
        ) : (
          <button
            type="button"
            className="button-secondary"
            disabled={busy}
            onClick={() =>
              void save(
                {
                  role: record.role,
                  capabilities: record.capabilities,
                  organizationIds: record.organizationIds,
                  status: "ACTIVE",
                },
                a.saved,
              )
            }
          >
            {a.enableAccount}
          </button>
        )}
      </section>
    </>
  );
}
