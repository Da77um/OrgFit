"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { fill, respondentMessages } from "../../../src/respondent-i18n";
import { direction, type Locale } from "../../../src/i18n";
import { Alert, Label, LoadingState, Mark } from "../../../src/ui";
import { Dialog, Shell } from "./survey-ui";

// The employee message page (migration 025).
//
// Privacy-relevant properties, all deliberate and all shared with the survey:
//  * the organization link is read from the URL fragment and removed from the
//    address bar and the history entry before anything else happens, so it
//    never reaches a server log, a Referer header or the back-button entry;
//  * the organization is CONFIRMED, never typed or chosen: it is whatever the
//    link resolves to, and no list of organizations is ever shown;
//  * there is no cookie, no session, no local storage and no analytics. The
//    link is kept in memory and posted with each request;
//  * the notice says what is attached (company, department), what is not
//    stored, and what the text itself can reveal. It never promises anonymity.

// Mirrors of the server bounds in src/respondent.ts and migration 025. The
// server is the authority; these only keep the form honest while typing.
const MESSAGE_MAX_CHARS = 2000;
const OTHER_DEPARTMENT_MAX_CHARS = 120;
const REQUEST_TIMEOUT_MS = 20_000;
const OTHER = "__other__";

type Department = { id: string; nameAr: string; nameEn: string | null };
type Context =
  | { access: "UNAVAILABLE" }
  | {
      access: "OPEN";
      organization: { nameAr: string; nameEn: string | null };
      departments: Department[];
    };
type Stage = "loading" | "blocked" | "form" | "sent";

let capturedToken: string | null | undefined;
function takeFragmentToken() {
  if (capturedToken === undefined) {
    const fragment = window.location.hash.replace(/^#/, "");
    capturedToken = /^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment : null;
    if (capturedToken)
      window.history.replaceState(null, "", window.location.pathname);
  }
  return capturedToken;
}

async function api<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`/public/v1/${path}`, {
      method: "POST",
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("NETWORK");
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.code ?? "TEMPORARILY_UNAVAILABLE");
  return data?.data as T;
}

function readLocaleCookie(): Locale | null {
  try {
    const match = document.cookie.match(/(?:^|;\s*)orgfit-survey-locale=(ar|en)/);
    return (match?.[1] as Locale | undefined) ?? null;
  } catch {
    return null;
  }
}

