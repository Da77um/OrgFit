/* Full document navigation intentionally clears organization-scoped state. */
"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { RequestProblem, silent, useStaffApi } from "../request-ui";
import { RequestFailure, staffRequest } from "../staff-request";
import { navigateAfterSave, useUnsavedChanges, type SaveOutcome } from "../unsaved";
import { fillText, minutesSince, overdue as isOverdue, usePollWhile } from "../background-status";
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
  Badge,
  EmptyState,
  Label,
  LoadingState,
  Micro,
  PageHeader,
} from "../../../../src/ui";
import {
  formatInZone,
  formatUtc,
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
  const [loadProblem, setLoadProblem] = useState<unknown>(null);
  const [note, setNote] = useState("");
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  // One failed change at a time, shown where it was made. `retry` re-sends the
  // SAME attempt (same idempotency key and body); `scope` names the ledger
  // entry when there is one.
  const [problem, setProblem] = useState<{
    failure: unknown;
    where: "page" | "attachment";
    scope?: string;
    retry?: () => Promise<boolean>;
  } | null>(null);
  // The values each open form started from, so "dirty" means "differs from
  // what was loaded", not "was touched".
  const [formStart, setFormStart] = useState("");
  const [followUpStart, setFollowUpStart] = useState("");
  // The refusal is brought into view when it appears: a file picker returning
  // on a phone does not leave the page where the finger was.
  const attachmentAlert = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (problem?.where === "attachment")
      attachmentAlert.current?.scrollIntoView({ block: "nearest" });
  }, [problem]);
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const client = useStaffApi(locale);
  const root = `/api/v1/organizations/${org}`;

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setBusy(true);
      try {
        setConsultants((await client.read<{ items: Consultant[] }>(`${root}/visit-consultants`)).items);
        if (visitId) setVisit(await client.read<Visit>(`${root}/visits/${visitId}`));
        else {
          const query = new URLSearchParams();
          if (filters.state) query.set("state", filters.state);
          if (filters.consultantId) query.set("consultantId", filters.consultantId);
          setVisits((await client.read<{ items: Visit[] }>(`${root}/visits?${query.toString()}`)).items);
          setOverdue(
            (await client.read<{ items: FollowUp[] }>(
              `${root}/follow-ups?status=OPEN&dueBefore=${today(timezone)}`,
            )).items,
          );
        }
        setLoadProblem(null);
        setCheckedAt(new Date().toISOString());
      } catch (e) {
        if (!silent(e)) setLoadProblem(e);
      } finally {
        if (!quiet) setBusy(false);
      }
    },
    [client, root, visitId, filters, timezone],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // A quarantined file is waiting on the scanner; look again while it waits.
  usePollWhile(
    !!visit?.attachments?.some((a) => a.scanStatus === "QUARANTINED"),
    () => load(true),
  );

  // An error is shown where the action was taken. On a phone the page header
  // is a long scroll away from the attachment control, and a refusal printed
  // up there would be announced but never seen. Resolves true only once the
  // server has confirmed the change.
  const guarded = async (
    work: () => Promise<void>,
    where: "page" | "attachment" = "page",
    scope?: string,
    retry?: () => Promise<boolean>,
  ): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    setNote("");
    try {
      await work();
      await load(true);
      return true;
    } catch (e) {
      if (!silent(e)) setProblem({ failure: e, where, scope, retry });
      return false;
    } finally {
      setBusy(false);
    }
  };

  // One logical change: the first send, or a retry of the same attempt, then
  // what to do with the confirmed answer.
  const change = <T,>(
    scope: string,
    send: () => Promise<T>,
    apply: (data: T, retried: boolean) => void | Promise<void>,
    where: "page" | "attachment" = "page",
  ): Promise<boolean> => {
    const again = (): Promise<boolean> =>
      guarded(async () => apply(await client.retry<T>(scope), true), where, scope, again);
    return guarded(async () => apply(await send(), false), where, scope, again);
  };

  const visitBody = (values: VisitForm) => ({
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
  });

  // Creating a visit is not replaceable while an earlier create is
  // unconfirmed (it could be a second visit); an edit is, because its
  // revision precondition refuses a stale write.
  // `navigate`: go to a created visit at once (the Save button). The leave
  // dialog passes false and navigates itself once the language is saved. A
  // retry confirmed later from the page always continues to the new visit.
  const submitVisit = async (values: VisitForm, navigate = false): Promise<SaveOutcome> => {
    let next: string | undefined;
    const ok = visit
      ? await change(
          "visit-save",
          () =>
            client.mutate<Visit>("visit-save", `${root}/visits/${visit.id}`, {
              method: "PATCH",
              body: visitBody(values),
              revision: visit.revision,
              replace: true,
            }),
          () => setForm(null),
        )
      : await change(
          "visit-save",
          () =>
            client.mutate<Visit>("visit-save", `${root}/visits`, {
              method: "POST",
              body: visitBody(values),
            }),
          (created, retried) => {
            next = `/organizations/${org}/visits/${created.id}`;
            setForm(null);
            if (navigate || retried) navigateAfterSave(next);
          },
        );
    return ok ? { ok: true, next } : { ok: false };
  };
  const saveVisit = (values: VisitForm) => void submitVisit(values, true);

  const transition = (target: string) =>
    visit &&
    change(
      "visit-transition",
      () =>
        client.mutate("visit-transition", `${root}/visits/${visit.id}/transition`, {
          method: "POST",
          body: { target, reason: reason || null },
          revision: visit.revision,
          replace: true,
        }),
      () => setReason(""),
    );

  const submitFollowUp = async (): Promise<SaveOutcome> => {
    if (!visit || !followUpForm) return { ok: false };
    const body = {
      title: followUpForm.title,
      ownerStaffId: followUpForm.ownerStaffId,
      dueDate: followUpForm.dueDate,
      status: followUpForm.status,
      notes: followUpForm.notes || null,
      closureReason: followUpForm.closureReason || null,
    };
    const ok = await change(
      "follow-up-save",
      () =>
        followUpForm.id
          ? client.mutate("follow-up-save", `${root}/visits/${visit.id}/follow-ups/${followUpForm.id}`, {
              method: "PATCH",
              body,
              revision: followUpForm.revision ?? undefined,
              replace: true,
            })
          : client.mutate("follow-up-save", `${root}/visits/${visit.id}/follow-ups`, {
              method: "POST",
              body,
            }),
      () => setFollowUpForm(null),
    );
    return ok ? { ok: true } : { ok: false };
  };

  // Two calls: one to mint a row and a generated object name, one to stream the
  // bytes. The response of the second is deliberately not a download link — the
  // file is quarantined until something else has proved it safe.
  //
  // The first call is keyed like any other change. The second carries raw
  // bytes and is not: when its answer is lost, the row is read back first, and
  // the bytes are sent again only if the row is still waiting for them.
  const sendContent = async (file: File, id: string, maxBytes: number) => {
    if (!visit) return;
    if (file.size > maxBytes)
      throw new RequestFailure(base.tooLarge, "REJECTED", { code: "PAYLOAD_TOO_LARGE" });
    await staffRequest(locale, `${root}/visits/${visit.id}/attachments/${id}/content`, {
      method: "PUT",
      raw: await file.arrayBuffer(),
      headers: { "Content-Type": "application/octet-stream" },
      // Up to 20 MB over a slow link: a longer deadline than a JSON call.
      timeoutMs: 120_000,
    });
    setNote(m.uploadAccepted);
  };
  const resendContent = (file: File, id: string, maxBytes: number): Promise<boolean> =>
    guarded(
      async () => {
        const current = await client.read<Visit>(`${root}/visits/${visitId}`);
        const row = current.attachments?.find((a) => a.id === id);
        if (row && row.scanStatus !== "UPLOADING") {
          // The earlier upload did arrive.
          setNote(m.uploadAccepted);
          return;
        }
        await sendContent(file, id, maxBytes);
      },
      "attachment",
      undefined,
      () => resendContent(file, id, maxBytes),
    );
  const upload = async (file: File) => {
    if (!visit) return;
    const declaredType = typeFor(file.name);
    if (!declaredType) {
      setProblem({ failure: new RequestFailure(m.allowedTypes, "REJECTED"), where: "attachment" });
      return;
    }
    const holder: { started?: { id: string; maxBytes: number } } = {};

    const begun = await change(
      "attachment-begin",
      () =>
        client.mutate<{ id: string; maxBytes: number }>(
          "attachment-begin",
          `${root}/visits/${visit.id}/attachments`,
          { method: "POST", body: { filename: file.name, declaredType } },
        ),
      async (data) => {
        holder.started = data;
        await sendContent(file, data.id, data.maxBytes);
      },
      "attachment",
    );
    const s = holder.started;
    if (!begun && s) {
      // The row exists; only the bytes are in doubt.
      setProblem((p) =>
        p && p.failure instanceof RequestFailure && p.failure.uncertain
          ? { ...p, scope: undefined, retry: () => resendContent(file, s.id, s.maxBytes) }
          : p,
      );
    }
  };

  const removeAttachment = (id: string) =>
    visit &&
    change(
      `attachment-remove:${id}`,
      () =>
        client.mutate(`attachment-remove:${id}`, `${root}/visits/${visit.id}/attachments/${id}`, {
          method: "DELETE",
        }),
      () => undefined,
      "attachment",
    );

  // Unsaved edits: the visit form and the follow-up form can be saved from the
  // leave dialog; a typed transition reason can only be kept or discarded.
  const visitDirty = form !== null && JSON.stringify(form) !== formStart;
  useUnsavedChanges(visitDirty, form ? () => submitVisit(form) : undefined);
  const followUpDirty = followUpForm !== null && JSON.stringify(followUpForm) !== followUpStart;
  useUnsavedChanges(followUpDirty, followUpForm ? submitFollowUp : undefined);
  useUnsavedChanges(reason.trim() !== "");
  const openVisitForm = (values: VisitForm) => {
    setForm(values);
    setFormStart(JSON.stringify(values));
  };
  const openFollowUpForm = (values: NonNullable<typeof followUpForm>) => {
    setFollowUpForm(values);
    setFollowUpStart(JSON.stringify(values));
  };

  const problemView = (where: "page" | "attachment") => {
    if (problem?.where !== where) return null;
    const uncertain = problem.failure instanceof RequestFailure && problem.failure.uncertain;
    const retryable =
      !!problem.retry && uncertain && (!problem.scope || !!client.ledger.uncertain(problem.scope));
    return (
      <RequestProblem
        locale={locale}
        failure={problem.failure}
        busy={busy}
        testId={`visit-${where}-problem`}
        bare={where === "attachment"}
        onRetrySame={retryable ? () => void problem.retry!() : undefined}
        onCheck={uncertain ? () => void load() : undefined}
        onDiscard={
          problem.scope && client.ledger.uncertain(problem.scope)
            ? () => {
                client.ledger.settle(problem.scope!);
                setProblem(null);
              }
            : undefined
        }
      />
    );
  };

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
        <RequestProblem
          locale={locale}
          failure={loadProblem}
          busy={busy}
          testId="visits-load-problem"
          onRetryRead={() => void load()}
        />
        {problemView("page")}
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
                    openVisitForm(blankVisit(consultants[0]?.id ?? "", timezone))
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
                onSubmit={saveVisit}
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
                    openVisitForm({
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
                onSubmit={saveVisit}
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
                                openFollowUpForm({
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
                  openFollowUpForm({
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
              <div ref={attachmentAlert} data-testid="visit-attachment-problem">{problemView("attachment")}</div>
              {visit.attachments?.some((a) => a.scanStatus === "QUARANTINED" || a.scanStatus === "UPLOADING") && (
                <div className="row row-between">
                  <p className="muted">
                    {checkedAt ? fillText(m.statusCheckedAt, { time: formatUtc(checkedAt).replace(" UTC", "") }) : ""}
                  </p>
                  <button
                    type="button"
                    className="button-small button-secondary"
                    disabled={busy}
                    onClick={() => void load()}
                  >
                    {m.refreshStatus}
                  </button>
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
                          <td data-scan-state={a.scanStatus}>
                            {m[a.scanStatus]}
                            {a.rejectionCode
                              ? ` — ${rejection(m, a.rejectionCode)}`
                              : ""}
                            <ScanNote attachment={a} m={m} />
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
// What a file is waiting for, in words, beside its status (Post-Audit Repair
// Pass 2). A quarantined file waits for the scanner, which runs every minute;
// one still waiting after ten minutes says the scanner may not be running.
function ScanNote({ attachment: a, m }: { attachment: Attachment; m: M }) {
  if (a.scanStatus === "QUARANTINED") {
    const late = isOverdue(a.createdAt);
    return (
      <p className="field-hint" data-overdue={late || undefined}>
        {late ? fillText(m.scanOverdue, { minutes: minutesSince(a.createdAt) }) : m.scanWaitingNote}
      </p>
    );
  }
  if (a.scanStatus === "UPLOADING" && isOverdue(a.createdAt))
    return <p className="field-hint">{m.uploadIncomplete}</p>;
  if (a.scanStatus === "FAILED") return <p className="field-hint">{m.scanFailedNote}</p>;
  return null;
}
function rejection(m: M, code: string) {
  return code in m ? m[code as VisitMessageKey] : m.REJECTED_OTHER;
}
