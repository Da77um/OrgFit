import { useCallback, useSyncExternalStore } from "react";
import { messages, type Locale } from "../../../src/i18n";
import { jsonOf, staffFetch } from "./staff-fetch";

// Request helpers shared by the administration and account screens.
//
// A refusal keeps its code, so a screen can tell "someone changed this record"
// (offer a reload) from "you may not do this" and from "the service did not
// answer". An ended session goes to sign-in and says so, as everywhere else.
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}

export type Mutation = {
  method: "POST" | "PATCH";
  body?: unknown;
  revision?: number | string;
  idempotencyKey?: string;
};

export function useApi(locale: Locale) {
  return useCallback(
    async <T>(path: string, mutation?: Mutation): Promise<T> => {
      const r = await staffFetch(locale)(`/api/v1/${path}`, {
        method: mutation?.method ?? "GET",
        headers: {
          "Accept-Language": locale,
          ...(mutation
            ? {
                "Content-Type": "application/json",
                "Idempotency-Key": mutation.idempotencyKey ?? crypto.randomUUID(),
              }
            : {}),
          ...(mutation?.revision !== undefined
            ? { "If-Match": `"${mutation.revision}"` }
            : {}),
        },
        body: mutation ? JSON.stringify(mutation.body ?? {}) : undefined,
      });
      if (r.status === 401) {
        location.assign("/login?expired=1");
        throw new ApiError(messages(locale).denied, 401, "SESSION_REQUIRED");
      }
      if (r.status === 204) return null as T;
      const json = await jsonOf(r);
      if (!r.ok)
        throw new ApiError(
          json.message ?? messages(locale).unavailable,
          r.status,
          json.code ?? "TEMPORARILY_UNAVAILABLE",
        );
      return json.data as T;
    },
    [locale],
  );
}

const subscribe = () => () => {};
export const useHydrated = () =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

// Every time on these screens is shown in UTC, the same convention the
// dashboards and reports use (D-122), and labelled as UTC. The form is
// YYYY-MM-DD HH:MM in both languages: a localized Arabic date set inside a
// left-to-right numeric span reorders into something unreadable.
export function utc(value: string | null | undefined, _locale?: Locale) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 16).replace("T", " ");
}

export const errorText = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;