export default function EmployeeMessage() {
  const [locale, setLocale] = useState<Locale>("ar");
  const m = respondentMessages(locale);
  const dir = direction(locale);
  const [stage, setStage] = useState<Stage>("loading");
  const [blocked, setBlocked] = useState<string>("");
  const [context, setContext] = useState<Extract<Context, { access: "OPEN" }> | null>(null);
  const [department, setDepartment] = useState("");
  const [otherDepartment, setOtherDepartment] = useState("");
  const [body, setBody] = useState("");
  const [showIssues, setShowIssues] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const bootstrapped = useRef(false);

  const name = (value: { nameAr: string; nameEn: string | null }) =>
    locale === "en" && value.nameEn ? value.nameEn : value.nameAr;

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    const saved = readLocaleCookie();
    if (saved) setLocale(saved);
    token.current = takeFragmentToken();
    if (!token.current) {
      setBlocked("UNAVAILABLE");
      setStage("blocked");
      return;
    }
    api<Context>("messages/context", { token: token.current })
      .then((data) => {
        if (data?.access === "OPEN") {
          setContext(data);
          setStage("form");
        } else {
          setBlocked("UNAVAILABLE");
          setStage("blocked");
        }
      })
      .catch((e: unknown) => {
        setBlocked(e instanceof Error ? e.message : "TEMPORARILY_UNAVAILABLE");
        setStage("blocked");
      });
  }, []);

  // Each new screen starts at the top with its heading focused.
  useEffect(() => {
    if (stage === "loading") return;
    window.scrollTo(0, 0);
    headingRef.current?.focus({ preventScroll: true });
  }, [stage]);

  const changeLocale = useCallback((next: Locale) => {
    setLocale(next);
    void api("locale", { locale: next }).catch(() => undefined);
  }, []);

  const other = department === OTHER;
  const trimmedOther = otherDepartment.trim();
  const trimmedBody = body.trim();
  const departmentIssue =
    !department || (other && (!trimmedOther || trimmedOther.length > OTHER_DEPARTMENT_MAX_CHARS))
      ? m.msgDepartmentRequired
      : null;
  const bodyIssue =
    !trimmedBody || trimmedBody.length > MESSAGE_MAX_CHARS ? m.msgBodyRequired : null;
  const departmentLabel = other
    ? trimmedOther
    : context?.departments.find((d) => d.id === department)
      ? name(context.departments.find((d) => d.id === department)!)
      : "";

  const review = () => {
    setShowIssues(true);
    setError(null);
    if (departmentIssue || bodyIssue) return;
    setConfirming(true);
  };

  const send = async () => {
    if (!token.current || sending) return;
    setSending(true);
    setError(null);
    try {
      await api("messages", {
        token: token.current,
        departmentId: other ? null : department,
        otherDepartment: other ? trimmedOther : null,
        body: trimmedBody,
      });
      setConfirming(false);
      setBody("");
      setShowIssues(false);
      setStage("sent");
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      setConfirming(false);
      if (code === "MESSAGE_LINK_UNAVAILABLE") {
        setBlocked("UNAVAILABLE");
        setStage("blocked");
      } else if (code === "RATE_LIMITED") setError(m.rateLimited);
      else if (code === "VALIDATION_FAILED") setError(m.msgInvalid);
      // No answer arrived: the message may or may not have been stored.
      else if (code === "NETWORK") setError(m.msgSendUncertain);
      else setError(m.serviceUnavailable);
    } finally {
      setSending(false);
    }
  };

  if (stage === "loading")
    return (
      <main id="main" className="wrap">
        <LoadingState label={m.loading} />
      </main>
    );

  if (stage === "blocked" || stage === "sent")
    return (
      <Shell locale={locale} setLocale={changeLocale} dir={dir} title={m.msgAppTitle}>
        <section className="panel login stack">
          <Mark className="state-mark" />
          <h1 ref={headingRef} tabIndex={-1}>
            {stage === "sent" ? m.msgSentTitle : m.msgAppTitle}
          </h1>
          {stage === "sent" ? (
            <>
              <Alert tone="success" role="status">
                {m.msgSentBody}
              </Alert>
              <div className="survey-actions">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setStage("form")}
                >
                  {m.msgWriteAnother}
                </button>
              </div>
            </>
          ) : (
            <Alert tone="warning" role="status">
              {blocked === "RATE_LIMITED"
                ? m.rateLimited
                : blocked === "UNAVAILABLE" || blocked === "MALFORMED" || blocked === "VALIDATION_FAILED"
                  ? m.msgUnavailable
                  : m.serviceUnavailable}
            </Alert>
          )}
        </section>
      </Shell>
    );

  if (!context) return null;
  const otherHintId = "message-other-hint";
  const bodyHintId = "message-body-hint";
  return (
    <Shell locale={locale} setLocale={changeLocale} dir={dir} title={m.msgAppTitle}>
      <section className="panel login stack">
        <Label accent>{m.msgOrganizationLabel}</Label>
        <h1 ref={headingRef} tabIndex={-1}>
          <bdi>{name(context.organization)}</bdi>
        </h1>
        <p className="muted">{m.msgOrganizationConfirm}</p>

        {/* The notice comes before the form, and the limits sit inside the same
            block as what is stored, so neither is read without the other. */}
        <section className="card card-accent stack">
          <div className="card-head">
            <h2>{m.msgNoticeTitle}</h2>
          </div>
          <p>{m.msgNoticeBody}</p>
          <div className="note">
            <div>
              <p>{m.msgNoticeLimits}</p>
            </div>
          </div>
        </section>

        {error && (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        )}

        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            review();
          }}
        >
          <label>
            <span>{m.msgDepartment}</span>
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              aria-invalid={showIssues && departmentIssue && !other ? "true" : undefined}
              aria-describedby={showIssues && departmentIssue && !other ? "message-department-error" : undefined}
            >
              <option value="">{m.msgDepartmentChoose}</option>
              {context.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {name(d)}
                </option>
              ))}
              <option value={OTHER}>{m.msgDepartmentOther}</option>
            </select>
            {showIssues && departmentIssue && !other && (
              <span className="field-error" id="message-department-error">
                {departmentIssue}
              </span>
            )}
          </label>
          {other && (
            <label>
              <span>{m.msgOtherDepartment}</span>
              <input
                type="text"
                value={otherDepartment}
                maxLength={OTHER_DEPARTMENT_MAX_CHARS}
                autoComplete="off"
                onChange={(e) => setOtherDepartment(e.target.value)}
                aria-invalid={showIssues && departmentIssue ? "true" : undefined}
                aria-describedby={otherHintId}
              />
              <span className="field-hint" id={otherHintId}>
                {showIssues && departmentIssue
                  ? departmentIssue
                  : fill(m.msgOtherHint, { max: OTHER_DEPARTMENT_MAX_CHARS })}
              </span>
            </label>
          )}
          <label>
            <span>{m.msgBody}</span>
            <textarea
              value={body}
              rows={8}
              maxLength={MESSAGE_MAX_CHARS}
              onChange={(e) => setBody(e.target.value)}
              aria-invalid={showIssues && bodyIssue ? "true" : undefined}
              aria-describedby={bodyHintId}
            />
            <span className={showIssues && bodyIssue ? "field-error" : "field-hint"} id={bodyHintId}>
              {showIssues && bodyIssue
                ? bodyIssue
                : fill(m.msgBodyHint, { count: body.length, max: MESSAGE_MAX_CHARS })}
            </span>
          </label>
          <div className="survey-actions">
            <button type="submit" disabled={sending}>
              {m.msgReview}
            </button>
          </div>
        </form>
      </section>

      {confirming && (
        <Dialog
          titleId="messageConfirmTitle"
          title={m.msgConfirmTitle}
          onCancel={() => !sending && setConfirming(false)}
        >
          <Alert tone="warning" role="note">
            {fill(m.msgConfirmBody, { department: departmentLabel })}
          </Alert>
          <p className="muted">{m.msgNoticeLimits}</p>
          <div className="modal-actions">
            <button type="button" onClick={() => void send()} disabled={sending}>
              {sending ? m.msgSending : m.msgSend}
            </button>
            <button
              type="button"
              className="button-secondary"
              data-autofocus
              disabled={sending}
              onClick={() => setConfirming(false)}
            >
              {m.cancel}
            </button>
          </div>
        </Dialog>
      )}
    </Shell>
  );
}
