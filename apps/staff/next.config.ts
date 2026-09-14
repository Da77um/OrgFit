import type { NextConfig } from "next";
const config: NextConfig = {
  // Test tooling only: lets the browser harness run beside another local dev
  // server of this app, whose lock lives in the default directory.
  ...(process.env.E2E_NEXT_DIST_DIR ? { distDir: process.env.E2E_NEXT_DIST_DIR } : {}),
  poweredByHeader: false,
  devIndicators: false,
  reactStrictMode: true,
  serverExternalPackages: ["pg", "kysely", "openid-client"],
  logging: { incomingRequests: false },
  experimental: { externalDir: true },
};
export default config;
