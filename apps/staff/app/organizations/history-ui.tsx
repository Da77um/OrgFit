/* Full document navigation intentionally clears organization-scoped state. */
"use client";
import { jsonOf, staffFetch } from "../staff-fetch";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Profile } from "../../../../src/db";
import type { DirectoryRecord } from "../../../../src/directory";
import { messages, type Locale } from "../../../../src/i18n";
import { historyMessages } from "../../../../src/history-i18n";
import { localeText } from "../../../../src/results-i18n";
import { utcDate } from "../../../../src/zoned-time";
import { Workspace, organizationName } from "../shell";
import {
  ErrorState,
  Label,
  LoadingState,
  PageHeader,
} from "../../../../src/ui";

// The history surface. Every number it shows came from a published snapshot,
// and every absence is stated: an unreleased round, a withheld result and a
// changed measurement are three different sentences, none of which is a zero
// and none of which is drawn as a line through the gap.

type M = ReturnType<typeof historyMessages>;
type Translation = { ar?: string; en?: string };
type Point = {
  roundId: string;
  label: string;
  periodStart: string;
  status: "COMPARABLE" | "GAP" | "NOT_COMPARABLE";
  reasonCode: string | null;
  value: string | null;
  contributorCount: number | null;
  band: { label: Translation } | null;
};
type Trend = {
  metricKey: string;
  label: Translation;
  direction: "HIGH_GOOD" | "HIGH_RISK" | null;
  points: Point[];
};
type Round = {
  roundId: string;
  label: string;
  periodStart: string;
  periodEnd: string | null;
  state: string;
  releaseState: string | null;
  contributorCount: number | null;
};
type SeriesSummary = {
  id: string;
  name_ar: string;
  name_en: string | null;
  purpose: string;
  round_count: number;
  released_count: number;
};
type ComparisonSummary = {
  id: string;
  classification: string;
  leftRoundId: string;
  rightRoundId: string;
  rationale: string;
  reviewedBy: string | null;
  reviewedAt: string;
};
type ComparisonCell = {
  metricKey: string;
  groupKey: string;
  label: Translation;
  groupLabel: Translation;
  direction: "HIGH_GOOD" | "HIGH_RISK" | null;
  status: "COMPARABLE" | "GAP" | "NOT_COMPARABLE";
  reasonCode: string | null;
  left: { value: string | null } | null;
  right: { value: string | null } | null;
  pointChange: string | null;
  percentChange: string | null;
  improved: boolean | null;
};
type ComparisonView = {
  id: string;
  classification: string;
  comparable: boolean;
  rationale: string;
  reviewedBy: string | null;
  reviewedAt: string;
  populationCaveats: string[];
  cells: ComparisonCell[];
  left: { label: string; periodStart: string; contributorCount: number };
  right: { label: string; periodStart: string; contributorCount: number };
};
type Proposal = {
  identicalVersion: boolean;
  suggestion: string;
  pairs: { leftKey: string; rightKey: string; equivalent: boolean }[];
  added: string[];
  removed: string[];
};
const subscribe = () => () => {};

