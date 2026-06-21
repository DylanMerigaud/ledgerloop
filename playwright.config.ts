import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the LOCAL end-to-end test (`pnpm e2e`).
 *
 * This drives the real app — real React UI, real Mastra agent (Claude Haiku),
 * real Supabase — so it needs ANTHROPIC_API_KEY + DATABASE_URL in the
 * environment (load them from .env). It is deliberately NOT wired into CI: CI has
 * no secrets and shouldn't spend tokens (same stance as the live eval in the
 * sibling repo). Run it by hand before deploys to confirm the human-in-the-loop
 * Approve/Reject flow works through the actual browser.
 *
 * Specs live in `e2e/*.e2e.ts` so they're not picked up by `pnpm test` (Node's
 * runner globs `**​/*.test.ts`).
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  // A full 4-agent run plus the approval resume is a handful of Haiku calls;
  // give each test generous headroom over that.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Start the app for the test. `reuseExistingServer` lets you point at a dev
  // server you already have running; otherwise it boots `pnpm dev`. The dev
  // process must see the env vars — run `pnpm e2e` with .env loaded.
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
