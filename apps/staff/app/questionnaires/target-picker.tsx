"use client";
import { useEffect, useState } from "react";
import type { DepartmentOption, QuestionnaireTarget } from "../../../../src/instruments";
import { silent } from "../request-ui";

// Questionnaire targeting inside its organization. The organization always
// owns the questionnaire and stays visible; departments are only a narrower
// target within it, and are only ever loaded for that one organization.
export type TargetValue = {
  mode: QuestionnaireTarget["target_mode"];
  departmentIds: string[];
};
export const entireOrganization: TargetValue = { mode: "ORGANIZATION", departmentIds: [] };
type Translate = (ar: string, en: string) => string;
type Organization = { id: string; name_ar: string; name_en: string | null };

export const departmentName = (d: DepartmentOption, locale: string) =>
  locale === "ar" ? d.name_ar : d.name_en || d.name_ar;
export const organizationName = (o: Organization | undefined, locale: string) =>
  o ? (locale === "ar" ? o.name_ar : o.name_en || o.name_ar) : "";

// Options for exactly one organization. A slower answer for an organization
// that is no longer selected is discarded, so another organization's
// departments can never appear in the list.
export function useDepartmentOptions(
  read: <T>(url: string) => Promise<T>,
  org: string | null,
) {
  const [state, setState] = useState<{
    org: string | null;
    items: DepartmentOption[];
    failed: boolean;
  }>({ org: null, items: [], failed: false });
  useEffect(() => {
    if (!org) return;
    let live = true;
    read<{ items: DepartmentOption[] }>(`/api/v1/organizations/${org}/questionnaire-departments`)
      .then((data) => live && setState({ org, items: data.items, failed: false }))
      .catch((e) => live && !silent(e) && setState({ org, items: [], failed: true }));
    return () => {
      live = false;
    };
  }, [read, org]);
  const current = !!org && state.org === org;
  return {
    items: current ? state.items : [],
    loading: !!org && !current,
    failed: current && state.failed,
  };
}

// The request body for a target, restricted to departments of the currently
// loaded organization. The server validates again; this only guarantees the
// screen never sends an identifier it is not showing.
export function targetBody(value: TargetValue, options: DepartmentOption[]) {
  if (value.mode === "ORGANIZATION") return { mode: "ORGANIZATION" as const };
  const allowed = new Set(options.filter((d) => d.status === "ACTIVE").map((d) => d.id));
  return {
    mode: "DEPARTMENTS" as const,
    departmentIds: value.departmentIds.filter((id) => allowed.has(id)),
  };
}
export const targetComplete = (value: TargetValue, options: DepartmentOption[]) => {
  const body = targetBody(value, options);
  return body.mode === "ORGANIZATION" || body.departmentIds.length > 0;
};

export function TargetPicker({
  t,
  locale,
  org,
  value,
  onChange,
  options,
  name,
}: {
  t: Translate;
  locale: string;
  org: string;
  value: TargetValue;
  onChange: (v: TargetValue) => void;
  options: ReturnType<typeof useDepartmentOptions>;
  name: string;
}) {
  const active = options.items.filter((d) => d.status === "ACTIVE");
  const chosen = new Set(value.departmentIds);
  return (
    <fieldset className="stack-tight" data-testid={`${name}-target`}>
      <legend>{t("الاستهداف", "Target")}</legend>
      <label className="choice">
        <input
          type="radio"
          name={`${name}-mode`}
          checked={value.mode === "ORGANIZATION"}
          onChange={() => onChange({ mode: "ORGANIZATION", departmentIds: [] })}
        />
        <span>{t("المنظمة بالكامل", "Entire organization")}</span>
      </label>
      <label className="choice">
        <input
          type="radio"
          name={`${name}-mode`}
          checked={value.mode === "DEPARTMENTS"}
          onChange={() => onChange({ mode: "DEPARTMENTS", departmentIds: value.departmentIds })}
        />
        <span>{t("أقسام محددة", "Specific departments")}</span>
      </label>
      {value.mode === "DEPARTMENTS" && (
        <fieldset className="stack-tight">
          <legend>{t("أقسام هذه المنظمة", "This organization's departments")}</legend>
          {options.loading ? (
            <p role="status">{t("جارٍ تحميل الأقسام…", "Loading departments…")}</p>
          ) : options.failed ? (
            <p role="alert">
              {t("تعذر تحميل أقسام المنظمة. أعد المحاولة.", "The organization's departments could not be loaded. Try again.")}
            </p>
          ) : !active.length ? (
            <p>
              {t("لا توجد أقسام نشطة في هذه المنظمة. ", "This organization has no active departments. ")}
              <a href={`/organizations/${org}/departments`}>
                {t("إدارة أقسام المنظمة", "Manage the organization's departments")}
              </a>
            </p>
          ) : (
            <>
              {active.map((d) => (
                <label className="choice" key={d.id}>
                  <input
                    type="checkbox"
                    checked={chosen.has(d.id)}
                    onChange={(e) =>
                      onChange({
                        mode: "DEPARTMENTS",
                        departmentIds: e.target.checked
                          ? [...value.departmentIds.filter((id) => id !== d.id), d.id]
                          : value.departmentIds.filter((id) => id !== d.id),
                      })
                    }
                  />
                  <span>
                    <bdi>{departmentName(d, locale)}</bdi> <small className="muted">{d.code}</small>
                  </span>
                </label>
              ))}
              {!targetComplete(value, options.items) && (
                <p className="muted">{t("اختر قسماً واحداً على الأقل.", "Select at least one department.")}</p>
              )}
            </>
          )}
        </fieldset>
      )}
    </fieldset>
  );
}

export function targetText(
  t: Translate,
  locale: string,
  target: Partial<QuestionnaireTarget>,
) {
  return target.target_mode === "DEPARTMENTS"
    ? (target.departments ?? []).map((d) => departmentName(d, locale)).join(locale === "ar" ? "، " : ", ")
    : t("المنظمة بالكامل", "Entire organization");
}

// Organization first, always: a department is shown only as part of it.
export function TargetSummary({
  t,
  locale,
  organization,
  target,
}: {
  t: Translate;
  locale: string;
  organization: string;
  target: Partial<QuestionnaireTarget>;
}) {
  return (
    <dl className="result-facts" data-testid="questionnaire-target-summary">
      <div>
        <dt>{t("المنظمة", "Organization")}</dt>
        <dd className="fact-text">
          <bdi>{organization}</bdi>
        </dd>
      </div>
      <div>
        <dt>{t("الاستهداف", "Target")}</dt>
        <dd className="fact-text">
          <bdi>{targetText(t, locale, target)}</bdi>
        </dd>
      </div>
    </dl>
  );
}
