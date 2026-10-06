import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  reactStrictMode: true,
  logging: { incomingRequests: false },
  experimental: { externalDir: true },
  // The database CA certificate is named by path in each database URL
  // (sslrootcert), so it is never imported and must be traced explicitly.
  outputFileTracingIncludes: { "/**": ["../../deploy/certs/**"] },
};
export default config;
