import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionCookie } from "../../../src/auth";
import { withStaff, type Profile, type Tx } from "../../../src/db";
import { localeOf, messages } from "../../../src/i18n";
import { adminMessages } from "../../../src/admin-i18n";
import { DeniedState, ErrorState } from "../../../src/ui";
import { AdminFrame, type AdminSection } from "./shell";

// The server half of every administration and account page.
//
// The session is resolved here, before anything renders. An administrator-only
// page checks the role here as well, and a staff member who is not a Super Admin
// receives the permission-denied state with no data loaded at all — the
// client component that would fetch it is never sent. The API and the database
// routines refuse the same request independently.
export async function accountPage<T>({
  section,
  adminOnly,
  load,
  render,
}: {
  section: AdminSection;
  adminOnly: boolean;
  load: (tx: Tx, profile: Profile) => Promise<T>;
  render: (profile: Profile, data: T) => ReactNode;
}) {
  const jar = await cookies();
  let result: { profile: Profile; data: T | null };
  try {
    result = await withStaff(jar.get(sessionCookie())?.value, async (tx, profile) => ({
      profile,
      data: adminOnly && profile.role !== "SUPER_ADMIN" ? null : await load(tx, profile),
    }));
  } catch (e) {
    if (e instanceof Error && e.message === "SESSION_REQUIRED")
      redirect(jar.get(sessionCookie())?.value ? "/login?expired=1" : "/login");
    const m = messages(localeOf(jar.get("orgfit-locale")?.value));
    return (
      <main id="main" className="wrap">
        <ErrorState
          title={m.errorTitle}
          body={m.unavailable}
          action={<a href="/workspace">{m.backHome}</a>}
        />
      </main>
    );
  }
  const { profile, data } = result;
  const a = adminMessages(profile.locale);
  return (
    <AdminFrame locale={profile.locale} role={profile.role} section={section}>
      {data === null ? (
        <>
          <h1 className="page-title">{a.adminOnlyTitle}</h1>
          <DeniedState
            title={a.adminOnlyTitle}
            body={a.adminOnlyBody}
            action={<a href="/workspace">{a.navWorkspace}</a>}
          />
        </>
      ) : (
        render(profile, data)
      )}
    </AdminFrame>
  );
}
