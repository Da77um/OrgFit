import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import pg from "pg";
import { migrate } from "../scripts/migrate";
import { clusterRolePassword, LOGIN_ROLES, passwordLiteral } from "../scripts/role-password";
import { migrateAnonymous } from "../scripts/migrate-anonymous";
import { withStaff } from "../src/db";
import { campaignTransition } from "../src/campaigns";
import { configureGateway } from "../src/gateway-db";
import { setCustodianSecret } from "../src/key-custody";
import { exchange, instrument, finalize } from "../src/respondent";
import { processCampaign, reconcile } from "../src/processor";
import { releaseCampaign } from "../src/publication";
import { runRetention, storeInconsistencies } from "../src/operations";
import { checkDatabases } from "../src/preflight";
import { digest, secret } from "../src/security";
import type { Instrument } from "../src/instrument-input";

// R-3 — upgrade from the previous supported release schema, with state written
// by that release's own code.
//
// No production release of OrgFit exists. The previous supported schema is
// therefore the last commit that passed a full functional checkpoint before
// the operations migrations: Checkpoint F, 59c99e3 (core 001–016, anonymous
// 001). A git worktree of that commit runs tests/release/baseline-state.ts
// with its own code; this test then upgrades the resulting databases with the
// candidate's migrators and drives the candidate's gateway, processor and
// publication job against them.
const BASELINE = "59c99e3";

function answersFor(d: Instrument) {
  const out: Record<string, string | string[]> = {};
  for (const q of d.sections.flatMap((s) => s.questions)) {
    if (q.type === "CONTENT") continue;
    if (q.type === "CHECKBOXES") out[q.id] = [q.options[0].id];
    else if (q.type === "MATRIX") for (const r of q.rows) out[r.id] = q.columns[0].id;
    else if (["MULTIPLE_CHOICE", "DROPDOWN", "YES_NO"].includes(q.type)) out[q.id] = q.options[0].id;
    else if (q.type === "RATING_5") out[q.id] = "2";
    else if (q.type === "RATING_10") out[q.id] = "5";
    else if (q.type === "NUMBER") out[q.id] = "4";
    else if (q.type === "DATE") out[q.id] = "2026-06-15";
    else out[q.id] = "نص";
  }
  return out;
}

