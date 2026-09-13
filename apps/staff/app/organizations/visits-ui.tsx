/* Full document navigation intentionally clears organization-scoped state. */
"use client";
import { jsonOf, staffFetch } from "../staff-fetch";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Profile } from "../../../../src/db";
import type { DirectoryRecord } from "../../../../src/directory";
import { messages, type Locale } from "../../../../src/i18n";
import {
  visitMessages,
  type VisitMessageKey,
} from "../../../../src/visits-i18n";
import {
  allowedExtensions,
  ALLOWED_TYPES,
  previewableType,
  type AllowedType,
} from "../../../../src/attachment-types";
import { Workspace, organizationName } from "../shell";
import {
  Alert,
  Badge,
  EmptyState,
  ErrorState,
  Label,
  LoadingState,
  Micro,
  PageHeader,
} from "../../../../src/ui";
import {
  formatInZone,
  instantToWallClock,
  wallClockToInstant,
} from "../../../../src/zoned-time";

// The field-visit screens.
//
// A calendar and list, one visit with its notes, its follow-up actions and its
// attachments, and an internal overdue list. Nothing here renders a survey
// result, and there is no control that could ask for one.
//
// Two behaviours are deliberate rather than incidental. A completed visit's
// edit form demands an amendment reason and says why, so a correction is never
// mistaken for the original record. And an attachment shows its scan status as
// the first thing about it: a quarantined file offers no download link, because
// it has no download.

type M = ReturnType<typeof visitMessages>;
type Consultant = { id: string; displayName: string };
type FollowUp = {
  id: string;
  visitId: string;
  title: string;
  ownerStaffId: string;
  ownerName: string | null;
  dueDate: string;
  status: "OPEN" | "DONE" | "CANCELLED";
  notes: string | null;
  closureReason: string | null;
  overdue: boolean;
  revision: number;
  visitPurpose?: string;
  scheduledStart?: string;
};
type Attachment = {
  id: string;
  originalName: string;
  declaredType: string;
  contentType: string | null;
  size: number | null;
  scanStatus:
    "UPLOADING" | "QUARANTINED" | "CLEAN" | "REJECTED" | "FAILED" | "EXPIRED";
  rejectionCode: string | null;
  uploadedByName: string | null;
  createdAt: string;
  expiresAt: string | null;
  downloadable: boolean;
};
type Visit = {
  id: string;
  relatedRoundId: string | null;
  relatedRoundLabel: string | null;
  assignedConsultantId: string;
  assignedConsultantName: string | null;
  assignedConsultantActive: boolean | null;
  scheduledStart: string;
  scheduledEnd: string | null;
  timezone: string;
  purpose: string;
  notes: string | null;
  findings: string | null;
  recommendations: string | null;
  followUpDate: string | null;
  state: "DRAFT" | "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  completedAt: string | null;
  cancellationReason: string | null;
  amendmentCount: number;
  revision: number;
  attachmentCount?: number;
  openFollowUps?: number;
  followUps?: FollowUp[];
  attachments?: Attachment[];
};

const subscribe = () => () => {};
// A visit's times are read and written in the VISIT's timezone, never in the
// viewing browser's. See src/zoned-time.ts for the defect this replaced.
const zoned = (value: string | null | undefined, timeZone: string) =>
  value ? `${formatInZone(value, timeZone)} ${timeZone}` : "";
const kilobytes = (value: number | null) =>
  value === null ? "" : `${Math.max(1, Math.round(Number(value) / 1024))} KB`;

// Which transitions the current state actually offers. The database is the
// authority; this only avoids presenting a button that would be refused.
const NEXT: Record<
  string,
  ("SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED")[]
> = {
  DRAFT: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};
const ACTION_LABEL: Record<string, VisitMessageKey> = {
  SCHEDULED: "schedule",
  IN_PROGRESS: "start",
  COMPLETED: "complete",
  CANCELLED: "cancelVisit",
};

const blankVisit = (consultantId: string, timezone: string) => ({
  relatedRoundId: "",
  assignedConsultantId: consultantId,
  scheduledStart: "",
  scheduledEnd: "",
  timezone,
  purpose: "",
  notes: "",
  findings: "",
  recommendations: "",
  followUpDate: "",
  amendmentReason: "",
});
type VisitForm = ReturnType<typeof blankVisit>;

