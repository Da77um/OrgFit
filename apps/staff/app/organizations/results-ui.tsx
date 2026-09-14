/* Full document navigation intentionally clears organization-scoped state. */
"use client";
import { ChangeProblem, silent, useStaffApi, type ChangeFailure } from "../request-ui";
import { RequestFailure } from "../staff-request";
import { useUnsavedChanges, type SaveOutcome } from "../unsaved";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Profile } from "../../../../src/db";
import type { DirectoryRecord } from "../../../../src/directory";
import { messages, type Locale } from "../../../../src/i18n";
import { resultsMessages, localeText } from "../../../../src/results-i18n";
import { ReportsPanel } from "./reports-ui";
import { utcDate } from "../../../../src/zoned-time";
import { Workspace, organizationName } from "../shell";
import {
  Alert,
  Badge,
  EmptyState,
  ErrorState,
  Label,
  LoadingState,
  Meter,
  Micro,
  PageHeader,
  Tile,
} from "../../../../src/ui";

// The staff analytics surface. Every number it renders came from a published
// aggregate cell; it computes no value of its own, so it cannot display one the
// disclosure engine withheld. Withheld cells arrive with nulls and are shown as
// an explained status, never as zero, an empty bar or a gap in a chart.

type M = ReturnType<typeof resultsMessages>;
type Translation = { ar?: string; en?: string };
type Band = { key: string; label: Translation; severity: string; semantic: string };
type Cell = {
  groupKey: string;
  metricKey: string;
  status: "AVAILABLE" | "SUPPRESSED" | "INSUFFICIENT" | "UNSCORED" | "NOT_COMPARABLE";
  reasonCode: string | null;
  contributorCount: number | null;
  value: string | null;
  coverage: string | null;
  distribution: {
    total: number;
    bins: { key: string; label: Translation; count: number; share: string }[];
  } | null;
  band: Band | null;
};
type Metric = {
  key: string;
  kind: "OVERALL" | "DIMENSION" | "QUESTION";
  label: Translation;
  description: Translation;
  direction: "HIGH_GOOD" | "HIGH_RISK" | null;
  unit: string;
  bands: Band[];
};
type Group = { key: string; kind: string; label: Translation };
type Ranked = { metricKey: string; label: Translation; value: string; band: Band | null };
type ViewData = {
  view: "overview" | "departments" | "questions" | "recommendations";
  snapshotId: string;
  contentHash: string;
  threshold: number;
  companyGroupKey: string;
  metrics: Metric[];
  cells: Cell[];
  groups: Group[];
  contributorCount?: number;
  generatedAt?: string;
  period?: Record<string, string | null>;
  versions?: Record<string, string>;
  manifest?: Record<string, string | number>;
  strengths?: Ranked[];
  weaknesses?: Ranked[];
  gaps?: { groupKey: string; metricKey: string; points: string | null }[];
  items?: Recommendation[];
  rulesVersion?: string | null;
  previewCount?: number;
};
type ActionRecord = {
  id: string;
  status: "OPEN" | "IN_PROGRESS" | "DONE" | "DISMISSED";
  ownerStaffId: string | null;
  ownerName: string | null;
  dueDate: string | null;
  staffNotes: string | null;
  resolution: string | null;
  revision: number;
};
type Recommendation = {
  id: string;
  groupKey: string;
  metricKey: string;
  ruleKey: string;
  rulesVersion: string;
  priority: number;
  severity: string;
  text: {
    title: Translation;
    body: Translation;
    action: Translation;
    rationale: Translation;
  };
  evidence: {
    items: { metricKey: string; groupKey: string; value: string; unit: string }[];
  };
  action: ActionRecord | null;
};
type StaffOption = { id: string; displayName: string };
const VIEWS = ["overview", "departments", "questions", "recommendations"] as const;
// "reports" is a tab, not a results view: it requests a rendering of what the
// other tabs already show and fetches nothing from the results endpoint.
const TABS = [...VIEWS, "reports"] as const;
type Tab = (typeof TABS)[number];
const subscribe = () => () => {};

// A cell is either a published value or an explained absence. This single
// helper is what keeps "missing" from ever rendering as a number.
function statusText(cell: Cell | undefined, m: M) {
  if (!cell) return m.UNSCORED;
  const base = m[cell.status as keyof M] ?? cell.status;
  const reason = cell.reasonCode
    ? (m[cell.reasonCode as keyof M] ?? "")
    : "";
  return reason ? `${base} — ${reason}` : String(base);
}

