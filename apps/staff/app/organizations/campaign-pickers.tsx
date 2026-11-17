"use client";
// Pickers for the campaign forms (D-189): a questionnaire, a department or
// people are chosen from lists, never typed as identifiers. The lists come
// from read-only routes under the reader's own capabilities.
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { staffRequest } from "../staff-request";
import { redirectIfClean, silent } from "../request-ui";
import { campaignMessages, fill } from "../../../../src/campaign-i18n";
import { messages, type Locale } from "../../../../src/i18n";
import type {
  CampaignOptions,
  DepartmentChoice,
  UsableVersion,
} from "../../../../src/campaign-guide";

type M = ReturnType<typeof campaignMessages>;

export function useCampaignOptions(org: string, locale: Locale, enabled = true) {
  const [options, setOptions] = useState<CampaignOptions | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const r = await staffRequest<CampaignOptions>(
        locale,
        `/api/v1/organizations/${org}/campaign-options`,
      );
      setOptions(r.data);
      setError("");
    } catch (e) {
      redirectIfClean(e);
      if (!silent(e)) setError(e instanceof Error ? e.message : messages(locale).unavailable);
    }
  }, [org, locale, enabled]);
  useEffect(() => {
    void load();
  }, [load]);
  return { options, error, reload: load };
}

export const versionTitle = (v: UsableVersion, locale: Locale) =>
  (locale === "en" ? v.title?.en || v.title?.ar : v.title?.ar) ||
  (locale === "en" ? v.name.en || v.name.ar : v.name.ar);

export const departmentName = (d: { nameAr: string; nameEn: string | null }, locale: Locale) =>
  locale === "en" ? d.nameEn || d.nameAr : d.nameAr;

export function VersionSelect({
  id,
  name,
  versions,
  value,
  onChange,
  locale,
  disabled,
  describedBy,
}: {
  id: string;
  name?: string;
  versions: UsableVersion[];
  value: string;
  onChange: (id: string) => void;
  locale: Locale;
  disabled?: boolean;
  describedBy?: string;
}) {
  const m = campaignMessages(locale);
  const group = (scope: UsableVersion["scope"]) =>
    versions
      .filter((v) => v.scope === scope)
      .map((v) => (
        <option key={v.id} value={v.id}>
          {fill(m.versionOption, { title: versionTitle(v, locale), n: v.versionNumber })}
        </option>
      ));
  const own = group("ORGANIZATION"),
    global = group("GLOBAL");
  return (
    <select
      id={id}
      name={name}
      required
      value={value}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.currentTarget.value)}
    >
      <option value="">{m.chooseQuestionnaire}</option>
      {own.length > 0 && <optgroup label={m.ownLibrary}>{own}</optgroup>}
      {global.length > 0 && <optgroup label={m.globalLibrary}>{global}</optgroup>}
    </select>
  );
}

// One entry per questionnaire lineage (family), for the series form.
export function FamilySelect({
  id,
  name,
  versions,
  locale,
}: {
  id: string;
  name: string;
  versions: UsableVersion[];
  locale: Locale;
}) {
  const m = campaignMessages(locale);
  const seen = new Set<string>();
  const families = versions.filter((v) => !seen.has(v.familyKey) && seen.add(v.familyKey));
  return (
    <select id={id} name={name} required defaultValue="">
      <option value="">{m.chooseQuestionnaire}</option>
      {families.map((v) => (
        <option key={v.familyKey} value={v.familyKey}>
          {locale === "en" ? v.name.en || v.name.ar : v.name.ar}
        </option>
      ))}
    </select>
  );
}

export function DepartmentSelect({
  id,
  name,
  departments,
  value,
  onChange,
  locale,
  describedBy,
}: {
  id: string;
  name?: string;
  departments: DepartmentChoice[];
  value: string;
  onChange: (id: string) => void;
  locale: Locale;
  describedBy?: string;
}) {
  const m = campaignMessages(locale);
  return (
    <select
      id={id}
      name={name}
      required
      value={value}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.currentTarget.value)}
    >
      <option value="">{m.chooseDepartment}</option>
      {departments.map((d) => (
        <option key={d.id} value={d.id}>
          {d.active === null
            ? departmentName(d, locale)
            : fill(m.departmentCount, { name: departmentName(d, locale), n: d.active })}
        </option>
      ))}
    </select>
  );
}

