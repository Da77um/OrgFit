"use client";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { messages, type Locale } from "../../../src/i18n";
import { Alert } from "../../../src/ui";

// Unsaved edits on staff screens (Post-Audit Repair Pass 2, audit finding 5).
//
// A form that holds edits the server has not confirmed registers itself here.
// While anything is registered:
//
//   * the language switch, sign-out and every same-origin link ask first, in
//     the reader's language, with Save and continue / Discard / Keep editing;
//   * a reload, a typed address or closing the tab gets the browser's own
//     "leave site?" prompt (the only prompt a browser allows there).
//
// A registration is released when the form reports it clean — after the
// server CONFIRMED the save, never when the request was merely sent — or when
// the form unmounts. The registry holds callbacks only: no field value is kept
// here, in the address or in browser storage.

export type SaveOutcome = { ok: true; next?: string } | { ok: false };
type Entry = { save?: () => Promise<SaveOutcome> };
export type LeaveIntent = "locale" | "navigate" | "signout";
export type LeaveDecision = { go: true; next?: string } | { go: false };

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
let leaving = false;
let host: ((intent: LeaveIntent) => Promise<LeaveDecision>) | null = null;
const notify = () => {
  version++;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const hasUnsavedChanges = () => entries.size > 0;

/** Register `dirty` edits for as long as they are dirty. */
export function useUnsavedChanges(dirty: boolean, save?: () => Promise<SaveOutcome>) {
  const id = useId();
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  const canSave = save !== undefined;
  useEffect(() => {
    if (!dirty) return;
    // New edits after a cancelled or failed departure are protected again.
    leaving = false;
    entries.set(id, {
      save: canSave ? () => saveRef.current!() : undefined,
    });
    notify();
    return () => {
      entries.delete(id);
      notify();
    };
  }, [dirty, canSave, id]);
}

/**
 * Dirty state of an uncontrolled form: its current fields compared with the
 * snapshot taken when the form element attached (or when `markClean` was last
 * called), so typing a value back to what it was is clean again. Spread
 * `bind` onto the <form>; `form` is its element for validation and reading.
 * Controlled parts of a form (checkbox lists without names) are passed in as
 * `extra` and compared the same way.
 */
export function useFormDirty(extra = "") {
  const form = useRef<HTMLFormElement | null>(null);
  const baseline = useRef<string | null>(null);
  const extraRef = useRef(extra);
  const [dirty, setDirty] = useState(false);
  const snapshot = useCallback(() => {
    const el = form.current;
    if (!el) return "";
    return JSON.stringify([
      [...new FormData(el)].map(([k, v]) => [k, typeof v === "string" ? v : `${v.name}:${v.size}`]),
      extraRef.current,
    ]);
  }, []);
  const check = useCallback(() => {
    if (!form.current) return;
    if (baseline.current === null) baseline.current = snapshot();
    setDirty(snapshot() !== baseline.current);
  }, [snapshot]);
  const ref = useCallback(
    (node: HTMLFormElement | null) => {
      form.current = node;
      baseline.current = node ? snapshot() : null;
      if (!node) setDirty(false);
    },
    [snapshot],
  );
  useEffect(() => {
    extraRef.current = extra;
    check();
  }, [extra, check]);
  const markClean = useCallback(() => {
    baseline.current = snapshot();
    setDirty(false);
  }, [snapshot]);
  return { dirty, markClean, form, bind: { ref, onInput: check, onChange: check } };
}
/**
 * Ask before an action that would discard registered edits. Resolves at once
 * when nothing is registered.
 */
export async function confirmLeave(intent: LeaveIntent, locale: Locale): Promise<LeaveDecision> {
  if (!entries.size) return { go: true };
  if (host) return host(intent);
  // No dialog host on this screen: the plain, still localized, confirmation.
  const m = messages(locale);
  const ok = window.confirm(
    `${m.unsavedTitle}\n${intent === "locale" ? m.unsavedLocale : intent === "signout" ? m.unsavedSignOut : m.unsavedNavigate}`,
  );
  if (ok) releaseAll();
  return ok ? { go: true } : { go: false };
}

// A discard does not forget the registrations: if the action that follows
// fails (the language could not be saved), the edits are still on the page and
// `abortLeave` makes them protected again.
function releaseAll() {
  leaving = true;
}

/** The departure that was confirmed did not happen. */
export function abortLeave() {
  leaving = false;
}

/** Navigate after a confirmed save without tripping the unload prompt. */
export function navigateAfterSave(url: string) {
  leaving = true;
  location.assign(url);
}

/**
 * Mounted once per signed-in screen (in the app bar). Owns the dialog, the
 * link interception and the unload prompt.
 */
export function UnsavedChangesGuard({ locale }: { locale: Locale }) {
  const m = messages(locale);
  const dialog = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const [intent, setIntent] = useState<LeaveIntent>("navigate");
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const pending = useRef<((d: LeaveDecision) => void) | null>(null);
  const returnFocus = useRef<Element | null>(null);
  useSyncExternalStore(subscribe, () => version, () => 0);
  const canSave = [...entries.values()].every((e) => e.save);

  const finish = useCallback((decision: LeaveDecision) => {
    const resolve = pending.current;
    pending.current = null;
    dialog.current?.close();
    setSaving(false);
    setSaveFailed(false);
    if (!decision.go && returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
    resolve?.(decision);
  }, []);

  useEffect(() => {
    host = (next) =>
      new Promise<LeaveDecision>((resolve) => {
        // A second request while the dialog is open answers the first "stay".
        pending.current?.({ go: false });
        pending.current = resolve;
        returnFocus.current = document.activeElement;
        setIntent(next);
        setSaveFailed(false);
        if (!dialog.current?.open) dialog.current?.showModal();
        requestAnimationFrame(() => stay.current?.focus());
      });
    return () => {
      host = null;
    };
  }, []);

  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (leaving || !entries.size) return;
      e.preventDefault();
      e.returnValue = "";
    };
    // Capture phase, so the question is asked before any other click handler
    // starts a navigation. Only a plain same-origin page link is intercepted:
    // new tabs, downloads, API file links and in-page anchors leave nothing.
    const click = (e: MouseEvent) => {
      if (!entries.size || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      if ((link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
      if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
      e.preventDefault();
      void confirmLeave("navigate", locale).then((d) => {
        if (d.go) {
          leaving = true;
          location.assign(url.href);
        }
      });
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    };
  }, [locale]);

  async function saveAll() {
    setSaving(true);
    setSaveFailed(false);
    let next: string | undefined;
    for (const [id, entry] of [...entries]) {
      let outcome: SaveOutcome = { ok: false };
      try {
        outcome = entry.save ? await entry.save() : { ok: false };
      } catch {
        outcome = { ok: false };
      }
      if (!outcome.ok) {
        setSaving(false);
        setSaveFailed(true);
        return;
      }
      next = outcome.next ?? next;
      entries.delete(id);
    }
    leaving = true;
    notify();
    finish({ go: true, next });
  }

  const body =
    intent === "locale" ? m.unsavedLocale : intent === "signout" ? m.unsavedSignOut : m.unsavedNavigate;
  return (
    <dialog
      ref={dialog}
      className="modal unsaved-dialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="unsaved-dialog"
      onCancel={(e) => {
        // Escape means "keep editing", and never while a save is running.
        e.preventDefault();
        if (!saving) finish({ go: false });
      }}
    >
      <div className="modal-head">
        <h2 id={titleId}>{m.unsavedTitle}</h2>
      </div>
      <div className="stack">
        <p id={bodyId}>{body}</p>
        {!canSave && <p className="field-hint">{m.unsavedNoSave}</p>}
        {saveFailed && (
          <Alert tone="danger" role="alert">
            {m.unsavedSaveFailed}
          </Alert>
        )}
        <p role="status" aria-live="polite" className="muted">
          {saving ? m.unsavedSaving : ""}
        </p>
      </div>
      <div className="modal-actions">
        {canSave && (
          <button type="button" disabled={saving} onClick={() => void saveAll()}>
            {m.unsavedSave}
          </button>
        )}
        <button
          type="button"
          className="button-secondary"
          disabled={saving}
          onClick={() => {
            releaseAll();
            finish({ go: true });
          }}
        >
          {m.unsavedDiscard}
        </button>
        <button
          ref={stay}
          type="button"
          className="button-quiet"
          disabled={saving}
          onClick={() => finish({ go: false })}
        >
          {m.unsavedStay}
        </button>
      </div>
    </dialog>
  );
}
