/* Full document navigation intentionally clears organization-scoped state. */
"use client";
import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import type { Profile } from "../../../../src/db";
import type { DirectoryRecord } from "../../../../src/directory";
import { campaignMessages } from "../../../../src/campaign-i18n";
import { messages, type Locale } from "../../../../src/i18n";
import { historyMessages } from "../../../../src/history-i18n";
import { Workspace, organizationName } from "../shell";
import {
  Alert,
  Badge,
  EmptyState,
  ErrorState,
  Label,
  LoadingState,
  Micro,
  PageHeader,
} from "../../../../src/ui";

type M = ReturnType<typeof campaignMessages>;
const subscribe = () => () => {};
async function api(
  path: string,
  locale: Locale,
  method = "GET",
  body?: unknown,
  revision?: string,
) {
  const r = await fetch("/api/v1/" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Accept-Language": locale,
      ...(method !== "GET" ? { "Idempotency-Key": crypto.randomUUID() } : {}),
      ...(revision ? { "If-Match": `"${revision}"` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await r.json();
  if (!r.ok)
    throw new Error(
      json.code === "TOKEN_ALREADY_ISSUED"
        ? campaignMessages(locale).linkOnce
        : (json.message ?? messages(locale).unavailable),
    );
  return json.data;
}
const label = (
  m: M,
  value: string | null | undefined,
  fallback = m.none,
): string =>
  value ? ((m as Record<string, string>)[value] ?? value) : fallback;
const localeText = (value: unknown, locale: Locale): string => {
  const v = value as { ar?: string; en?: string } | null;
  if (!v) return "";
  return (locale === "en" ? v.en || v.ar : v.ar) ?? "";
};

type Round = {
  id: string;
  label: string;
  state: string;
  series_id: string;
  period_start: string;
  campaign_id: string | null;
  campaign_state: string | null;
  campaign_effective_state: string | null;
};
type Series = { id: string; name_ar: string; name_en: string | null };
type Campaign = {
  id: string;
  round_id: string;
  state: string;
  starts_at: string;
  ends_at: string | null;
  timezone: string;
  target_mode: string;
  threshold: number;
  revision: string;
  archived: boolean;
  frozen_invited_count: number | null;
  frozen_manifest: { instrumentHash?: string } | null;
  close_reason: string | null;
  release_state: string;
  reportGroups: { id: string; kind: string; label: unknown }[];
  round: Round;
};
type Review = {
  invited: number;
  threshold: number;
  reportEligible: boolean;
  singlePerson: boolean;
  frozen: boolean;
  groups: { kind: string; label: unknown; count: number }[];
};
type Participation = {
  items: {
    invitationId: string;
    displayReference: string;
    displayName: string;
    status: string;
    issued: boolean;
    generation: number;
  }[];
  totals: Record<string, number | string | null>;
};

export function Campaigns({
  path,
  profile,
  organization,
}: {
  path: string[];
  profile: Profile;
  organization: DirectoryRecord | null;
}) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const locale = profile.locale,
    m = campaignMessages(locale),
    org = path[0],
    section = path[1],
    id = path[2] ?? null;
  const manage =
    profile.role === "SUPER_ADMIN" ||
    profile.capabilities.includes("campaigns.manage");
  const base = `organizations/${org}`;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [series, setSeries] = useState<Series[]>([]);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [people, setPeople] = useState<Participation | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [exportId, setExportId] = useState("");

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError("");
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : messages(locale).unavailable);
      } finally {
        setBusy(false);
      }
    },
    [locale],
  );
  const reload = useCallback(async () => {
    if (section === "assessments" && !id) {
      const [s, r] = await Promise.all([
        api(`${base}/assessment-series`, locale),
        api(`${base}/assessments`, locale),
      ]);
      setSeries(s.items);
      setRounds(r.items);
      return;
    }
    if (section === "campaigns" && id) {
      const c = (await api(`${base}/campaigns/${id}`, locale)) as Campaign;
      setCampaign(c);
      setReview(
        (await api(`${base}/campaigns/${id}/launch-review`, locale)) as Review,
      );
      if (c.state !== "DRAFT")
        setPeople(
          (await api(
            `${base}/campaigns/${id}/participation`,
            locale,
          )) as Participation,
        );
    }
  }, [base, id, locale, section]);
  useEffect(() => {
    void run(reload);
  }, [reload, run]);

  const shell = (children: React.ReactNode) => (
    <Workspace
      locale={locale}
      organization={organization}
      section="assessments"
      canManage={manage}
    >
      {children}
    </Workspace>
  );
  if (!hydrated) return shell(<LoadingState label={m.loading} />);

  const alerts = (
    <>
      {error && <ErrorState title={messages(locale).errorTitle} body={error} />}
      <p role="status" aria-live="polite">
        {notice}
      </p>
    </>
  );

  async function createSeries(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await run(async () => {
      await api(`${base}/assessment-series`, locale, "POST", {
        nameAr: String(form.get("nameAr")),
        nameEn: String(form.get("nameEn") ?? "") || null,
        purpose: String(form.get("purpose")),
        questionnaireFamilyId: String(form.get("family")),
      });
      setNotice(m.saved);
      await reload();
    });
  }
  async function createRound(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await run(async () => {
      await api(`${base}/assessments`, locale, "POST", {
        seriesId: String(form.get("seriesId")),
        label: String(form.get("label")),
        periodStart: String(form.get("periodStart")),
        periodEnd: String(form.get("periodEnd") ?? "") || null,
        questionnaireVersionId: String(form.get("versionId")),
        populationDefinition: {
          schemaVersion: 1,
          descriptionAr: String(form.get("population") ?? "") || undefined,
        },
      });
      setNotice(m.saved);
      await reload();
    });
  }
  async function createCampaign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const mode = String(form.get("mode"));
    const target =
      mode === "SINGLE"
        ? { mode, participantId: String(form.get("participantId")).trim() }
        : mode === "DEPARTMENT"
          ? { mode, departmentId: String(form.get("departmentId")).trim() }
          : {
              mode,
              participantIds: String(form.get("participantIds"))
                .split(/\s+/)
                .filter(Boolean),
            };
    await run(async () => {
      const created = (await api(`${base}/campaigns`, locale, "POST", {
        roundId: String(form.get("roundId")),
        questionnaireVersionId: String(form.get("versionId")),
        target,
        startsAt: new Date(String(form.get("startsAt"))).toISOString(),
        endsAt: form.get("endsAt")
          ? new Date(String(form.get("endsAt"))).toISOString()
          : null,
        timezone: String(form.get("timezone")),
        threshold: Number(form.get("threshold")),
      })) as Campaign;
      location.assign(`/${base}/campaigns/${created.id}`);
    });
  }
  const act = (
    action: string,
    method = "POST",
    body: unknown = {},
    withRevision = true,
  ) =>
    run(async () => {
      await api(
        `${base}/campaigns/${id}/${action}`,
        locale,
        method,
        body,
        withRevision ? campaign!.revision : undefined,
      );
      setNotice(m.saved);
      await reload();
    });
  const invitationAct = (
    invitationId: string,
    action: "issue" | "rotate" | "revoke",
    generation: number,
    reason?: string,
  ) =>
    run(async () => {
      const result = (await api(
        `${base}/campaigns/${id}/invitations/${invitationId}/${action}`,
        locale,
        "POST",
        action === "issue"
          ? { expectedGeneration: generation }
          : { expectedGeneration: generation, reason: reason ?? "" },
      )) as { url?: string };
      // The link is held only in this browser tab, only until reload.
      if (result.url) setLinks((v) => ({ ...v, [invitationId]: result.url! }));
      await reload();
    });

  if (section === "assessments")
    return shell(
      <>
          <PageHeader
            eyebrow={<Label accent>{organizationName(organization, locale)}</Label>}
            title={m.assessments}
            sub={historyMessages(locale).history}
            actions={
              <a className="button button-secondary" href={`/${base}/history`}>
                {historyMessages(locale).history}
              </a>
            }
          />
          {alerts}
          <section className="card stack">
            <div className="card-head">
              <h2>{m.series}</h2>
              <Micro>{series.length} SERIES</Micro>
            </div>
            {series.length === 0 ? (
              <EmptyState title={messages(locale).emptyTitle} body={m.empty} />
            ) : (
              <ul className="plain-list stack stack-tight">
                {series.map((s) => (
                  <li key={s.id}>
                    <bdi>
                      {locale === "en" && s.name_en ? s.name_en : s.name_ar}
                    </bdi>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {manage && (
            <form className="stack" onSubmit={createSeries}>
              <h3>{m.newSeries}</h3>
              <label htmlFor="nameAr">{m.seriesName}</label>
              <input id="nameAr" name="nameAr" required maxLength={500} />
              <label htmlFor="nameEn">{m.seriesNameEn}</label>
              <input id="nameEn" name="nameEn" maxLength={500} />
              <label htmlFor="purpose">{m.purpose}</label>
              <input id="purpose" name="purpose" required maxLength={2000} />
              <label htmlFor="family">{m.family}</label>
              <input id="family" name="family" required />
              <button disabled={busy}>{m.create}</button>
            </form>
          )}
          <h2>{m.rounds}</h2>
          {rounds.length === 0 && <p>{m.empty}</p>}
          <div className="scroll">
            <table>
              <caption>{m.rounds}</caption>
              <thead>
                <tr>
                  <th scope="col">{m.label}</th>
                  <th scope="col">{m.periodStart}</th>
                  <th scope="col">{m.state}</th>
                  <th scope="col">{m.campaign}</th>
                </tr>
              </thead>
              <tbody>
                {rounds.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <bdi>{r.label}</bdi>
                    </td>
                    <td>
                      <bdi>{String(r.period_start).slice(0, 10)}</bdi>
                    </td>
                    <td>{label(m, r.state)}</td>
                    <td>
                      {r.campaign_id ? (
                        <a href={`/${base}/campaigns/${r.campaign_id}`}>
                          {label(m, r.campaign_effective_state)}
                        </a>
                      ) : (
                        m.none
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {manage && (
            <>
              <form className="stack" onSubmit={createRound}>
                <h3>{m.newRound}</h3>
                <label htmlFor="seriesId">{m.series}</label>
                <select id="seriesId" name="seriesId" required>
                  {series.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name_ar}
                    </option>
                  ))}
                </select>
                <label htmlFor="label">{m.label}</label>
                <input id="label" name="label" required maxLength={200} />
                <label htmlFor="periodStart">{m.periodStart}</label>
                <input
                  id="periodStart"
                  name="periodStart"
                  type="date"
                  required
                />
                <label htmlFor="periodEnd">{m.periodEnd}</label>
                <input id="periodEnd" name="periodEnd" type="date" />
                <label htmlFor="versionId">{m.version}</label>
                <input id="versionId" name="versionId" required />
                <label htmlFor="population">{m.population}</label>
                <input id="population" name="population" maxLength={2000} />
                <button disabled={busy}>{m.create}</button>
              </form>
              <form className="stack" onSubmit={createCampaign}>
                <h3>{m.newCampaign}</h3>
                <p>{m.launchHelp}</p>
                <label htmlFor="roundId">{m.round}</label>
                <select id="roundId" name="roundId" required>
                  {rounds
                    .filter((r) => !r.campaign_id && r.state === "DRAFT")
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                </select>
                <label htmlFor="campaignVersion">{m.version}</label>
                <input id="campaignVersion" name="versionId" required />
                <label htmlFor="mode">{m.targetMode}</label>
                <select id="mode" name="mode" defaultValue="DEPARTMENT">
                  <option value="SINGLE">{m.SINGLE}</option>
                  <option value="SELECTED">{m.SELECTED}</option>
                  <option value="DEPARTMENT">{m.DEPARTMENT}</option>
                </select>
                <label htmlFor="departmentId">{m.departmentId}</label>
                <input id="departmentId" name="departmentId" />
                <label htmlFor="participantId">{m.participantId}</label>
                <input id="participantId" name="participantId" />
                <label htmlFor="participantIds">{m.participantIds}</label>
                <textarea id="participantIds" name="participantIds" rows={3} />
                <label htmlFor="startsAt">{m.startsAt}</label>
                <input
                  id="startsAt"
                  name="startsAt"
                  type="datetime-local"
                  required
                />
                <label htmlFor="endsAt">{m.endsAt}</label>
                <input id="endsAt" name="endsAt" type="datetime-local" />
                <label htmlFor="timezone">{m.timezone}</label>
                <input
                  id="timezone"
                  name="timezone"
                  defaultValue="Asia/Riyadh"
                  required
                />
                <label htmlFor="threshold">{m.threshold}</label>
                <input
                  id="threshold"
                  name="threshold"
                  type="number"
                  min={5}
                  defaultValue={5}
                  required
                />
                <button disabled={busy}>{m.create}</button>
              </form>
            </>
          )}
      </>,
    );

  if (!campaign)
    return shell(
      <>
        {alerts}
        <LoadingState label={m.loading} />
      </>,
    );

  const totals = people?.totals ?? {};
  // Issuing, rotating and revoking are possible only while a campaign can
  // still collect answers; a closed or cancelled campaign offers none of them.
  const collecting = ["SCHEDULED", "OPEN"].includes(campaign.state);
  return shell(
    <>
        <PageHeader
          eyebrow={<Label accent>{organizationName(organization, locale)}</Label>}
          title={
            <>
              {m.campaign}: <bdi>{campaign.round.label}</bdi>
            </>
          }
          actions={
            <>
              <span className="row">
                <Label>{m.state}:</Label>
                <Badge tone={stateTone(campaign.state)}>
                  {label(m, campaign.state)}
                </Badge>
              </span>
              {campaign.archived && <Badge tone="neutral">{m.archive}</Badge>}
            </>
          }
        />
        {alerts}
        <Alert tone="info" role="note">
          {m.noAnswers}
        </Alert>

        <section className="stack">
          <h2>{m.review}</h2>
          {review && (
            <>
              <p>
                {m.invited}: <bdi>{review.invited}</bdi> · {m.threshold}:{" "}
                <bdi>{review.threshold}</bdi> ·{" "}
                {review.reportEligible ? m.eligible : m.ineligible}
              </p>
              {review.singlePerson && <p role="note">{m.singleWarning}</p>}
              {!review.reportEligible && !review.singlePerson && (
                <p role="note">{m.thresholdWarning}</p>
              )}
              <h3>{m.groups}</h3>
              <ul>
                {review.groups.map((g, index) => (
                  <li key={index}>
                    <bdi>
                      {label(m, g.kind)} — {localeText(g.label, locale)} (
                      {g.count})
                    </bdi>
                  </li>
                ))}
              </ul>
            </>
          )}
          {campaign.frozen_manifest && (
            <p>
              {m.manifest} · {m.instrumentHash}:{" "}
              <bdi>{String(campaign.frozen_manifest.instrumentHash ?? "")}</bdi>
            </p>
          )}
        </section>

        {campaign.release_state === "PUBLISHED" && (
          <section className="stack">
            <h2>{m.results}</h2>
            <a href={`/${base}/results/${campaign.round_id}`}>
              {m.viewResults}
            </a>
          </section>
        )}

        {manage && (
          <section className="stack">
            <h2>{m.campaign}</h2>
            <p>{m.endDateHelp}</p>
            {campaign.state === "DRAFT" && (
              <button disabled={busy} onClick={() => void act("launch")}>
                {m.launch}
              </button>
            )}
            {campaign.state === "OPEN" && (
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  const reason = String(
                    new FormData(e.currentTarget).get("reason") ?? "",
                  );
                  void act("close", "POST", { reason });
                }}
              >
                <label htmlFor="closeReason">{m.reason}</label>
                <input
                  id="closeReason"
                  name="reason"
                  required
                  maxLength={500}
                />
                <button disabled={busy}>{m.close}</button>
              </form>
            )}
            {["DRAFT", "SCHEDULED", "OPEN"].includes(campaign.state) && (
              <>
                <form
                  className="stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const value = String(
                      new FormData(e.currentTarget).get("endsAt") ?? "",
                    );
                    void act("end-date", "PUT", {
                      endsAt: value ? new Date(value).toISOString() : null,
                    });
                  }}
                >
                  <label htmlFor="endsAt">{m.endDate}</label>
                  <input id="endsAt" name="endsAt" type="datetime-local" />
                  <button disabled={busy}>{m.save}</button>
                </form>
                <form
                  className="stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const reason = String(
                      new FormData(e.currentTarget).get("reason") ?? "",
                    );
                    void act("cancel", "POST", { reason });
                  }}
                >
                  <label htmlFor="cancelReason">{m.reason}</label>
                  <input
                    id="cancelReason"
                    name="reason"
                    required
                    maxLength={500}
                  />
                  <button disabled={busy}>{m.cancelCampaign}</button>
                </form>
              </>
            )}
            {["CLOSED", "CANCELLED"].includes(campaign.state) && (
              <>
                <p role="note">{m.noReopen}</p>
                {!campaign.archived && (
                  <button disabled={busy} onClick={() => void act("archive")}>
                    {m.archive}
                  </button>
                )}
              </>
            )}
          </section>
        )}

        {people && (
          <section className="stack">
            <h2>{m.participation}</h2>
            <p>
              {m.invited}: <bdi>{String(totals.invited)}</bdi> · {m.completed}:{" "}
              <bdi>{String(totals.completed)}</bdi> · {m.outstanding}:{" "}
              <bdi>{String(totals.outstanding)}</bdi> · {m.revoked}:{" "}
              <bdi>{String(totals.revoked)}</bdi> · {m.eligibleCount}:{" "}
              <bdi>{String(totals.eligible)}</bdi> · {m.rate}:{" "}
              <bdi>{totals.rate === null ? m.none : String(totals.rate)}</bdi>
            </p>
            <p>{m.linkOnce}</p>
            <p>{m.linkPrivacy}</p>
            <div className="scroll">
              <table>
                <caption>{m.invitations}</caption>
                <thead>
                  <tr>
                    <th scope="col">{m.displayName}</th>
                    <th scope="col">{m.displayReference}</th>
                    <th scope="col">{m.status}</th>
                    <th scope="col">{m.generation}</th>
                    {manage && <th scope="col">{m.invitations}</th>}
                  </tr>
                </thead>
                <tbody>
                  {people.items.map((i) => (
                    <tr key={i.invitationId}>
                      <td>
                        <bdi>{i.displayName}</bdi>
                      </td>
                      <td>
                        <bdi>{i.displayReference}</bdi>
                      </td>
                      <td>{label(m, i.status)}</td>
                      <td>
                        <bdi>{i.issued ? i.generation : m.notIssued}</bdi>
                      </td>
                      {manage && (
                        <td className="row">
                          {collecting && i.status === "READY" && !i.issued && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void invitationAct(
                                  i.invitationId,
                                  "issue",
                                  i.generation,
                                )
                              }
                            >
                              {m.issue}
                            </button>
                          )}
                          {collecting && i.status === "READY" && i.issued && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void invitationAct(
                                  i.invitationId,
                                  "rotate",
                                  i.generation,
                                  m.rotate,
                                )
                              }
                            >
                              {m.rotate}
                            </button>
                          )}
                          {collecting && i.status === "READY" && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void invitationAct(
                                  i.invitationId,
                                  "revoke",
                                  i.generation,
                                  m.revoke,
                                )
                              }
                            >
                              {m.revoke}
                            </button>
                          )}
                          {links[i.invitationId] && (
                            <input
                              readOnly
                              aria-label={m.copy}
                              value={links[i.invitationId]}
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {manage && collecting && (
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  const confirmRotation =
                    new FormData(e.currentTarget).get("confirmRotation") ===
                    "on";
                  void run(async () => {
                    const result = (await api(
                      `${base}/campaigns/${id}/link-exports`,
                      locale,
                      "POST",
                      {
                        invitationIds: people.items
                          .filter((i) => i.status === "READY")
                          .map((i) => i.invitationId),
                        expectedGenerations: people.items
                          .filter((i) => i.status === "READY")
                          .map((i) => i.generation),
                        confirmRotation,
                      },
                    )) as { exportId: string };
                    setExportId(result.exportId);
                    setNotice(m.exportReady);
                    await reload();
                  });
                }}
              >
                <h3>{m.export}</h3>
                <p>{m.exportHelp}</p>
                <label htmlFor="confirmRotation">
                  <input
                    id="confirmRotation"
                    name="confirmRotation"
                    type="checkbox"
                  />
                  {m.confirmRotation}
                </label>
                <button disabled={busy}>{m.export}</button>
              </form>
            )}
            {exportId && (
              <a
                href={`/api/v1/${base}/campaigns/${id}/link-exports/${exportId}`}
              >
                {m.download}
              </a>
            )}
          </section>
        )}
    </>,
  );
}

// The lifecycle in one glance. A campaign that can still collect is the one
// state a reader must be able to pick out of a list without reading a word,
// so it is the only one carried in the accent.
function stateTone(state: string) {
  return state === "OPEN"
    ? "accent"
    : state === "CLOSED" || state === "PUBLISHED"
      ? "positive"
      : state === "CANCELLED"
        ? "danger"
        : "neutral";
}
