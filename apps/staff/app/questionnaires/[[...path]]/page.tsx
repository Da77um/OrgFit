/* eslint-disable @next/next/no-html-link-for-pages */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionCookie } from "../../../../../src/auth";
import { withStaff } from "../../../../../src/db";
import { instrumentAccess } from "../../../../../src/instruments";
import { uuid } from "../../../../../src/security";
import { localeOf, messages } from "../../../../../src/i18n";
import { InstrumentWorkspace } from "../workspace";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<{ organization?: string }>;
}) {
  const jar = await cookies(),
    { path = [] } = await params,
    { organization } = await searchParams;
  try {
    const org = organization ? uuid.parse(organization) : null;
    const data = await withStaff(
      jar.get(sessionCookie())?.value,
      async (tx, profile) => {
        await instrumentAccess(tx, org);
        return {
          profile,
          organizations: await tx
            .selectFrom("core.organization")
            .select(["id", "name_ar", "name_en"])
            .where("status", "=", "ACTIVE")
            .execute(),
        };
      },
    );
    return (
      <InstrumentWorkspace
        key={[org, ...path].join("/")}
        {...data}
        org={org}
        path={path}
      />
    );
  } catch (e) {
    if (e instanceof Error && e.message === "SESSION_REQUIRED")
      redirect("/login");
    const m = messages(localeOf(jar.get("orgfit-locale")?.value));
    return (
      <main id="main" className="wrap">
        <p role="alert">
          {e instanceof Error && e.message === "NOT_FOUND"
            ? m.notFound
            : m.unavailable}
        </p>
        <a href="/">{m.home}</a>
      </main>
    );
  }
}
