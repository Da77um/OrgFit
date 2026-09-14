"use client";
import { useState, useSyncExternalStore } from "react";
import { localeOf, messages, type Locale } from "../../../src/i18n";
import { RequestFailure, staffRequest } from "./staff-request";
import { abortLeave, confirmLeave } from "./unsaved";
export function AccountControls({
  locale,
  guest = false,
}: {
  locale: Locale;
  guest?: boolean;
}) {
  const m = messages(locale),
    [value, setValue] = useState(locale),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  async function change(action: "locale" | "logout") {
    setError("");
    // Both a language change (reload) and signing out discard unsaved edits
    // elsewhere on the page; ask first (Post-Audit Repair Pass 2).
    const decision = await confirmLeave(action === "logout" ? "signout" : "locale", locale);
    if (!decision.go) return;
    setPending(true);
    try {
      await staffRequest(
        locale,
        action === "logout" ? "/api/v1/auth/logout" : guest ? "/api/v1/locale" : "/api/v1/profile",
        {
          method: action === "logout" ? "POST" : guest ? "POST" : "PATCH",
          body: action === "logout" ? {} : { locale: value },
        },
      );
      if (action === "logout") location.assign("/login");
      else if (decision.next) location.assign(decision.next);
      else location.reload();
    } catch (e) {
      abortLeave();
      // Signing out of a session that has already ended has nothing left to do.
      if (e instanceof RequestFailure && e.kind === "SESSION")
        return location.assign(action === "logout" ? "/login" : "/login?expired=1");
      setError(e instanceof Error && e.message ? e.message : m.unavailable);
      setPending(false);
    }
  }
  return (
    <div className="stack">
      <label htmlFor="locale">{m.language}</label>
      <select
        disabled={!hydrated || pending}
        id="locale"
        value={value}
        onChange={(e) => setValue(localeOf(e.target.value))}
      >
        <option value="ar" lang="ar">
          العربية
        </option>
        <option value="en" lang="en">
          English
        </option>
      </select>
      <button disabled={!hydrated || pending} onClick={() => change("locale")}>
        {m.save}
      </button>
      {!guest && (
        <button
          disabled={!hydrated || pending}
          onClick={() => change("logout")}
        >
          {m.logout}
        </button>
      )}
      <p role="status" aria-live="polite">
        {error}
      </p>
    </div>
  );
}
const subscribe = () => () => {};
