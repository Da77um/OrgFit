import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setupDatabase } from "./database";
import { testProvider } from "./oidc-provider";
import { generateCustodianKeypair } from "../src/key-custody";
const fixture = await setupDatabase();
// Overridable so the harness can run beside another local server (defaults unchanged).
const STAFF_PORT = Number(process.env.E2E_STAFF_PORT ?? 3000);
const RESPONDENT_PORT = Number(process.env.E2E_RESPONDENT_PORT ?? 3001);
const STAFF_ORIGIN = `http://127.0.0.1:${STAFF_PORT}`;
const RESPONDENT_ORIGIN = `http://localhost:${RESPONDENT_PORT}`;
// The key custodian: the staff app receives only the PUBLIC half, so a launch
// can seal a campaign private key it can never open again. The secret half goes
// to the processor alone and is never given to either web process.
const custodian = await generateCustodianKeypair();
const custodyDirectory = resolve("work/key-custody");
const provider = await testProvider(undefined, STAFF_ORIGIN);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  IMPORT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  IMPORT_LOCAL_DIRECTORY: resolve("work/imports"),
  INVITATION_DIGEST_KEY: randomBytes(32).toString("hex"),
  INVITATION_DIGEST_KEY_VERSION: "e2e",
  LINK_EXPORT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  LINK_EXPORT_LOCAL_DIRECTORY: resolve("work/link-exports"),
  // The staff process reads a finished report to serve an authorized download
  // and writes the named participation list. It never receives
  // REPORT_DATABASE_URL: that belongs to the renderer, and readConfig refuses
  // to start the staff app if it finds one.
  REPORT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  REPORT_LOCAL_DIRECTORY: resolve("work/reports"),
  PARTICIPATION_EXPORT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  PARTICIPATION_EXPORT_LOCAL_DIRECTORY: resolve("work/participation-exports"),
  // Visit attachments. The staff process stores and serves them; it never
  // receives SCANNER_DATABASE_URL, which belongs to the scanner, and readConfig
  // refuses to start the staff app if it finds one.
  ATTACHMENT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  ATTACHMENT_LOCAL_DIRECTORY: resolve("work/attachments"),
  CAMPAIGN_KEY_CUSTODY_DIRECTORY: custodyDirectory,
  CAMPAIGN_KEY_CUSTODY_PUBLIC_KEY: custodian.publicKey,
  NODE_ENV: "development",
  NEXT_TELEMETRY_DISABLED: "1",
  STAFF_ORIGIN,
  RESPONDENT_ORIGIN,
  DATABASE_URL: fixture.url("orgfit_staff"),
  AUTH_DATABASE_URL: fixture.url("orgfit_auth"),
  OIDC_ISSUER: "http://127.0.0.1:4010",
  OIDC_CLIENT_ID: "orgfit-test",
  OIDC_CLIENT_SECRET: "synthetic-oidc-test-secret",
  OIDC_MFA_ACR: "urn:test:mfa",
};
delete (env as NodeJS.ProcessEnv).MIGRATION_DATABASE_URL;
await writeFile(
  "work/e2e-fixture.json",
  JSON.stringify({
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
  }),
);
const next = resolve("node_modules/next/dist/bin/next");
const children = ["staff", "respondent"].map((app, i) =>
  spawn(
    process.execPath,
    [
      next,
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(i === 0 ? STAFF_PORT : RESPONDENT_PORT),
    ],
    {
      cwd: resolve("apps", app),
      env:
        app === "staff"
          ? env
          : {
              GATEWAY_DATABASE_URL: fixture.url("orgfit_gateway"),
              INVITATION_DIGEST_KEY: env.INVITATION_DIGEST_KEY,
              INVITATION_DIGEST_KEY_VERSION: env.INVITATION_DIGEST_KEY_VERSION,
              RESPONDENT_ORIGIN,
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
