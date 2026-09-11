import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  reactStrictMode: true,
  serverExternalPackages: ["pg", "kysely", "openid-client"],
  logging: { incomingRequests: false },
  experimental: { externalDir: true },
};
export default config;
