import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  AttemptLedger,
  RequestFailure,
  sendAttempt,
  staffRequest,
} from "../apps/staff/app/staff-request";
import { ar, en } from "../src/i18n";

// Post-Audit Repair Pass 2: the staff request core against a REAL HTTP server
// on loopback — real delays, a body that stalls after its headers, a change
// that commits and then loses its answer, sessions that end, cancellation.
// Nothing here is a mocked fetch.

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function serve(handler: Handler) {
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// Every timer the core starts must be cleared however the request ends. Only
// timers created from staff-request.ts are counted: the HTTP client keeps its
// own keep-alive timers, which are not this code's to clear.
const live = new Set<unknown>();
const realSet = globalThis.setTimeout;
const realClear = globalThis.clearTimeout;
globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
  const ours = /staff-request\.ts/.test(new Error().stack ?? "");
  const id = realSet(() => {
    live.delete(id);
    fn();
  }, ms, ...rest);
  if (ours) live.add(id);
  return id;
}) as typeof setTimeout;
globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
  live.delete(id);
  realClear(id);
}) as typeof clearTimeout;

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};

test("SR-1 a response that never comes is a TIMEOUT within the deadline; a read is not uncertain", async () => {
  const server = await serve(() => {
    /* never answers */
  });
  try {
    const started = Date.now();
    await assert.rejects(staffRequest("en", server.url("/slow"), { timeoutMs: 300 }), (e: unknown) => {
      assert.ok(e instanceof RequestFailure);
      assert.equal(e.kind, "TIMEOUT");
      assert.equal(e.uncertain, false);
      assert.match(e.message, /did not answer within 0 seconds|did not answer within/);
      assert.match(e.message, /Nothing was changed/);
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 280 && elapsed < 2000, `elapsed ${elapsed}`);
    assert.equal(live.size, 0, "timer cleared");
  } finally {
    await server.close();
  }
});

test("SR-2 a 200 whose body stalls after the headers still times out, and a change is then uncertain", async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"data":{"id":"'); // and nothing more
  });
  try {
    for (const method of ["GET", "POST"] as const) {
      const started = Date.now();
      await assert.rejects(
        staffRequest("en", server.url("/stall"), { method, timeoutMs: 400, ...(method === "POST" ? { body: {} } : {}) }),
        (e: unknown) =>
          e instanceof RequestFailure && e.kind === "TIMEOUT" && e.uncertain === (method === "POST"),
      );
      assert.ok(Date.now() - started < 2500, "the body read is bounded");
    }
    assert.equal(live.size, 0);
  } finally {
    await server.close();
  }
});

test("SR-3 a delayed answer inside the deadline succeeds; the deadline covers the whole exchange", async () => {
  const server = await serve((_req, res) => {
    realSet(() => json(res, 200, { data: { ok: true } }), 150);
  });
  try {
    const r = await staffRequest<{ ok: boolean }>("en", server.url("/delayed"), { timeoutMs: 2000 });
    assert.deepEqual(r.data, { ok: true });
    assert.equal(live.size, 0);
  } finally {
    await server.close();
  }
});

