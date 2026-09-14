"use client";
// ---------------------------------------------------------------------------
// Invitation-only staff activation.
//
// THIS IS NOT PUBLIC REGISTRATION. The screen cannot create an account on its
// own: it needs a valid, unexpired, unused invitation token, and the account it
// produces takes its address, its role, its capabilities and its organizations
// from the invitation row the administrator created — never from anything typed
// here. A visitor with no token is told how accounts are made and given no
// form.
//
// The token travels in the URL FRAGMENT, exactly as the respondent invitation
// does (`/s#…`). A fragment is not sent to the server with the request and does
// not appear in an access log or a referrer, so the secret reaches this code
// only, and only in the browser that was given the link.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useId, useState } from "react";
import { messages, type Locale } from "../../../../src/i18n";
import { Alert, DeniedState, EmptyState, LoadingState } from "../../../../src/ui";
import { checkPasswordPolicy } from "../../../../src/password-policy";
import { RequestFailure, staffRequest } from "../staff-request";

type State =
  | "LOADING"
  | "MISSING"
  | "VALID"
  | "EXPIRED"
  | "CONSUMED"
  | "REVOKED"
  | "INVALID"
  | "ALREADY_REGISTERED"
  | "ACTIVATED"
  | "UNAVAILABLE";

type Invitation = { email?: string; role?: "SUPER_ADMIN" | "STAFF" };

