import { useCallback, useMemo, useSyncExternalStore } from "react";
import { type Locale } from "../../../src/i18n";
import { useStaffApi } from "./request-ui";
import { RequestFailure } from "./staff-request";

// Request helpers shared by the administration and account screens.
//
// A refusal keeps its code, so a screen can tell "someone changed this record"
// (offer a reload) from "you may not do this" and from "the service did not
// answer". Since Post-Audit Repair Pass 2 every call is bounded, and every
// change is keyed per logical attempt: `scope` names the change (it defaults
// to the method and path), and an unconfirmed attempt is retried with the same
// key and body through `api.retry(scope)`.
export { RequestFailure as ApiError };

export type Mutation = {
  method: "POST" | "PATCH";
  body?: unknown;
  revision?: number | string;
  scope?: string;
  replace?: boolean;
};

export const scopeOf = (path: string, mutation: Mutation) =>
  mutation.scope ?? `${mutation.method} ${path}`;

export function useApi(locale: Locale) {
  const client = useStaffApi(locale);
  const call = useCallback(
    <T,>(path: string, mutation?: Mutation): Promise<T> =>
      mutation
        ? client.mutate<T>(scopeOf(path, mutation), `/api/v1/${path}`, {
            method: mutation.method,
            body: mutation.body ?? {},
            revision: mutation.revision,
            replace: mutation.replace,
          })
        : client.read<T>(`/api/v1/${path}`),
    [client],
  );
  return useMemo(
    () =>
      Object.assign(call, {
        retry: client.retry,
        ledger: client.ledger,
      }),
    [call, client],
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
