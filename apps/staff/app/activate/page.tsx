/* Full document navigation intentionally clears any prior client state. */
/* eslint-disable @next/next/no-html-link-for-pages */
// ---------------------------------------------------------------------------
// Staff account activation.
//
// The shell is a server component so the page shares the public chrome and the
// document's language and direction; everything that touches the invitation is
// in the client form, because the token lives in the URL fragment and never
// reaches the server as part of the request.
//
// There is no public registration route in this product and this is not one.
// Without an invitation the screen states, in the reader's language, that
// accounts are created by invitation from OrgFit administration, and offers no
// form at all.
// ---------------------------------------------------------------------------

import { cookies } from "next/headers";
import { localeOf, messages } from "../../../../src/i18n";
import { landing } from "../../../../src/landing-i18n";
import "../../../../src/landing.css";
import { LanguageSwitch, SiteBrand } from "../landing-ui";
import { IconBack } from "../figures";
import { ActivateForm } from "./activate-form";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "OrgFit",
  robots: { index: false, follow: false },
};

export default async function Activate() {
  const locale = localeOf((await cookies()).get("orgfit-locale")?.value);
  const m = messages(locale);
  const c = landing(locale);
  return (
    <div className="landing auth-page">
      <header className="site-header">
        <div className="site-header-inner">
          <SiteBrand locale={locale} />
          <div className="site-actions">
            <LanguageSwitch locale={locale} />
          </div>
        </div>
      </header>
      <main id="main" className="auth-main">
        <div className="auth-card">
          <h1>{m.activateTitle}</h1>
          <p>{m.activateLead}</p>
          <ActivateForm locale={locale} />
          <p>
            <a className="auth-back" href="/">
              <IconBack />
              {m.backToSite}
            </a>
          </p>
        </div>
      </main>
      <footer className="site-footer">
        <div className="site-footer-inner">
          <div className="footer-rule">
            <p className="footer-note">{c.footerInternal}</p>
            <p className="footer-note">{c.footerRespondent}</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