export function ActivateForm({ locale }: { locale: Locale }) {
  const m = messages(locale);
  const [token, setToken] = useState("");
  const [state, setState] = useState<State>("LOADING");
  const [invitation, setInvitation] = useState<Invitation>({});

  const nameId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<{
    displayName?: string;
    password?: string;
    confirm?: string;
  }>({});
  const [formError, setFormError] = useState("");

  // Bounded (Post-Audit Repair Pass 2). Returns the state it found, or null.
  const inspect = useCallback(async (value: string, keepForm = false): Promise<State | null> => {
    try {
      const { data } = await staffRequest<{ state: State } & Invitation>(locale, "/api/v1/auth/invitation", {
        method: "POST",
        body: { token: value },
      });
      setInvitation({ email: data.email, role: data.role });
      setState(data.state);
      return data.state;
    } catch {
      if (!keepForm) setState("UNAVAILABLE");
      return null;
    }
  }, [locale]);

  useEffect(() => {
    const read = () => {
      const value = location.hash.replace(/^#/, "");
      setToken(value);
      if (!value) {
        setState("MISSING");
        return;
      }
      setState("LOADING");
      void inspect(value);
    };
    read();
    // Pasting a second invitation link into a tab already on /activate changes
    // only the fragment, which does not reload the document. Without this the
    // screen would keep showing the first invitation's state.
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [inspect]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    const next: typeof errors = {};
    if (!displayName.trim()) next.displayName = m.displayNameRequired;
    if (checkPasswordPolicy(password)) next.password = m.passwordWeak;
    if (password !== confirm) next.confirm = m.passwordMismatch;
    setErrors(next);
    if (Object.keys(next).length) return;

    setPending(true);
    setFormError("");
    try {
      const { data } = await staffRequest<{ state: State }>(locale, "/api/v1/auth/activate", {
        method: "POST",
        body: { token, displayName: displayName.trim(), password },
      });
      setPassword("");
      setConfirm("");
      setState(data.state);
    } catch (e) {
      // The invitation is single-use, so activating twice cannot create two
      // accounts. When the answer was lost, the invitation is read back: if it
      // has been used, the screen says so (and to sign in) instead of offering
      // a form that can no longer succeed. The password stays in memory only.
      if (e instanceof RequestFailure && e.uncertain) {
        const found = await inspect(token, true);
        if (found === "VALID" || found === null) setFormError(e.message);
      } else setFormError(m.unavailable);
    } finally {
      setPending(false);
    }
  }

  if (state === "LOADING") return <LoadingState label={m.loading} />;

  if (state === "ACTIVATED")
    return (
      <>
        <Alert tone="success" role="status">
          {m.activatedTitle}
        </Alert>
        <p>{m.activatedBody}</p>
        <p>
          <a className="button" href="/login">
            {m.goToLogin}
          </a>
        </p>
      </>
    );

  // The four ways an invitation can fail to be usable, each told apart, because
  // "expired" and "already used" call for different next steps. None of them
  // reveals whether the address is known: a token the caller does not hold is
  // simply INVALID.
  if (state !== "VALID") {
    const copy: Record<string, { title: string; body: string }> = {
      MISSING: { title: m.invitationMissingTitle, body: m.invitationMissingBody },
      INVALID: { title: m.invitationInvalidTitle, body: m.invitationInvalidBody },
      EXPIRED: { title: m.invitationExpiredTitle, body: m.invitationExpiredBody },
      CONSUMED: { title: m.invitationConsumedTitle, body: m.invitationConsumedBody },
      ALREADY_REGISTERED: {
        title: m.invitationConsumedTitle,
        body: m.invitationConsumedBody,
      },
      REVOKED: { title: m.invitationRevokedTitle, body: m.invitationRevokedBody },
      UNAVAILABLE: { title: m.errorTitle, body: m.unavailable },
    };
    const { title, body } = copy[state];
    const action = (
      <a className="button button-secondary" href="/login">
        {m.goToLogin}
      </a>
    );
    return state === "MISSING" ? (
      <EmptyState title={title} body={body} action={action} />
    ) : (
      <DeniedState title={title} body={body} action={action} />
    );
  }

  return (
    <>
      {/* What the administrator decided, shown as fact rather than as a field.
          Neither value is editable, and neither is sent back with the form. */}
      <dl className="auth-summary">
        <dt>{m.invitedAs}</dt>
        <dd className="bidi">{invitation.email}</dd>
        <dt>{m.invitedRole}</dt>
        <dd>{invitation.role === "SUPER_ADMIN" ? m.admin : m.staff}</dd>
      </dl>
      <form className="auth-form" onSubmit={submit} noValidate>
        {formError && (
          <Alert tone="danger" role="alert">
            {formError}
          </Alert>
        )}
        <div className="auth-field">
          <label htmlFor={nameId}>{m.displayNameLabel}</label>
          <input
            id={nameId}
            name="displayName"
            type="text"
            autoComplete="name"
            required
            value={displayName}
            aria-invalid={errors.displayName ? true : undefined}
            aria-describedby={errors.displayName ? `${nameId}-error` : undefined}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={pending}
          />
          {errors.displayName && (
            <p className="field-error" id={`${nameId}-error`}>
              {errors.displayName}
            </p>
          )}
        </div>
        <div className="auth-field">
          <label htmlFor={passwordId}>{m.passwordLabel}</label>
          <div className="password-field">
            <input
              id={passwordId}
              name="password"
              type={reveal ? "text" : "password"}
              autoComplete="new-password"
              required
              value={password}
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={`${passwordId}-hint${errors.password ? ` ${passwordId}-error` : ""}`}
              onChange={(e) => setPassword(e.target.value)}
              disabled={pending}
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              aria-pressed={reveal}
              disabled={pending}
            >
              {reveal ? m.hidePassword : m.showPassword}
            </button>
          </div>
          <p className="field-hint" id={`${passwordId}-hint`}>
            {m.passwordPolicy}
          </p>
          {errors.password && (
            <p className="field-error" id={`${passwordId}-error`}>
              {errors.password}
            </p>
          )}
        </div>
        <div className="auth-field">
          <label htmlFor={confirmId}>{m.passwordConfirmLabel}</label>
          <input
            id={confirmId}
            name="passwordConfirm"
            type={reveal ? "text" : "password"}
            autoComplete="new-password"
            required
            value={confirm}
            aria-invalid={errors.confirm ? true : undefined}
            aria-describedby={errors.confirm ? `${confirmId}-error` : undefined}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={pending}
          />
          {errors.confirm && (
            <p className="field-error" id={`${confirmId}-error`}>
              {errors.confirm}
            </p>
          )}
        </div>
        <button className="button" type="submit" disabled={pending}>
          {pending ? m.activating : m.activateAction}
        </button>
      </form>
    </>
  );
}
