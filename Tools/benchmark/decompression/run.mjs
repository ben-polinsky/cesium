#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  loadScenarios,
  parseBenchmarkArguments,
  printBenchmarkHelp,
  repositoryRoot,
} from "./benchmark-utils.mjs";

const options = parseBenchmarkArguments(process.argv.slice(2));
if (options.help) {
  printBenchmarkHelp();
  process.exit(0);
}

await loadScenarios(options.scenarios);
await mkdir(path.dirname(options.output), { recursive: true });
await access(path.join(repositoryRoot, "node_modules", ".bin", "playwright"));

const environment = {
  ...process.env,
  BENCHMARK_SCENARIOS: options.scenarios.join(","),
  BENCHMARK_STATES: options.states.join(","),
  BENCHMARK_VARIANTS: JSON.stringify(options.variants),
  BENCHMARK_COLD_ITERATIONS: String(options.coldIterations),
  BENCHMARK_WARM_ITERATIONS: String(options.warmIterations),
  BENCHMARK_READY_TIMEOUT_MS: String(options.readyTimeoutMs),
  BENCHMARK_SEED: String(options.seed),
  BENCHMARK_OUTPUT: options.output,
  BENCHMARK_HEADED: String(options.headed),
  BENCHMARK_PORT: String(options.port),
};

const playwright = path.join(
  repositoryRoot,
  "node_modules",
  ".bin",
  "playwright",
);
const config = path.join(
  repositoryRoot,
  "Tools",
  "benchmark",
  "decompression",
  "playwright.config.js",
);

const child = spawn(
  playwright,
  ["test", "-c", config, "--project=chromium"],
  {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error(`Unable to launch Playwright: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Playwright exited with signal ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
