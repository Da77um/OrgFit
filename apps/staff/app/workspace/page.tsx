/* Full document navigation intentionally clears organization-scoped client state. */
/* eslint-disable @next/next/no-html-link-for-pages */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionCookie } from "../../../../src/auth";
import { withStaff } from "../../../../src/db";
import { localeOf, messages } from "../../../../src/i18n";
import {
  Badge,
  EmptyState,
  ErrorState,
  Label,
  Micro,
  PageHeader,
} from "../../../../src/ui";
import { AccountControls } from "../ui";
import { Frame } from "../shell";
export default async function Home() {
  const jar = await cookies();
  let data;
  try {
    data = await withStaff(
      jar.get(sessionCookie())?.value,
      async (tx, profile) => ({
        profile,
        organizations: await tx
          .selectFrom("core.organization")
          .select(["id", "name_ar", "name_en", "code"])
          .where("status", "=", "ACTIVE")
          .orderBy("name_ar")
          .limit(100)
          .execute(),
      }),
    );
  } catch (e) {
    if (e instanceof Error && e.message === "SESSION_REQUIRED")
      // A stale cookie means the session ended rather than never existed, so the
      // sign-in screen is told to say so instead of showing a bare form.
      redirect(jar.get(sessionCookie())?.value ? "/login?expired=1" : "/login");
    const m = messages(localeOf(jar.get("orgfit-locale")?.value));
    return (
      <main id="main" className="wrap">
        <ErrorState title={m.errorTitle} body={m.unavailable} />
      </main>
    );
  }
  const { profile, organizations } = data,
    m = messages(profile.locale);
  return (
    <Frame
      locale={profile.locale}
      meta={<Micro>{profile.role === "SUPER_ADMIN" ? "SUPER ADMIN" : "STAFF"}</Micro>}
    >
      <PageHeader
        eyebrow={<Label accent>{m.home}</Label>}
        title={`${m.welcome}، ${profile.displayName}`}
        sub={m.scope}
        actions={
          <a className="button button-secondary" href="/questionnaires">
            {m.questionnaires}
          </a>
        }
      />
      <div className="grid">
        <section className="card">
          <div className="card-head">
            <h2>
              <a href="/organizations">{m.organizations}</a>
            </h2>
            <Micro>
              {organizations.length} {organizations.length === 1 ? "ORG" : "ORGS"}
            </Micro>
          </div>
          {organizations.length ? (
            <ul className="orgs">
              {organizations.map((o) => {
                const english = profile.locale === "en" && o.name_en;
                return (
                  <li key={o.id}>
                    <a href={`/organizations/${o.id}/overview`}>
                      <strong lang={english ? "en" : "ar"} dir={english ? "ltr" : "rtl"}>
                        {english ? o.name_en : o.name_ar}
                      </strong>
                      <Micro>{o.code}</Micro>
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState title={m.emptyTitle} body={m.empty} />
          )}
        </section>
        <aside className="card stack">
          <div className="card-head">
            <h2>{m.account}</h2>
          </div>
          <p className="code">{profile.email}</p>
          <p>
            <Badge tone={profile.role === "SUPER_ADMIN" ? "accent" : "neutral"}>
              {profile.role === "SUPER_ADMIN" ? m.admin : m.staff}
            </Badge>
          </p>
          <AccountControls locale={profile.locale} />
        </aside>
      </div>
    </Frame>
  );
}
