import { messages, type Locale } from "../../../src/i18n";

// Every staff-screen request goes through here (Post-Audit Repair Pass 2).
//
// Three properties the bare `fetch` it replaces did not have:
//
//   * A deadline. One timer covers the whole exchange — connecting, the
//     headers AND reading the body — so a connection that answers "200" and
//     then stalls cannot hold a screen's controls disabled indefinitely. The
//     caller's own AbortSignal is honoured, and every timer and listener is
//     removed however the request ends.
//   * An honest failure. A read that failed changed nothing. A change whose
//     answer never arrived (timeout, dropped connection, a 5xx, an unreadable
//     2xx) may or may not have happened: it is `uncertain`, and a screen must
//     not present it as a refusal. A 2xx whose body is not the `{data}` shape
//     is a failure, never an empty success.
//   * A stable idempotency key per logical change (AttemptLedger below), so
//     "try again" after a lost answer replays the server's receipt instead of
//     creating a second record.
//
// Nothing here touches the DOM, storage or the address bar, so the node test
// suite exercises it against a real HTTP server. It stores no request body
// anywhere except in the ledger's memory while an attempt is unresolved.

export const REQUEST_TIMEOUT_MS = 20_000;

export type FailureKind =
  | "TIMEOUT" // no complete answer within the deadline
  | "NETWORK" // the connection failed before a complete answer
  | "SESSION" // 401: the session ended; nothing was done
  | "MALFORMED" // an answer arrived that is not the API's shape
  | "REJECTED" // a definite refusal (4xx): nothing was done
  | "UNAVAILABLE" // 5xx: for a change, the outcome is unknown
  | "CANCELLED" // the caller aborted
  | "UNRESOLVED"; // a different change is blocked behind an unconfirmed one

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export class RequestFailure extends Error {
  readonly kind: FailureKind;
  readonly status: number;
  readonly code: string;
  /** True when a change may have been applied although no success arrived. */
  readonly uncertain: boolean;
  readonly body: Record<string, unknown> | null;
  attempt?: Attempt;
  constructor(
    message: string,
    kind: FailureKind,
    init: {
      status?: number;
      code?: string;
      uncertain?: boolean;
      body?: Record<string, unknown> | null;
    } = {},
  ) {
    super(message);
    this.name = "RequestFailure";
    this.kind = kind;
    this.status = init.status ?? 0;
    this.code = init.code ?? kind;
    this.uncertain = init.uncertain ?? false;
    this.body = init.body ?? null;
  }
}

export type RequestOptions = {
  method?: Method;
  /** JSON-serialised as the request body. */
  body?: unknown;
  /** A binary body (attachment content). Mutually exclusive with `body`. */
  raw?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** "json" (default) expects `{data}`; "blob" returns the bytes. */
  read?: "json" | "blob";
};

export type StaffResponse<T> = {
  status: number;
  headers: Headers;
  data: T;
  blob: Blob | null;
};

const seconds = (ms: number) => String(Math.round(ms / 1000));