export function Visits({
  profile,
  organization,
  path,
}: {
  profile: Profile;
  organization: DirectoryRecord | null;
  path: string[];
}) {
  const locale = profile.locale as Locale;
  const m: M = visitMessages(locale);
  const base = messages(locale);
  const org = path[0],
    visitId = path[2] ?? "";
  const timezone = String(
    (organization as { timezone?: string } | null)?.timezone ?? "Asia/Riyadh",
  );

  const [visits, setVisits] = useState<Visit[]>([]);
  const [visit, setVisit] = useState<Visit | null>(null);
  const [consultants, setConsultants] = useState<Consultant[]>([]);
  const [overdue, setOverdue] = useState<FollowUp[]>([]);
  const [filters, setFilters] = useState({ state: "", consultantId: "" });
  const [form, setForm] = useState<VisitForm | null>(null);
  const [followUpForm, setFollowUpForm] = useState<{
    id: string | null;
    revision: number | null;
    title: string;
    ownerStaffId: string;
    dueDate: string;
    status: "OPEN" | "DONE" | "CANCELLED";
    notes: string;
    closureReason: string;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [attachmentError, setAttachmentError] = useState("");
  // The refusal is brought into view when it appears: a file picker returning
  // on a phone does not leave the page where the finger was.
  const attachmentAlert = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (attachmentError)
      attachmentAlert.current?.scrollIntoView({ block: "nearest" });
  }, [attachmentError]);
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

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
          ...(init?.headers ?? {}),
        },
      });
      if (r.status === 204) return null;
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
      setConsultants((await api("visit-consultants")).items);
      if (visitId) setVisit(await api(`visits/${visitId}`));
      else {
        const query = new URLSearchParams();
        if (filters.state) query.set("state", filters.state);
        if (filters.consultantId)
          query.set("consultantId", filters.consultantId);
        setVisits((await api(`visits?${query.toString()}`)).items);
        setOverdue(
          (await api(`follow-ups?status=OPEN&dueBefore=${today(timezone)}`)).items,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : base.unavailable);
    } finally {
      setBusy(false);
    }
  }, [api, visitId, filters, base]);

  useEffect(() => {
    void load();
  }, [load]);

  // An error is shown where the action was taken. On a phone the page header
  // is a long scroll away from the attachment control, and a refusal printed
  // up there would be announced but never seen.
  const guarded = async (
    work: () => Promise<void>,
    report: (message: string) => void = setError,
  ) => {
    setBusy(true);
    setError("");
    setAttachmentError("");
    setNote("");
    try {
      await work();
      await load();
    } catch (e) {
      report(e instanceof Error ? e.message : base.unavailable);
      setBusy(false);
    }
  };

  const submitVisit = (values: VisitForm) =>
    guarded(async () => {
      const body = {
        relatedRoundId: values.relatedRoundId || null,
        assignedConsultantId: values.assignedConsultantId,
        // An unparseable time or zone is sent as-is and refused by the server's
        // validation, rather than being guessed at here.
        scheduledStart:
          wallClockToInstant(values.scheduledStart, values.timezone) ??
          values.scheduledStart,
        scheduledEnd: values.scheduledEnd
          ? (wallClockToInstant(values.scheduledEnd, values.timezone) ??
            values.scheduledEnd)
          : null,
        timezone: values.timezone,
        purpose: values.purpose,
        notes: values.notes || null,
        findings: values.findings || null,
        recommendations: values.recommendations || null,
        followUpDate: values.followUpDate || null,
        amendmentReason: values.amendmentReason || null,
      };
      if (visit)
        await api(`visits/${visit.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
          headers: { "if-match": `"${visit.revision}"` },
        });
      else {
        const created = (await api("visits", {
          method: "POST",
          body: JSON.stringify(body),
        })) as Visit;
        location.assign(`/organizations/${org}/visits/${created.id}`);
        return;
      }
      setForm(null);
    });

  const transition = (target: string) =>
    guarded(async () => {
      if (!visit) return;
      await api(`visits/${visit.id}/transition`, {
        method: "POST",
        body: JSON.stringify({ target, reason: reason || null }),
        headers: { "if-match": `"${visit.revision}"` },
      });
      setReason("");
    });

  const submitFollowUp = () =>
    guarded(async () => {
      if (!visit || !followUpForm) return;
      const body = {
        title: followUpForm.title,
        ownerStaffId: followUpForm.ownerStaffId,
        dueDate: followUpForm.dueDate,
        status: followUpForm.status,
        notes: followUpForm.notes || null,
        closureReason: followUpForm.closureReason || null,
      };
      if (followUpForm.id)
        await api(`visits/${visit.id}/follow-ups/${followUpForm.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
          headers: { "if-match": `"${followUpForm.revision}"` },
        });
      else
        await api(`visits/${visit.id}/follow-ups`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      setFollowUpForm(null);
    });

  // Two calls: one to mint a row and a generated object name, one to stream the
  // bytes. The response of the second is deliberately not a download link — the
  // file is quarantined until something else has proved it safe.
  const upload = (file: File) =>
    guarded(async () => {
      if (!visit) return;
      const declaredType = typeFor(file.name);
      if (!declaredType) throw new Error(m.allowedTypes);
      const started = (await api(`visits/${visit.id}/attachments`, {
        method: "POST",
        body: JSON.stringify({ filename: file.name, declaredType }),
      })) as { id: string; maxBytes: number };
      if (file.size > started.maxBytes) throw new Error(base.tooLarge);
      const r = await staffFetch(locale)(
        `/api/v1/organizations/${org}/visits/${visit.id}/attachments/${started.id}/content`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "Accept-Language": locale,
          },
          body: await file.arrayBuffer(),
        },
      );
      if (!r.ok) {
        // A refusal from something in front of the application (a proxy's own
        // 413 page) is not JSON; its status still says what happened, and a
        // parser's complaint must never be shown in its place.
        const body = (await jsonOf(r)) as { message?: string };
        throw new Error(
          body.message ?? (r.status === 413 ? base.tooLarge : base.unavailable),
        );
      }
      setNote(m.QUARANTINED);
    }, setAttachmentError);

  const removeAttachment = (id: string) =>
    guarded(async () => {
      if (!visit) return;
      await api(`visits/${visit.id}/attachments/${id}`, { method: "DELETE" });
    });

  const shell = (children: React.ReactNode) => (
    <Workspace
      locale={locale}
      organization={organization}
      section="visits"
      canManage={
        profile.role === "SUPER_ADMIN" ||
        profile.capabilities.includes("directory.manage")
      }
    >
      {children}
    </Workspace>
  );
  if (!hydrated) return shell(<LoadingState label={m.loading} />);

  const editing = form !== null;
  const completed = visit?.state === "COMPLETED";
  return shell(
    <>
        <PageHeader
          eyebrow={<Label accent>{organizationName(organization, locale)}</Label>}
          title={m.visits}
          sub={m.confidential}
        />
        {/* Both notes state a constraint the schema enforces, so they read as
            qualifications of the screen rather than as warnings on it. */}
        <div className="note" role="note">
          <p>{m.noEmail}</p>
        </div>
        {error && <ErrorState title={base.errorTitle} body={error} />}
        <p role="status" aria-live="polite">
          {busy ? m.loading : note}
        </p>

        {!visitId && (
          <>
            <section className="stack">
              <div className="row">
                <label>
                  {m.filterState}
                  <select
                    value={filters.state}
                    onChange={(e) =>
                      setFilters({ ...filters, state: e.target.value })
                    }
                  >
                    <option value="">{m.filterAll}</option>
                    {(
                      [
                        "DRAFT",
                        "SCHEDULED",
                        "IN_PROGRESS",
                        "COMPLETED",
                        "CANCELLED",
                      ] as const
                    ).map((s) => (
                      <option key={s} value={s}>
                        {m[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {m.filterConsultant}
                  <select
                    value={filters.consultantId}
                    onChange={(e) =>
                      setFilters({ ...filters, consultantId: e.target.value })
                    }
                  >
                    <option value="">{m.filterAll}</option>
                    {consultants.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={() =>
                    setForm(blankVisit(consultants[0]?.id ?? "", timezone))
                  }
                  disabled={busy || !consultants.length}
                >
                  {m.newVisit}
                </button>
              </div>
            </section>

            {editing && (
              <VisitForm
                m={m}
                form={form}
                setForm={setForm}
                consultants={consultants}
                completed={false}
                onSubmit={submitVisit}
                busy={busy}
              />
            )}

            <section className="card stack">
              <div className="card-head">
                <h2>{m.list}</h2>
                <Micro>{visits.length} VISITS</Micro>
              </div>
              {!visits.length && !busy && (
                <EmptyState title={base.emptyTitle} body={m.none} />
              )}
              {visits.length > 0 && (
                <div
                  className="table-wrap scroll"
                  tabIndex={0}
                  role="region"
                  aria-label={m.visits}
                >
                  <table className="result-table">
                    <caption>{m.visits}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{m.scheduledStart}</th>
                        <th scope="col">{m.purpose}</th>
                        <th scope="col">{m.consultant}</th>
                        <th scope="col">{m.state}</th>
                        <th scope="col">{m.followUps}</th>
                        <th scope="col">{m.attachments}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visits.map((v) => (
                        <tr key={v.id}>
                          <th scope="row">
                            <a href={`/organizations/${org}/visits/${v.id}`}>
                              <bdi dir="ltr">{zoned(v.scheduledStart, v.timezone)}</bdi>
                            </a>
                          </th>
                          <td>{v.purpose}</td>
                          <td>
                            {v.assignedConsultantName}
                            {v.assignedConsultantActive === false
                              ? ` (${m.inactiveConsultant})`
                              : ""}
                          </td>
                          <td>
                            <Badge tone={visitTone(v.state)}>{m[v.state]}</Badge>
                          </td>
                          <td>{v.openFollowUps ?? 0}</td>
                          <td>{v.attachmentCount ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="stack">
              <h2>{m.followUpsTab}</h2>
              <p role="note">{m.onlyOverdue}</p>
              {!overdue.length && !busy && (
                <p className="muted">{m.noFollowUps}</p>
              )}
              <ul>
                {overdue.map((f) => (
                  <li key={f.id}>
                    <a href={`/organizations/${org}/visits/${f.visitId}`}>
                      {f.title}
                    </a>{" "}
                    — {m.dueDate}: {f.dueDate} — {m.owner}: {f.ownerName ?? ""}{" "}
                    {f.overdue ? `(${m.overdue})` : ""}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}

        {visitId && visit && (
          <>
            <p>
              <a href={`/organizations/${org}/visits`}>{m.back}</a>
            </p>
            <section className="stack">
              <h2>{visit.purpose}</h2>
              <dl>
                <dt>{m.state}</dt>
                <dd>
                  <Badge tone={visitTone(visit.state)}>{m[visit.state]}</Badge>
                </dd>
                <dt>{m.consultant}</dt>
                <dd>
                  {visit.assignedConsultantName}
                  {visit.assignedConsultantActive === false
                    ? ` (${m.inactiveConsultant})`
                    : ""}
                </dd>
                <dt>{m.scheduledStart}</dt>
                <dd><bdi dir="ltr">{zoned(visit.scheduledStart, visit.timezone)}</bdi></dd>
                <dt>{m.scheduledEnd}</dt>
                <dd><bdi dir="ltr">{zoned(visit.scheduledEnd, visit.timezone)}</bdi></dd>
                <dt>{m.timezone}</dt>
                <dd><bdi dir="ltr">{visit.timezone}</bdi></dd>
                <dt>{m.relatedRound}</dt>
                <dd>{visit.relatedRoundLabel ?? m.noRound}</dd>
                <dt>{m.followUpDate}</dt>
                <dd>{visit.followUpDate ?? ""}</dd>
                <dt>{m.notes}</dt>
                <dd>{visit.notes ?? ""}</dd>
                <dt>{m.findings}</dt>
                <dd>{visit.findings ?? ""}</dd>
                <dt>{m.recommendations}</dt>
                <dd>{visit.recommendations ?? ""}</dd>
                {visit.completedAt && (
                  <>
                    <dt>{m.completedAt}</dt>
                    <dd><bdi dir="ltr">{zoned(visit.completedAt, visit.timezone)}</bdi></dd>
                    <dt>{m.amendmentCount}</dt>
                    <dd>{visit.amendmentCount}</dd>
                  </>
                )}
                {visit.cancellationReason && (
                  <>
                    <dt>{m.cancellationReason}</dt>
                    <dd>{visit.cancellationReason}</dd>
                  </>
                )}
              </dl>
              {visit.state !== "CANCELLED" && (
                <button
                  disabled={busy}
                  onClick={() =>
                    setForm({
                      relatedRoundId: visit.relatedRoundId ?? "",
                      assignedConsultantId: visit.assignedConsultantId,
                      scheduledStart: instantToWallClock(visit.scheduledStart, visit.timezone),
                      scheduledEnd: instantToWallClock(visit.scheduledEnd, visit.timezone),
                      timezone: visit.timezone,
                      purpose: visit.purpose,
                      notes: visit.notes ?? "",
                      findings: visit.findings ?? "",
                      recommendations: visit.recommendations ?? "",
                      followUpDate: visit.followUpDate ?? "",
                      amendmentReason: "",
                    })
                  }
                >
                  {completed ? m.amendment : m.edit}
                </button>
              )}
            </section>

            {editing && (
              <VisitForm
                m={m}
                form={form}
                setForm={setForm}
                consultants={consultants}
                completed={completed}
                onSubmit={submitVisit}
                busy={busy}
              />
            )}

            {NEXT[visit.state].length > 0 && (
              <section className="stack">
                <h2>{m.transition}</h2>
                <label>
                  {m.reason}
                  <input
                    value={reason}
                    maxLength={500}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <div className="row">
                  {NEXT[visit.state].map((target) => (
                    <button
                      key={target}
                      disabled={busy || (target === "CANCELLED" && !reason)}
                      onClick={() => void transition(target)}
                    >
                      {m[ACTION_LABEL[target]]}
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section className="stack">
              <h2>{m.followUps}</h2>
              {!visit.followUps?.length && (
                <p className="muted">{m.noFollowUps}</p>
              )}
              {!!visit.followUps?.length && (
                <div
                  className="table-wrap scroll"
                  tabIndex={0}
                  role="region"
                  aria-label={m.followUps}
                >
                  <table className="result-table">
                    <caption>{m.followUps}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{m.title}</th>
                        <th scope="col">{m.owner}</th>
                        <th scope="col">{m.dueDate}</th>
                        <th scope="col">{m.status}</th>
                        <th scope="col">{m.edit}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visit.followUps.map((f) => (
                        <tr key={f.id}>
                          <th scope="row">{f.title}</th>
                          <td>{f.ownerName ?? ""}</td>
                          <td>
                            {f.dueDate}
                            {f.overdue ? ` (${m.overdue})` : ""}
                          </td>
                          <td>{m[f.status]}</td>
                          <td>
                            <button
                              disabled={busy}
                              onClick={() =>
                                setFollowUpForm({
                                  id: f.id,
                                  revision: f.revision,
                                  title: f.title,
                                  ownerStaffId: f.ownerStaffId,
                                  dueDate: f.dueDate,
                                  status: f.status,
                                  notes: f.notes ?? "",
                                  closureReason: f.closureReason ?? "",
                                })
                              }
                            >
                              {m.edit}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <button
                disabled={busy || !consultants.length}
                onClick={() =>
                  setFollowUpForm({
                    id: null,
                    revision: null,
                    title: "",
                    ownerStaffId: consultants[0]?.id ?? "",
                    dueDate: today(timezone),
                    status: "OPEN",
                    notes: "",
                    closureReason: "",
                  })
                }
              >
                {m.newFollowUp}
              </button>
              {followUpForm && (
                <form
                  className="stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitFollowUp();
                  }}
                >
                  <label>
                    {m.title}
                    <input
                      required
                      maxLength={300}
                      value={followUpForm.title}
                      onChange={(e) =>
                        setFollowUpForm({
                          ...followUpForm,
                          title: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    {m.owner}
                    <select
                      value={followUpForm.ownerStaffId}
                      onChange={(e) =>
                        setFollowUpForm({
                          ...followUpForm,
                          ownerStaffId: e.target.value,
                        })
                      }
                    >
                      {consultants.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {m.dueDate}
                    <input
                      required
                      type="date"
                      value={followUpForm.dueDate}
                      onChange={(e) =>
                        setFollowUpForm({
                          ...followUpForm,
                          dueDate: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    {m.status}
                    <select
                      value={followUpForm.status}
                      onChange={(e) =>
                        setFollowUpForm({
                          ...followUpForm,
                          status: e.target.value as FollowUp["status"],
                        })
                      }
                    >
                      {(["OPEN", "DONE", "CANCELLED"] as const).map((s) => (
                        <option key={s} value={s}>
                          {m[s]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {m.notes}
                    <textarea
                      maxLength={4000}
                      value={followUpForm.notes}
                      onChange={(e) =>
                        setFollowUpForm({
                          ...followUpForm,
                          notes: e.target.value,
                        })
                      }
                    />
                  </label>
                  {followUpForm.status === "CANCELLED" && (
                    <label>
                      {m.closureReason}
                      <input
                        required
                        maxLength={500}
                        value={followUpForm.closureReason}
                        onChange={(e) =>
                          setFollowUpForm({
                            ...followUpForm,
                            closureReason: e.target.value,
                          })
                        }
                      />
                    </label>
                  )}
                  <div className="row">
                    <button type="submit" disabled={busy}>
                      {m.save}
                    </button>
                    <button type="button" onClick={() => setFollowUpForm(null)}>
                      {m.close}
                    </button>
                  </div>
                </form>
              )}
            </section>

            <section className="stack">
              <h2>{m.attachments}</h2>
              <p role="note">{m.quarantineNote}</p>
              <p role="note">{m.allowedTypes}</p>
              {visit.state !== "CANCELLED" && (
                <label>
                  {m.addAttachment}
                  <input
                    type="file"
                    accept={allowedExtensions.join(",")}
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) void upload(file);
                    }}
                  />
                </label>
              )}
              {attachmentError && (
                <div ref={attachmentAlert}>
                  <Alert tone="danger" role="alert">
                    {attachmentError}
                  </Alert>
                </div>
              )}
              {!visit.attachments?.length && (
                <p className="muted">{m.noAttachments}</p>
              )}
              {!!visit.attachments?.length && (
                <div
                  className="table-wrap scroll"
                  tabIndex={0}
                  role="region"
                  aria-label={m.attachments}
                >
                  <table className="result-table">
                    <caption>{m.attachments}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{m.fileName}</th>
                        <th scope="col">{m.fileType}</th>
                        <th scope="col">{m.size}</th>
                        <th scope="col">{m.scanStatus}</th>
                        <th scope="col">{m.uploadedBy}</th>
                        <th scope="col">{m.download}</th>
                        <th scope="col">{m.remove}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visit.attachments.map((a) => (
                        <tr key={a.id}>
                          <th scope="row">{a.originalName}</th>
                          <td>{a.contentType ?? a.declaredType}</td>
                          <td>
                            <bdi dir="ltr">{kilobytes(a.size)}</bdi>
                          </td>
                          <td>
                            {m[a.scanStatus]}
                            {a.rejectionCode
                              ? ` — ${rejection(m, a.rejectionCode)}`
                              : ""}
                          </td>
                          <td>{a.uploadedByName ?? ""}</td>
                          <td>
                            {a.downloadable ? (
                              <>
                                <a
                                  href={`/api/v1/organizations/${org}/visits/${visit.id}/attachments/${a.id}/download`}
                                >
                                  {m.download}
                                </a>
                                {previewableType(a.contentType) ? (
                                  <>
                                    {" "}
                                    <a
                                      target="_blank"
                                      rel="noreferrer noopener"
                                      href={`/api/v1/organizations/${org}/visits/${visit.id}/attachments/${a.id}/preview`}
                                    >
                                      {m.preview}
                                    </a>
                                  </>
                                ) : null}
                              </>
                            ) : (
                              ""
                            )}
                          </td>
                          <td>
                            <button
                              disabled={busy}
                              onClick={() => {
                                if (confirm(m.removeConfirm))
                                  void removeAttachment(a.id);
                              }}
                            >
                              {m.remove}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
    </>,
  );
}

function VisitForm({
  m,
  form,
  setForm,
  consultants,
  completed,
  onSubmit,
  busy,
}: {
  m: M;
  form: VisitForm;
  setForm: (value: VisitForm | null) => void;
  consultants: Consultant[];
  completed: boolean;
  onSubmit: (values: VisitForm) => void;
  busy: boolean;
}) {
  const set = (key: keyof VisitForm, value: string) =>
    setForm({ ...form, [key]: value });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form);
      }}
    >
      {completed && <p role="note">{m.amendmentNote}</p>}
      <label>
        {m.purpose}
        <input
          required
          maxLength={500}
          value={form.purpose}
          onChange={(e) => set("purpose", e.target.value)}
        />
      </label>
      <label>
        {m.consultant}
        <select
          value={form.assignedConsultantId}
          onChange={(e) => set("assignedConsultantId", e.target.value)}
        >
          {consultants.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName}
            </option>
          ))}
        </select>
      </label>
      <p className="muted" id="visitTimesHelp">
        {m.timesInZone}
      </p>
      <label>
        {m.scheduledStart}
        <input
          required
          aria-describedby="visitTimesHelp"
          type="datetime-local"
          value={form.scheduledStart}
          onChange={(e) => set("scheduledStart", e.target.value)}
        />
      </label>
      <label>
        {m.scheduledEnd}
        <input
          aria-describedby="visitTimesHelp"
          type="datetime-local"
          value={form.scheduledEnd}
          onChange={(e) => set("scheduledEnd", e.target.value)}
        />
      </label>
      <label>
        {m.timezone}
        <input
          required
          maxLength={100}
          value={form.timezone}
          onChange={(e) => set("timezone", e.target.value)}
        />
      </label>
      <label>
        {m.followUpDate}
        <input
          type="date"
          value={form.followUpDate}
          onChange={(e) => set("followUpDate", e.target.value)}
        />
      </label>
      <label>
        {m.notes}
        <textarea
          maxLength={5000}
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
      </label>
      <label>
        {m.findings}
        <textarea
          maxLength={5000}
          value={form.findings}
          onChange={(e) => set("findings", e.target.value)}
        />
      </label>
      <label>
        {m.recommendations}
        <textarea
          maxLength={5000}
          value={form.recommendations}
          onChange={(e) => set("recommendations", e.target.value)}
        />
      </label>
      {completed && (
        <label>
          {m.amendmentReason}
          <input
            required
            maxLength={500}
            value={form.amendmentReason}
            onChange={(e) => set("amendmentReason", e.target.value)}
          />
        </label>
      )}
      <div className="row">
        <button type="submit" disabled={busy}>
          {m.save}
        </button>
        <button type="button" onClick={() => setForm(null)}>
          {m.close}
        </button>
      </div>
    </form>
  );
}

// "Today" is the organization's calendar day, not UTC's and not the browser's:
// a follow-up due today in Riyadh is not overdue at 01:00 Riyadh time.
const today = (timeZone: string) =>
  formatInZone(new Date().toISOString(), timeZone).slice(0, 10) ||
  new Date().toISOString().slice(0, 10);
// The browser's guess from the extension. It is a hint the server records as
// `declaredType` and the scanner then contradicts if the bytes disagree.
function typeFor(filename: string): AllowedType | null {
  const dot = filename.lastIndexOf(".");
  const extension = dot < 0 ? "" : filename.slice(dot).toLowerCase();
  for (const [type, extensions] of Object.entries(ALLOWED_TYPES))
    if ((extensions as readonly string[]).includes(extension))
      return type as AllowedType;
  return null;
}
// A visit's lifecycle carried without relying on hue: the badge prints the
// state's word and a glyph, and the tone only reinforces them.
function visitTone(state: string) {
  return state === "COMPLETED"
    ? "positive"
    : state === "CANCELLED"
      ? "danger"
      : state === "IN_PROGRESS"
        ? "accent"
        : "neutral";
}
function rejection(m: M, code: string) {
  return code in m ? m[code as VisitMessageKey] : m.REJECTED_OTHER;
}