test("R-3 a populated database from the previous release upgrades in place and keeps every one-use and count guarantee", async (t) => {
  if (spawnSync("git", ["cat-file", "-e", `${BASELINE}^{commit}`]).status !== 0) {
    t.skip(`baseline commit ${BASELINE} is not in this clone`);
    return;
  }
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
  assert.ok(adminUrl, "TEST_ADMIN_DATABASE_URL is required");

  // 1. The previous release writes its state.
  const tree = resolve(`work/release-baseline-${BASELINE}`);
  if (!existsSync(join(tree, "package.json"))) {
    const add = spawnSync("git", ["worktree", "add", "--detach", tree, BASELINE], { encoding: "utf8" });
    assert.equal(add.status, 0, add.stderr);
  }
  if (!existsSync(join(tree, "node_modules"))) symlinkSync(resolve("node_modules"), join(tree, "node_modules"), "junction");
  mkdirSync(join(tree, "tests/release"), { recursive: true });
  copyFileSync("tests/release/baseline-state.ts", join(tree, "tests/release/baseline-state.ts"));
  const started = Date.now();
  const run = spawnSync(process.execPath, ["--import", "tsx", "tests/release/baseline-state.ts"], {
    cwd: tree,
    encoding: "utf8",
    env: { ...process.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `baseline run failed: ${run.stderr.slice(-2000)}`);
  const line = run.stdout.split("\n").find((l) => l.startsWith("BASELINE_STATE "));
  assert.ok(line, "baseline state not reported");
  const state = JSON.parse(line.slice("BASELINE_STATE ".length));
  console.log(`R-3 baseline state written by ${BASELINE} in ${Date.now() - started} ms; A processed ${state.A.processed}, released ${state.A.released}`);
  assert.equal(state.A.processed, 6);

  // The baseline commit's harness gave the login roles a random password it did
  // not report (and briefly broke anything else using this cluster). Put back
  // the cluster's stable one, which is also what development sign-in uses.
  const password = clusterRolePassword(adminUrl);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (const role of LOGIN_ROLES) await admin.query(`ALTER ROLE ${role} PASSWORD ${passwordLiteral(password)}`);
  await admin.end();
  const at = (role: string, database: string) => {
    const u = new URL(adminUrl);
    u.username = role;
    u.password = password;
    u.pathname = `/${database}`;
    return u.href;
  };
  const url = (role: string) => at(role, state.core);
  const anonymousUrl = (role: string) => at(role, state.anonymous);

  const operator = new pg.Client({ connectionString: url("orgfit_migrator") });
  const anonOwner = new pg.Client({ connectionString: anonymousUrl("orgfit_anon_migrator") });
  await Promise.all([operator.connect(), anonOwner.connect()]);
  await operator.query("SET ROLE orgfit_core_owner");
  await anonOwner.query("SET ROLE orgfit_anon_owner");
  const snapshot = async () => ({
    ledger: (await operator.query("SELECT max(name) m, count(*)::int n FROM public.orgfit_migrations")).rows[0],
    anonLedger: (await anonOwner.query("SELECT max(name) m FROM public.orgfit_anonymous_migrations")).rows[0].m,
    campaigns: (await operator.query("SELECT id::text, state, release_state FROM core.campaign WHERE id = ANY($1::uuid[]) ORDER BY id", [[state.A.campaignId, state.B.campaignId]])).rows,
    completed: (await operator.query("SELECT campaign_id::text c, count(*)::int n FROM core.invitation WHERE status='COMPLETED' AND campaign_id = ANY($1::uuid[]) GROUP BY 1 ORDER BY 1", [[state.A.campaignId, state.B.campaignId]])).rows,
    inboxB: (await operator.query("SELECT count(*)::int n FROM intake.submission_inbox WHERE campaign_id=$1", [state.B.campaignId])).rows[0].n,
    anonymousA: (await anonOwner.query("SELECT count(*)::int n FROM anonymous.anonymous_response WHERE campaign_id=$1", [state.A.campaignId])).rows[0].n,
    participants: (await operator.query("SELECT count(*)::int n FROM core.participant")).rows[0].n,
    audit: (await operator.query("SELECT count(*)::int n FROM ops.audit_log")).rows[0].n,
  });
  try {
    const before = await snapshot();
    assert.equal(before.ledger.m, "016_local_access.sql");
    assert.equal(before.anonLedger, "001_anonymous.sql");
    assert.equal(before.inboxB, 3);
    assert.equal(before.anonymousA, 6);

    // 2. Upgrade with the candidate's migrators, twice (idempotent).
    const t0 = Date.now();
    await migrate(url("orgfit_migrator"));
    await migrateAnonymous(anonymousUrl("orgfit_anon_migrator"));
    const upgradeMs = Date.now() - t0;
    await migrate(url("orgfit_migrator"));
    await migrateAnonymous(anonymousUrl("orgfit_anon_migrator"));
    const after = await snapshot();
    console.log(`R-3 upgrade 016 -> ${after.ledger.m} and anonymous -> ${after.anonLedger}: ${upgradeMs} ms`);
    assert.deepEqual({ ...after, ledger: undefined, anonLedger: undefined, audit: undefined }, { ...before, ledger: undefined, anonLedger: undefined, audit: undefined }, "the upgrade changed no existing row");
    assert.ok(after.audit >= before.audit, "no audit record was lost");
    const preflight = await checkDatabases("operator", { MIGRATION_DATABASE_URL: url("orgfit_migrator"), ANONYMOUS_MIGRATION_DATABASE_URL: anonymousUrl("orgfit_anon_migrator") }, { production: false });
    for (const check of ["migrations:core", "migrations:anonymous", "restore-state"])
      assert.equal(preflight.find((f) => f.check === check)?.outcome, "PASS", `${check}: ${JSON.stringify(preflight)}`);

    // 3. The candidate's gateway against the upgraded store.
    Object.assign(process.env, {
      NODE_ENV: "test",
      STAFF_ORIGIN: "http://127.0.0.1:3000",
      RESPONDENT_ORIGIN: "http://localhost:3001",
      DATABASE_URL: url("orgfit_staff"),
      AUTH_DATABASE_URL: url("orgfit_auth"),
      OIDC_ISSUER: "http://127.0.0.1:4010",
      OIDC_CLIENT_ID: "test",
      OIDC_CLIENT_SECRET: "synthetic-test-secret",
      OIDC_MFA_ACR: "urn:test:mfa",
      INVITATION_DIGEST_KEY: "a".repeat(64),
      INVITATION_DIGEST_KEY_VERSION: "test-v1",
      LINK_EXPORT_ENCRYPTION_KEY: "b".repeat(64),
      CAMPAIGN_KEY_CUSTODY_DIRECTORY: state.custodyDirectory,
      CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY: state.custodianPublicKey,
    });
    configureGateway(url("orgfit_gateway"));
    const inboxB = async () => (await operator.query("SELECT count(*)::int n FROM intake.submission_inbox WHERE campaign_id=$1", [state.B.campaignId])).rows[0].n as number;

    // Invitations consumed under the previous release stay consumed.
    const seen = new Set<string>();
    for (const token of [...state.A.tokens, ...state.B.used]) {
      const opened = await exchange(token);
      const access = String((opened.context as { access: string }).access);
      seen.add(access);
      assert.notEqual(access, "OPEN", "a consumed invitation reopened after the upgrade");
      if (opened.session) await finalize(opened.session, { answers: {} }).catch(() => undefined);
    }
    assert.equal(await inboxB(), 3, "no second submission from a consumed invitation");
    console.log(`R-3 consumed links after upgrade answer: ${[...seen].join(", ")}`);

    // Unused links issued by the previous release still open once, and only once.
    for (const token of state.B.unused) {
      const opened = await exchange(token);
      assert.equal((opened.context as { access: string }).access, "OPEN");
      await finalize(opened.session!, { answers: answersFor((await instrument(opened.session!)).document) });
      const again = await exchange(token);
      assert.notEqual((again.context as { access: string }).access, "OPEN");
    }
    assert.equal(await inboxB(), 6);

    // 4. Close, process and publish B with the candidate; reconcile both.
    const auth = new pg.Client({ connectionString: url("orgfit_auth") });
    await auth.connect();
    const token = secret();
    await auth.query("SELECT access.issue_session($1,$2,$3)", ["http://127.0.0.1:4010", "staff", digest(token)]);
    await auth.end();
    const revision = (await operator.query("SELECT revision FROM core.campaign WHERE id=$1", [state.B.campaignId])).rows[0].revision as string;
    await withStaff(token, (tx) => campaignTransition(tx, state.orgA, state.B.campaignId, revision, "CLOSE", { reason: "ترقية" }, randomUUID()));
    setCustodianSecret(state.custodianSecret);
    const core = new pg.Pool({ connectionString: url("orgfit_processor"), max: 2 });
    const anon = new pg.Pool({ connectionString: anonymousUrl("orgfit_processor"), max: 2 });
    try {
      const processed = await processCampaign(core, anon, state.B.campaignId);
      assert.equal(processed.processedCount, 6);
      const released = await releaseCampaign(core, anon, state.B.campaignId);
      assert.equal(released.state, state.A.released, "B publishes exactly as A did under the previous release");
      for (const id of [state.A.campaignId, state.B.campaignId]) {
        const r = await reconcile(core, anon, id);
        assert.equal(r.countsAgree, true, `${id} counts`);
      }
    } finally {
      await core.end();
      await anon.end();
      setCustodianSecret(undefined);
      configureGateway(undefined);
    }
    assert.deepEqual(await storeInconsistencies(url("orgfit_migrator"), anonymousUrl("orgfit_anon_migrator")), []);
    const retention = await runRetention(url("orgfit_migrator"), anonymousUrl("orgfit_anon_migrator"));
    assert.equal(retention.anonymous_campaigns, 0, "retention on a fresh upgrade purges no current campaign");
  } finally {
    await operator.end();
    await anonOwner.end();
  }
});