export async function staffRequest<T = unknown>(
  locale: Locale,
  url: string,
  options: RequestOptions = {},
): Promise<StaffResponse<T>> {
  const m = messages(locale);
  const method = options.method ?? "GET";
  const change = method !== "GET";
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (options.signal?.aborted)
    throw new RequestFailure(m.unavailable, "CANCELLED", { uncertain: false });
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Some engines keep a body read pending after an abort; the race makes the
  // deadline hold regardless.
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("aborted"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  // The losing side of a race still settles later; it must not surface as an
  // unhandled rejection.
  const bounded = <V>(work: Promise<V>) => {
    work.catch(() => {});
    return Promise.race([work, aborted]);
  };

  const interrupted = () =>
    timedOut
      ? new RequestFailure((change ? m.requestTimeoutChange : m.requestTimeout).replace("{seconds}", seconds(timeoutMs)), "TIMEOUT", {
          uncertain: change,
        })
      : options.signal?.aborted
        ? new RequestFailure(m.unavailable, "CANCELLED", { uncertain: change })
        : new RequestFailure(m.connectionLost, "NETWORK", { uncertain: change });

  try {
    let response: Response;
    try {
      response = await bounded(
        fetch(url, {
          method,
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            "Accept-Language": locale,
            ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...options.headers,
          },
          body:
            options.raw ??
            (options.body !== undefined ? JSON.stringify(options.body) : undefined),
        }),
      );
    } catch {
      throw interrupted();
    }

    if (response.ok && options.read === "blob") {
      let blob: Blob;
      try {
        blob = await bounded(response.blob());
      } catch {
        throw interrupted();
      }
      return { status: response.status, headers: response.headers, data: null as T, blob };
    }

    let text: string;
    try {
      text = await bounded(response.text());
    } catch {
      throw interrupted();
    }
    let json: Record<string, unknown> | null = null;
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          json = parsed as Record<string, unknown>;
      } catch {
        json = null;
      }
    }

    if (response.status === 401)
      throw new RequestFailure(m.sessionExpired, "SESSION", {
        status: 401,
        code: "SESSION_REQUIRED",
        body: json,
      });

    if (response.ok) {
      if (response.status === 204)
        return { status: 204, headers: response.headers, data: null as T, blob: null };
      if (!json || !("data" in json))
        // The server may well have acted; what it said cannot be read.
        throw new RequestFailure(m.responseUnreadable, "MALFORMED", {
          status: response.status,
          uncertain: change,
        });
      return {
        status: response.status,
        headers: response.headers,
        data: json.data as T,
        blob: null,
      };
    }

    const code = typeof json?.code === "string" ? json.code : "";
    const serverMessage = typeof json?.message === "string" ? json.message : "";
    if (response.status >= 500)
      throw new RequestFailure(serverMessage || m.unavailable, "UNAVAILABLE", {
        status: response.status,
        code: code || "TEMPORARILY_UNAVAILABLE",
        uncertain: change,
        body: json,
      });
    throw new RequestFailure(
      code === "IDEMPOTENCY_CONFLICT"
        ? m.idempotencyConflict
        : response.status === 429
          ? m.rateLimited
          : response.status === 413
            ? m.tooLarge
            : serverMessage || m.unavailable,
      "REJECTED",
      {
        status: response.status,
        code: code || (response.status === 413 ? "PAYLOAD_TOO_LARGE" : "REJECTED"),
        body: json,
      },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// One logical change at a time per scope.
//
// `prepare` returns the attempt to send. While a scope's attempt is sending or
// unconfirmed, the SAME change (same method, URL, body and revision) gets the
// SAME idempotency key, so a retry is a replay the server answers from its
// receipt. A DIFFERENT change in that scope is refused with UNRESOLVED unless
// the scope allows replacement, because a new key could create a second
// record if the first one did land. A confirmed success or a definite refusal
// settles the scope; only an uncertain failure keeps it.
// ---------------------------------------------------------------------------

export type Attempt = {
  scope: string;
  url: string;
  method: Method;
  body?: unknown;
  revision?: number | string;
  key: string;
  signature: string;
};

type Entry = { attempt: Attempt; state: "sending" | "uncertain"; failure?: RequestFailure };

export class AttemptLedger {
  #entries = new Map<string, Entry>();
  #listeners = new Set<() => void>();
  #version = 0;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  version = () => this.#version;
  #changed() {
    this.#version++;
    for (const l of this.#listeners) l();
  }

  prepare(
    locale: Locale,
    scope: string,
    request: { url: string; method: Method; body?: unknown; revision?: number | string },
    replace = false,
  ): Attempt {
    const signature = JSON.stringify([
      request.method,
      request.url,
      request.body ?? null,
      request.revision ?? null,
    ]);
    const existing = this.#entries.get(scope);
    if (existing) {
      if (existing.attempt.signature === signature) return existing.attempt;
      if (!replace)
        throw Object.assign(
          new RequestFailure(messages(locale).unresolvedAttempt, "UNRESOLVED", {
            uncertain: true,
          }),
          { attempt: existing.attempt },
        );
    }
    return { scope, ...request, key: crypto.randomUUID(), signature };
  }

  /** The unconfirmed attempt for a scope, if one is waiting for a decision. */
  uncertain(scope: string) {
    const e = this.#entries.get(scope);
    return e?.state === "uncertain" ? { attempt: e.attempt, failure: e.failure! } : null;
  }

  sending(scope: string) {
    return this.#entries.get(scope)?.state === "sending";
  }

  begin(attempt: Attempt) {
    this.#entries.set(attempt.scope, { attempt, state: "sending" });
    this.#changed();
  }
  markUncertain(attempt: Attempt, failure: RequestFailure) {
    this.#entries.set(attempt.scope, { attempt, state: "uncertain", failure });
    this.#changed();
  }
  /** A confirmed outcome, or the user chose to set the attempt aside. */
  settle(scope: string) {
    if (this.#entries.delete(scope)) this.#changed();
  }
}

export async function sendAttempt<T>(
  locale: Locale,
  ledger: AttemptLedger,
  attempt: Attempt,
  options: Omit<RequestOptions, "method" | "body"> = {},
): Promise<StaffResponse<T>> {
  ledger.begin(attempt);
  try {
    const result = await staffRequest<T>(locale, attempt.url, {
      ...options,
      method: attempt.method,
      body: attempt.body,
      headers: {
        ...options.headers,
        "Idempotency-Key": attempt.key,
        ...(attempt.revision !== undefined ? { "If-Match": `"${attempt.revision}"` } : {}),
      },
    });
    ledger.settle(attempt.scope);
    return result;
  } catch (e) {
    const failure =
      e instanceof RequestFailure
        ? e
        : new RequestFailure(messages(locale).unavailable, "NETWORK", { uncertain: true });
    failure.attempt = attempt;
    if (failure.uncertain) ledger.markUncertain(attempt, failure);
    else ledger.settle(attempt.scope);
    throw failure;
  }
}

export const failureText = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;
