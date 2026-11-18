import type { NextConfig } from "next";

// Scheduled jobs on Vercel Cron (D-165). One route, no pages. Deployed as four
// Vercel projects (processor, report, scanner, operator), each holding only its
// own process's environment; see docs/orgfit/vercel-deployment.md.
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  reactStrictMode: true,
  serverExternalPackages: ["pg", "kysely", "playwright", "playwright-core", "@sparticuz/chromium"],
  logging: { incomingRequests: false },
  experimental: { externalDir: true },
  // The database CA certificate is named by path in each database URL
  // (sslrootcert), so it is never imported and must be traced explicitly.
  // The serverless Chromium (D-191) finds its compressed binary by path at run
  // time, so the report job traces it explicitly as well.
  outputFileTracingIncludes: {
    "/**": [
      "../../deploy/certs/**",
      "../../node_modules/@sparticuz/chromium/bin/**",
      // Report fonts are read from disk by src/report-fonts.ts (D-191).
      "../../node_modules/@fontsource/cairo/package.json",
      "../../node_modules/@fontsource/cairo/files/cairo-arabic-400-normal.woff2",
      "../../node_modules/@fontsource/cairo/files/cairo-arabic-700-normal.woff2",
      "../../node_modules/@fontsource/cairo/files/cairo-latin-400-normal.woff2",
      "../../node_modules/@fontsource/cairo/files/cairo-latin-700-normal.woff2",
      "../../node_modules/@fontsource/noto-sans/package.json",
      "../../node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff2",
      "../../node_modules/@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff2",
    ],
  },
};
export default config;
