"use client";
import { useState, useSyncExternalStore } from "react";
import { messages, type Locale } from "../../../src/i18n";
import { staffRequest, RequestFailure } from "./staff-request";
import { abortLeave, confirmLeave } from "./unsaved";

// The language switch carried by the app bar on every signed-in screen.
//
// It names the OTHER language, in that language, so a reader who cannot read
// the current interface can still find it. The preference is persisted on the
// staff profile first and only then is the page reloaded; a refusal is shown in
// place rather than reloading into the same language as if it had worked.
// An ended session goes to sign-in and says so.
//
// Post-Audit Repair Pass 2: the reload would discard unsaved edits, so it asks
// first (save / discard / keep editing) when a form on the page holds any; the
// request is bounded; and the button stays disabled until the page is
// interactive, so a click before hydration is not silently lost.
const subscribe = () => () => {};
export function LocaleSwitch({ locale }: { locale: Locale }) {
  const m = messages(locale);
  const target: Locale = locale === "ar" ? "en" : "ar";
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState("");
  async function change() {
    setFailed("");
    const decision = await confirmLeave("locale", locale);
    if (!decision.go) return;
    setPending(true);
    try {
      await staffRequest(locale, "/api/v1/profile", {
        method: "PATCH",
        body: { locale: target },
      });
      if (decision.next) location.assign(decision.next);
      else location.reload();
    } catch (e) {
      abortLeave();
      if (e instanceof RequestFailure && e.kind === "SESSION")
        return location.assign("/login?expired=1");
      // Setting a preference twice is harmless, so any failure may be retried.
      setFailed(e instanceof Error && e.message ? e.message : m.unavailable);
      setPending(false);
    }
  }
  return (
    <span className="appbar-locale">
      <button
        type="button"
        className="button-small button-on-dark"
        lang={target}
        disabled={!hydrated || pending}
        aria-busy={pending || undefined}
        onClick={change}
        data-testid="appbar-locale"
      >
        {target === "en" ? "English" : "العربية"}
      </button>
      {failed && (
        <span role="alert" className="appbar-locale-error">
          {failed}
        </span>
      )}
    </span>
  );
}
