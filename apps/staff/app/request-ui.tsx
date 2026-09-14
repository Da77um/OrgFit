"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { messages, type Locale } from "../../../src/i18n";
import { Alert } from "../../../src/ui";
import {
  AttemptLedger,
  RequestFailure,
  sendAttempt,
  staffRequest,
  type Method,
  type RequestOptions,
} from "./staff-request";
import { hasUnsavedChanges } from "./unsaved";

// React glue for staff requests (Post-Audit Repair Pass 2).
//
// `read` is bounded and is cancelled when the screen unmounts. `mutate` is
// bounded, keyed per logical change through the screen's AttemptLedger, and
// NOT cancelled on unmount: abandoning a change mid-flight would only turn a
// known outcome into an unknown one. An ended session sends the reader to
// sign-in as before — unless the page holds unsaved edits, in which case the
// failure is shown in place so the edits survive.

export function useLedger() {
  const [ledger] = useState(() => new AttemptLedger());
  useSyncExternalStore(ledger.subscribe, ledger.version, () => 0);
  return ledger;
}

export function redirectIfClean(e: unknown) {
  if (e instanceof RequestFailure && e.kind === "SESSION" && !hasUnsavedChanges())
    location.assign("/login?expired=1");
}

export type MutationInit = {
  method: Exclude<Method, "GET">;
  body?: unknown;
  revision?: number | string;
  /** Allow a different change to replace an unconfirmed one in this scope. */
  replace?: boolean;
};

export function useStaffApi(locale: Locale) {
  const ledger = useLedger();
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  const read = useCallback(
    async <T,>(url: string, options: Pick<RequestOptions, "signal"> = {}): Promise<T> => {
      const signal = options.signal ?? lifetime.current?.signal;
      try {
        return (await staffRequest<T>(locale, url, { signal })).data;
      } catch (e) {
        // Cancelled because the screen went away (including React's simulated
        // unmount in development): the read never settles, so no handler of a
        // screen that is gone sets "failed" or "empty" state. A caller's own
        // signal still rejects with CANCELLED.
        if (
          e instanceof RequestFailure &&
          e.kind === "CANCELLED" &&
          !options.signal &&
          signal?.aborted
        )
          return new Promise<T>(() => {});
        redirectIfClean(e);
        throw e;
      }
    },
    [locale],
  );

  const mutate = useCallback(
    async <T,>(scope: string, url: string, init: MutationInit): Promise<T> => {
      try {
        const attempt = ledger.prepare(
          locale,
          scope,
          { url, method: init.method, body: init.body, revision: init.revision },
          init.replace,
        );
        return (await sendAttempt<T>(locale, ledger, attempt)).data;
      } catch (e) {
        redirectIfClean(e);
        throw e;
      }
    },
    [ledger, locale],
  );

  /** Send the scope's unconfirmed attempt again: same key, same body. */
  const retry = useCallback(
    async <T,>(scope: string): Promise<T> => {
      const pending = ledger.uncertain(scope);
      if (!pending)
        throw new RequestFailure(messages(locale).unavailable, "REJECTED", { code: "NOTHING_TO_RETRY" });
      try {
        return (await sendAttempt<T>(locale, ledger, pending.attempt)).data;
      } catch (e) {
        redirectIfClean(e);
        throw e;
      }
    },
    [ledger, locale],
  );

  return useMemo(() => ({ read, mutate, retry, ledger }), [read, mutate, retry, ledger]);
}

/** A failed change as a screen keeps it: the failure, its ledger scope, and
 *  how to send the same attempt again. */
export type ChangeFailure = { failure: unknown; scope?: string; retry?: () => void };

export const isUncertain = (e: unknown) => e instanceof RequestFailure && e.uncertain;

/** RequestProblem wired to a ledger: the exact retry and "set aside" are only
 *  offered while the ledger still holds the unconfirmed attempt. */
export function ChangeProblem({
  locale,
  problem,
  ledger,
  busy,
  onCheck,
  onDismiss,
  testId,
}: {
  locale: Locale;
  problem: ChangeFailure | null;
  ledger: AttemptLedger;
  busy?: boolean;
  onCheck?: () => void;
  onDismiss: () => void;
  testId?: string;
}) {
  if (!problem) return null;
  const pending = problem.scope ? ledger.uncertain(problem.scope) : null;
  const uncertain = isUncertain(problem.failure);
  const canRetry = uncertain && !!problem.retry && (!problem.scope || !!pending);
  return (
    <RequestProblem
      locale={locale}
      failure={problem.failure}
      busy={busy}
      testId={testId}
      onRetrySame={canRetry ? problem.retry : undefined}
      onCheck={uncertain ? onCheck : undefined}
      onDiscard={
        pending
          ? () => {
              ledger.settle(problem.scope!);
              onDismiss();
            }
          : undefined
      }
    />
  );
}

/** A failure that should not be shown at all (the screen went away). */
export const silent = (e: unknown) => e instanceof RequestFailure && e.kind === "CANCELLED";

/**
 * One place that words a failed request. An uncertain change offers the exact
 * retry and a way to look at the current state; a definite refusal does not
 * pretend a retry would help; an ended session keeps the edits.
 */
export function RequestProblem({
  locale,
  failure,
  onRetrySame,
  onCheck,
  onDiscard,
  onRetryRead,
  busy = false,
  testId,
  bare = false,
}: {
  locale: Locale;
  failure: unknown;
  onRetrySame?: () => void;
  onCheck?: () => void;
  onDiscard?: () => void;
  onRetryRead?: () => void;
  busy?: boolean;
  testId?: string;
  /** Render the alert without a wrapping element (the caller supplies it). */
  bare?: boolean;
}) {
  const m = messages(locale);
  const wrap = (node: React.ReactNode, outcome?: string) =>
    bare ? node : <div data-testid={testId} data-outcome={outcome}>{node}</div>;
  if (!failure || silent(failure)) return null;
  const f =
    failure instanceof RequestFailure
      ? failure
      : new RequestFailure(failure instanceof Error && failure.message ? failure.message : m.unavailable, "REJECTED");
  if (f.kind === "SESSION")
    return wrap(
        <Alert tone="danger" role="alert">
          <p>{m.sessionEndedKeep}</p>
          <p>
            <a href="/login" target="_blank" rel="noopener">
              {m.signInNewTab}
            </a>
          </p>
        </Alert>,
    );
  if (f.uncertain && f.kind !== "CANCELLED")
    return wrap(
        <Alert tone="warning" role="alert">
          <p>
            <strong>{m.outcomeUnknownTitle}</strong>
          </p>
          <p>{f.kind === "UNRESOLVED" ? f.message : `${f.message} ${m.outcomeUnknownBody}`}</p>
          <div className="row">
            {onRetrySame && (
              <button type="button" className="button-small" disabled={busy} onClick={onRetrySame}>
                {m.retrySame}
              </button>
            )}
            {onCheck && (
              <button type="button" className="button-small button-secondary" disabled={busy} onClick={onCheck}>
                {m.checkState}
              </button>
            )}
            {onDiscard && (
              <button type="button" className="button-small button-quiet" disabled={busy} onClick={onDiscard}>
                {m.discardAttempt}
              </button>
            )}
          </div>
        </Alert>,
      "uncertain",
    );
  return wrap(
      <Alert tone="danger" role="alert">
        <p>{f.message}</p>
        {onRetryRead && f.kind !== "REJECTED" && (
          <p>
            <button type="button" className="button-small button-secondary" disabled={busy} onClick={onRetryRead}>
              {m.retry}
            </button>
          </p>
        )}
      </Alert>,
  );
}
