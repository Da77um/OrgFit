/* Navigation rule. A transition between sections of the SAME organization — the
   rail entries built from `base` in Workspace — is client-side through
   next/link: it stays inside one tenant and one access scope. Every link that
   leaves organization scope (switch organization, questionnaires, workspace,
   profile, the administration rail, sign-out) stays a full document
   navigation, which intentionally clears organization-scoped client state.
   @next/next/no-html-link-for-pages is therefore enforced down to the
   same-organization rail and disabled only from the first link that leaves
   organization scope. */
// ---------------------------------------------------------------------------
// The staff workspace shell.
//
// Before this pass every screen restated its own header as three or four bare
// links in a flex row, and there was no way to tell from the chrome which
// organization you were inside or which section you were in. The layout here
// is the one in section 04 of the signature system: an ink bar carrying the
// lockup and the record's coordinates, a quiet rail of sections, and the work
// itself on limestone.
//
// Two properties matter beyond appearance:
//
//   * The rail is rendered from ONE list, and an entry that requires a
//     permission the viewer does not hold is not rendered at all. The shell
//     never becomes a catalogue of things the viewer cannot open.
//   * <main id="main"> lives here, so every screen has exactly one main
//     landmark and the skip link always lands somewhere.
// ---------------------------------------------------------------------------
import type { ReactNode } from "react";
import Link from "next/link";
import { Label, Lockup, Micro } from "../../../src/ui";
import { messages, type Locale } from "../../../src/i18n";
import { adminMessages } from "../../../src/admin-i18n";
import { LocaleSwitch } from "./locale-switch";
import { UnsavedChangesGuard } from "./unsaved";

export type Section =
  | "overview"
  | "settings"
  | "departments"
  | "participants"
  | "assessments"
  | "results"
  | "history"
  | "visits"
  | "messages";

export type ShellOrganization = {
  id: string;
  code?: string | null;
  name_ar?: string | null;
  name_en?: string | null;
};

export function organizationName(
  organization: ShellOrganization | null | undefined,
  locale: Locale,
) {
  if (!organization) return "";
  return locale === "en" && organization.name_en
    ? organization.name_en
    : (organization.name_ar ?? "");
}

