import type { NextConfig } from "next";

// Scheduled jobs on Vercel Cron (D-165). One route, no pages. Deployed as four
// Vercel projects (processor, report, scanner, operator), each holding only its
// own process's environment; see docs/orgfit/vercel-deployment.md.
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  reactStrictMode: true,
  serverExternalPackages: ["pg", "kysely", "playwright", "playwright-core"],
  logging: { incomingRequests: false },
  experimental: { externalDir: true },
  // The database CA certificate is named by path in each database URL
  // (sslrootcert), so it is never imported and must be traced explicitly.
  outputFileTracingIncludes: { "/**": ["../../deploy/certs/**"] },
};
export default config;
