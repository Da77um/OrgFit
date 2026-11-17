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
import { formatInZone } from "../../../../src/zoned-time";
import { nextProcessingRun } from "../../../../src/processing-schedule";

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

// Where one campaign stands, from sending to the report (D-190). Every step
// is read from the campaign itself and its live participation counts; nothing
// here touches an answer. The answers travel encrypted into the separate
// anonymous store, and only the daily processing turns them into group results.
type JourneyStep = { key: string; title: string; body: string; state: "done" | "now" | "later"; link?: { href: string; text: string } };
export function CampaignJourney({
  locale,
  base,
  campaign,
  invited,
  completed,
  issued,
}: {
  locale: Locale;
  base: string;
  campaign: {
    state: string;
    release_state: string;
    ends_at: string | null;
    timezone: string;
    threshold: number;
    round_id: string;
  };
  invited: number;
  completed: number;
  issued: number;
}) {
  const m = campaignMessages(locale);
  const [now] = useState(() => new Date());
  if (campaign.state === "CANCELLED") return null;
  const zone = campaign.timezone;
  const when = (iso: string) => `${formatInZone(iso, zone)} (${zone})`;
  const launched = campaign.state !== "DRAFT";
  const closed = campaign.state === "CLOSED";
  const processed = ["PUBLISHED", "INSUFFICIENT_DATA"].includes(campaign.release_state);
  const enough = completed >= campaign.threshold;
  const results = `/${base}/results/${campaign.round_id}`;
  const steps: JourneyStep[] = [
    {
      key: "launch",
      title: m.jLaunch,
      body: launched ? m.jLaunchDone : m.jLaunchNow,
      state: launched ? "done" : "now",
    },
    {
      key: "links",
      title: m.jLinks,
      body: fill(m.jLinksBody, { issued, invited }),
      state: !launched ? "later" : issued >= invited && invited > 0 ? "done" : closed ? "done" : "now",
    },
    {
      key: "answers",
      title: m.jAnswers,
      body:
        fill(m.jAnswersBody, { completed, invited }) +
        " " +
        (enough ? m.jAnswersEnough : fill(m.jAnswersShort, { t: campaign.threshold, n: campaign.threshold - completed })),
      state: !launched ? "later" : closed ? "done" : "now",
    },
    {
      key: "close",
      title: m.jClose,
      body: closed ? m.jCloseDone : campaign.ends_at ? fill(m.jCloseAuto, { at: when(campaign.ends_at) }) : m.jCloseManual,
      state: closed ? "done" : launched ? "now" : "later",
    },
    {
      key: "process",
      title: m.jProcess,
      body: processed
        ? m.jProcessDone
        : fill(closed ? m.jProcessNext : m.jProcessLater, { at: when(nextProcessingRun(now).toISOString()) }),
      state: processed ? "done" : closed ? "now" : "later",
    },
    {
      key: "results",
      title: m.jResults,
      body:
        campaign.release_state === "PUBLISHED"
          ? m.jResultsDone
          : campaign.release_state === "INSUFFICIENT_DATA"
            ? m.belowThresholdFinal
            : fill(m.jResultsLater, { t: campaign.threshold }),
      state: campaign.release_state === "PUBLISHED" ? "done" : processed ? "done" : "later",
      link: campaign.release_state === "PUBLISHED" ? { href: results, text: m.viewResults } : undefined,
    },
  ];
  const tone = { done: "positive", now: "accent", later: "neutral" } as const;
  const word = { done: m.jDone, now: m.jNow, later: m.jLater };
  return (
    <section className="card stack" data-testid="campaign-journey">
      <div className="card-head">
        <h2>{m.journey}</h2>
      </div>
      <p className="muted">{m.journeyPrivacy}</p>
      <ol className="stack stack-tight">
        {steps.map((s) => (
          <li key={s.key} className="stack stack-tight" data-testid={`journey-${s.key}`} data-state={s.state}>
            <span className="row">
              <strong>{s.title}</strong>
              <Badge tone={tone[s.state]}>{word[s.state]}</Badge>
            </span>
            <span>{s.body}</span>
            {s.link && <a href={s.link.href}>{s.link.text}</a>}
          </li>
        ))}
      </ol>
    </section>
  );
}
