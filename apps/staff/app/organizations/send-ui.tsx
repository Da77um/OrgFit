/* Full document navigation intentionally clears organization-scoped state. */
"use client";
// The guided "send a questionnaire" flow (D-189). One page, pickers only. On
// submit it creates the series, the round and the campaign through the
// existing endpoints, in that order, each a keyed attempt in the screen's
// ledger, then opens the existing launch review. Nothing is launched and no
// link is issued here.
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { RequestFailure, sendAttempt, staffRequest } from "../staff-request";
import { ChangeProblem, redirectIfClean, silent, useLedger, type ChangeFailure } from "../request-ui";
import { confirmLeave, navigateAfterSave, useFormDirty, useUnsavedChanges } from "../unsaved";
import type { Profile } from "../../../../src/db";
import type { DirectoryRecord } from "../../../../src/directory";
import type { UsableVersion } from "../../../../src/campaign-guide";
import { campaignMessages, fill } from "../../../../src/campaign-i18n";
import { messages, type Locale } from "../../../../src/i18n";
import { Alert, ErrorState, Label, LoadingState, PageHeader } from "../../../../src/ui";
import { instantToWallClock, wallClockToInstant } from "../../../../src/zoned-time";
import { Workspace, organizationName } from "../shell";
import {
  DepartmentSelect,
  ParticipantPicker,
  VersionSelect,
  departmentName,
  useCampaignOptions,
  versionTitle,
  type Person,
} from "./campaign-pickers";

const subscribe = () => () => {};
type Mode = "ALL" | "DEPARTMENT" | "SELECTED";
type Step = "series" | "round" | "campaign";
type Progress = {
  series?: { id: string; family: string; reused: boolean };
  round?: { id: string; seriesId: string; versionId: string; label: string; reused: boolean };
  failed?: Step;
};
type RoundRow = {
  id: string;
  label: string;
  state: string;
  questionnaire_version_id: string;
  campaign_id: string | null;
  campaign_state: string | null;
};
const targetCodes: readonly string[] = ["OUTSIDE_QUESTIONNAIRE_TARGET", "NO_ELIGIBLE_PARTICIPANTS"];

