#!/usr/bin/env node

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, "../../..");

const { values } = parseArgs({
  options: {
    scenario: { type: "string", multiple: true, default: [] },
    "cold-iterations": { type: "string", default: "10" },
    "warm-iterations": { type: "string", default: "30" },
    output: { type: "string" },
    port: { type: "string", default: "8080" },
    headed: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`Usage: npm run benchmark-decompression -- [options]

Options:
  --scenario id            Restrict to one scenario id (repeatable, default: all)
  --cold-iterations N      Fresh browser process samples (default: 10)
  --warm-iterations N      Warm shared-context samples (default: 30)
  --output path            Report JSON output path
  --port N                 Local static server port (default: 8080)
  --headed                 Launch Chromium headed
`);
  process.exit(0);
}

const child = spawn(
  path.join(repositoryRoot, "node_modules", ".bin", "playwright"),
  ["test", "-c", path.join(directory, "playwright.config.js"), "--project=chromium"],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      BENCHMARK_SCENARIOS: values.scenario.join(","),
      BENCHMARK_COLD_ITERATIONS: values["cold-iterations"],
      BENCHMARK_WARM_ITERATIONS: values["warm-iterations"],
      BENCHMARK_PORT: values.port,
      BENCHMARK_HEADED: String(values.headed),
      ...(values.output ? { BENCHMARK_OUTPUT: path.resolve(values.output) } : {}),
    },
  },
);

child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