// A line is drawn only between two consecutive comparable points. A gap or a
// measurement break ends the segment; nothing is interpolated across it.
function TrendChart({ trend, m }: { trend: Trend; m: M }) {
  const points = trend.points;
  if (points.filter((p) => p.value !== null).length < 2) return null;
  const width = 320,
    height = 120,
    pad = 16;
  const x = (index: number) =>
    pad + (index * (width - 2 * pad)) / Math.max(1, points.length - 1);
  const y = (value: number) => height - pad - (value / 100) * (height - 2 * pad);
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${x(index)},${y(Number(point.value))}`);
  });
  if (current.length > 1) segments.push(current.join(" "));
  return (
    <figure className="result-radar">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={m.trendDescription}>
        {segments.map((segment) => (
          <polyline key={segment} className="radar-shape" points={segment} fill="none" />
        ))}
        {points.map((point, index) =>
          point.value === null ? null : (
            <circle
              key={point.roundId}
              cx={x(index)}
              cy={y(Number(point.value))}
              r="3"
              className="radar-grid"
            />
          ),
        )}
      </svg>
    </figure>
  );
}

function Trends({ trends, m, locale }: { trends: Trend[]; m: M; locale: Locale }) {
  return (
    <div className="stack">
      <h2>{m.trend}</h2>
      <p className="muted">{m.trendDescription}</p>
      {trends.map((trend) => (
        <section key={trend.metricKey} className="stack result-metric">
          <h3>{localeText(trend.label, locale)}</h3>
          <TrendChart trend={trend} m={m} />
          <div
            className="table-wrap scroll"
            tabIndex={0}
            role="region"
            aria-label={localeText(trend.label, locale)}
          >
            <table className="result-table">
              <caption>{localeText(trend.label, locale)}</caption>
              <thead>
                <tr>
                  <th scope="col">{m.round}</th>
                  <th scope="col">{m.period}</th>
                  <th scope="col">{m.value}</th>
                  <th scope="col">{m.contributors}</th>
                  <th scope="col">{m.status}</th>
                </tr>
              </thead>
              <tbody>
                {trend.points.map((point) => (
                  <tr key={point.roundId}>
                    <th scope="row">{point.label}</th>
                    <td>{point.periodStart}</td>
                    <td>{point.value ?? "—"}</td>
                    <td>{point.contributorCount ?? "—"}</td>
                    <td>
                      {m[point.status as keyof M]}
                      {point.reasonCode
                        ? ` — ${m[point.reasonCode as keyof M] ?? point.reasonCode}`
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function ComparisonDetail({
  view,
  m,
  locale,
}: {
  view: ComparisonView;
  m: M;
  locale: Locale;
}) {
  return (
    <div className="stack">
      {/* U+2192 is not mirrored by the bidi algorithm, so on an RTL page it
          would point back at the earlier round. The arrow follows the reading
          direction instead. */}
      <h3>
        <bdi>{view.left.label}</bdi> {locale === "ar" ? "←" : "→"}{" "}
        <bdi>{view.right.label}</bdi>
      </h3>
      <dl className="result-facts">
        <div>
          <dt>{m.classification}</dt>
          {/* Words, not a readout: the mono LTR face pulls Arabic letters
              apart (CF-002). */}
          <dd className="fact-text">
            {m[view.classification as keyof M] ?? view.classification}
          </dd>
        </div>
        <div>
          <dt>{m.reviewedBy}</dt>
          <dd className="fact-text">
            <bdi>{view.reviewedBy ?? "—"}</bdi>
          </dd>
        </div>
        <div>
          <dt>{m.reviewedAt}</dt>
          <dd>
            <bdi dir="ltr">{utcDate(view.reviewedAt)}</bdi>
          </dd>
        </div>
        <div>
          <dt>{m.contributors}</dt>
          <dd>
            {view.left.contributorCount} → {view.right.contributorCount}
          </dd>
        </div>
      </dl>
      <p>
        <strong>{m.rationale}:</strong> {view.rationale}
      </p>
      {view.populationCaveats.length > 0 && (
        <div className="stack">
          <h4>{m.caveats}</h4>
          <ul>
            {view.populationCaveats.map((caveat) => (
              <li key={caveat}>{m[caveat as keyof M] ?? caveat}</li>
            ))}
          </ul>
        </div>
      )}
      <div
        className="table-wrap scroll"
        tabIndex={0}
        role="region"
        aria-label={m.comparison}
      >
        <table className="result-table">
          <caption>{m.comparison}</caption>
          <thead>
            <tr>
              <th scope="col">{m.metric}</th>
              <th scope="col">{m.earlier}</th>
              <th scope="col">{m.later}</th>
              <th scope="col">{m.pointChange}</th>
              <th scope="col">{m.percentChange}</th>
              <th scope="col">{m.improvement}</th>
              <th scope="col">{m.status}</th>
            </tr>
          </thead>
          <tbody>
            {view.cells.map((cell) => (
              <tr key={`${cell.groupKey}/${cell.metricKey}`}>
                <th scope="row">
                  {localeText(cell.label, locale)}
                  <span className="muted"> · {localeText(cell.groupLabel, locale)}</span>
                </th>
                {/* Signed values and percentages are isolated left to right:
                    under RTL "-5.7" printed as "5.7-" and "-10.2%" as "%10.2-",
                    which reads as the opposite change (CF-004). */}
                <td><bdi dir="ltr">{cell.left?.value ?? "—"}</bdi></td>
                <td><bdi dir="ltr">{cell.right?.value ?? "—"}</bdi></td>
                <td>
                  <bdi dir="ltr">
                    {cell.pointChange === null
                      ? "—"
                      : `${Number(cell.pointChange) > 0 ? "+" : ""}${cell.pointChange}`}
                  </bdi>
                </td>
                <td>
                  <bdi dir="ltr">
                    {cell.percentChange === null ? "—" : `${cell.percentChange}%`}
                  </bdi>
                </td>
                <td>
                  {cell.improved === null
                    ? cell.status === "COMPARABLE"
                      ? m.unchanged
                      : "—"
                    : cell.improved
                      ? m.improved
                      : m.worsened}
                </td>
                <td>
                  {m[cell.status as keyof M]}
                  {cell.reasonCode
                    ? ` — ${m[cell.reasonCode as keyof M] ?? cell.reasonCode}`
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">{m.descriptive}</p>
    </div>
  );
}

export function History({
  profile,
  organization,
  path,
}: {
  profile: Profile;
  organization: DirectoryRecord | null;
  path: string[];
}) {
  const locale = profile.locale as Locale;
  const m = historyMessages(locale),
    base = messages(locale);
  const org = path[0],
    seriesId = path[2] ?? "";
  // Same rule as the server's access.has_capability and every other screen: a
  // Super Admin holds every capability. Without the role clause the review
  // form was hidden from the one account the server always allows (CF-001).
  const canReview =
    profile.role === "SUPER_ADMIN" ||
    profile.capabilities.includes("instruments.manage");
  const [list, setList] = useState<SeriesSummary[]>([]);
  const [series, setSeries] = useState<{
    nameAr: string;
    nameEn: string | null;
    purpose: string;
    rounds: Round[];
    trends: Trend[];
  } | null>(null);
  const [comparisons, setComparisons] = useState<ComparisonSummary[]>([]);
  const [view, setView] = useState<ComparisonView | null>(null);
  const [form, setForm] = useState({ left: "", right: "", rationale: "" });
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const api = useCallback(
    async (suffix: string, init?: RequestInit) => {
      const r = await staffFetch(locale)(`/api/v1/organizations/${org}/${suffix}`, {
        ...init,
        headers: {
          "Accept-Language": locale,
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...(init?.method && init.method !== "GET"
            ? { "idempotency-key": crypto.randomUUID() }
            : {}),
        },
      });
      const json = await jsonOf(r);
      if (!r.ok) throw new Error(json.message ?? base.unavailable);
      return json.data;
    },
    [org, locale, base],
  );
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      if (!seriesId) setList((await api("history")).items);
      else {
        setSeries(await api(`history/${seriesId}`));
        setComparisons((await api(`comparisons?seriesId=${seriesId}`)).items);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : base.unavailable);
    } finally {
      setBusy(false);
    }
  }, [api, seriesId, base]);
  useEffect(() => {
    void load();
  }, [load]);
  const shell = (children: React.ReactNode) => (
    <Workspace
      locale={locale}
      organization={organization}
      section="history"
      canManage={
        profile.role === "SUPER_ADMIN" ||
        profile.capabilities.includes("directory.manage")
      }
    >
      {children}
    </Workspace>
  );
  if (!hydrated) return shell(<LoadingState label={m.loading} />);
  const released = series?.rounds.filter((r) => r.releaseState === "PUBLISHED") ?? [];
  return shell(
    <>
        <PageHeader
          eyebrow={<Label accent>{organizationName(organization, locale)}</Label>}
          title={m.history}
          sub={m.descriptive}
        />
        {error && <ErrorState title={base.errorTitle} body={error} />}
        <p role="status" aria-live="polite">
          {busy ? m.loading : note}
        </p>

        {!seriesId && (
          <div
            className="table-wrap scroll"
            tabIndex={0}
            role="region"
            aria-label={m.series}
          >
            <table className="result-table">
              <caption>{m.series}</caption>
              <thead>
                <tr>
                  <th scope="col">{m.seriesName}</th>
                  <th scope="col">{m.purpose}</th>
                  <th scope="col">{m.rounds}</th>
                  <th scope="col">{m.released}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((item) => (
                  <tr key={item.id}>
                    <th scope="row">
                      <a href={`/organizations/${org}/history/${item.id}`}>
                        {locale === "en" ? (item.name_en ?? item.name_ar) : item.name_ar}
                      </a>
                    </th>
                    <td>{item.purpose}</td>
                    <td>{item.round_count}</td>
                    <td>{item.released_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!seriesId && !busy && !list.length && <p className="muted">{m.empty}</p>}

        {seriesId && series && (
          <>
            <h2>
              {locale === "en" ? (series.nameEn ?? series.nameAr) : series.nameAr}
            </h2>
            <Trends trends={series.trends} m={m} locale={locale} />

            <section className="stack">
              <h2>{m.comparisons}</h2>
              {!comparisons.length && <p className="muted">{m.noComparisons}</p>}
              <ul>
                {comparisons.map((item) => (
                  <li key={item.id}>
                    <button
                      onClick={() =>
                        void (async () => {
                          try {
                            setView(await api(`comparisons/${item.id}`));
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "");
                          }
                        })()
                      }
                    >
                      {m[item.classification as keyof M] ?? item.classification} ·{" "}
                      {/* An ISO date beside Arabic words is reordered to
                          "14-09-2026" unless isolated (CF-004). */}
                      <bdi dir="ltr">{utcDate(item.reviewedAt)}</bdi>
                    </button>
                  </li>
                ))}
              </ul>
              {view && <ComparisonDetail view={view} m={m} locale={locale} />}
            </section>

            {canReview && released.length >= 2 && (
              <section className="stack">
                <h2>{m.newComparison}</h2>
                <div className="form-grid">
                  {(["left", "right"] as const).map((sideKey) => (
                    <label key={sideKey}>
                      {sideKey === "left" ? m.earlier : m.later}
                      <select
                        value={form[sideKey]}
                        onChange={(e) => {
                          setForm({ ...form, [sideKey]: e.target.value });
                          setProposal(null);
                        }}
                      >
                        <option value="">—</option>
                        {released.map((round) => (
                          // An option holds text only, so the date is isolated
                          // with LRI/PDI (what <bdi dir="ltr"> does) rather than
                          // markup; beside Arabic it otherwise reads 01-01-2026.
                          <option key={round.roundId} value={round.roundId}>
                            {`${round.label} · \u2066${round.periodStart}\u2069`}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <button
                  disabled={!form.left || !form.right || busy}
                  onClick={() =>
                    void (async () => {
                      setError("");
                      try {
                        setProposal(
                          await api(
                            `comparisons/proposal?left=${form.left}&right=${form.right}`,
                          ),
                        );
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "");
                      }
                    })()
                  }
                >
                  {m.check}
                </button>
                {proposal && (
                  <div className="stack">
                    <p>
                      {m.suggestion}:{" "}
                      {m[proposal.suggestion as keyof M] ?? proposal.suggestion}
                    </p>
                    <p className="muted">
                      {m.equivalentMetrics}:{" "}
                      {proposal.pairs.filter((p) => p.equivalent).length} ·{" "}
                      {m.changedMetrics}:{" "}
                      {proposal.pairs.filter((p) => !p.equivalent).length} ·{" "}
                      {m.addedMetrics}: {proposal.added.length} ·{" "}
                      {m.removedMetrics}: {proposal.removed.length}
                    </p>
                    {proposal.pairs.some((p) => !p.equivalent) && (
                      <p role="note">{m.notEquivalentNote}</p>
                    )}
                    <label>
                      {m.rationale}
                      <textarea
                        value={form.rationale}
                        maxLength={2000}
                        onChange={(e) =>
                          setForm({ ...form, rationale: e.target.value })
                        }
                      />
                    </label>
                    <button
                      disabled={!form.rationale.trim() || busy}
                      onClick={() =>
                        void (async () => {
                          setError("");
                          try {
                            const equivalentPairs = proposal.pairs.filter(
                              (p) => p.equivalent,
                            );
                            const classification = proposal.identicalVersion
                              ? "IDENTICAL"
                              : equivalentPairs.length
                                ? "REVIEWED_EQUIVALENT"
                                : "NOT_COMPARABLE";
                            const created = await api("comparisons", {
                              method: "POST",
                              body: JSON.stringify({
                                leftRoundId: form.left,
                                rightRoundId: form.right,
                                classification,
                                mapping:
                                  classification === "NOT_COMPARABLE"
                                    ? []
                                    : equivalentPairs.map((p) => ({
                                        leftKey: p.leftKey,
                                        rightKey: p.rightKey,
                                      })),
                                rationale: form.rationale.trim(),
                              }),
                            });
                            setView(created);
                            setNote(m.saved);
                            setProposal(null);
                            await load();
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "");
                          }
                        })()
                      }
                    >
                      {m.save}
                    </button>
                  </div>
                )}
              </section>
            )}
          </>
        )}
    </>,
  );
}
