import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.BENCHMARK_PORT ?? 8080);
const baseURL = `http://localhost:${port}`;
const serverScript = path.join(directory, "static-server.mjs");
const root = path.resolve(directory, "../../..");

export default defineConfig({
  testDir: directory,
  testMatch: "benchmark.spec.js",
  outputDir: path.resolve(
    directory,
    "../../../Build/Performance/Decompression/playwright",
  ),
  timeout: 0,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL,
    headless: process.env.BENCHMARK_HEADED !== "true",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
      },
    },
  ],
  webServer: {
    command: `node ${serverScript} --root ${root} --port ${port}`,
    url: baseURL,
    reuseExistingServer: process.env.BENCHMARK_REUSE_SERVER === "true",
    timeout: 120000,
  },
});
