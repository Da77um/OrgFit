import { spawn } from "node:child_process";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
};
const child = spawn(
  process.execPath,
  [
    resolve("node_modules/next/dist/bin/next"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3099",
  ],
  { cwd: resolve("apps/staff"), env, stdio: "ignore", windowsHide: true },
);
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = (await fetch("http://127.0.0.1:3099/health/live")).ok;
      if (ready) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(
    ready,
    true,
    "production build should start without exposing secrets",
  );
  const r = await fetch("http://127.0.0.1:3099/health/ready");
  assert.equal(r.status, 503);
  const body = await r.text();
  assert.doesNotMatch(body, /DATABASE_URL|OIDC|postgres|password|stack/);
  const login = await fetch("http://127.0.0.1:3099/login");
  assert.equal(login.status, 200);
  const html = await login.text();
  assert.match(html, /lang="ar"/);
  assert.match(html, /dir="rtl"/);
  assert.doesNotMatch(html, /href="\/api\/v1\/auth\/start"/);
  const csp = login.headers.get("content-security-policy") ?? "";
  assert.ok(csp.includes("'nonce-"));
  assert.ok(!csp.includes("unsafe-eval"));
  assert.ok(!csp.includes("unsafe-inline"));
  // Phase 14: no cross-origin grant anywhere, including a hostile preflight;
  // no framework banner; the protective headers on a page and on the API.
  assert.equal(login.headers.get("access-control-allow-origin"), null);
  assert.equal(login.headers.get("x-powered-by"), null);
  assert.equal(login.headers.get("x-frame-options"), "DENY");
  assert.equal(login.headers.get("referrer-policy"), "no-referrer");
  assert.equal(login.headers.get("x-content-type-options"), "nosniff");
  assert.equal(login.headers.get("cache-control"), "no-store");
  const preflight = await fetch("http://127.0.0.1:3099/api/v1/profile", {
    method: "OPTIONS",
    headers: {
      Origin: "https://attacker.example",
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  const forged = await fetch("http://127.0.0.1:3099/api/v1/profile", {
    method: "PATCH",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ locale: "en" }),
  });
  assert.ok([401, 403, 503].includes(forged.status), `forged mutation ${forged.status}`);
  assert.equal(forged.headers.get("access-control-allow-origin"), null);
  console.log(
    "Production build fails safely with missing environment; Arabic fallback and strict CSP verified.",
  );
} finally {
  child.kill();
}
