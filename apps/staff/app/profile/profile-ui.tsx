"use client";
import { useCallback, useEffect, useState } from "react";
import type { Profile } from "../../../../src/db";
import { adminMessages, fill } from "../../../../src/admin-i18n";
import { messages, type Locale } from "../../../../src/i18n";
import { Alert, Badge, ErrorState, LoadingState, Num, PageHeader } from "../../../../src/ui";
import { errorText, useApi, useHydrated, utc } from "../admin-client";
import { ConfirmAction } from "../admin-controls";
import { ChangeProblem, silent, type ChangeFailure } from "../request-ui";
import { AccountControls } from "../ui";

type Session = {
  id: string;
  authMethod: "OIDC" | "PASSWORD";
  mfaVerified: boolean;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  current: boolean;
};

// The caller's own account. Every session operation here is scoped by the
// server to the signed-in account (access.my_sessions and friends take no
// staff id), so nothing on this screen can reach anyone else's session.
export function ProfileScreen({
  profile,
  organizations,
  accountUrl,
}: {
  profile: Profile;
  organizations: { id: string; code: string; name_ar: string; name_en: string | null }[];
  accountUrl: string | null;
}) {
  const locale: Locale = profile.locale;
  const a = adminMessages(locale);
  const m = messages(locale);
  const api = useApi(locale);
  const hydrated = useHydrated();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ChangeFailure | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions((await api<{ items: Session[] }>("profile/sessions")).items);
      setError("");
    } catch (e) {
      if (!silent(e)) setError(errorText(e, m.unavailable));
    }
  }, [api, m.unavailable]);
  useEffect(() => {
    void load();
  }, [load]);

  // Ending a session is safe to send again: a retry after a lost answer re-sends
  // the same attempt, and "Check the current state" reloads the session list.
  const act = async (scope: string, work: (again: boolean) => Promise<string>, again = false) => {
    setBusy(true);
    setProblem(null);
    setNote("");
    try {
      setNote(await work(again));
      await load();
    } catch (e) {
      if (!silent(e)) setProblem({ failure: e, scope, retry: () => void act(scope, work, true) });
    } finally {
      setBusy(false);
    }
  };

  if (!hydrated) return <LoadingState label={a.loading} />;
  const current = sessions?.find((s) => s.current);
  const others = sessions?.filter((s) => !s.current) ?? [];

  return (
    <>
      <PageHeader title={a.profileTitle} sub={a.profileLead} />
      <div className="grid">
        <section className="card stack" aria-labelledby="account-heading">
          <h2 id="account-heading">{a.accountTitle}</h2>
          <dl className="facts">
            <dt>{a.displayName}</dt>
            <dd>{profile.displayName}</dd>
            <dt>{a.email}</dt>
            <dd><bdi dir="ltr">{profile.email}</bdi></dd>
            <dt>{a.role}</dt>
            <dd><Badge tone={profile.role === "SUPER_ADMIN" ? "accent" : "neutral"}>{a[profile.role]}</Badge></dd>
            <dt>{a.capabilities}</dt>
            <dd>
              {profile.role === "SUPER_ADMIN"
                ? a.adminHasAll
                : profile.capabilities.length
                  ? profile.capabilities.map((c) => a[c]).join(locale === "en" ? ", " : "، ")
                  : a.none}
            </dd>
            <dt>{a.organizations}</dt>
            <dd>
              {profile.role === "SUPER_ADMIN" ? (
                a.adminHasAll
              ) : organizations.length ? (
                <ul className="plain-list">
                  {organizations.map((o) => {
                    const english = locale === "en" && o.name_en;
                    return (
                      <li key={o.id}>
                        <a href={`/organizations/${o.id}/overview`} lang={english ? "en" : "ar"} dir={english ? "ltr" : "rtl"}>
                          {english ? o.name_en : o.name_ar}
                        </a>{" "}
                        <bdi dir="ltr" className="muted">{o.code}</bdi>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                a.none
              )}
            </dd>
          </dl>
        </section>
        <aside className="card stack" aria-labelledby="language-heading">
          <h2 id="language-heading">{a.languageTitle}</h2>
          {/* The existing account controls: saving the language and signing out
              behave exactly as they do on the workspace home. */}
          <AccountControls locale={locale} />
        </aside>
      </div>

      <section className="card stack" aria-labelledby="security-heading">
        <h2 id="security-heading">{a.securityTitle}</h2>
        {current?.authMethod === "PASSWORD" ? (
          <Alert tone="warning" role="note">{a.passwordAccount}</Alert>
        ) : (
          <>
            <p>{a.providerManaged}</p>
            {accountUrl ? (
              <p>
                <a className="button button-secondary" href={accountUrl} rel="noopener noreferrer" target="_blank">
                  {a.providerLink}
                </a>
              </p>
            ) : (
              <p className="field-hint">{a.providerNoLink}</p>
            )}
          </>
        )}
      </section>

      <section className="stack" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">{a.mySessions}</h2>
        <p className="page-sub">{a.mySessionsLead}</p>
        {error && <ErrorState title={m.errorTitle} body={error} action={<button type="button" onClick={() => void load()}>{m.retry}</button>} />}
        <ChangeProblem
          locale={locale}
          problem={problem}
          ledger={api.ledger}
          busy={busy}
          onCheck={() => void load()}
          onDismiss={() => setProblem(null)}
        />
        {note && <Alert tone="success">{note}</Alert>}
        {!sessions && !error && <LoadingState label={a.loading} />}
        {sessions && (
          <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="sessions-heading">
            <table className="result-table admin-table">
              <caption className="visually-hidden">{a.sessionsCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{a.started}</th>
                  <th scope="col">{a.lastActive}</th>
                  <th scope="col">{a.authMethod}</th>
                  <th scope="col">{a.mfa}</th>
                  <th scope="col">{a.absoluteExpires}</th>
                  <th scope="col"><span className="visually-hidden">{a.endSession}</span></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <th scope="row">
                      <Num>{utc(s.createdAt, locale)}</Num>
                      {s.current && (
                        <>
                          {" "}
                          <Badge tone="accent">{a.currentSession}</Badge>
                        </>
                      )}
                    </th>
                    <td><Num>{utc(s.lastSeenAt, locale)}</Num></td>
                    <td>{a[s.authMethod]}</td>
                    <td>
                      <Badge tone={s.mfaVerified ? "positive" : "caution"}>
                        {s.mfaVerified ? a.mfaVerified : a.mfaNotVerified}
                      </Badge>
                    </td>
                    <td><Num>{utc(s.absoluteExpiresAt, locale)}</Num></td>
                    <td>
                      {!s.current && (
                        <button
                          type="button"
                          className="button-small button-secondary"
                          disabled={busy}
                          onClick={() =>
                            void act(`session-revoke:${s.id}`, async (again) => {
                              const scope = `session-revoke:${s.id}`;
                              await (again
                                ? api.retry(scope)
                                : api(`profile/sessions/${s.id}/revoke`, { method: "POST", scope }));
                              return a.sessionEnded;
                            })
                          }
                        >
                          {a.endSession}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="field-hint">{a.timesUtc}</p>
        {sessions && others.length === 0 ? (
          <p className="muted">{a.noOtherSessions}</p>
        ) : (
          sessions && (
            <ConfirmAction
              a={a}
              label={a.endOthers}
              confirmLabel={a.confirm}
              disabled={busy}
              onConfirm={() =>
                act("sessions-revoke-others", async (again) => {
                  const scope = "sessions-revoke-others";
                  const r = again
                    ? await api.retry<{ revoked: number }>(scope)
                    : await api<{ revoked: number }>("profile/sessions/revoke-others", { method: "POST", scope });
                  return fill(a.othersEnded, { n: r.revoked });
                })
              }
            />
          )
        )}
      </section>
    </>
  );
}
