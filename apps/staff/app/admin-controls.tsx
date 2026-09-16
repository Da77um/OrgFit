"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AdminMessages } from "../../../src/admin-i18n";

// Small controls shared by the administration screens.

// A destructive action asks once, in place. No modal: the question sits next
// to the control that raised it, focus moves to the confirming button, and
// Cancel (or Escape) puts focus back where it was.
export function ConfirmAction({
  label,
  confirmLabel,
  body,
  onConfirm,
  a,
  disabled = false,
  danger = true,
}: {
  label: string;
  confirmLabel: string;
  body?: ReactNode;
  onConfirm: () => void | Promise<void>;
  a: AdminMessages;
  disabled?: boolean;
  danger?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) confirmRef.current?.focus();
  }, [asking]);
  const close = () => {
    setAsking(false);
    requestAnimationFrame(() => openRef.current?.focus());
  };
  if (!asking)
    return (
      <button
        ref={openRef}
        type="button"
        className={danger ? "button-secondary" : "button-secondary"}
        disabled={disabled}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  return (
    <div
      className="confirm-inline stack stack-tight"
      role="group"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      {body && <p>{body}</p>}
      <div className="row">
        <button
          ref={confirmRef}
          type="button"
          className={danger ? "button-danger" : undefined}
          disabled={disabled}
          onClick={async () => {
            await onConfirm();
            setAsking(false);
          }}
        >
          {confirmLabel}
        </button>
        <button type="button" className="button-quiet" onClick={close}>
          {a.cancel}
        </button>
      </div>
    </div>
  );
}

export type OrganizationOption = {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  status: string;
};

export type AccessValue = {
  role: "SUPER_ADMIN" | "STAFF";
  capabilities: string[];
  organizationIds: string[];
};

export const CAPABILITIES = [
  "directory.manage",
  "instruments.manage",
  "campaigns.manage",
  "participation.read",
  "participation.export",
  "results.read",
  "reports.manage",
  "visits.manage",
  "messages.read",
] as const;

const toggle = (list: string[], value: string, on: boolean) =>
  on ? [...new Set([...list, value])] : list.filter((v) => v !== value);

// Role, capabilities and organizations — the three things an administrator
// decides about an account, in the same shape for an existing account, a new
// provider registration and an invitation.
export function AccessFields({
  a,
  locale,
  idPrefix,
  value,
  onChange,
  organizations,
  organizationsTruncated,
  roleLocked = false,
  children,
}: {
  a: AdminMessages;
  locale: "ar" | "en";
  idPrefix: string;
  value: AccessValue;
  onChange: (next: AccessValue) => void;
  organizations: OrganizationOption[];
  organizationsTruncated: boolean;
  roleLocked?: boolean;
  children?: ReactNode;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  // An assignment is always listed, even when it does not match the filter,
  // so a filter can never hide what is about to be saved.
  const shown = organizations.filter(
    (o) =>
      !needle ||
      value.organizationIds.includes(o.id) ||
      o.code.toLowerCase().includes(needle) ||
      o.name_ar.toLowerCase().includes(needle) ||
      (o.name_en ?? "").toLowerCase().includes(needle),
  );
  return (
    <div className="stack">
      <div className="form-grid">
        <label htmlFor={`${idPrefix}-role`}>
          {a.role}
          <select
            id={`${idPrefix}-role`}
            value={value.role}
            disabled={roleLocked}
            onChange={(e) =>
              onChange({ ...value, role: e.target.value as AccessValue["role"] })
            }
          >
            <option value="STAFF">{a.STAFF}</option>
            <option value="SUPER_ADMIN">{a.SUPER_ADMIN}</option>
          </select>
        </label>
        {children}
      </div>
      {value.role === "SUPER_ADMIN" && (
        <p className="field-hint">{a.adminHasAll}</p>
      )}
      <fieldset>
        <legend>{a.capabilities}</legend>
        <div className="form-grid">
          {CAPABILITIES.map((c) => (
            <label key={c} className="choice">
              <input
                type="checkbox"
                checked={value.capabilities.includes(c)}
                onChange={(e) =>
                  onChange({
                    ...value,
                    capabilities: toggle(value.capabilities, c, e.target.checked),
                  })
                }
              />
              <span>
                {a[c]} <bdi dir="ltr" className="muted">{c}</bdi>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>
          {a.organizations} ({value.organizationIds.length})
        </legend>
        <label htmlFor={`${idPrefix}-org-filter`}>
          {a.filterOrganizations}
          <input
            id={`${idPrefix}-org-filter`}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        {organizationsTruncated && <p className="field-hint">{a.orgsTruncated}</p>}
        <ul className="checklist plain-list" aria-label={a.organizations}>
          {shown.map((o) => {
            const english = locale === "en" && o.name_en;
            return (
              <li key={o.id}>
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={value.organizationIds.includes(o.id)}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        organizationIds: toggle(value.organizationIds, o.id, e.target.checked),
                      })
                    }
                  />
                  <span>
                    <span lang={english ? "en" : "ar"} dir={english ? "ltr" : "rtl"}>
                      {english ? o.name_en : o.name_ar}
                    </span>{" "}
                    <bdi dir="ltr" className="muted">{o.code}</bdi>
                    {o.status !== "ACTIVE" && <span className="muted"> · {a.archived}</span>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
    </div>
  );
}

export function roleTone(role: string) {
  return role === "SUPER_ADMIN" ? ("accent" as const) : ("neutral" as const);
}
export function statusTone(status: string) {
  return status === "ACTIVE" ? ("positive" as const) : ("danger" as const);
}
