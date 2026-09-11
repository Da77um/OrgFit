// ---------------------------------------------------------------------------
// Local design-review harness.
//
// Brings up the whole product on a SEPARATE port pair from the Playwright
// harness (3100 staff / 3101 respondent, test identity provider on 4110) so a
// reviewer can walk every screen by hand while `npm run test:e2e` still owns
// 3000/3001. It is a development tool: it refuses to run against anything but a
// loopback test cluster, it creates its own throwaway databases, and it is not
// referenced by the application or by any test.
//
// One caveat: Next refuses to run two dev servers from the same app directory,
// so the showcase and `npm run test:e2e` cannot be up at the same time. Stop
// one before starting the other.
//
// It seeds what the screens need in order to be judged at all: an organization
// with departments and participants, a published questionnaire, one campaign
// carried all the way through collection, the privacy processor and the release
// job so the analytics screens have real released cells, and a second campaign
// left OPEN with one live invitation so the respondent journey can be opened.
// ---------------------------------------------------------------------------
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { setupDatabase } from "../tests/database";
import { testProvider } from "../tests/oidc-provider";
import { generateCustodianKeypair } from "../src/key-custody";
import { ids } from "./seed";

const STAFF_PORT = Number(process.env.SHOWCASE_STAFF_PORT ?? 3100);
const RESPONDENT_PORT = Number(process.env.SHOWCASE_RESPONDENT_PORT ?? 3101);
const OIDC_PORT = Number(process.env.SHOWCASE_OIDC_PORT ?? 4110);
const STAFF = `http://127.0.0.1:${STAFF_PORT}`;
const RESPONDENT = `http://localhost:${RESPONDENT_PORT}`;
const ISSUER = `http://127.0.0.1:${OIDC_PORT}`;

const fixture = await setupDatabase(ISSUER);
const custodian = await generateCustodianKeypair();
const custodyDirectory = resolve("work/showcase-custody");
const provider = await testProvider(OIDC_PORT, STAFF);

const env: NodeJS.ProcessEnv = {
  ...process.env,
  IMPORT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  IMPORT_LOCAL_DIRECTORY: resolve("work/showcase-imports"),
  INVITATION_DIGEST_KEY: randomBytes(32).toString("hex"),
  INVITATION_DIGEST_KEY_VERSION: "showcase",
  LINK_EXPORT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  LINK_EXPORT_LOCAL_DIRECTORY: resolve("work/showcase-link-exports"),
  REPORT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  REPORT_LOCAL_DIRECTORY: resolve("work/showcase-reports"),
  PARTICIPATION_EXPORT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  PARTICIPATION_EXPORT_LOCAL_DIRECTORY: resolve("work/showcase-participation"),
  ATTACHMENT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  ATTACHMENT_LOCAL_DIRECTORY: resolve("work/showcase-attachments"),
  CAMPAIGN_KEY_CUSTODY_DIRECTORY: custodyDirectory,
  CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY: custodian.publicKey,
  NODE_ENV: "development",
  NEXT_TELEMETRY_DISABLED: "1",
  STAFF_ORIGIN: STAFF,
  RESPONDENT_ORIGIN: RESPONDENT,
  DATABASE_URL: fixture.url("orgfit_staff"),
  AUTH_DATABASE_URL: fixture.url("orgfit_auth"),
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: "orgfit-test",
  OIDC_CLIENT_SECRET: "synthetic-oidc-test-secret",
  OIDC_MFA_ACR: "urn:test:mfa",
};
delete (env as NodeJS.ProcessEnv).MIGRATION_DATABASE_URL;

await writeFile(
  "work/showcase-fixture.json",
  JSON.stringify(
    {
      migration: fixture.url("orgfit_migrator"),
      invitationDigestKey: env.INVITATION_DIGEST_KEY,
      invitationDigestKeyVersion: env.INVITATION_DIGEST_KEY_VERSION,
      processor: fixture.url("orgfit_processor"),
      gateway: fixture.url("orgfit_gateway"),
      anonymous: fixture.anonymousUrl("orgfit_processor"),
      custodyDirectory,
      custodianPublicKey: custodian.publicKey,
      custodianSecretKey: custodian.secretKey,
      report: fixture.url("orgfit_report"),
      reportEncryptionKey: env.REPORT_ENCRYPTION_KEY,
      reportDirectory: env.REPORT_LOCAL_DIRECTORY,
      scanner: fixture.url("orgfit_scanner"),
      attachmentEncryptionKey: env.ATTACHMENT_ENCRYPTION_KEY,
      attachmentDirectory: env.ATTACHMENT_LOCAL_DIRECTORY,
    },
    null,
    2,
  ),
);
// The shared fixture reads work/e2e-fixture.json by name, so the showcase
// writes that too. The Playwright harness rewrites it on its next run.
await writeFile(
  "work/e2e-fixture.json",
  await (await import("node:fs/promises")).readFile("work/showcase-fixture.json", "utf8"),
);