export type Person = { id: string; name: string; reference: string };
type Listed = {
  items: { id: string; display_name: string; private_reference: string }[];
  nextCursor: string | null;
};

// A searchable list of the organization's active participants. The chosen
// people travel as hidden inputs named `name`, one per person, so the forms
// read them like any other field. `single` keeps at most one.
export function ParticipantPicker({
  org,
  locale,
  name,
  idPrefix,
  selected,
  onChange,
  single = false,
  label,
}: {
  org: string;
  locale: Locale;
  name: string;
  idPrefix: string;
  selected: Person[];
  onChange: (people: Person[]) => void;
  single?: boolean;
  label: string;
}) {
  const m: M = campaignMessages(locale);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Person[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const search = useCallback(
    async (text: string, after: string | null) => {
      try {
        const params = new URLSearchParams({ status: "ACTIVE", limit: "20" });
        if (text.trim()) params.set("q", text.trim());
        if (after) params.set("cursor", after);
        const r = await staffRequest<Listed>(
          locale,
          `/api/v1/organizations/${org}/participants?${params}`,
        );
        const people = r.data.items.map((p) => ({
          id: p.id,
          name: p.display_name,
          reference: p.private_reference,
        }));
        setFound((prev) => (after ? [...prev, ...people] : people));
        setCursor(r.data.nextCursor);
        setSearched(true);
        setError("");
      } catch (e) {
        redirectIfClean(e);
        if (!silent(e)) setError(e instanceof Error ? e.message : messages(locale).unavailable);
      }
    },
    [org, locale],
  );
  useEffect(() => {
    void search("", null);
  }, [search]);
  const chosen = new Set(selected.map((p) => p.id));
  const add = (p: Person) => onChange(single ? [p] : [...selected, p]);
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter searches; it must not submit the surrounding form.
    if (e.key === "Enter") {
      e.preventDefault();
      void search(q, null);
    }
  };
  return (
    <fieldset className="stack stack-tight">
      <legend>{label}</legend>
      {selected.map((p) => (
        <input key={p.id} type="hidden" name={name} value={p.id} />
      ))}
      <div className="row">
        <label htmlFor={`${idPrefix}-q`} className="visually-hidden">
          {m.searchPeople}
        </label>
        <input
          id={`${idPrefix}-q`}
          type="search"
          value={q}
          placeholder={m.searchPeople}
          onChange={(e) => setQ(e.currentTarget.value)}
          onKeyDown={keys}
        />
        <button type="button" className="button-secondary" onClick={() => void search(q, null)}>
          {m.search}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {searched && !found.length && <p className="muted">{m.noMatches}</p>}
      {found.length > 0 && (
        <ul className="plain-list stack stack-tight" aria-label={m.searchPeople}>
          {found.map((p) => (
            <li key={p.id} className="row">
              <bdi>{p.name}</bdi>
              <span className="muted">
                <bdi>{p.reference}</bdi>
              </span>
              <button
                type="button"
                className="button-secondary"
                disabled={chosen.has(p.id)}
                aria-label={`${m.add}: ${p.name}`}
                onClick={() => add(p)}
              >
                {m.add}
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button type="button" className="button-secondary" onClick={() => void search(q, cursor)}>
          {m.morePeople}
        </button>
      )}
      <p aria-live="polite">{fill(m.selectedPeople, { n: selected.length })}</p>
      {selected.length > 0 && (
        <ul className="plain-list stack stack-tight" aria-label={fill(m.selectedPeople, { n: selected.length })}>
          {selected.map((p) => (
            <li key={p.id} className="row">
              <bdi>{p.name}</bdi>
              <button
                type="button"
                className="button-secondary"
                aria-label={`${m.remove}: ${p.name}`}
                onClick={() => onChange(selected.filter((x) => x.id !== p.id))}
              >
                {m.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
