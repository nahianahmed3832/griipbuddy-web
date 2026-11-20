import { config } from "dotenv";
import { defineConfig } from "@playwright/test";

const isolated = process.env.GRIIPBUDDY_ENV_FILE === ".env.test";
const stageURL = process.env.GRIIPBUDDY_STAGE_URL;
const executablePath = process.env.GRIIPBUDDY_BROWSER;
if (stageURL && (!stageURL.startsWith("https://") || isolated || !process.env.STAGING_USER || !process.env.STAGING_PASSWORD)) {
  throw new Error("Use a dedicated HTTPS staging URL and its review credentials.");
}
if (isolated) {
  config({ path: [".env.test", ".local/test-staff.env"], override: true, quiet: true });
  const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) || database.pathname !== "/griipbuddy_test" || database.search) {
    throw new Error("The database browser suite requires the isolated local test database.");
  }
}

const baseURL = stageURL ?? (isolated ? "http://127.0.0.1:3101" : "http://127.0.0.1:3100");

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  expect: { timeout: stageURL ? 15_000 : 5_000 },
  use: {
    baseURL, launchOptions: executablePath ? { executablePath, args: process.env.TEST_NO_DEFAULT_GPC === "1" ? ["--disable-features=BraveGlobalPrivacyControl"] : [] } : undefined, trace: "retain-on-failure",
    httpCredentials: stageURL ? { username: process.env.STAGING_USER!, password: process.env.STAGING_PASSWORD!, origin: new URL(stageURL).origin } : undefined,
  },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } } },
    { name: "narrow-mobile", use: { browserName: "chromium", viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
  ],
  webServer: stageURL ? undefined : {
    command: isolated ? "npm start -- 3101" : "npm start",
    url: baseURL, reuseExistingServer: !isolated, timeout: 45_000,
  },
});
