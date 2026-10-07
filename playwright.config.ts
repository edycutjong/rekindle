import { defineConfig, devices } from "@playwright/test";

/**
 * Two modes:
 *  - default (CI): builds nothing itself, starts `next start` with NO provider keys, and checks that the product
 *    renders, refuses honestly without Qloo (no week is invented), and lays out at 375 / 768 / 1440 px.
 *  - E2E_BASE_URL=https://rekindle.edycu.dev E2E_LIVE=1: the same suites plus e2e/live-plan.spec.ts against
 *    a real deployment (live Qloo + model calls). Nothing is mocked in either mode.
 */
const external = process.env.E2E_BASE_URL;
const baseURL = external ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "on-first-retry", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
  ],
  webServer: external
    ? undefined
    : { command: "npm run start", url: baseURL, reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
