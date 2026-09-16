/* Full document navigation intentionally clears organization-scoped client state. */
"use client";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import {
  AttemptLedger,
  RequestFailure,
  sendAttempt,
  staffRequest,
  type Method,
} from "../staff-request";
import {
  ChangeProblem,
  redirectIfClean,
  silent,
  useLedger,
  type ChangeFailure,
} from "../request-ui";
import { useFormDirty, useUnsavedChanges, type SaveOutcome } from "../unsaved";
import type { Profile } from "../../../../src/db";
import type { DirectoryRecord } from "../../../../src/directory";
import { directoryMessages } from "../../../../src/directory-i18n";
import { messages, type Locale } from "../../../../src/i18n";
import {
  importFields,
  type DirectoryKind,
} from "../../../../src/directory-input";
import { AccountControls } from "../ui";
import { Frame, Workspace, organizationName, type Section } from "../shell";
import {
  Badge,
  DeniedState,
  EmptyState,
  Label,
  LoadingState,
  PageHeader,
  Tile,
} from "../../../../src/ui";
type M = ReturnType<typeof directoryMessages>;
const subscribe = () => () => {};
// Every directory request is bounded (Post-Audit Repair Pass 2). A change is
// sent through the caller's AttemptLedger under a named scope, so a retry
// after a lost answer carries the same idempotency key and body. A refusal
// keeps its kind and uncertainty; only its wording is made specific here.
async function api(
  path: string,
  locale: Locale,
  method: Method = "GET",
  body?: unknown,
  revision?: string,
  change?: { ledger: AttemptLedger; scope: string; replace?: boolean; retry?: boolean },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const url = "/api/v1/" + path;
  try {
    if (method === "GET") return (await staffRequest(locale, url)).data;
    if (!change) throw new Error("A directory change needs a ledger scope.");
    const pending = change.retry ? change.ledger.uncertain(change.scope) : null;
    const attempt =
      pending?.attempt ??
      change.ledger.prepare(locale, change.scope, { url, method, body, revision }, change.replace);
    return (await sendAttempt(locale, change.ledger, attempt)).data;
  } catch (e) {
    redirectIfClean(e);
    if (!(e instanceof RequestFailure)) throw e;
    const m = directoryMessages(locale);
    const specific =
      e.code === "DEPARTMENT_CYCLE"
        ? m.cycle
        : e.code === "DEPARTMENT_IN_USE"
          ? m.inUse
          : e.code === "IMPORT_EXPIRED"
            ? m.expired
            : e.code === "IMPORT_CHANGED"
              ? m.reviewAgain
              : null;
    if (!specific) throw e;
    throw Object.assign(
      new RequestFailure(specific, e.kind, { status: e.status, code: e.code, uncertain: e.uncertain, body: e.body }),
      { attempt: e.attempt },
    );
  }
}
const failureMessage = (e: unknown, locale: Locale) =>
  e instanceof Error && e.message ? e.message : messages(locale).unavailable;
