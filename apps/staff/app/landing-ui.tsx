"use client";
// ---------------------------------------------------------------------------
// The public chrome: the site header with its responsive navigation, and the
// language control that every public screen carries.
//
// The language control is the SAME mechanism the workspace uses — POST
// /api/v1/locale, which sets the host-only `orgfit-locale` cookie and changes
// no identity and no access. That is why the chosen language survives the move
// from the overview page to sign-in, through activation, and into the
// authenticated workspace: one cookie, read by the root layout, and replaced by
// the signed-in profile's own preference once there is one.
// ---------------------------------------------------------------------------

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Mark } from "../../../src/ui";
import { messages, type Locale } from "../../../src/i18n";
import { landing } from "../../../src/landing-i18n";
import { staffRequest } from "./staff-request";

const subscribe = () => () => {};
const useHydrated = () =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

export function LanguageSwitch({ locale }: { locale: Locale }) {
  const m = messages(locale);
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  async function choose(next: Locale) {
    if (next === locale || pending) return;
    setPending(true);
    try {
      await staffRequest(locale, "/api/v1/locale", { method: "POST", body: { locale: next } });
      location.reload();
    } catch {
      setPending(false);
    }
  }
  return (
    <div className="lang-switch" role="group" aria-label={m.language}>
      {(["ar", "en"] as const).map((value) => (
        <button
          key={value}
          type="button"
          lang={value}
          disabled={!hydrated || pending || value === locale}
          aria-current={value === locale}
          onClick={() => choose(value)}
        >
          {value === "ar" ? "العربية" : "English"}
        </button>
      ))}
    </div>
  );
}

export function SiteBrand({ locale, href = "/" }: { locale: Locale; href?: string }) {
  const m = messages(locale);
  return (
    <a className="site-brand" href={href}>
      <Mark className="site-brand-mark" />
      <span className="site-brand-text" aria-hidden="true">
        <span className="site-brand-word">ORGFIT</span>
        <span className="site-brand-descriptor">
          {locale === "en" ? "Organizational assessment" : "التقييم التنظيمي"}
        </span>
      </span>
      <span className="visually-hidden">{m.title}</span>
    </a>
  );
}

export function SiteHeader({ locale }: { locale: Locale }) {
  const c = landing(locale);
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape closes the panel and returns focus to the control that opened it,
  // which is the part a disclosure usually gets wrong.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const items: { href: string; text: string }[] = [
    { href: "#overview", text: c.navOverview },
    { href: "#capabilities", text: c.navCapabilities },
    { href: "#workflow", text: c.navWorkflow },
    { href: "#faq", text: c.navFaq },
  ];

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <SiteBrand locale={locale} />
        <nav className="site-nav" aria-label={c.navMenu}>
          {items.map((item) => (
            <a key={item.href} href={item.href}>
              {item.text}
            </a>
          ))}
        </nav>
        <div className="site-actions site-actions-collapsing">
          <LanguageSwitch locale={locale} />
          <a className="button" href="/login">
            {c.signIn}
          </a>
          <button
            ref={buttonRef}
            type="button"
            className="button button-secondary site-menu-button"
            aria-expanded={open}
            aria-controls={panelId}
            disabled={!hydrated}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? c.navCloseMenu : c.navOpenMenu}
          </button>
        </div>
      </div>
      <div className="site-menu" id={panelId} hidden={!open}>
        <nav aria-label={c.navMenu}>
          {items.map((item) => (
            <a key={item.href} href={item.href} onClick={() => setOpen(false)}>
              {item.text}
            </a>
          ))}
        </nav>
        <LanguageSwitch locale={locale} />
        <a className="button" href="/login">
          {c.signIn}
        </a>
      </div>
    </header>
  );
}