function Bar({ cell, m }: { cell: Cell | undefined; m: M }) {
  if (!cell || cell.status !== "AVAILABLE" || cell.value === null)
    return (
      <p className="result-withheld" role="note">
        {statusText(cell, m)}
      </p>
    );
  const value = Number(cell.value);
  return <Meter value={value} label={m.value} accent={value < 55} />;
}

// An accessible radar over the published dimensions only. A withheld dimension
// is absent from the polygon rather than plotted at the origin, which would
// read as a score of zero.
function Radar({
  metrics,
  cells,
  company,
  m,
  locale,
}: {
  metrics: Metric[];
  cells: Cell[];
  company: string;
  m: M;
  locale: Locale;
}) {
  const points = metrics
    .filter((metric) => metric.kind === "DIMENSION")
    .map((metric) => ({
      metric,
      cell: cells.find(
        (c) => c.metricKey === metric.key && c.groupKey === company,
      ),
    }))
    .filter((p) => p.cell?.status === "AVAILABLE" && p.cell.value !== null);
  if (points.length < 3) return null;
  // Exactly one dimension is carried in clay — the weakest published one. The
  // identity's rule is that a signature colours a single concern, and here that
  // concern is the same one the recommendations open with.
  const lowest = points.reduce((low, p) =>
    Number(p.cell!.value) < Number(low.cell!.value) ? p : low,
  ).metric.key;
  const size = 260,
    center = size / 2,
    radius = center - 46;
  const at = (index: number, fraction: number) => {
    const angle = (index / points.length) * 2 * Math.PI - Math.PI / 2;
    return [
      center + Math.cos(angle) * radius * fraction,
      center + Math.sin(angle) * radius * fraction,
    ] as const;
  };
  return (
    <figure className="result-radar">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby="radarTitle radarDesc">
        <title id="radarTitle">{m.radar}</title>
        <desc id="radarDesc">{m.radarDescription}</desc>
        {[0.25, 0.5, 0.75, 1].map((ring) => (
          <polygon
            key={ring}
            className="radar-grid"
            points={points.map((_, i) => at(i, ring).join(",")).join(" ")}
          />
        ))}
        {points.map((p, i) => {
          const [x, y] = at(i, 1);
          return (
            <line
              key={"axis-" + p.metric.key}
              className="radar-axis"
              x1={center}
              y1={center}
              x2={x}
              y2={y}
            />
          );
        })}
        <polygon
          className="radar-shape"
          points={points
            .map((p, i) => at(i, Number(p.cell!.value) / 100).join(","))
            .join(" ")}
        />
        {points.map((p, i) => {
          const [x, y] = at(i, Number(p.cell!.value) / 100);
          return (
            <circle
              key={"node-" + p.metric.key}
              className={p.metric.key === lowest ? "radar-node-low" : "radar-node"}
              cx={x}
              cy={y}
              r="3.5"
            />
          );
        })}
        {points.map((p, i) => {
          const [x, y] = at(i, 1.16);
          return (
            <text key={p.metric.key} x={x} y={y} className="radar-label">
              {localeText(p.metric.label, locale).slice(0, 18)}
            </text>
          );
        })}
      </svg>
      <figcaption>{m.radarDescription}</figcaption>
    </figure>
  );
}

