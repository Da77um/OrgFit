"use client";
import { useParams } from "next/navigation";
import { LoadingState } from "../../../src/ui";
import { messages, type Locale } from "../../../src/i18n";
import { AppBar, Frame, Workspace, type Section } from "./shell";

// What a staff screen shows while its records load. It is the fallback of the
// segment's loading.tsx and of the Suspense boundary around the database work
// in the catch-all page, so the chrome paints on the click instead of the
// previous page sitting frozen until every query has returned.
//
// Nothing here reads a record. The rail is rebuilt from the address alone, so
// the organization's name is not known yet, and the entries that need the
// directory permission are left out: the loading chrome never offers an entry
// the viewer may not hold. The screen's own shell replaces it once resolved.

const sections: Record<string, Section> = {
  overview: "overview",
  settings: "settings",
  departments: "departments",
  participants: "participants",
  assessments: "assessments",
  campaigns: "assessments",
  results: "results",
  history: "history",
  visits: "visits",
};

export function OrganizationLoading({ locale }: { locale: Locale }) {
  const m = messages(locale);
  const params = useParams<{ path?: string[] | string }>();
  const path = [params?.path ?? []].flat();
  const status = <LoadingState label={m.loading} />;
  if (!path[0])
    return (
      <Frame locale={locale} context={m.organizations}>
        {status}
      </Frame>
    );
  return (
    <Workspace
      locale={locale}
      organization={{ id: path[0] }}
      section={sections[path[1] ?? "overview"] ?? "overview"}
      canManage={false}
    >
      {status}
    </Workspace>
  );
}

export function QuestionnairesLoading({ locale }: { locale: Locale }) {
  const m = messages(locale);
  return (
    <>
      <AppBar locale={locale} context={m.questionnaires} />
      <main id="main" className="wrap instrument-workspace">
        <LoadingState label={m.loading} />
      </main>
    </>
  );
}
