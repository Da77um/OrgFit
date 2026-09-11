import { cookies } from "next/headers";
import { readConfig } from "../../../../src/config";
import { localeOf, messages } from "../../../../src/i18n";
import { Alert, Mark } from "../../../../src/ui";
import { AccountControls } from "../ui";
/* OIDC initiation must be a document navigation, never a prefetched client route. */
/* eslint-disable @next/next/no-html-link-for-pages */
export default async function Login() {
  const locale = localeOf((await cookies()).get("orgfit-locale")?.value),
    m = messages(locale);
  let configured = true;
  try {
    readConfig();
  } catch {
    configured = false;
  }
  return (
    <main id="main" className="wrap">
      <section className="panel login stack">
        {/* Lockup A at the one place in the product with room for it: the mark,
            the Latin name, and the Arabic descriptor beneath a hairline. The
            accessible name is the product's, not the three parts separately. */}
        <div className="lockup" role="img" aria-label={m.title}>
          <Mark className="lockup-mark" />
          <span className="lockup-text" aria-hidden="true">
            <span className="lockup-word">ORGFIT</span>
            <span className="lockup-rule" />
            <span className="lockup-descriptor">{m.title}</span>
          </span>
        </div>
        <h1>{m.login}</h1>
        <p>{m.intro}</p>
        {configured ? (
          <p>
            <a className="button" href="/api/v1/auth/start">
              {m.signin}
            </a>
          </p>
        ) : (
          <Alert tone="danger" role="alert">
            {m.unavailable}
          </Alert>
        )}
        <div className="rule" />
        <AccountControls locale={locale} guest />
      </section>
    </main>
  );
}
