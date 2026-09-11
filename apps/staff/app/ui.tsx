"use client";
import { useState, useSyncExternalStore } from "react";
import { localeOf, messages, type Locale } from "../../../src/i18n";
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
    setPending(true);
    setError("");
    try {
      const r = await fetch(
        action === "logout"
          ? "/api/v1/auth/logout"
          : guest
            ? "/api/v1/locale"
            : "/api/v1/profile",
        {
          method: action === "logout" ? "POST" : guest ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action === "logout" ? {} : { locale: value }),
        },
      );
      if (!r.ok) throw new Error("unavailable");
      if (action === "logout") location.assign("/login");
      else location.reload();
    } catch {
      setError(m.unavailable);
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
