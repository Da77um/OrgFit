import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  reactStrictMode: true,
  logging: { incomingRequests: false },
  experimental: { externalDir: true },
};
export default config;