function ScoreTable({
  metrics,
  cells,
  company,
  m,
  locale,
}: {
  metrics: Metric[];
  cells: Cell[];
  company: string;
  m: M;
  locale: Locale;
}) {
  return (
    <div
      className="table-wrap scroll"
      tabIndex={0}
      role="region"
      aria-label={m.table}
    >
      <table className="result-table">
        <caption>{m.table}</caption>
        <thead>
          <tr>
            <th scope="col">{m.metric}</th>
            <th scope="col">{m.value}</th>
            <th scope="col">{m.band}</th>
            <th scope="col">{m.respondents}</th>
            <th scope="col">{m.coverage}</th>
            <th scope="col">{m.status}</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((metric) => {
            const cell = cells.find(
              (c) => c.metricKey === metric.key && c.groupKey === company,
            );
            const available = cell?.status === "AVAILABLE";
            return (
              <tr key={metric.key}>
                <th scope="row">
                  {localeText(metric.label, locale)}
                  {metric.direction && (
                    <span className="muted"> · {m[metric.direction]}</span>
                  )}
                </th>
                <td>{available ? cell!.value : "—"}</td>
                <td>
                  {available && cell!.band ? (
                    <Badge tone={bandTone(cell!.band.severity)}>
                      {localeText(cell!.band.label, locale)}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{available ? cell!.contributorCount : "—"}</td>
                <td>{available ? cell!.coverage : "—"}</td>
                <td>{statusText(cell, m)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Overview({ data, m, locale }: { data: ViewData; m: M; locale: Locale }) {
  const company = data.companyGroupKey;
  const list = (title: string, items: Ranked[] | undefined) => (
    <div className="stack">
      <h3>{title}</h3>
      {items?.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.metricKey}>
              {localeText(item.label, locale)} — {item.value}
              {item.band ? ` (${localeText(item.band.label, locale)})` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{m.none}</p>
      )}
    </div>
  );
  return (
    <div className="stack">
      <div className="tiles">
        <Tile label={m.contributors} value={data.contributorCount ?? "—"} />
        <Tile label={m.threshold} value={data.threshold} />
        <Tile label={m.generated} value={utcDate(data.generatedAt) || "—"} />
      </div>
      {/* Provenance: which engine, which disclosure rules, which snapshot. It
          stays on screen because a released number only means something with
          the version that produced it. */}
      <dl className="result-facts">
        <div>
          <dt>{m.engine}</dt>
          <dd>{data.versions?.scoring}</dd>
        </div>
        <div>
          <dt>{m.disclosure}</dt>
          <dd>{data.manifest?.disclosureVersion}</dd>
        </div>
        <div>
          <dt>{m.snapshot}</dt>
          <dd className="muted">{data.contentHash.slice(0, 16)}</dd>
        </div>
      </dl>
      {data.metrics.map((metric) => {
        const cell = data.cells.find(
          (c) => c.metricKey === metric.key && c.groupKey === company,
        );
        return (
          <section key={metric.key} className="stack result-metric">
            <h3>
              {metric.kind === "OVERALL" ? m.overall : localeText(metric.label, locale)}
            </h3>
            {localeText(metric.description, locale) && (
              <p className="muted">{localeText(metric.description, locale)}</p>
            )}
            <Bar cell={cell} m={m} />
            {cell?.status === "AVAILABLE" && cell.band && (
              <p>
                {m.band}: {localeText(cell.band.label, locale)}
              </p>
            )}
          </section>
        );
      })}
      <Radar
        metrics={data.metrics}
        cells={data.cells}
        company={company}
        m={m}
        locale={locale}
      />
      <div className="grid">
        {list(m.strengths, data.strengths)}
        {list(m.weaknesses, data.weaknesses)}
      </div>
      <ScoreTable
        metrics={data.metrics}
        cells={data.cells}
        company={company}
        m={m}
        locale={locale}
      />
    </div>
  );
}

function Departments({ data, m, locale }: { data: ViewData; m: M; locale: Locale }) {
  const company = data.companyGroupKey;
  const cell = (metricKey: string, groupKey: string) =>
    data.cells.find((c) => c.metricKey === metricKey && c.groupKey === groupKey);
  const gap = (metricKey: string, groupKey: string) =>
    data.gaps?.find((g) => g.metricKey === metricKey && g.groupKey === groupKey)
      ?.points ?? null;
  return (
    <div className="stack">
      <Alert tone="info" role="note">
        {m.descriptive}
      </Alert>
      <div
        className="table-wrap scroll"
        tabIndex={0}
        role="region"
        aria-label={m.heatmap}
      >
      <table className="result-table heatmap table-sticky">
        <caption>{m.heatmap}</caption>
        <thead>
          <tr>
            <th scope="col">{m.metric}</th>
            <th scope="col">{m.company}</th>
            {data.groups?.map((group) => (
              <th key={group.key} scope="col">
                {localeText(group.label, locale)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.metrics.map((metric) => (
            <tr key={metric.key}>
              <th scope="row">
                {metric.kind === "OVERALL" ? m.overall : localeText(metric.label, locale)}
              </th>
              {[{ key: company }, ...(data.groups ?? [])].map((group) => {
                const current = cell(metric.key, group.key);
                const available =
                  current?.status === "AVAILABLE" && current.value !== null;
                const points = group.key === company ? null : gap(metric.key, group.key);
                return (
                  <td
                    key={group.key}
                    // The shade is redundant with the printed number, never the
                    // only way a value is communicated.
                    className={available ? `heat heat-${band(Number(current!.value))}` : "heat-none"}
                  >
                    {available ? (
                      <>
                        <span className="heat-value">{current!.value}</span>
                        {points !== null && (
                          // A signed number is isolated left to right: under
                          // RTL "-10.0" otherwise prints as "10.0-" (CF-004).
                          <span className="muted">
                            {" "}
                            (<bdi dir="ltr">{Number(points) > 0 ? "+" : ""}{points}</bdi>)
                          </span>
                        )}
                        <span className="muted"> · {current!.contributorCount}</span>
                      </>
                    ) : (
                      <span className="result-withheld">{statusText(current, m)}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <p className="muted">{m.gap}</p>
    </div>
  );
}

// The disclosure engine names the severity; the badge only reflects it, and
// prints the band's own word beside a glyph so the judgement survives a
// greyscale print and a reader who cannot separate the hues.
function bandTone(severity: string) {
  const s = severity.toUpperCase();
  return s.includes("CRITICAL") || s.includes("HIGH")
    ? "danger"
    : s.includes("MEDIUM") || s.includes("MODERATE")
      ? "caution"
      : s.includes("LOW") || s.includes("NONE") || s.includes("GOOD")
        ? "positive"
        : "neutral";
}
const band = (value: number) =>
  value >= 80 ? 5 : value >= 60 ? 4 : value >= 40 ? 3 : value >= 20 ? 2 : 1;

function Questions({ data, m, locale }: { data: ViewData; m: M; locale: Locale }) {
  return (
    <div className="stack">
      {data.metrics.map((metric) => {
        const cell = data.cells.find((c) => c.metricKey === metric.key);
        return (
          <section key={metric.key} className="stack result-metric">
            <h3>{localeText(metric.label, locale)}</h3>
            {cell?.status === "AVAILABLE" && cell.distribution ? (
              <div
                className="table-wrap scroll"
                tabIndex={0}
                role="region"
                aria-label={`${m.respondents}: ${cell.contributorCount}`}
              >
                <table className="result-table">
                  <caption>
                    {m.respondents}: {cell.contributorCount}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{m.value}</th>
                      <th scope="col">{m.respondents}</th>
                      <th scope="col">{m.share}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cell.distribution.bins.map((bin) => (
                      <tr key={bin.key}>
                        <th scope="row">{localeText(bin.label, locale)}</th>
                        <td>{bin.count}</td>
                        <td>
                          <Meter
                            value={Math.round(Number(bin.share) * 100)}
                            label={m.share}
                            suffix="%"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : cell?.status === "AVAILABLE" && cell.value !== null ? (
              <p>
                {m.value}: {cell.value} · {m.respondents}: {cell.contributorCount}
              </p>
            ) : (
              <p className="result-withheld" role="note">
                {statusText(cell, m)}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

// One recommendation: the frozen computed finding, then the separate human
// follow-up beside it. The two are visually and structurally distinct, and the
// computed half has no editable control at all.
function RecommendationCard({
  item,
  data,
  m,
  locale,
  org,
  staff,
  onSaved,
}: {
  item: Recommendation;
  data: ViewData;
  m: M;
  locale: Locale;
  org: string;
  staff: StaffOption[];
  onSaved: () => void;
}) {
  const stored = {
    status: item.action?.status ?? "OPEN",
    ownerStaffId: item.action?.ownerStaffId ?? "",
    dueDate: item.action?.dueDate ?? "",
    staffNotes: item.action?.staffNotes ?? "",
    resolution: item.action?.resolution ?? "",
  };
  const [form, setForm] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<ChangeFailure | null>(null);
  const client = useStaffApi(locale);
  // Dirty against what the server holds for this action; a confirmed save
  // reloads the card with the saved values, which are then clean.
  const dirty = JSON.stringify(form) !== JSON.stringify(stored);
  useUnsavedChanges(dirty, () => save());
  const group = data.groups?.find((g) => g.key === item.groupKey);
  const metricLabel = (key: string) =>
    localeText(data.metrics.find((x) => x.key === key)?.label, locale) || key;
  // The first save creates the follow-up row (no revision: not replaceable
  // while unconfirmed); later saves carry its revision and may replace.
  const scope = `recommendation-action:${item.id}`;
  const save = async (again = false): Promise<SaveOutcome> => {
    setBusy(true);
    setNote("");
    setProblem(null);
    try {
      if (again) await client.retry(scope);
      else
        await client.mutate(scope, `/api/v1/organizations/${org}/recommendation-actions/${item.id}`, {
          method: "PATCH",
          revision: item.action?.revision,
          replace: !!item.action,
          body: {
            status: form.status,
            ownerStaffId: form.ownerStaffId || null,
            dueDate: form.dueDate || null,
            staffNotes: form.staffNotes || null,
            resolution: form.resolution || null,
          },
        });
      setNote(m.saved);
      onSaved();
      return { ok: true };
    } catch (e) {
      if (!silent(e)) {
        if (e instanceof RequestFailure && (e.uncertain || e.kind === "SESSION"))
          setProblem({ failure: e, scope, retry: () => void save(true) });
        else setNote(e instanceof Error && e.message ? e.message : m.unavailable);
      }
      return { ok: false };
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="stack result-metric">
      <h3>{localeText(item.text.title, locale)}</h3>
      <p className="muted">
        {m.priority}: {item.priority} · {m.severityLabel}:{" "}
        {(m[item.severity as keyof M] as string) ?? item.severity}
        {group ? ` · ${localeText(group.label, locale)}` : ` · ${m.company}`}
      </p>
      <p>{localeText(item.text.body, locale)}</p>
      <p>
        <strong>{m.suggestedAction}:</strong>{" "}
        {localeText(item.text.action, locale)}
      </p>
      {localeText(item.text.rationale, locale) && (
        <p>
          <strong>{m.rationale}:</strong>{" "}
          {localeText(item.text.rationale, locale)}
        </p>
      )}
      <div
        className="table-wrap scroll"
        tabIndex={0}
        role="region"
        aria-label={m.evidence}
      >
        <table className="result-table">
          <caption>{m.evidence}</caption>
          <thead>
            <tr>
              <th scope="col">{m.metric}</th>
              <th scope="col">{m.value}</th>
            </tr>
          </thead>
          <tbody>
            {item.evidence.items.map((e) => (
              <tr key={e.metricKey}>
                <th scope="row">{metricLabel(e.metricKey)}</th>
                <td>{e.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        {m.ruleReference}: {item.ruleKey.slice(0, 8)} · {m.rulesVersion}:{" "}
        {item.rulesVersion}
      </p>
      <div className="note" role="note">
        <p>{m.frozenNote}</p>
      </div>
      <div className="stack">
        <div className="form-grid">
          <label>
            {m.actionStatus}
            <select
              value={form.status}
              onChange={(e) =>
                setForm({
                  ...form,
                  status: e.target.value as ActionRecord["status"],
                })
              }
            >
              {(["OPEN", "IN_PROGRESS", "DONE", "DISMISSED"] as const).map(
                (s) => (
                  <option key={s} value={s}>
                    {m[s]}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            {m.owner}
            <select
              value={form.ownerStaffId}
              onChange={(e) =>
                setForm({ ...form, ownerStaffId: e.target.value })
              }
            >
              <option value="">{m.unassigned}</option>
              {staff.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            {m.dueDate}
            <input
              type="date"
              value={form.dueDate}
              onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
            />
          </label>
        </div>
        <label>
          {m.staffNotes}
          <textarea
            value={form.staffNotes}
            maxLength={4000}
            onChange={(e) => setForm({ ...form, staffNotes: e.target.value })}
          />
        </label>
        <label>
          {m.resolution}
          <textarea
            value={form.resolution}
            maxLength={4000}
            onChange={(e) => setForm({ ...form, resolution: e.target.value })}
          />
        </label>
        <div className="row">
          <button disabled={busy} onClick={() => void save()}>
            {m.saveAction}
          </button>
          <span role="status">{note}</span>
        </div>
        <ChangeProblem
          locale={locale}
          problem={problem}
          ledger={client.ledger}
          busy={busy}
          onCheck={onSaved}
          onDismiss={() => setProblem(null)}
        />
      </div>
    </section>
  );
}

function Recommendations({
  data,
  m,
  locale,
  org,
  reload,
}: {
  data: ViewData;
  m: M;
  locale: Locale;
  org: string;
  reload: () => void;
}) {
  const [all, setAll] = useState(false);
  // The owner list is staff identity, not result data: it comes from the access
  // surface and never from the release.
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const client = useStaffApi(locale);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        // The staff list is keyset-paginated; active accounts are followed
        // page by page (bounded) so an owner past the first page is offered.
        const all: StaffOption[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 20; page++) {
          const data: { items?: StaffOption[]; nextCursor?: string | null } = await client.read(
            `/api/v1/staff?status=ACTIVE&limit=100${cursor ? `&cursor=${cursor}` : ""}`,
          );
          all.push(...(data.items ?? []));
          cursor = data.nextCursor ?? null;
          if (!cursor) break;
        }
        if (live) setStaff(all);
      } catch {
        /* The owner select degrades to "unassigned" only. */
      }
    })();
    return () => {
      live = false;
    };
  }, [client]);
  const items = data.items ?? [];
  const preview = data.previewCount ?? 5;
  const shown = all ? items : items.slice(0, preview);
  return (
    <div className="stack">
      <Alert tone="info" role="note">
        {m.recommendationsNote}
      </Alert>
      {!items.length && <EmptyState title={m.noRecommendations} />}
      {shown.map((item) => (
        <RecommendationCard
          key={item.id}
          item={item}
          data={data}
          m={m}
          locale={locale}
          org={org}
          staff={staff}
          onSaved={reload}
        />
      ))}
      {items.length > preview && (
        <p>
          <button className="button-secondary" onClick={() => setAll(!all)}>
            {all ? m.showTop : m.showAll}
          </button>
        </p>
      )}
    </div>
  );
}

export function Results({
  profile,
  organization,
  path,
}: {
  profile: Profile;
  organization: DirectoryRecord | null;
  path: string[];
}) {
  const locale = profile.locale as Locale;
  const m = resultsMessages(locale),
    base = messages(locale);
  const org = path[0],
    roundId = path[2] ?? "";
  const [view, setView] = useState<Tab>("overview");
  const [data, setData] = useState<ViewData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const client = useStaffApi(locale);
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const load = useCallback(
    async (next: Tab) => {
      setBusy(true);
      setError("");
      try {
        // The reports tab owns its own loading; the results payload it would
        // otherwise leave on screen belongs to a different view.
        if (next === "reports") {
          setData(null);
          return;
        }
        const suffix = next === "overview" ? "" : `/${next}`;
        try {
          setData(
            await client.read<ViewData>(
              `/api/v1/organizations/${org}/assessments/${roundId}/results${suffix}`,
            ),
          );
        } catch (e) {
          if (e instanceof RequestFailure && e.code === "RESULTS_NOT_READY") throw new Error(m.notReady);
          if (e instanceof RequestFailure && e.code === "RESULTS_UNAVAILABLE") throw new Error(m.unavailable);
          throw e;
        }
      } catch (e) {
        if (silent(e)) return;
        setData(null);
        setError(e instanceof Error ? e.message : base.unavailable);
      } finally {
        setBusy(false);
      }
    },
    [org, roundId, client, m, base],
  );
  useEffect(() => {
    void load(view);
  }, [load, view]);
  const shell = (children: React.ReactNode) => (
    <Workspace
      locale={locale}
      organization={organization}
      section="results"
      canManage={
        profile.role === "SUPER_ADMIN" ||
        profile.capabilities.includes("directory.manage")
      }
    >
      {children}
    </Workspace>
  );
  if (!hydrated) return shell(<LoadingState label={m.loading} />);
  return shell(
    <>
      <PageHeader
        eyebrow={<Label accent>{organizationName(organization, locale)}</Label>}
        title={m.results}
        sub={m.privacyNote}
        meta={
          data?.contentHash ? <Micro>SNAPSHOT {data.contentHash.slice(0, 8)}</Micro> : undefined
        }
      />
      <nav aria-label={m.results}>
        <ul className="tabs">
          {TABS.map((item) => (
            <li key={item}>
              <button
                aria-current={view === item ? "page" : undefined}
                // Busy tabs stay focusable (CF-005): \`disabled\` threw keyboard
                // focus off the tab just activated and left the scrolling tab
                // strip with nothing a keyboard could reach.
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) setView(item);
                }}
              >
                {m[item]}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {error && <ErrorState title={base.errorTitle} body={error} />}
      <p role="status" aria-live="polite">
        {busy ? m.loading : ""}
      </p>
        {/* Each view renders only its OWN payload. The requested tab changes
            before the fetch resolves, and the views do not share a shape — the
            recommendations release carries no cells — so keying the render on
            the loaded payload is what keeps a tab switch from rendering one
            view against another's data. */}
        {data?.view === "overview" && (
          <Overview data={data} m={m} locale={locale} />
        )}
        {data?.view === "departments" && (
          <Departments data={data} m={m} locale={locale} />
        )}
        {data?.view === "questions" && (
          <Questions data={data} m={m} locale={locale} />
        )}
        {view === "reports" && (
          <ReportsPanel org={org} roundId={roundId} locale={locale} />
        )}
      {data?.view === "recommendations" && (
        <Recommendations
          data={data}
          m={m}
          locale={locale}
          org={org}
          reload={() => void load("recommendations")}
        />
      )}
    </>,
  );
}
