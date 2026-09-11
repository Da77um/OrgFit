import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:3000",
    headless: true,
    trace: "off",
    screenshot: "off",
  },
  webServer: {
    command: "node --import tsx tests/serve.ts",
    url: "http://127.0.0.1:3000/health/live",
    reuseExistingServer: false,
    timeout: 120000,
  },
  reporter: "list",
});