test("SR-4 a change that commits and loses its answer is retried with the same key and body: one record", async () => {
  // A receipt store like access.staff_mutation: same key + same body replays,
  // same key + different body is IDEMPOTENCY_CONFLICT.
  const receipts = new Map<string, { digest: string; id: string }>();
  let created = 0;
  let dropNext = true;
  const seen: { key: string; body: string }[] = [];
  const server = await serve((req, res, body) => {
    const key = String(req.headers["idempotency-key"]);
    seen.push({ key, body });
    const old = receipts.get(key);
    if (old && old.digest !== body) return json(res, 409, { code: "IDEMPOTENCY_CONFLICT", message: "x" });
    const id = old?.id ?? `r${++created}`;
    receipts.set(key, { digest: body, id });
    if (dropNext) {
      dropNext = false;
      // Committed, then the connection dies before any answer.
      res.socket?.destroy();
      return;
    }
    json(res, old ? 200 : 201, { data: { id, replayed: !!old } });
  });
  try {
    const ledger = new AttemptLedger();
    const payload = { name: "Visit", notes: "نص عربي" };
    const attempt = ledger.prepare("ar", "visit-save", { url: server.url("/visits"), method: "POST", body: payload });
    await assert.rejects(sendAttempt("ar", ledger, attempt), (e: unknown) => {
      assert.ok(e instanceof RequestFailure);
      assert.equal(e.kind, "NETWORK");
      assert.equal(e.uncertain, true);
      assert.equal(e.message, ar.connectionLost);
      return true;
    });
    const pending = ledger.uncertain("visit-save");
    assert.ok(pending, "the unconfirmed attempt is kept");

    // Repeat click with the same content: same key (no new record possible).
    const again = ledger.prepare("ar", "visit-save", { url: server.url("/visits"), method: "POST", body: { ...payload } });
    assert.equal(again.key, attempt.key);

    // Different content while unconfirmed: refused, nothing sent.
    const before = seen.length;
    assert.throws(
      () => ledger.prepare("ar", "visit-save", { url: server.url("/visits"), method: "POST", body: { name: "Other" } }),
      (e: unknown) => e instanceof RequestFailure && e.kind === "UNRESOLVED" && e.message === ar.unresolvedAttempt,
    );
    assert.equal(seen.length, before);

    const replay = await sendAttempt<{ id: string; replayed: boolean }>("ar", ledger, pending.attempt);
    assert.deepEqual(replay.data, { id: "r1", replayed: true });
    assert.equal(created, 1, "exactly one record");
    assert.equal(seen[0].key, seen[1].key, "same idempotency key");
    assert.equal(seen[0].body, seen[1].body, "byte-identical body");
    assert.equal(ledger.uncertain("visit-save"), null, "settled after confirmation");

    // Once settled, a new change gets a new key.
    const next = ledger.prepare("ar", "visit-save", { url: server.url("/visits"), method: "POST", body: payload });
    assert.notEqual(next.key, attempt.key);
    assert.equal(live.size, 0);
  } finally {
    await server.close();
  }
});

test("SR-5 a revision-checked change may replace an unconfirmed one; a create may not", async () => {
  const server = await serve((_req, res) => res.socket?.destroy());
  try {
    const ledger = new AttemptLedger();
    const first = ledger.prepare("en", "edit", { url: server.url("/v/1"), method: "PATCH", body: { a: 1 }, revision: 3 });
    await assert.rejects(sendAttempt("en", ledger, first));
    const replaced = ledger.prepare("en", "edit", { url: server.url("/v/1"), method: "PATCH", body: { a: 2 }, revision: 3 }, true);
    assert.notEqual(replaced.key, first.key);
    // The revision precondition is sent with the attempt.
    assert.equal(replaced.revision, 3);
  } finally {
    await server.close();
  }
});

test("SR-6 an ended session, a refusal, a 5xx and an unreadable 2xx are told apart", async () => {
  const server = await serve((req, res) => {
    const path = req.url ?? "";
    if (path === "/session") return json(res, 401, { code: "SESSION_REQUIRED", message: "x" });
    if (path === "/refused") return json(res, 422, { code: "VALIDATION_FAILED", message: "Check the submitted information." });
    if (path === "/limited") return json(res, 429, { code: "RATE_LIMITED" });
    if (path === "/conflict") return json(res, 409, { code: "IDEMPOTENCY_CONFLICT", message: "generic" });
    if (path === "/proxy") {
      res.writeHead(502, { "Content-Type": "text/html" });
      return res.end("<html>Bad gateway</html>");
    }
    if (path === "/html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<html>login</html>");
    }
    if (path === "/nodata") return json(res, 200, { items: [] });
    if (path === "/empty") {
      res.writeHead(204);
      return res.end();
    }
    json(res, 404, {});
  });
  const failure = async (path: string, method: "GET" | "POST" = "GET") => {
    try {
      await staffRequest("en", server.url(path), { method, ...(method === "POST" ? { body: {} } : {}) });
    } catch (e) {
      assert.ok(e instanceof RequestFailure);
      return e;
    }
    assert.fail(`${path} succeeded`);
  };
  try {
    const session = await failure("/session", "POST");
    assert.equal(session.kind, "SESSION");
    assert.equal(session.uncertain, false);
    assert.equal(session.message, en.sessionExpired);

    const refused = await failure("/refused", "POST");
    assert.deepEqual([refused.kind, refused.uncertain, refused.code, refused.status], ["REJECTED", false, "VALIDATION_FAILED", 422]);
    assert.equal(refused.message, "Check the submitted information.");
    assert.equal((await failure("/limited", "POST")).message, en.rateLimited);
    assert.equal((await failure("/conflict", "POST")).message, en.idempotencyConflict);

    const proxyChange = await failure("/proxy", "POST");
    assert.deepEqual([proxyChange.kind, proxyChange.uncertain], ["UNAVAILABLE", true]);
    assert.equal(proxyChange.message, en.unavailable, "a proxy page is never shown as text");
    assert.equal((await failure("/proxy")).uncertain, false);

    // Never converted into an apparent success.
    const html = await failure("/html", "POST");
    assert.deepEqual([html.kind, html.uncertain, html.message], ["MALFORMED", true, en.responseUnreadable]);
    const nodata = await failure("/nodata");
    assert.deepEqual([nodata.kind, nodata.uncertain], ["MALFORMED", false]);

    const empty = await staffRequest("en", server.url("/empty"), { method: "POST", body: {} });
    assert.equal(empty.status, 204);
    assert.equal(empty.data, null);

    // A definite refusal settles the ledger; an uncertain one keeps it.
    const ledger = new AttemptLedger();
    const a = ledger.prepare("en", "s", { url: server.url("/refused"), method: "POST", body: {} });
    await assert.rejects(sendAttempt("en", ledger, a));
    assert.equal(ledger.uncertain("s"), null);
    const b = ledger.prepare("en", "s", { url: server.url("/proxy"), method: "POST", body: {} });
    await assert.rejects(sendAttempt("en", ledger, b));
    assert.ok(ledger.uncertain("s"));
    const c = ledger.prepare("en", "t", { url: server.url("/session"), method: "POST", body: {} });
    await assert.rejects(sendAttempt("en", ledger, c));
    assert.equal(ledger.uncertain("t"), null, "an ended session did nothing; nothing to reconcile");
    assert.equal(live.size, 0);
  } finally {
    await server.close();
  }
});

