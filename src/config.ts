import { z } from "zod";

export class ConfigurationError extends Error {
  constructor() {
    super("Configuration unavailable");
  }
}
const origin = z.url().refine((v) => new URL(v).origin === v);
const schema = z.object({
  STAFF_ORIGIN: origin,
  RESPONDENT_ORIGIN: origin,
  DATABASE_URL: z.url(),
  AUTH_DATABASE_URL: z.url(),
  OIDC_ISSUER: z.url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(16),
  OIDC_MFA_ACR: z.string().min(1),
});
export type Config = z.infer<typeof schema>;
export function readConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const result = schema.safeParse(env);
  if (!result.success) throw new ConfigurationError();
  const c = result.data;
  const staff = new URL(c.STAFF_ORIGIN),
    respondent = new URL(c.RESPONDENT_ORIGIN);
  if (
    staff.hostname === respondent.hostname ||
    staff.origin === respondent.origin
  )
    throw new ConfigurationError();
  for (const [key, role] of [
    ["DATABASE_URL", "orgfit_staff"],
    ["AUTH_DATABASE_URL", "orgfit_auth"],
  ] as const) {
    const u = new URL(c[key]);
    if (
      !["postgres:", "postgresql:"].includes(u.protocol) ||
      u.username !== role ||
      !u.password ||
      u.password === "CHANGE_ME"
    )
      throw new ConfigurationError();
    if (
      env.NODE_ENV === "production" &&
      u.searchParams.get("sslmode") !== "verify-full"
    )
      throw new ConfigurationError();
  }
  // The staff process must never hold an operator, processor, gateway, report
  // renderer or key custody credential. Holding any of them would collapse a
  // privacy boundary the rest of the design depends on, so it refuses to start
  // instead. The staff process does hold REPORT_ENCRYPTION_KEY: it must decrypt
  // a finished artifact to serve an authorized download, and it holds
  // ATTACHMENT_ENCRYPTION_KEY for the same reason on the visit side.
  if (
    env.MIGRATION_DATABASE_URL ||
    env.PROCESSOR_DATABASE_URL ||
    env.ANONYMOUS_DATABASE_URL ||
    env.ANONYMOUS_MIGRATION_DATABASE_URL ||
    env.GATEWAY_DATABASE_URL ||
    env.REPORT_DATABASE_URL ||
    env.SCANNER_DATABASE_URL ||
    env.CAMPAIGN_KEY_CUSTODY_SECRET_KEY
  )
    throw new ConfigurationError();
  for (const value of [c.STAFF_ORIGIN, c.RESPONDENT_ORIGIN, c.OIDC_ISSUER]) {
    const u = new URL(value);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      (u.protocol !== "https:" &&
        !(env.NODE_ENV !== "production" && local && u.protocol === "http:"))
    )
      throw new ConfigurationError();
  }
  if (c.OIDC_CLIENT_SECRET.includes("CHANGE_ME"))
    throw new ConfigurationError();
  return c;
}
