import { defineConfig, devices } from "@playwright/test";

/**
 * E2E suite for the pre-auth onboarding screen.
 * Run with:  npm run test:e2e   (auto-starts `next dev` unless one is already running)
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    // Sandboxes/CI images that ship their own Chromium can point at it with
    // PW_CHROMIUM_PATH instead of downloading browsers. Such builds run
    // unprivileged in a container, so the sandbox flags come with them.
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? {
          executablePath: process.env.PW_CHROMIUM_PATH,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        }
      : {},
  },
  projects: [
    {
      name: "Mobile Chrome",
      ...devices["Pixel 7"], // 412×915 mobile viewport, touch emulation
    },
    {
      name: "Desktop Chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
