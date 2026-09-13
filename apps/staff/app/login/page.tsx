/* OIDC initiation must be a document navigation, never a prefetched client route. */
/* eslint-disable @next/next/no-html-link-for-pages */
// ---------------------------------------------------------------------------
// Staff sign in.
//
// Two real paths, and which ones are offered is decided by the installation
// rather than by this file:
//
//   * The identity provider, offered whenever OIDC configuration is present.
//     This is the production path and is unchanged from Phase 02.
//   * Email and password, offered only where the database's local access
//     switch is on — see db/migrations/016_local_access.sql. In a database
//     where it is off, the form is not rendered at all and a request to the
//     endpoint is refused by the routine, not by this page.
//
// The page is part of the same visual system as the overview page: same
// chrome, same lockup, same limestone, same single clay accent on the card's
// top rule.
// ---------------------------------------------------------------------------

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionCookie } from "../../../../src/auth";
import { readConfig } from "../../../../src/config";
import { withStaff } from "../../../../src/db";
import { localAccessEnabled } from "../../../../src/local-auth";
import { localeOf, messages } from "../../../../src/i18n";
import { landing } from "../../../../src/landing-i18n";
import { Alert } from "../../../../src/ui";
import "../../../../src/landing.css";
import { LanguageSwitch, SiteBrand } from "../landing-ui";
import { IconBack } from "../figures";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const jar = await cookies();
  const locale = localeOf(jar.get("orgfit-locale")?.value);
  const m = messages(locale);
  const c = landing(locale);
  const params = await searchParams;

  let provider = true;
  try {
    readConfig();
  } catch {
    provider = false;
  }

  // Somebody who already has a session does not need this screen. The cookie
  // name comes from configuration, so without configuration there is no
  // session to look for — and the page must still render its unavailable state
  // rather than fail (found by running the production build unconfigured).
  const token = provider ? jar.get(sessionCookie())?.value : undefined;
  if (token) {
    try {
      await withStaff(token, async (_tx, p) => p);
      redirect("/workspace");
    } catch (e) {
      // `redirect` throws by design; anything else means there is no usable
      // session and the form below is exactly what the caller needs.
      if (e && typeof e === "object" && "digest" in e) throw e;
    }
  }

  const local = provider && (await localAccessEnabled());
  const expired = params.expired === "1";

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
          <h1>{m.loginTitle}</h1>
          <p>{m.loginLead}</p>

          {local ? (
            <LoginForm locale={locale} expired={expired} />
          ) : (
            provider && (
              <Alert tone="warning" role="status">
                {m.localAccessOff}
              </Alert>
            )
          )}

          {local && provider && <div className="auth-divider">{m.providerOr}</div>}

          {provider ? (
            <p>
              <a className="button button-secondary" href="/api/v1/auth/start">
                {m.signin}
              </a>
            </p>
          ) : (
            !local && (
              <Alert tone="danger" role="alert">
                {m.unavailable}
              </Alert>
            )
          )}

          {/* The one thing this screen says about accounts. It does not offer a
              registration link, because there is no public registration. */}
          <p className="auth-foot">{m.loginHelp}</p>
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
