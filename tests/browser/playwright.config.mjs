import { defineConfig } from "@playwright/test";
const origin = process.env.MAM_BROWSER_ORIGIN;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? "")) throw new Error("Run npm run test:browser; loopback fixture required");
export default defineConfig({
  testDir: ".", testMatch: "**/*.spec.mjs", fullyParallel: true,
  retries: 0, workers: 2, timeout: 20_000,
  outputDir: process.env.MAM_BROWSER_RESULTS,
  reporter: "list",
  use: { baseURL: origin, browserName: "chromium", headless: true },
});
