"use client";
// ---------------------------------------------------------------------------
// Staff sign-in.
//
// It posts to the real authentication endpoint and nothing about it is a
// mockup: POST /api/v1/auth/password verifies the credential against the
// stored hash, mints a session through access.issue_password_session, and sets
// the same host-only session cookie the OIDC callback sets. A failure here is a
// real failure.
//
// The error surface is deliberately flat. A wrong password, an address that
// belongs to nobody, and an address that belongs to a disabled account all
// produce ONE message, because a reply that distinguishes them tells a stranger
// which addresses are OrgFit staff. Only two states are told apart from that:
// throttling, because the caller needs to know that waiting helps, and the
// service being unavailable, because retrying immediately does not.
//
// No administrator credential is displayed, prefilled, defaulted or hinted at
// anywhere in this file.
// ---------------------------------------------------------------------------

import { useId, useState, useSyncExternalStore } from "react";
import { messages, type Locale } from "../../../../src/i18n";
import { Alert } from "../../../../src/ui";
import { RequestFailure, staffRequest } from "../staff-request";

const subscribe = () => () => {};

export function LoginForm({ locale, expired }: { locale: Locale; expired: boolean }) {
  const m = messages(locale);
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState(expired ? m.sessionExpired : "");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    // Validated here as well as by the server, so the common mistakes are
    // answered beside the field that caused them rather than at the top.
    const next: { email?: string; password?: string } = {};
    if (!email.trim()) next.email = m.emailRequired;
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      next.email = m.emailMalformed;
    if (!password) next.password = m.passwordRequired;
    setFieldErrors(next);
    if (Object.keys(next).length) return;

    setPending(true);
    setFormError("");
    try {
      // Bounded (Post-Audit Repair Pass 2). Signing in again after a lost
      // answer is harmless: at worst an unused session expires on its own.
      const { data } = await staffRequest<{ redirect: string }>(locale, "/api/v1/auth/password", {
        method: "POST",
        body: { email: email.trim(), password },
      });
      // A full document navigation, not a client transition: the session
      // cookie has just changed and every server component must be re-run.
      location.assign(data.redirect);
      return;
    } catch (e) {
      const f = e instanceof RequestFailure ? e : null;
      // A refusal of the credential keeps its one generic message; only
      // throttling and "the service did not answer" are told apart from it.
      if (f && f.kind === "REJECTED" && f.status === 429) setFormError(m.rateLimited);
      else if (!f || f.kind === "REJECTED" || f.kind === "SESSION") {
        setFormError(f ? m.credentialsInvalid : m.unavailable);
        setPassword("");
      } else setFormError(f.kind === "UNAVAILABLE" ? m.unavailable : f.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      {formError && (
        <Alert tone="danger" role="alert">
          {formError}
        </Alert>
      )}
      <div className="auth-field">
        <label htmlFor={emailId}>{m.emailLabel}</label>
        <input
          id={emailId}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          value={email}
          aria-invalid={fieldErrors.email ? true : undefined}
          aria-describedby={fieldErrors.email ? `${emailId}-error` : undefined}
          onChange={(e) => setEmail(e.target.value)}
          disabled={pending}
        />
        {fieldErrors.email && (
          <p className="field-error" id={`${emailId}-error`}>
            {fieldErrors.email}
          </p>
        )}
      </div>
      <div className="auth-field">
        <label htmlFor={passwordId}>{m.passwordLabel}</label>
        {/* The reveal control sits inside the field's border rather than
            floating over the input, so it never covers the text it reveals and
            is a full 44px target of its own. `type` is swapped on the same
            input so a password manager keeps its binding to one field. */}
        <div className="password-field">
          <input
            id={passwordId}
            name="password"
            type={reveal ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={fieldErrors.password ? `${passwordId}-error` : undefined}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            aria-pressed={reveal}
            disabled={!hydrated || pending}
          >
            {reveal ? m.hidePassword : m.showPassword}
          </button>
        </div>
        {fieldErrors.password && (
          <p className="field-error" id={`${passwordId}-error`}>
            {fieldErrors.password}
          </p>
        )}
      </div>
      <button className="button" type="submit" disabled={!hydrated || pending}>
        {pending ? m.signingIn : m.signInAction}
      </button>
      <p className="visually-hidden" role="status" aria-live="polite">
        {pending ? m.signingIn : ""}
      </p>
    </form>
  );
}