// One shell for a screen that has no organization context: sign-in, the
// workspace home, the questionnaire library.
export function Frame({
  locale,
  context,
  meta,
  children,
  wide = false,
}: {
  locale: Locale;
  context?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const m = messages(locale);
  return (
    <>
      <AppBar locale={locale} context={context} meta={meta} />
      <main id="main" className={wide ? "wrap stack" : "wrap stack"}>
        {children}
      </main>
      <SrOnlyHome label={m.backHome} />
    </>
  );
}

// The organization workspace: bar, rail, canvas.
export function Workspace({
  locale,
  organization,
  section,
  canManage,
  canReadMessages,
  meta,
  children,
}: {
  locale: Locale;
  organization: ShellOrganization | null;
  section: Section;
  canManage: boolean;
  /** messages.read or Super Admin. Required, so no screen can forget to decide. */
  canReadMessages: boolean;
  meta?: ReactNode;
  children: ReactNode;
}) {
  const m = messages(locale);
  const base = organization ? `/organizations/${organization.id}` : "/organizations";
  // The order is the order of the work: understand the organization, describe
  // it, measure it, read the measurement, compare it over time, visit it.
  const groups: { label: string; items: { key: Section; href: string; text: string }[] }[] = [
    {
      label: m.organization,
      items: [
        { key: "overview", href: `${base}/overview`, text: m.navOverview },
        ...(canManage
          ? ([
              { key: "settings", href: `${base}/settings`, text: m.navSettings },
              { key: "departments", href: `${base}/departments`, text: m.navDepartments },
              { key: "participants", href: `${base}/participants`, text: m.navParticipants },
            ] as const)
          : []),
      ],
    },
    {
      label: m.workspaceNav,
      items: [
        { key: "assessments", href: `${base}/assessments`, text: m.navAssessments },
        { key: "history", href: `${base}/history`, text: m.navHistory },
        { key: "visits", href: `${base}/visits`, text: m.navVisits },
        // An entry the viewer cannot open is not rendered at all.
        ...(canReadMessages
          ? ([{ key: "messages", href: `${base}/messages`, text: m.navMessages }] as const)
          : []),
      ],
    },
  ];
  return (
    <>
      <AppBar
        locale={locale}
        context={organizationName(organization, locale) || m.organizations}
        meta={
          <>
            {organization?.code && <Micro>{organization.code}</Micro>}
            {meta}
          </>
        }
      />
      <div className="shell">
        <nav className="rail" aria-label={m.workspaceNav}>
          {/* Same organization: client-side. */}
          {groups.map((group) => (
            <div className="rail-group" key={group.label}>
              <Label className="rail-label">{group.label}</Label>
              {group.items.map((item) => (
                <Link
                  key={item.key}
                  className="rail-link"
                  href={item.href}
                  aria-current={
                    item.key === section ||
                    // The results and reports tabs live under the assessments
                    // route, so both mark the same rail entry.
                    (item.key === "assessments" && section === "results")
                      ? "page"
                      : undefined
                  }
                >
                  {item.text}
                </Link>
              ))}
            </div>
          ))}
          {/* Leaves organization scope: document navigation. */}
          {/* eslint-disable @next/next/no-html-link-for-pages */}
          <div className="rail-group">
            <a className="rail-link" href="/organizations">
              {m.switchOrganization}
            </a>
            <a className="rail-link" href="/questionnaires">
              {m.questionnaires}
            </a>
            <a className="rail-link" href="/workspace">
              {m.home}
            </a>
            <a className="rail-link" href="/profile">
              {adminMessages(locale).navProfile}
            </a>
          </div>
        </nav>
        <main id="main" className="canvas stack">
          {children}
        </main>
      </div>
    </>
  );
}

// The administration and account shell: the same bar and rail as an
// organization workspace, with no organization in context. The administration
// group is rendered only for a Super Admin — a convenience, never the boundary:
// each page and every API routine refuses a non-administrator on its own.
export type AdminSection = "staff" | "audit" | "settings" | "profile";
export function AdminFrame({
  locale,
  role,
  section,
  children,
}: {
  locale: Locale;
  role: "SUPER_ADMIN" | "STAFF";
  section: AdminSection;
  children: ReactNode;
}) {
  const a = adminMessages(locale);
  const admin: { key: AdminSection; href: string; text: string }[] = [
    { key: "staff", href: "/staff", text: a.navStaff },
    { key: "audit", href: "/audit", text: a.navAudit },
    { key: "settings", href: "/settings", text: a.navSettings },
  ];
  return (
    <>
      <AppBar
        locale={locale}
        context={section === "profile" ? a.navProfile : a.administration}
        meta={<Micro>{role === "SUPER_ADMIN" ? "SUPER ADMIN" : "STAFF"}</Micro>}
      />
      <div className="shell">
        <nav className="rail" aria-label={a.adminNav}>
          {role === "SUPER_ADMIN" && (
            <div className="rail-group">
              <Label className="rail-label">{a.administration}</Label>
              {admin.map((item) => (
                <a
                  key={item.key}
                  className="rail-link"
                  href={item.href}
                  aria-current={item.key === section ? "page" : undefined}
                >
                  {item.text}
                </a>
              ))}
            </div>
          )}
          <div className="rail-group">
            <a
              className="rail-link"
              href="/profile"
              aria-current={section === "profile" ? "page" : undefined}
            >
              {a.navProfile}
            </a>
            <a className="rail-link" href="/workspace">
              {a.navWorkspace}
            </a>
            <a className="rail-link" href="/organizations">
              {a.navOrganizations}
            </a>
            <a className="rail-link" href="/questionnaires">
              {a.navQuestionnaires}
            </a>
          </div>
        </nav>
        <main id="main" className="canvas stack">
          {children}
        </main>
      </div>
    </>
  );
}

export function AppBar({
  locale,
  context,
  meta,
}: {
  locale: Locale;
  context?: ReactNode;
  meta?: ReactNode;
}) {
  const m = messages(locale);
  return (
    <header className="appbar">
      <div className="appbar-inner">
        <div className="row" role="none">
          <Lockup href="/workspace" label={m.title} />
          {context && (
            <>
              <span className="appbar-divider" aria-hidden="true" />
              <span className="appbar-context">{context}</span>
            </>
          )}
        </div>
        <div className="appbar-meta">
          {meta}
          {/* Reachable from every signed-in screen, not only the home page. */}
          <LocaleSwitch locale={locale} />
        </div>
      </div>
      {/* One unsaved-changes guard per signed-in screen (Post-Audit Repair
          Pass 2): the language switch, sign-out and page links ask through it. */}
      <UnsavedChangesGuard locale={locale} />
    </header>
  );
}

// A screen reached from a bare URL should always offer one way back that does
// not depend on the browser's history.
function SrOnlyHome({ label }: { label: string }) {
  return (
    <p className="visually-hidden">
      <a href="/workspace">{label}</a>
    </p>
  );
}