export function Directory({
  path,
  profile,
  organization,
}: {
  path: string[];
  profile: Profile;
  organization: DirectoryRecord | null;
}) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const locale = profile.locale,
    m = directoryMessages(locale),
    org = path[0],
    section = path[1] ?? "overview";
  const manage =
    profile.role === "SUPER_ADMIN" ||
    profile.capabilities.includes("directory.manage");
  const base = `organizations/${org}`;
  const sectionKey = (
    ["overview", "settings", "departments", "participants"].includes(section)
      ? section
      : "overview"
  ) as Section;
  // One body expression, wrapped by the shell that fits the route: the
  // authorized-organization list has no organization to hang a rail on, and
  // every organization-scoped section does.
  const body = !hydrated ? (
    <LoadingState label={m.loading} />
  ) : (
    <>
        {!org ? (
          <Records
            key="organizations"
            locale={locale}
            kind="organization"
            endpoint="organizations"
            canManage={profile.role === "SUPER_ADMIN"}
          />
        ) : section === "overview" ? (
          <section className="stack">
            <div className="tiles">
              <Tile label={m.timezone} value={String(organization?.timezone ?? "—")} />
              <Tile
                label={m.industry}
                value={String(organization?.industry ?? m.none)}
              />
              <Tile
                label={m.status}
                value={organization?.status === "ARCHIVED" ? m.archived : m.active}
                accent={organization?.status === "ARCHIVED"}
              />
            </div>
            <div className="card">
              <div className="card-head">
                <h2>{m.details}</h2>
              </div>
              <p>{m.workspaceHelp}</p>
              {manage && (
                <div className="row">
                  <a className="button" href={`/${base}/participants`}>
                    {m.participants}
                  </a>
                  <a className="button button-secondary" href={`/${base}/departments`}>
                    {m.departments}
                  </a>
                </div>
              )}
            </div>
          </section>
        ) : section === "settings" ? (
          manage ? (
            <Records
              locale={locale}
              kind="organization"
              endpoint="organizations"
              org={org}
              detailId={org}
              canManage={organization?.status === "ACTIVE"}
              canArchive={profile.role === "SUPER_ADMIN"}
            />
          ) : (
            <DeniedState
              title={messages(locale).deniedTitle}
              body={messages(locale).forbidden}
            />
          )
        ) : path[2] === "import" ? (
          <ImportPanel locale={locale} org={org} />
        ) : (
          <Records
            key={path.join("/")}
            locale={locale}
            kind={section === "departments" ? "department" : "participant"}
            endpoint={`${base}/${section}`}
            org={org}
            detailId={path[2]}
            canManage={organization?.status === "ACTIVE"}
          />
        )}
      <details className="card">
        <summary>{messages(locale).account}</summary>
        <div className="spaced">
          <AccountControls locale={locale} />
        </div>
      </details>
    </>
  );
  if (!org)
    return (
      <Frame locale={locale} context={m.organizations}>
        <PageHeader
          eyebrow={<Label accent>{messages(locale).home}</Label>}
          title={m.organizations}
          sub={messages(locale).scope}
        />
        {body}
      </Frame>
    );
  return (
    <Workspace
      locale={locale}
      organization={organization}
      section={sectionKey}
      canManage={manage}
      canReadMessages={
        profile.role === "SUPER_ADMIN" ||
        profile.capabilities.includes("messages.read")
      }
    >
      <PageHeader
        eyebrow={<Label accent>{m[sectionKey as "overview"]}</Label>}
        title={organizationName(organization, locale) || m.organizations}
        sub={organization?.status === "ARCHIVED" ? m.archived : m.workspaceHelp}
        actions={
          organization?.status === "ARCHIVED" ? (
            <Badge tone="caution">{m.archived}</Badge>
          ) : undefined
        }
      />
      {body}
    </Workspace>
  );
}
function Records({
  locale,
  kind,
  endpoint,
  org,
  detailId,
  canManage,
  canArchive = true,
}: {
  locale: Locale;
  kind: DirectoryKind;
  endpoint: string;
  org?: string;
  detailId?: string;
  canManage: boolean;
  canArchive?: boolean;
}) {
  const m = directoryMessages(locale),
    [items, setItems] = useState<DirectoryRecord[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [q, setQ] = useState(""),
    [status, setStatus] = useState("ACTIVE"),
    [department, setDepartment] = useState(""),
    [editor, setEditor] = useState<DirectoryRecord | "new" | null>(null),
    [archive, setArchive] = useState<DirectoryRecord | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true),
    [notice, setNotice] = useState(""),
    [archiveProblem, setArchiveProblem] = useState<ChangeFailure | null>(null);
  const ledger = useLedger();
  const [archiveReason, setArchiveReason] = useState("");
  // A typed archive reason is kept or discarded, never archived from the
  // leave dialog: archiving is not a save.
  useUnsavedChanges(!!archive && archiveReason.trim() !== "");
  async function load(next?: string) {
    setBusy(true);
    setError("");
    try {
      if (detailId) {
        setItems([await api(`${endpoint}/${detailId}`, locale)]);
      } else {
        const params = new URLSearchParams({
          q,
          status,
          ...(department ? { departmentId: department } : {}),
          ...(next ? { cursor: next } : {}),
        });
        const data = await api(endpoint + "?" + params, locale);
        setItems(data.items);
        setCursor(data.nextCursor);
      }
    } catch (e) {
      if (!silent(e)) setError(failureMessage(e, locale));
    } finally {
      setBusy(false);
    }
  }
  async function archiveRecord(target: DirectoryRecord, reason: unknown, again = false) {
    const scope = `archive:${target.id}`;
    setBusy(true);
    setError("");
    setArchiveProblem(null);
    try {
      await api(
        `${endpoint}/${target.id}/archive`,
        locale,
        "POST",
        { reason },
        String(target.revision),
        { ledger, scope, replace: true, retry: again },
      );
      await saved();
    } catch (e) {
      if (!silent(e))
        setArchiveProblem({ failure: e, scope, retry: () => void archiveRecord(target, reason, true) });
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let alive = true;
    api(detailId ? `${endpoint}/${detailId}` : endpoint, locale)
      .then((data) => {
        if (alive) {
          setItems(detailId ? [data] : data.items);
          setCursor(detailId ? null : data.nextCursor);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [endpoint, detailId, locale]);
  async function saved() {
    setEditor(null);
    setArchive(null);
    setNotice(m.saved);
    await load();
  }
  return (
    <section className="card stack">
      <div className="card-head">
        <h2>
          {kind === "organization"
            ? m.details
            : kind === "department"
              ? m.departments
              : m.participants}
        </h2>
        <div className="row">
          {kind === "participant" && !detailId && canManage && (
            <a
              className="button button-secondary button-small"
              href={`/organizations/${org}/participants/import`}
            >
              {m.import}
            </a>
          )}
          {canManage && !detailId && !editor && (
            <button
              className="button-small"
              onClick={() => {
                setEditor("new");
                setNotice("");
              }}
            >
              {m.new}
            </button>
          )}
        </div>
      </div>
      {!detailId && (
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <label>
            {m.search}
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              maxLength={100}
            />
          </label>
          <label>
            {m.status}
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="ACTIVE">{m.active}</option>
              <option value="ARCHIVED">{m.archived}</option>
              <option value="ALL">{m.all}</option>
            </select>
          </label>
          {kind === "participant" && (
            <Relation
              locale={locale}
              org={org!}
              name="filterDepartment"
              label={m.department}
              value={department}
              onChange={setDepartment}
            />
          )}
          <button className="button-secondary" disabled={busy}>
            {m.apply}
          </button>
        </form>
      )}
      <p role="status" aria-live="polite">
        {busy ? m.loading : notice}
      </p>
      {error && <p role="alert">{error}</p>}
      {editor && (
        <Editor
          key={editor === "new" ? "new" : editor.id}
          locale={locale}
          kind={kind}
          endpoint={endpoint}
          org={org}
          record={editor === "new" ? null : editor}
          onSaved={saved}
          onCancel={() => setEditor(null)}
        />
      )}
      {archive && (
        <form
          className="panel stack"
          onSubmit={(e) => {
            e.preventDefault();
            void archiveRecord(archive, archiveReason);
          }}
        >
          <h3>{m.archive}</h3>
          <p>{m.archiveHelp}</p>
          <ChangeProblem
            locale={locale}
            problem={archiveProblem}
            ledger={ledger}
            busy={busy}
            onCheck={() => void load()}
            onDismiss={() => setArchiveProblem(null)}
          />
          <label>
            {m.reason} *<input name="reason" required maxLength={500} value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)} />
          </label>
          <div className="row">
            <button disabled={busy}>{m.archive}</button>
            <button type="button" onClick={() => setArchive(null)}>
              {m.cancel}
            </button>
          </div>
        </form>
      )}
      {busy && !items.length && !error && <LoadingState label={m.loading} />}
      {/* An empty result and a failed request are different facts and get
          different shapes; neither is allowed to look like the other. */}
      {!busy && !items.length && !error && (
        <EmptyState title={messages(locale).emptyTitle} body={m.empty} />
      )}
      <ul className="directory-list">
        {items.map((item) => (
          <li key={item.id}>
            <div className="stack">
              <strong dir="auto">
                {kind === "participant"
                  ? item.display_name
                  : locale === "en" && item.name_en
                    ? item.name_en
                    : item.name_ar}
              </strong>
              <bdi>{item.private_reference ?? item.code}</bdi>
              <span>{item.status === "ACTIVE" ? m.active : m.archived}</span>
              {detailId && (
                <>
                  <dl>
                    {Object.entries(item)
                      .filter(
                        ([key, value]) =>
                          value !== null &&
                          [
                            "position",
                            "job_level",
                            "gender",
                            "age_group",
                            "years_of_service",
                            "department_id",
                            "industry",
                            "timezone",
                            "notes",
                          ].includes(key),
                      )
                      .map(([key, value]) => (
                        <div key={key}>
                          <dt>{m[camel(key) as keyof M] ?? key}</dt>
                          <dd dir="auto">
                            {key === "department_id"
                              ? String(
                                  locale === "en" && item.related_name_en
                                    ? item.related_name_en
                                    : (item.related_name_ar ?? m.none),
                                )
                              : String(value)}
                          </dd>
                        </div>
                      ))}
                  </dl>
                  {item.contact && typeof item.contact === "object" ? (
                    <dl>
                      {Object.entries(item.contact)
                        .filter(([key]) => key !== "schemaVersion")
                        .map(([key, value]) => (
                          <div key={key}>
                            <dt>{m[key as keyof M]}</dt>
                            <dd>
                              <bdi>{String(value)}</bdi>
                            </dd>
                          </div>
                        ))}
                    </dl>
                  ) : null}
                  {kind === "participant" && (
                    <>
                      <p>{m.privacy}</p>
                      <p className="muted">{m.invitation}</p>
                    </>
                  )}
                </>
              )}
            </div>
            <div className="row">
              {!detailId && (
                <a
                  href={
                    kind === "organization"
                      ? `/organizations/${item.id}/overview`
                      : kind === "participant"
                        ? `/organizations/${org}/participants/${item.id}`
                        : "#editor"
                  }
                  onClick={
                    kind === "department"
                      ? (e) => {
                          e.preventDefault();
                          setEditor(item);
                        }
                      : undefined
                  }
                >
                  {m.details}
                </a>
              )}
              {canManage && item.status === "ACTIVE" && (
                <>
                  <button
                    onClick={() => {
                      setEditor(item);
                      setArchive(null);
                    }}
                  >
                    {m.edit}
                  </button>
                  {canArchive && (
                    <button
                      onClick={() => {
                        setArchive(item);
                        setArchiveReason("");
                        setEditor(null);
                      }}
                    >
                      {m.archive}
                    </button>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!detailId && cursor && (
        <button disabled={busy} onClick={() => load(cursor)}>
          {m.next}
        </button>
      )}
    </section>
  );
}
const camel = (s: string) =>
  s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
function Relation({
  locale,
  org,
  name,
  label,
  value,
  onChange,
}: {
  locale: Locale;
  org: string;
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [selectedName, setSelectedName] = useState("");
  useEffect(() => {
    if (!value) return;
    let active = true;
    api(`organizations/${org}/departments/${value}`, locale)
      .then((data) => {
        if (active)
          setSelectedName(
            locale === "en" && data.name_en ? data.name_en : data.name_ar,
          );
      })
      .catch(() => {
        if (active) setSelectedName(directoryMessages(locale).none);
      });
    return () => {
      active = false;
    };
  }, [org, value, locale]);
  const m = directoryMessages(locale),
    [options, setOptions] = useState<DirectoryRecord[]>([]),
    [search, setSearch] = useState(""),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState("");
  async function find(next?: string) {
    try {
      const data = await api(
        `organizations/${org}/departments?` +
          new URLSearchParams({ q: search, ...(next ? { cursor: next } : {}) }),
        locale,
      );
      setOptions(data.items);
      setCursor(data.nextCursor);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    let active = true;
    api(`organizations/${org}/departments`, locale)
      .then((data) => {
        if (active) {
          setOptions(data.items);
          setCursor(data.nextCursor);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [org, locale]);
  return (
    <div className="stack relation">
      <label>
        {label}
        <select
          name={name}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{m.none}</option>
          {value && !options.some((o) => o.id === value) && (
            <option value={value}>{selectedName || m.loading}</option>
          )}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {locale === "en" && o.name_en ? o.name_en : o.name_ar} ({o.code})
            </option>
          ))}
        </select>
      </label>
      <details>
        <summary>{m.search}</summary>
        <label>
          {m.search}
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="button" onClick={() => find()}>
          {m.apply}
        </button>
        {cursor && (
          <button type="button" onClick={() => find(cursor)}>
            {m.next}
          </button>
        )}
      </details>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function Editor({
  locale,
  kind,
  endpoint,
  org,
  record,
  onSaved,
  onCancel,
}: {
  locale: Locale;
  kind: DirectoryKind;
  endpoint: string;
  org?: string;
  record: DirectoryRecord | null;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const m = directoryMessages(locale),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [relation, setRelation] = useState(
      String(
        record?.[
          kind === "department" ? "parent_department_id" : "department_id"
        ] ?? "",
      ),
    );
  const fields =
    kind === "organization"
      ? [
          "code",
          "nameAr",
          "nameEn",
          "industry",
          "timezone",
          "notes",
          "contactName",
          "email",
          "phone",
        ]
      : kind === "department"
        ? ["code", "nameAr", "nameEn"]
        : [
            "privateReference",
            "displayName",
            "position",
            "jobLevel",
            "gender",
            "ageGroup",
            "yearsOfService",
            "email",
            "phone",
          ];
  const values: Record<string, unknown> = Object.fromEntries(
    Object.entries(record ?? {}).map(([k, v]) => [camel(k), v]),
  );
  Object.assign(values, record?.contact ?? {});
  const { dirty, form: formRef, bind } = useFormDirty(relation);
  const ledger = useLedger();
  const [problem, setProblem] = useState<ChangeFailure | null>(null);
  // One scope per record (or per new record). An edit carries the revision it
  // started from and may replace an unconfirmed attempt; a create may not,
  // because a new key could create a second record if the first one landed.
  const scope = `directory-save:${kind}:${record?.id ?? "new"}`;
  // Dirty is released only by a confirmed save (the editor then closes) or an
  // explicit Cancel; the leave dialog saves through this same path.
  useUnsavedChanges(dirty, () => send());
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await send();
  }
  async function send(again = false): Promise<SaveOutcome> {
    const el = formRef.current;
    if (!el) return { ok: false };
    if (!again && !el.reportValidity()) return { ok: false };
    setBusy(true);
    setError("");
    setProblem(null);
    const f = new FormData(el),
      body: Record<string, unknown> = {},
      contact: Record<string, unknown> = { schemaVersion: 1 };
    for (const field of fields) {
      const v = String(f.get(field) ?? "").trim();
      if (["email", "phone", "contactName"].includes(field)) {
        if (v) contact[field] = v;
      } else body[field] = v || null;
    }
    if (kind !== "department") body.contact = contact;
    if (kind !== "organization")
      body[kind === "department" ? "parentDepartmentId" : "departmentId"] =
        relation || null;
    try {
      await api(
        record ? `${endpoint}/${record.id}` : endpoint,
        locale,
        record ? "PATCH" : "POST",
        body,
        record ? String(record.revision) : undefined,
        { ledger, scope, replace: !!record, retry: again },
      );
      await onSaved();
      return { ok: true };
    } catch (e) {
      if (!silent(e)) {
        if (e instanceof RequestFailure && (e.uncertain || e.kind === "SESSION"))
          setProblem({ failure: e, scope, retry: () => void send(true) });
        else setError(failureMessage(e, locale));
      }
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }
  return (
    <form id="editor" {...bind} className="panel stack" onSubmit={save}>
      <h3>{record ? m.edit : m.new}</h3>
      <p>{m.required}</p>
      <div className="form-grid">
        {fields.map((field) => {
          const required = [
            "code",
            "nameAr",
            "privateReference",
            "displayName",
            "timezone",
          ].includes(field);
          return (
            <label key={field}>
              {m[field as keyof M]}
              {required ? " *" : ""}
              <input
                name={field}
                defaultValue={String(
                  values[field] ?? (field === "timezone" ? "Asia/Riyadh" : ""),
                )}
                required={required}
                maxLength={
                  field === "notes"
                    ? 5000
                    : [
                          "code",
                          "privateReference",
                          "gender",
                          "ageGroup",
                        ].includes(field)
                      ? 80
                      : field === "phone"
                        ? 40
                        : 500
                }
                type={field === "email" ? "email" : "text"}
                dir={
                  [
                    "code",
                    "email",
                    "phone",
                    "privateReference",
                    "timezone",
                    "yearsOfService",
                  ].includes(field)
                    ? "ltr"
                    : field === "nameAr"
                      ? "rtl"
                      : field === "nameEn"
                        ? "ltr"
                        : "auto"
                }
                inputMode={field === "yearsOfService" ? "decimal" : undefined}
              />
            </label>
          );
        })}
        {kind !== "organization" && (
          <Relation
            locale={locale}
            org={org!}
            name="relation"
            label={
              kind === "department" ? m.parentDepartmentId : m.departmentId
            }
            value={relation}
            onChange={setRelation}
          />
        )}
      </div>
      {kind === "participant" && <p>{m.moveHelp}</p>}
      {kind !== "department" && <p>{m.contactHelp}</p>}
      {error && <p role="alert">{error}</p>}
      <ChangeProblem
        locale={locale}
        problem={problem}
        ledger={ledger}
        busy={busy}
        onDismiss={() => setProblem(null)}
        testId="directory-editor-problem"
      />
      <div className="row">
        <button disabled={busy}>{busy ? m.loading : m.save}</button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {m.cancel}
        </button>
      </div>
    </form>
  );
}
type Review = {
  id: string;
  revision: string;
  source_digest: string;
  state: string;
  mapping?: Record<string, string>;
  headers: string[];
  validation?: { validRows: number[]; errors: { row: number; code: string }[] };
  preview?: unknown[];
  committed_count?: number;
};
function ImportPanel({ locale, org }: { locale: Locale; org: string }) {
  const m = directoryMessages(locale),
    [record, setRecord] = useState<Review | null>(null),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [problem, setProblem] = useState<ChangeFailure | null>(null),
    [picked, setPicked] = useState(false),
    [mappingDirty, setMappingDirty] = useState(false);
  const ledger = useLedger();
  const endpoint = `organizations/${org}/imports`;
  // A chosen file not yet uploaded, or a mapping changed since the last
  // validation, is lost by a reload. Neither is saved from the leave dialog:
  // uploading and validating are steps the reader takes deliberately.
  useUnsavedChanges(picked || mappingDirty);
  const failed = (e: unknown, scope: string, retry: () => void) => {
    if (silent(e)) return;
    if (e instanceof RequestFailure && (e.uncertain || e.kind === "SESSION"))
      setProblem({ failure: e, scope, retry });
    else setError(failureMessage(e, locale));
  };
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("import");
    if (!id) return;
    let active = true;
    setBusy(true);
    api(`${endpoint}/${encodeURIComponent(id)}`, locale)
      .then((data: Review) => {
        if (active) {
          setRecord(data);
          setMapping(data.mapping ?? {});
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [endpoint, locale]);
  // The upload is a keyed create. Its body (the file, base64) is held in this
  // tab's memory only while its outcome is unconfirmed, so "send the same
  // request again" can replay it; it is never written to storage.
  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const file = new FormData(form).get("file") as File;
    if (!file || file.size > 1048576) {
      setError(m.fileHelp);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let raw = "";
    for (const byte of bytes) raw += String.fromCharCode(byte);
    await sendUpload({
      format: file.name.toLowerCase().endsWith(".xlsx") ? "XLSX" : "CSV",
      base64: btoa(raw),
    }, false, form);
  }
  async function sendUpload(body: unknown, again: boolean, form?: HTMLFormElement) {
    setBusy(true);
    setError("");
    setProblem(null);
    try {
      const data = await api(endpoint, locale, "POST", body, undefined, {
        ledger,
        scope: "import-upload",
        retry: again,
      });
      form?.reset();
      setPicked(false);
      setMappingDirty(false);
      setRecord(data);
      window.history.replaceState(null, "", `?import=${data.id}`);
      setConfirmed(false);
      setMapping(
        Object.fromEntries(
          data.headers
            .filter((h: string) => importFields.includes(h as never))
            .map((h: string) => [h, h]),
        ),
      );
    } catch (e) {
      failed(e, "import-upload", () => void sendUpload(body, true));
    } finally {
      setBusy(false);
    }
  }
  // Validate and commit carry the reviewed revision. A lost commit answer is
  // retried with the same key, and the server's commit receipt answers it
  // instead of committing the rows a second time.
  async function run(action: "validate" | "commit", again = false) {
    if (!record) return;
    const scope = `import-${action}`;
    setBusy(true);
    setError("");
    setProblem(null);
    try {
      const data = await api(
        `${endpoint}/${record.id}/${action}`,
        locale,
        "POST",
        action === "validate"
          ? { mapping }
          : {
              sourceDigest: record.source_digest,
              validationRevision: String(record.revision),
              confirmValidRows: true,
            },
        String(record.revision),
        { ledger, scope, replace: action === "validate", retry: again },
      );
      setRecord({ ...record, ...data });
      setConfirmed(false);
      if (action === "validate") setMappingDirty(false);
    } catch (e) {
      failed(e, scope, () => void run(action, true));
    } finally {
      setBusy(false);
    }
  }
  const check = async () => {
    if (!record) return;
    try {
      const data = await api(`${endpoint}/${encodeURIComponent(record.id)}`, locale);
      setRecord(data);
      setMapping(data.mapping ?? {});
    } catch (e) {
      if (!silent(e)) setError(failureMessage(e, locale));
    }
  };
  return (
    <section className="stack">
      <h2>{m.import}</h2>
      <p>{m.fileHelp}</p>
      <form className="panel stack" onSubmit={upload}>
        <label>
          {m.source}
          <input
            name="file"
            type="file"
            accept=".csv,.xlsx"
            required
            onChange={(e) => setPicked(!!e.target.files?.length)}
          />
        </label>
        <button disabled={busy}>{m.upload}</button>
      </form>
      <p>{m.duplicateHelp}</p>
      {error && <p role="alert">{error}</p>}
      <ChangeProblem
        locale={locale}
        problem={problem}
        ledger={ledger}
        busy={busy}
        onCheck={record ? () => void check() : undefined}
        onDismiss={() => setProblem(null)}
        testId="import-problem"
      />
      <p role="status">
        {busy
          ? m.loading
          : record?.state === "COMMITTED"
            ? `${m.committed}: ${record.committed_count}`
            : ""}
      </p>
      {record && record.state !== "COMMITTED" && (
        <>
          <h3>{m.mapping}</h3>
          <div className="form-grid">
            {record.headers.map((h) => (
              <label key={h}>
                <bdi>{h}</bdi>
                <select
                  value={mapping[h] ?? ""}
                  onChange={(e) => {
                    const next = { ...mapping };
                    if (e.target.value) next[h] = e.target.value;
                    else delete next[h];
                    setMapping(next);
                    setMappingDirty(true);
                    setRecord({
                      ...record,
                      state: "UPLOADED",
                      validation: undefined,
                      preview: undefined,
                    });
                    setConfirmed(false);
                  }}
                >
                  <option value="">{m.ignore}</option>
                  {importFields.map((f) => (
                    <option key={f} value={f}>
                      {m[f]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <button disabled={busy} onClick={() => run("validate")}>
            {m.validate}
          </button>
          {record.state === "VALIDATED" && record.validation && (
            <>
              <p>
                {m.valid}: {record.validation.validRows.length} · {m.errors}:{" "}
                {record.validation.errors.length}
              </p>
              <h3>{m.preview}</h3>
              <div className="preview" dir="auto">
                {record.preview?.map((row, index) => (
                  <div key={index}>
                    {Object.entries(
                      (row as { data?: Record<string, unknown> }).data ?? {},
                    )
                      .filter(([, v]) => typeof v === "string" && v)
                      .map(([key, v]) => (
                        <span key={key}>
                          <strong>{m[key as keyof M] ?? key}: </strong>
                          <bdi>{String(v)}</bdi>
                          {" · "}
                        </span>
                      ))}
                  </div>
                ))}
              </div>
              <a href={`/api/v1/${endpoint}/${record.id}/errors`}>
                {m.download}
              </a>
              <label className="row">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {m.confirm}
              </label>
              <button
                disabled={
                  busy || !confirmed || !record.validation.validRows.length
                }
                onClick={() => run("commit")}
              >
                {m.commit}
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
