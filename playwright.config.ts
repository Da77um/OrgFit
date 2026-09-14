import { defineConfig } from "@playwright/test";
// E2E_STAFF_PORT lets the harness run beside another local server; the default
// is the port every spec has always used.
const staffPort = Number(process.env.E2E_STAFF_PORT ?? 3000);
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: `http://127.0.0.1:${staffPort}`,
    headless: true,
    trace: "off",
    screenshot: "off",
  },
  webServer: {
    command: "node --import tsx tests/serve.ts",
    url: `http://127.0.0.1:${staffPort}/health/live`,
    reuseExistingServer: false,
    timeout: 120000,
  },
  reporter: "list",
});