const next = resolve("node_modules/next/dist/bin/next");
const children = [
  ["staff", STAFF_PORT] as const,
  ["respondent", RESPONDENT_PORT] as const,
].map(([app, port]) =>
  spawn(
    process.execPath,
    [next, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: resolve("apps", app),
      env:
        app === "staff"
          ? env
          : {
              GATEWAY_DATABASE_URL: fixture.url("orgfit_gateway"),
              INVITATION_DIGEST_KEY: env.INVITATION_DIGEST_KEY,
              INVITATION_DIGEST_KEY_VERSION: env.INVITATION_DIGEST_KEY_VERSION,
              RESPONDENT_ORIGIN: RESPONDENT,
              NODE_ENV: "development",
              NEXT_TELEMETRY_DISABLED: "1",
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
            },
      stdio: "inherit",
      windowsHide: true,
    },
  ),
);

function stop() {
  for (const c of children) c.kill();
  provider.close();
}
process.on("SIGINT", () => {
  stop();
  process.exit();
});
process.on("SIGTERM", () => {
  stop();
  process.exit();
});

async function waitFor(url: string) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* still starting */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out waiting for " + url);
}
await waitFor(`${STAFF}/health/live`);
await waitFor(`${RESPONDENT}/health/live`);

// ---------------------------------------------------------------------------
// Content. Driven through the real staff API in a real browser session, so the
// showcase can never create a row the product itself could not.
// ---------------------------------------------------------------------------
process.env.SHOWCASE_STAFF_ORIGIN = STAFF;
const { publishedRound } = await import("../tests/browser/published-round");

const browser = await chromium.launch();
const page = await browser.newPage();
let live: { url: string } | null = null;
try {
  const round = await publishedRound(page);
  console.log("published round:", round.roundId);

  // A second campaign on its own round, left OPEN, so the respondent journey
  // has a live one-use link to open. Same published version as the round above.
  const headers = () => ({ Origin: STAFF, "Idempotency-Key": randomUUID() });
  const base = `${STAFF}/api/v1/organizations/${ids.orgA}`;
  const roundRecord = (
    await (
      await page.request.get(`${base}/assessments/${round.roundId}`, {
        headers: { Origin: STAFF },
      })
    ).json()
  ).data as { questionnaire_version_id: string; series_id: string };
  const people = (
    await (
      await page.request.get(`${base}/participants?status=ACTIVE`, {
        headers: { Origin: STAFF },
      })
    ).json()
  ).data.items as { id: string }[];
  const stamp = Date.now().toString(36).toUpperCase();
  const series = await page.request.post(`${base}/assessment-series`, {
    headers: headers(),
    data: {
      nameAr: `سلسلة الاستبانة الحية ${stamp}`,
      purpose: "معاينة تجربة المشارك",
      questionnaireFamilyId: (
        await (
          await page.request.get(
            `${base}/assessment-series/${roundRecord.series_id}`,
            { headers: { Origin: STAFF } },
          )
        ).json()
      ).data.questionnaire_family_id,
    },
  });
  const roundTwo = await page.request.post(`${base}/assessments`, {
    headers: headers(),
    data: {
      seriesId: (await series.json()).data.id,
      label: "جولة المعاينة",
      periodStart: "2026-07-01",
      questionnaireVersionId: roundRecord.questionnaire_version_id,
      populationDefinition: { schemaVersion: 1 },
    },
  });
  const campaign = await page.request.post(`${base}/campaigns`, {
    headers: headers(),
    data: {
      roundId: (await roundTwo.json()).data.id,
      questionnaireVersionId: roundRecord.questionnaire_version_id,
      target: { mode: "SELECTED", participantIds: people.slice(0, 6).map((p) => p.id) },
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      timezone: "Asia/Riyadh",
    },
  });
  const created = (await campaign.json()).data as { id: string; revision: string };
  await page.request.post(`${base}/campaigns/${created.id}/launch`, {
    headers: { ...headers(), "If-Match": `"${created.revision}"` },
    data: {},
  });
  const list = (
    await (
      await page.request.get(`${base}/campaigns/${created.id}/participation`, {
        headers: { Origin: STAFF },
      })
    ).json()
  ).data.items as { invitationId: string; generation: number }[];
  const issued = await page.request.post(
    `${base}/campaigns/${created.id}/invitations/${list[0].invitationId}/issue`,
    { headers: headers(), data: { expectedGeneration: list[0].generation } },
  );
  live = { url: (await issued.json()).data.url as string };
} catch (e) {
  console.error("showcase content could not be seeded:", e);
} finally {
  await browser.close();
}

console.log(`
──────────────────────────────────────────────────────────────
OrgFit design review is running.

  Staff workspace       ${STAFF}
  Respondent survey     ${RESPONDENT}/s
  Test identity         ${ISSUER}   (pick "admin" and sign in)

  Organization          ${STAFF}/organizations/${ids.orgA}/overview
  Results / analytics   ${STAFF}/organizations/${ids.orgA}/assessments
  Field visits          ${STAFF}/organizations/${ids.orgA}/visits
  Questionnaire library ${STAFF}/questionnaires
${live ? `
  Live one-use survey link (opens the respondent journey):
  ${live.url}
` : "\n  No live survey link was issued; see the error above.\n"}
Ctrl+C to stop.
──────────────────────────────────────────────────────────────
`);