const monthYear = (local: string, locale: Locale) => {
  const date = new Date(`${local.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-u-nu-latn-ca-gregory" : "en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
};
const zones = (current: string) => {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf("timeZone");
  } catch {
    all = [];
  }
  return all.includes(current) ? all : [current, ...all];
};

export function SendQuestionnaire({
  path,
  profile,
  organization,
  defaults,
  version: initialVersion,
}: {
  path: string[];
  profile: Profile;
  organization: DirectoryRecord | null;
  defaults?: { defaultTimezone: string; defaultCampaignThreshold: number };
  version?: string | null;
}) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const locale = profile.locale,
    m = campaignMessages(locale),
    ar = campaignMessages("ar"),
    org = path[0],
    base = `organizations/${org}`;
  const manage = profile.role === "SUPER_ADMIN" || profile.capabilities.includes("campaigns.manage");
  const threshold = defaults?.defaultCampaignThreshold ?? 5;
  const orgZone =
    typeof organization?.timezone === "string" && organization.timezone
      ? organization.timezone
      : (defaults?.defaultTimezone ?? "Asia/Riyadh");
  const { options, error: optionsError } = useCampaignOptions(org, locale);
  const ledger = useLedger();
  const form = useFormDirty();
  const [orgs, setOrgs] = useState<{ id: string; name_ar: string; name_en: string | null }[]>([]);
  const [versionId, setVersionId] = useState("");
  const [mode, setMode] = useState<Mode>("ALL");
  const [departmentId, setDepartmentId] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [timezone, setTimezone] = useState(orgZone);
  const [startsAt, setStartsAt] = useState(() => instantToWallClock(new Date().toISOString(), orgZone));
  const [endsAt, setEndsAt] = useState("");
  const [labelText, setLabelText] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [problem, setProblem] = useState<ChangeFailure | null>(null);
  const [sent, setSent] = useState(false);
  const preselected = useRef(false);
  useUnsavedChanges((form.dirty || !!progress.series) && !sent);

  useEffect(() => {
    void staffRequest<{ items: { id: string; name_ar: string; name_en: string | null }[] }>(
      locale,
      "/api/v1/organizations?limit=100",
    )
      .then((r) => setOrgs(r.data.items))
      .catch((e) => redirectIfClean(e));
  }, [locale]);

  const versions = options?.versions ?? [];
  const version: UsableVersion | undefined = versions.find((v) => v.id === versionId);
  const targeted = version?.target.mode === "DEPARTMENTS";
  const allowed = (options?.departments ?? []).filter(
    (d) => !targeted || version!.target.departmentIds.includes(d.id),
  );

  // Choosing a questionnaire applies its department targeting (020): the
  // first targeted department is preselected, and the reader is told so.
  function choose(id: string) {
    setVersionId(id);
    const v = versions.find((x) => x.id === id);
    if (!v || !options) return;
    if (v.target.mode === "DEPARTMENTS") {
      const first = options.departments.find((d) => v.target.departmentIds.includes(d.id));
      setMode("DEPARTMENT");
      setDepartmentId(first?.id ?? "");
    } else if (mode === "DEPARTMENT" && !options.departments.some((d) => d.id === departmentId)) {
      setDepartmentId("");
    }
  }
  useEffect(() => {
    if (!options || preselected.current) return;
    preselected.current = true;
    if (initialVersion && options.versions.some((v) => v.id === initialVersion)) choose(initialVersion);
  });

  const locked = !!progress.round;
  const defaultLabel = version ? `${versionTitle(version, locale)} — ${monthYear(startsAt, locale)}` : "";
  const label = locked ? progress.round!.label : (labelText ?? defaultLabel);
  const department = allowed.find((d) => d.id === departmentId);
  const sum = (values: (number | null)[]) =>
    values.some((v) => v === null) ? null : values.reduce<number>((a, b) => a + (b ?? 0), 0);
  const count: number | null =
    mode === "ALL"
      ? targeted
        ? sum(allowed.map((d) => d.active))
        : (options?.organizationActive ?? null)
      : mode === "DEPARTMENT"
        ? department
          ? department.active
          : null
        : people.length;

  // Hard stops, shown before submit; each says how to fix it.
  const stops: { key: string; text: string; fix?: React.ReactNode }[] = [];
  const participantLinks = (
    <span className="row">
      <a href={`/${base}/participants`}>{m.openParticipants}</a>
      <a href={`/${base}/participants/import`}>{m.importParticipants}</a>
    </span>
  );
  if (options && !versions.length)
    stops.push({
      key: "versions",
      text: m.noVersions,
      fix: <a href={`/questionnaires?organization=${org}`}>{m.openLibrary}</a>,
    });
  else if (options && !version) stops.push({ key: "version", text: m.chooseQuestionnaire });
  if (mode === "DEPARTMENT" && !department) stops.push({ key: "department", text: m.noDepartment });
  if (mode === "SELECTED" && options && !options.directoryReadable)
    stops.push({ key: "people-hidden", text: m.peopleHidden });
  else if (mode === "SELECTED" && !people.length) stops.push({ key: "people", text: m.noneSelected });
  if (count === 0 && mode !== "SELECTED")
    stops.push({
      key: "zero",
      text: mode === "DEPARTMENT" ? m.zeroDepartment : m.zeroAudience,
      fix: participantLinks,
    });
  const startInstant = wallClockToInstant(startsAt, timezone);
  const endInstant = endsAt ? wallClockToInstant(endsAt, timezone) : null;
  if (startInstant && endInstant && endInstant <= startInstant)
    stops.push({ key: "dates", text: m.endBeforeStart });
  const warn = count !== null && count > 0 && count < threshold;

  async function change(scope: string, url: string, body: unknown, again: boolean) {
    const pending = again ? ledger.uncertain(scope) : null;
    const attempt = pending?.attempt ?? ledger.prepare(locale, scope, { url, method: "POST", body });
    return (await sendAttempt<{ id: string }>(locale, ledger, attempt)).data;
  }
  const read = async <T,>(url: string) => (await staffRequest<T>(locale, `/api/v1/${url}`)).data;

  async function submit(e?: FormEvent<HTMLFormElement>, again = false) {
    e?.preventDefault();
    if (!version || stops.length || !manage) return;
    setBusy(true);
    setError("");
    setProblem(null);
    let step: Step = "series";
    try {
      // 1. The series: reuse the active series of this questionnaire family,
      // read fresh, before ever creating one.
      let series =
        progress.series && progress.series.family === version.familyKey ? progress.series : null;
      if (!series) {
        const fresh = await read<{ series: { id: string; familyKey: string }[] }>(`${base}/campaign-options`);
        const existing = fresh.series.find((s) => s.familyKey === version.familyKey);
        if (existing) {
          series = { id: existing.id, family: version.familyKey, reused: true };
          // An earlier unconfirmed create that did land is this series.
          ledger.settle("guided-series");
        } else {
          const created = await change(
            "guided-series",
            `/api/v1/${base}/assessment-series`,
            {
              nameAr: version.name.ar,
              nameEn: version.name.en || null,
              purpose: fill(ar.seriesPurpose, { title: version.name.ar }),
              questionnaireFamilyId: version.familyKey,
            },
            again,
          );
          series = { id: created.id, family: version.familyKey, reused: false };
        }
        const s = series;
        setProgress((p) => ({ ...p, series: s }));
      }
      // 2. The round: a draft round of this series, version and label that
      // has no campaign yet is the one an earlier attempt created; a draft
      // campaign already on it means only the review is left.
      step = "round";
      let round =
        progress.round && progress.round.seriesId === series.id && progress.round.versionId === version.id
          ? progress.round
          : null;
      if (!round) {
        const rows: RoundRow[] = [];
        for (let cursor: string | null = null, first = true, pages = 0; (first || cursor) && pages < 20; first = false, pages++) {
          const page: { items: RoundRow[]; nextCursor: string | null } = await read(
            `${base}/assessments?seriesId=${series.id}${cursor ? `&cursor=${cursor}` : ""}`,
          );
          rows.push(...page.items);
          cursor = page.nextCursor;
        }
        const same = rows.filter(
          (r) => r.state === "DRAFT" && r.questionnaire_version_id === version.id && r.label === label.trim(),
        );
        const drafted = same.find((r) => r.campaign_id && r.campaign_state === "DRAFT");
        if (drafted) {
          setSent(true);
          navigateAfterSave(`/${base}/campaigns/${drafted.campaign_id}`);
          return;
        }
        const open = same.find((r) => !r.campaign_id);
        if (open) {
          round = { id: open.id, seriesId: series.id, versionId: version.id, label: open.label, reused: true };
          ledger.settle("guided-round");
        } else {
          const startDay = startsAt.slice(0, 10);
          const created = await change(
            "guided-round",
            `/api/v1/${base}/assessments`,
            {
              seriesId: series.id,
              label: label.trim(),
              periodStart: startDay,
              periodEnd: endsAt ? endsAt.slice(0, 10) : null,
              questionnaireVersionId: version.id,
              populationDefinition: {
                schemaVersion: 1,
                descriptionAr:
                  mode === "ALL"
                    ? ar.populationAll
                    : mode === "DEPARTMENT"
                      ? department!.nameAr
                      : fill(ar.populationSelected, { n: people.length }),
              },
            },
            again,
          );
          round = { id: created.id, seriesId: series.id, versionId: version.id, label: label.trim(), reused: false };
        }
        const r = round;
        setProgress((p) => ({ ...p, round: r }));
      }
      // 3. The campaign, then the existing launch review.
      step = "campaign";
      const target =
        mode === "ALL"
          ? { mode }
          : mode === "DEPARTMENT"
            ? { mode, departmentId }
            : { mode, participantIds: people.map((p) => p.id) };
      const created = await change(
        "guided-campaign",
        `/api/v1/${base}/campaigns`,
        {
          roundId: round.id,
          questionnaireVersionId: version.id,
          target,
          startsAt: startInstant ?? startsAt,
          endsAt: endsAt ? (endInstant ?? endsAt) : null,
          timezone,
          threshold,
        },
        again,
      );
      setSent(true);
      navigateAfterSave(`/${base}/campaigns/${created.id}`);
    } catch (e) {
      redirectIfClean(e);
      setProgress((p) => ({ ...p, failed: step }));
      if (silent(e)) return;
      const scope = `guided-${step}`;
      if (e instanceof RequestFailure && (e.uncertain || e.kind === "SESSION"))
        setProblem({ failure: e, scope, retry: () => void submit(undefined, true) });
      else if (e instanceof RequestFailure && targetCodes.includes(e.code ?? ""))
        setError(m[e.code as "OUTSIDE_QUESTIONNAIRE_TARGET" | "NO_ELIGIBLE_PARTICIPANTS"]);
      else setError(e instanceof Error ? e.message : messages(locale).unavailable);
    } finally {
      setBusy(false);
    }
  }

  const shell = (children: React.ReactNode) => (
    <Workspace
      locale={locale}
      organization={organization}
      section="assessments"
      canManage={manage}
      canReadMessages={profile.role === "SUPER_ADMIN" || profile.capabilities.includes("messages.read")}
    >
      {children}
    </Workspace>
  );
  if (!hydrated) return shell(<LoadingState label={m.loading} />);
  const header = (
    <PageHeader
      eyebrow={<Label accent>{organizationName(organization, locale)}</Label>}
      title={m.send}
      sub={m.sendIntro}
      actions={
        <a className="button button-secondary" href={`/${base}/assessments`}>
          {m.assessments}
        </a>
      }
    />
  );
  if (!manage)
    return shell(
      <>
        {header}
        <ErrorState title={messages(locale).deniedTitle} body={messages(locale).forbidden} />
      </>,
    );
  if (optionsError)
    return shell(
      <>
        {header}
        <ErrorState title={messages(locale).errorTitle} body={optionsError} />
      </>,
    );
  if (!options) return shell(<>{header}<LoadingState label={m.loading} /></>);

  const status = (s: Step) => {
    const done = s === "series" ? progress.series : s === "round" ? progress.round : undefined;
    if (done) return done.reused ? m.stepReused : m.stepCreated;
    return progress.failed === s ? m.stepFailed : m.stepPending;
  };
  const orgChoices = orgs.some((o) => o.id === org)
    ? orgs
    : [{ id: org, name_ar: String(organization?.name_ar ?? ""), name_en: (organization?.name_en as string | null) ?? null }, ...orgs];

  return shell(
    <>
      {header}
      {error && <ErrorState title={messages(locale).errorTitle} body={error} />}
      <ChangeProblem
        locale={locale}
        problem={problem}
        ledger={ledger}
        busy={busy}
        onDismiss={() => setProblem(null)}
        testId="send-problem"
      />
      <form className="stack" onSubmit={(e) => void submit(e)} {...form.bind} data-testid="send-form">
        <section className="card stack">
          <h2>{m.organization}</h2>
          <label htmlFor="send-org">{m.organization}</label>
          <select
            id="send-org"
            value={org}
            disabled={locked || busy}
            onChange={async (e) => {
              const next = e.currentTarget.value;
              // Another organization is another page: its departments, people
              // and own questionnaires never carry over. A global
              // questionnaire may.
              const keep = version?.scope === "GLOBAL" ? `?version=${version.id}` : "";
              const decision = await confirmLeave("navigate", locale);
              // A refused leave needs nothing: the select is controlled.
              if (decision.go) navigateAfterSave(`/organizations/${next}/send${keep}`);
            }}
          >
            {orgChoices.map((o) => (
              <option key={o.id} value={o.id}>
                {locale === "en" ? o.name_en || o.name_ar : o.name_ar}
              </option>
            ))}
          </select>
        </section>

        <section className="card stack">
          <h2>{m.questionnaire}</h2>
          {versions.length ? (
            <>
              <label htmlFor="send-version">{m.questionnaire}</label>
              <VersionSelect
                id="send-version"
                name="version"
                versions={versions}
                value={version ? versionId : ""}
                onChange={choose}
                locale={locale}
                disabled={locked || busy}
                describedBy={locked ? "send-locked" : undefined}
              />
            </>
          ) : (
            <Alert tone="danger" role="note">
              {m.noVersions} <a href={`/questionnaires?organization=${org}`}>{m.openLibrary}</a>
            </Alert>
          )}
        </section>

        <section className="card stack">
          <h2>{m.audience}</h2>
          <fieldset className="stack stack-tight">
            <legend>{m.audience}</legend>
            {(
              [
                ["ALL", targeted ? m.audienceAllTargeted : m.audienceAll],
                ["DEPARTMENT", m.audienceDepartment],
                ["SELECTED", m.audienceSelected],
              ] as const
            ).map(([value, text]) => (
              <label key={value} htmlFor={`send-mode-${value}`}>
                <input
                  id={`send-mode-${value}`}
                  type="radio"
                  name="mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />{" "}
                {text}
              </label>
            ))}
          </fieldset>
          {targeted && (
            <p className="muted" data-testid="send-targeted-note">
              {m.targetedNote}
            </p>
          )}
          {mode === "DEPARTMENT" && (
            <>
              <label htmlFor="send-department">{m.departmentId}</label>
              <DepartmentSelect
                id="send-department"
                name="department"
                departments={allowed}
                value={department ? departmentId : ""}
                onChange={setDepartmentId}
                locale={locale}
              />
            </>
          )}
          {mode === "SELECTED" && options.directoryReadable && (
            <ParticipantPicker
              org={org}
              locale={locale}
              name="participantIds"
              idPrefix="send-people"
              selected={people}
              onChange={setPeople}
              label={m.audienceSelected}
            />
          )}
          {!options.directoryReadable && <p className="muted">{m.directoryHidden}</p>}
          {count !== null && (
            <p data-testid="send-count">
              <bdi>{fill(m.recipients, { n: count })}</bdi>
            </p>
          )}
          {warn && (
            <Alert tone="warning" role="note">
              {fill(m.belowThreshold, { n: count!, t: threshold })}
            </Alert>
          )}
        </section>

        <section className="card stack">
          <h2>{m.dates}</h2>
          <p className="muted" id="send-zone-help">
            {m.timesInZone}
          </p>
          <label htmlFor="send-starts">{m.startsAt}</label>
          <input
            id="send-starts"
            name="startsAt"
            type="datetime-local"
            required
            value={startsAt}
            aria-describedby="send-zone-help"
            onChange={(e) => setStartsAt(e.currentTarget.value)}
          />
          <label htmlFor="send-ends">{m.endsAt}</label>
          <input
            id="send-ends"
            name="endsAt"
            type="datetime-local"
            value={endsAt}
            aria-describedby="send-zone-help"
            onChange={(e) => setEndsAt(e.currentTarget.value)}
          />
          <label htmlFor="send-zone">{m.timezone}</label>
          <select id="send-zone" name="timezone" value={timezone} onChange={(e) => setTimezone(e.currentTarget.value)}>
            {zones(timezone).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </section>

        <section className="card stack">
          <h2>{m.label}</h2>
          <label htmlFor="send-label">{m.label}</label>
          <input
            id="send-label"
            name="label"
            required
            maxLength={200}
            value={label}
            disabled={locked || busy}
            aria-describedby={locked ? "send-label-help send-locked" : "send-label-help"}
            onChange={(e) => setLabelText(e.currentTarget.value)}
          />
          <p className="muted" id="send-label-help">
            {m.roundLabelHelp}
          </p>
          {locked && (
            <p className="muted" id="send-locked">
              {m.lockedHelp}
            </p>
          )}
        </section>

        {stops.length > 0 && (
          <div className="stack stack-tight" id="send-stops" data-testid="send-stops">
            {stops.map((s) => (
              <Alert key={s.key} tone="danger" role="note">
                {s.text} {s.fix}
              </Alert>
            ))}
          </div>
        )}

        {(progress.series || progress.failed) && (
          <section className="card stack" aria-live="polite" data-testid="send-progress">
            <h2>{m.progress}</h2>
            <ol>
              <li>
                {m.stepSeries}: {status("series")}
              </li>
              <li>
                {m.stepRound}: {status("round")}
              </li>
              <li>
                {m.stepCampaign}: {status("campaign")}
              </li>
            </ol>
            {progress.failed && <p className="muted">{m.resumeHelp}</p>}
          </section>
        )}

        {version && mode === "DEPARTMENT" && department && (
          <p className="muted">
            <bdi>
              {versionTitle(version, locale)} → {departmentName(department, locale)}
            </bdi>
          </p>
        )}
        <div className="row">
          <button disabled={busy || stops.length > 0} aria-describedby={stops.length ? "send-stops" : undefined}>
            {m.sendSubmit}
          </button>
        </div>
      </form>
    </>,
  );
}
