import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionCookie } from "../../../../../src/auth";
import { withStaff } from "../../../../../src/db";
import { instrumentAccess } from "../../../../../src/instruments";
import { uuid } from "../../../../../src/security";
import { localeOf, messages } from "../../../../../src/i18n";
import { QuestionnairesLoading } from "../../loading-ui";
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
  // The chrome streams at once; the session check and every query resolve
  // behind this boundary.
  return (
    <Suspense
      key={[organization, ...path].join("/")}
      fallback={
        <QuestionnairesLoading locale={localeOf(jar.get("orgfit-locale")?.value)} />
      }
    >
      <InstrumentScreen path={path} organization={organization} />
    </Suspense>
  );
}

async function InstrumentScreen({
  path,
  organization,
}: {
  path: string[];
  organization?: string;
}) {
  const jar = await cookies();
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
      // A stale cookie means the session ended rather than never existed, so the
      // sign-in screen is told to say so instead of showing a bare form.
      redirect(jar.get(sessionCookie())?.value ? "/login?expired=1" : "/login");
    const m = messages(localeOf(jar.get("orgfit-locale")?.value));
    return (
      <main id="main" className="wrap">
        <p role="alert">
          {e instanceof Error && e.message === "NOT_FOUND"
            ? m.notFound
            : m.unavailable}
        </p>
        <a href="/workspace">{m.home}</a>
      </main>
    );
  }
}