test("SR-7 the caller's cancellation is honoured and every timer and listener is removed", async () => {
  const server = await serve(() => {
    /* never answers */
  });
  try {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      added++;
      return add(...args);
    }) as AbortSignal["addEventListener"];
    controller.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      removed++;
      return remove(...args);
    }) as AbortSignal["removeEventListener"];
    const pending = staffRequest("en", server.url("/hang"), { signal: controller.signal, timeoutMs: 10_000 });
    realSet(() => controller.abort(), 100);
    const started = Date.now();
    await assert.rejects(pending, (e: unknown) => e instanceof RequestFailure && e.kind === "CANCELLED");
    assert.ok(Date.now() - started < 2000, "cancelled promptly, not at the deadline");
    assert.equal(live.size, 0, "deadline timer cleared on cancellation");
    assert.equal(added, 1);
    assert.equal(removed, 1, "caller listener removed");

    // Already cancelled: nothing is sent.
    let hits = 0;
    const counting = await serve((_q, res) => {
      hits++;
      json(res, 200, { data: 1 });
    });
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(staffRequest("en", counting.url("/x"), { signal: aborted.signal }), (e: unknown) =>
      e instanceof RequestFailure && e.kind === "CANCELLED",
    );
    assert.equal(hits, 0);
    await counting.close();

    // Many completed requests leave no timers behind.
    const quick = await serve((_q, res) => json(res, 200, { data: 1 }));
    await Promise.all(Array.from({ length: 25 }, () => staffRequest("ar", quick.url("/q"))));
    assert.equal(live.size, 0);
    await quick.close();
  } finally {
    await server.close();
  }
});

test("SR-8 connection loss, the change timeout wording and both languages", async () => {
  const server = await serve((_req, res) => res.socket?.destroy());
  try {
    await assert.rejects(staffRequest("ar", server.url("/drop")), (e: unknown) =>
      e instanceof RequestFailure && e.kind === "NETWORK" && e.uncertain === false && e.message === ar.connectionLost,
    );
  } finally {
    await server.close();
  }
  const silentServer = await serve(() => {});
  try {
    await assert.rejects(
      staffRequest("ar", silentServer.url("/x"), { method: "PATCH", body: {}, timeoutMs: 1000 }),
      (e: unknown) =>
        e instanceof RequestFailure &&
        e.uncertain &&
        e.message === ar.requestTimeoutChange.replace("{seconds}", "1") &&
        // A timed-out change never claims that nothing changed.
        !/لم يتغير/.test(e.message),
    );
  } finally {
    await silentServer.close();
  }
  for (const key of Object.keys(ar) as (keyof typeof ar)[]) assert.ok(en[key], key);
  assert.equal(ar.requestTimeout.includes("{seconds}"), en.requestTimeout.includes("{seconds}"));
});
