"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ChangeProblem, RequestProblem, silent, useStaffApi, type ChangeFailure } from "../request-ui";
import type { Profile } from "../../../../src/db";
import type { DirectoryRecord } from "../../../../src/directory";
import type {
  EmployeeMessage,
  MessageLinkStatus,
  MessagePage,
} from "../../../../src/employee-messages";
import { messages, type Locale } from "../../../../src/i18n";
import { inboxMessages } from "../../../../src/inbox-i18n";
import { formatUtc } from "../../../../src/zoned-time";
import { Workspace, organizationName } from "../shell";
import { Alert, EmptyState, Label, LoadingState, Micro, PageHeader } from "../../../../src/ui";

// The employee-message inbox (migration 025).
//
// Read-only. A message is shown with the day it was received and a department,
// because that is all it carries; there is no sender to show, no time of day
// to sort by, and no control that could relate it to a survey answer. There is
// no reply. The link panel is for a Super Admin: everyone else who can read
// messages sees whether a link is active and nothing they cannot act on.

type Department = { id: string; nameAr: string; nameEn: string | null };
const subscribe = () => () => {};
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "");

export function Inbox({
  profile,
  organization,
  path,
}: {
  profile: Profile;
  organization: DirectoryRecord | null;
  path: string[];
}) {
  const locale = profile.locale as Locale;
  const m = inboxMessages(locale),
    base = messages(locale);
  const org = path[0];
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const client = useStaffApi(locale);
  const [items, setItems] = useState<EmployeeMessage[]>([]);
  const [next, setNext] = useState<[string, string] | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [department, setDepartment] = useState("");
  const [link, setLink] = useState<MessageLinkStatus | null>(null);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [linkNote, setLinkNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [busy, setBusy] = useState(true);
  const [loadProblem, setLoadProblem] = useState<unknown>(null);
  const [problem, setProblem] = useState<ChangeFailure | null>(null);

  const root = `/api/v1/organizations/${org}/messages`;
  const name = (value: { nameAr: string | null; nameEn: string | null }) =>
    (locale === "en" && value.nameEn ? value.nameEn : value.nameAr) ?? "";

  const load = useCallback(
    async (after: [string, string] | null = null) => {
      setBusy(true);
      setLoadProblem(null);
      try {
        const query = new URLSearchParams();
        if (department) query.set("department", department);
        if (after) {
          query.set("after", after[0]);
          query.set("afterId", after[1]);
        }
        const suffix = query.toString() ? `?${query}` : "";
        const [page, depts, status] = await Promise.all([
          client.read<MessagePage>(`${root}${suffix}`),
          after ? Promise.resolve(null) : client.read<Department[]>(`${root}/departments`),
          after ? Promise.resolve(null) : client.read<MessageLinkStatus>(`${root}/link`),
        ]);
        setItems((current) => (after ? [...current, ...page.items] : page.items));
        setNext(page.next);
        if (depts) setDepartments(depts);
        if (status) setLink(status);
      } catch (e) {
        if (!silent(e)) setLoadProblem(e);
      } finally {
        setBusy(false);
      }
    },
    [client, root, department],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const refreshLink = async () => setLink(await client.read<MessageLinkStatus>(`${root}/link`));

  const issue = async () => {
    const scope = "message-link-issue";
    setBusy(true);
    setProblem(null);
    setIssuedUrl(null);
    setLinkNote("");
    setCopied(false);
    try {
      const result = await client.mutate<{ replayed: boolean; url: string | null }>(scope, `${root}/link`, {
        method: "POST",
      });
      if (result.url) setIssuedUrl(result.url);
      else setLinkNote(m.linkReplayed);
      await refreshLink();
    } catch (e) {
      if (!silent(e)) setProblem({ failure: e, scope, retry: () => void issue() });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    const scope = "message-link-revoke";
    setBusy(true);
    setProblem(null);
    setIssuedUrl(null);
    setConfirmRevoke(false);
    try {
      await client.mutate(scope, `${root}/link`, { method: "DELETE" });
      setLinkNote(m.linkRevoked);
      await refreshLink();
    } catch (e) {
      if (!silent(e)) setProblem({ failure: e, scope, retry: () => void revoke() });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!issuedUrl) return;
    try {
      await navigator.clipboard.writeText(issuedUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <Workspace
      locale={locale}
      organization={organization}
      section="messages"
      canManage={profile.role === "SUPER_ADMIN" || profile.capabilities.includes("directory.manage")}
      canReadMessages={profile.role === "SUPER_ADMIN" || profile.capabilities.includes("messages.read")}
    >
      {children}
    </Workspace>
  );
  if (!hydrated) return shell(<LoadingState label={m.loading} />);

  const departmentOf = (item: EmployeeMessage) =>
    item.departmentId
      ? name({ nameAr: item.departmentNameAr, nameEn: item.departmentNameEn })
      : `${m.otherLabel}: ${item.otherDepartment ?? ""}`;

  return shell(
    <>
      <PageHeader
        eyebrow={<Label accent>{organizationName(organization, locale)}</Label>}
        title={m.title}
        sub={m.lead}
      />
      <div className="note" role="note">
        <p>{m.scope}</p>
      </div>
      <RequestProblem
        locale={locale}
        failure={loadProblem}
        busy={busy}
        testId="messages-load-problem"
        onRetryRead={() => void load()}
      />

      {link && (
        <section className="card stack" aria-labelledby="message-link-title">
          <div className="card-head">
            <h2 id="message-link-title">{m.linkTitle}</h2>
          </div>
          {!link.organizationActive ? (
            <p>{m.linkArchived}</p>
          ) : link.active ? (
            <>
              <p>{m.linkActive}</p>
              {link.issuedAt && (
                <p className="muted">
                  {fill(m.linkIssued, { time: formatUtc(link.issuedAt), name: link.issuedByName ?? "—" })}
                </p>
              )}
            </>
          ) : (
            <p>{m.linkNone}</p>
          )}
          <ChangeProblem
            locale={locale}
            problem={problem}
            ledger={client.ledger}
            busy={busy}
            onCheck={() => void load()}
            onDismiss={() => setProblem(null)}
            testId="message-link-problem"
          />
          {issuedUrl && (
            <div className="stack">
              <Alert tone="warning" role="status">
                {m.linkShownOnce}
              </Alert>
              <code className="resume-code" dir="ltr" translate="no" data-testid="message-link-url">
                {issuedUrl}
              </code>
              <div className="row">
                <button type="button" onClick={() => void copy()}>
                  {copied ? m.copied : m.copy}
                </button>
              </div>
            </div>
          )}
          {linkNote && (
            <Alert tone="info" role="status">
              {linkNote}
            </Alert>
          )}
          {link.canManage && link.organizationActive ? (
            <>
              {link.active && <p className="muted">{m.linkRotateNote}</p>}
              <div className="row">
                <button type="button" onClick={() => void issue()} disabled={busy}>
                  {link.active ? m.linkRotate : m.linkIssue}
                </button>
                {link.active && (
                  <button
                    type="button"
                    className="button-danger"
                    onClick={() => setConfirmRevoke(true)}
                    disabled={busy}
                  >
                    {m.linkRevoke}
                  </button>
                )}
              </div>
              {confirmRevoke && (
                <div className="stack">
                  <Alert tone="warning" role="alert">
                    {m.linkRevokeNote}
                  </Alert>
                  <div className="row">
                    <button type="button" className="button-danger" onClick={() => void revoke()} disabled={busy}>
                      {m.linkRevokeConfirm}
                    </button>
                    <button type="button" className="button-secondary" onClick={() => setConfirmRevoke(false)}>
                      {m.cancel}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            !link.canManage && <p className="muted">{m.linkReadOnly}</p>
          )}
        </section>
      )}

      <section className="card stack">
        <div className="card-head">
          <h2>{m.title}</h2>
          <Micro>
            {items.length} {m.countLabel}
          </Micro>
        </div>
        <div className="row">
          <label>
            {m.filterDepartment}
            <select value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">{m.filterAll}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {name(d)}
                </option>
              ))}
              <option value="OTHER">{m.filterOther}</option>
            </select>
          </label>
        </div>
        <p role="status" aria-live="polite">
          {busy ? m.loading : ""}
        </p>
        {!items.length && !busy && !loadProblem && (
          <EmptyState title={base.emptyTitle} body={department ? m.noneFiltered : m.none} />
        )}
        {items.length > 0 && (
          <dl className="result-facts review-answers" data-testid="employee-messages">
            {items.map((item) => (
              <div key={item.id}>
                <dt>
                  <bdi>{departmentOf(item)}</bdi> · {m.received}{" "}
                  <span className="num" dir="ltr">
                    {item.receivedOn}
                  </span>
                </dt>
                <dd>
                  <bdi>{item.body}</bdi>
                </dd>
              </div>
            ))}
          </dl>
        )}
        {next && (
          <div className="row">
            <button type="button" className="button-secondary" onClick={() => void load(next)} disabled={busy}>
              {m.loadMore}
            </button>
          </div>
        )}
      </section>
    </>,
  );
}
