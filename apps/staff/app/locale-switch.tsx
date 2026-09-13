"use client";
import { useState } from "react";
import { messages, type Locale } from "../../../src/i18n";

// The language switch carried by the app bar on every signed-in screen.
//
// It names the OTHER language, in that language, so a reader who cannot read
// the current interface can still find it. The preference is persisted on the
// staff profile first and only then is the page reloaded; a refusal is shown in
// place rather than reloading into the same language as if it had worked.
// An ended session goes to sign-in and says so.
export function LocaleSwitch({ locale }: { locale: Locale }) {
  const m = messages(locale);
  const target: Locale = locale === "ar" ? "en" : "ar";
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function change() {
    setPending(true);
    setFailed(false);
    try {
      const r = await fetch("/api/v1/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: target }),
      });
      if (r.status === 401) return location.assign("/login?expired=1");
      if (!r.ok) throw new Error("unavailable");
      location.reload();
    } catch {
      setFailed(true);
      setPending(false);
    }
  }
  return (
    <span className="appbar-locale">
      <button
        type="button"
        className="button-small button-on-dark"
        lang={target}
        disabled={pending}
        onClick={change}
        data-testid="appbar-locale"
      >
        {target === "en" ? "English" : "العربية"}
      </button>
      {failed && (
        <span role="alert" className="appbar-locale-error">
          {m.unavailable}
        </span>
      )}
    </span>
  );
}
