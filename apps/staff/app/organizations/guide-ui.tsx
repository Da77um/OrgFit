/* Full document navigation intentionally clears organization-scoped state. */
"use client";
// Next-step explanations (D-189): the results index, the overview's
// getting-started checklist. Both read real counts from the read-only
// campaign-status route; a count the reader may not see is said to be hidden,
// never shown as zero.
import { useEffect, useState, useSyncExternalStore } from "react";
import { staffRequest } from "../staff-request";
import { redirectIfClean, silent } from "../request-ui";
import type { Profile } from "../../../../src/db";
import type { DirectoryRecord } from "../../../../src/directory";
import type { CampaignStatus, CampaignStatusItem } from "../../../../src/campaign-guide";
import { campaignMessages, fill } from "../../../../src/campaign-i18n";
import { messages, type Locale } from "../../../../src/i18n";
import { Badge, EmptyState, ErrorState, Label, LoadingState, PageHeader } from "../../../../src/ui";
import { Workspace, organizationName } from "../shell";

const subscribe = () => () => {};
type M = ReturnType<typeof campaignMessages>;

export function useCampaignStatus(org: string, locale: Locale) {
  const [status, setStatus] = useState<CampaignStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void staffRequest<CampaignStatus>(locale, `/api/v1/organizations/${org}/campaign-status`)
      .then((r) => setStatus(r.data))
      .catch((e) => {
        redirectIfClean(e);
        if (!silent(e)) setError(e instanceof Error ? e.message : messages(locale).unavailable);
      });
  }, [org, locale]);
  return { status, error };
}

// Where a campaign stands on the way to published results.
export function campaignPhase(item: CampaignStatusItem, m: M) {
  if (item.releaseState === "PUBLISHED") return { text: m.statusPublished, tone: "positive" as const };
  if (item.releaseState === "INSUFFICIENT_DATA")
    return { text: m.statusInsufficient, tone: "neutral" as const };
  if (item.state === "CANCELLED") return { text: m.statusCancelled, tone: "danger" as const };
  if (item.state === "CLOSED") return { text: m.statusAwaiting, tone: "neutral" as const };
  if (item.state === "OPEN") return { text: m.statusOpen, tone: "accent" as const };
  if (item.state === "SCHEDULED") return { text: m.statusScheduled, tone: "neutral" as const };
  return { text: m.statusDraft, tone: "neutral" as const };
}

export function ResultsIndex({
  path,
  profile,
  organization,
  defaults,
}: {
  path: string[];
  profile: Profile;
  organization: DirectoryRecord | null;
  defaults?: { defaultTimezone: string; defaultCampaignThreshold: number };
}) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const locale = profile.locale,
    m = campaignMessages(locale),
    org = path[0],
    base = `/organizations/${org}`;
  const manage = profile.role === "SUPER_ADMIN" || profile.capabilities.includes("campaigns.manage");
  const { status, error } = useCampaignStatus(org, locale);
  const threshold = defaults?.defaultCampaignThreshold ?? 5;
  const shell = (children: React.ReactNode) => (
    <Workspace
      locale={locale}
      organization={organization}
      section="results"
      canManage={profile.role === "SUPER_ADMIN" || profile.capabilities.includes("directory.manage")}
      canReadMessages={profile.role === "SUPER_ADMIN" || profile.capabilities.includes("messages.read")}
    >
      {children}
    </Workspace>
  );
  if (!hydrated) return shell(<LoadingState label={m.loading} />);
  const send = manage ? (
    <a className="button" href={`${base}/send`}>
      {m.send}
    </a>
  ) : undefined;
  return shell(
    <>
      <PageHeader
        eyebrow={<Label accent>{organizationName(organization, locale)}</Label>}
        title={m.results}
        sub={fill(m.resultsHow, { t: threshold })}
        actions={
          <a className="button button-secondary" href={`${base}/assessments`}>
            {m.assessments}
          </a>
        }
      />
      {error && <ErrorState title={messages(locale).errorTitle} body={error} />}
      {!status && !error && <LoadingState label={m.loading} />}
      {status && status.items === null && <p role="note">{m.resultsHidden}</p>}
      {status?.items && status.items.length === 0 && (
        <EmptyState title={m.resultsNone} action={send} />
      )}
      {status?.items && status.items.length > 0 && (
        <section className="card stack" data-testid="results-status">
          <h2>{m.resultsState}</h2>
          <ul className="plain-list stack stack-tight">
            {status.items.map((item) => {
              const phase = campaignPhase(item, m);
              return (
                <li key={item.campaignId} className="row">
                  <bdi>{item.label}</bdi>
                  <Badge tone={phase.tone}>{phase.text}</Badge>
                  {item.releaseState === "PUBLISHED" ? (
                    <a href={`${base}/results/${item.roundId}`}>{m.viewResults}</a>
                  ) : (
                    <a href={`${base}/campaigns/${item.campaignId}`}>{m.openCampaign}</a>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>,
  );
}

// The overview's checklist. Each item links to where it is done; the list
// hides once every item is done.
export function GettingStarted({ org, locale }: { org: string; locale: Locale }) {
  const m = campaignMessages(locale);
  const { status } = useCampaignStatus(org, locale);
  if (!status) return null;
  const base = `/organizations/${org}`;
  const items: { key: string; text: string; count: number | null; href: string }[] = [
    { key: "departments", text: m.gsDepartments, count: status.departments, href: `${base}/departments` },
    { key: "participants", text: m.gsParticipants, count: status.participants, href: `${base}/participants` },
    {
      key: "questionnaire",
      text: m.gsQuestionnaire,
      count: status.publishedQuestionnaires,
      href: `/questionnaires?organization=${org}`,
    },
    { key: "campaign", text: m.gsCampaign, count: status.campaigns, href: `${base}/send` },
    { key: "links", text: m.gsLinks, count: status.linksIssued, href: `${base}/assessments` },
    { key: "responses", text: m.gsResponses, count: status.responses, href: `${base}/results` },
  ];
  if (items.every((i) => (i.count ?? 0) > 0)) return null;
  return (
    <section className="card stack" data-testid="getting-started">
      <div className="card-head">
        <h2>{m.gettingStarted}</h2>
      </div>
      <p className="muted">{m.gettingStartedHelp}</p>
      <ol className="stack stack-tight">
        {items.map((i) => (
          <li key={i.key} className="row" data-testid={`gs-${i.key}`}>
            <a href={i.href}>{i.text}</a>
            {i.count === null ? (
              <span className="muted">{m.gsHidden}</span>
            ) : (
              <Badge tone={i.count > 0 ? "positive" : "neutral"}>
                {i.count > 0 ? m.gsDone : m.gsTodo} (<bdi>{i.count}</bdi>)
              </Badge>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
