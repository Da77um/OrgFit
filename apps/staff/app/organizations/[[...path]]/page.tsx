/* Full document navigation intentionally clears organization-scoped client state. */
/* eslint-disable @next/next/no-html-link-for-pages */
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { sessionCookie } from "../../../../../src/auth";
import { withStaff, requireAccess } from "../../../../../src/db";
import { uuid } from "../../../../../src/security";
import { directoryGet } from "../../../../../src/directory";
import { localeOf, messages } from "../../../../../src/i18n";
import { Directory } from "../directory-ui";
import { Campaigns } from "../campaigns-ui";
import { Results } from "../results-ui";
import { History } from "../history-ui";
import { Visits } from "../visits-ui";
export default async function DirectoryPage({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path = [] } = await params,
    jar = await cookies();
  if (path.length > 3 || (path[0] && !uuid.safeParse(path[0]).success))
    notFound();
  if (
    path[1] &&
    ![
      "overview",
      "settings",
      "departments",
      "participants",
      "assessments",
      "campaigns",
      "results",
      "history",
      "visits",
    ].includes(path[1])
  )
    notFound();
  if (
    path[2] &&
    (!["participants", "campaigns", "results", "history", "visits"].includes(
      path[1],
    ) ||
      (path[2] !== "import" && !uuid.safeParse(path[2]).success))
  )
    notFound();
  try {
    const data = await withStaff(
      jar.get(sessionCookie())?.value,
      async (tx, profile) => {
        if (path[0])
          await requireAccess(
            tx,
            path[0],
            ["departments", "participants"].includes(path[1])
              ? "directory.manage"
              : undefined,
          );
        return {
          profile,
          organization: path[0]
            ? await directoryGet(tx, "organization", path[0], path[0])
            : null,
        };
      },
    );
    return path[1] === "visits" ? (
      <Visits key={path.join("/")} path={path} {...data} />
    ) : path[1] === "history" ? (
      <History key={path.join("/")} path={path} {...data} />
    ) : path[1] === "results" ? (
      <Results key={path.join("/")} path={path} {...data} />
    ) : ["assessments", "campaigns"].includes(path[1] ?? "") ? (
      <Campaigns key={path.join("/")} path={path} {...data} />
    ) : (
      <Directory key={path.join("/")} path={path} {...data} />
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
            : e instanceof Error && e.message === "FORBIDDEN"
              ? m.forbidden
              : m.unavailable}
        </p>
        <a href="/">{m.home}</a>
      </main>
    );
  }
}
