import { chromium, test } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summarize } from "./stats.mjs";

// Playwright controller for the public 14-asset decompression sweep.
//
// benchmark.html + browserRunner.js own the browser-side loading and the
// public-ready timer; this file owns browser/context lifecycle, sample
// looping, and report output.
//
// Cold sample: a brand-new Chromium process and profile, so the HTTP cache,
// Cesium resource cache, and codec workers/WASM are all empty.
// Warm sample: one shared browser context per scenario. The asset loads once
// (discarded) to warm the cache/workers, then every measured sample reuses
// that same warm context.
const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, "../../..");
const benchmarkPagePath = "/Tools/benchmark/decompression/benchmark.html";
const viewport = { width: 1280, height: 720 };

const port = Number(process.env.BENCHMARK_PORT ?? 8080);
const baseURL = `http://localhost:${port}`;
const coldIterations = Number(process.env.BENCHMARK_COLD_ITERATIONS ?? 10);
const warmIterations = Number(process.env.BENCHMARK_WARM_ITERATIONS ?? 30);
const headed = process.env.BENCHMARK_HEADED === "true";
const selectedScenarioIds = (process.env.BENCHMARK_SCENARIOS ?? "")
  .split(",")
  .filter(Boolean);
const outputPath =
  process.env.BENCHMARK_OUTPUT ??
  path.join(repositoryRoot, "Build", "Performance", "Decompression", "benchmark.json");

const allScenarios = JSON.parse(
  await readFile(path.join(directory, "scenarios.json"), "utf8"),
).scenarios;
const scenarios =
  selectedScenarioIds.length > 0
    ? allScenarios.filter((scenario) => selectedScenarioIds.includes(scenario.id))
    : allScenarios;

// One scenario (gee-metadata) reads packet data through a route stub instead
// of a file on disk. Installing it for every page is harmless for the other
// 13 scenarios since the route pattern only matches that one path.
async function installGeeRoute(page) {
  const metadata = await readFile(
    path.join(repositoryRoot, "Specs", "Data", "GoogleEarthEnterprise", "gee.metadata"),
  );
  await page.route("**/Tools/benchmark/decompression/gee/**", async (route) => {
    if (route.request().url().includes("q2-0")) {
      await route.fulfill({ body: metadata, contentType: "application/octet-stream" });
    } else {
      await route.fulfill({ status: 404 });
    }
  });
}

async function openBenchmarkPage(browser) {
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  await installGeeRoute(page);
  await page.goto(benchmarkPagePath, { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.decompressionBenchmarkReady === true);
  return { context, page };
}

async function measureOnce(page, scenario) {
  const { durationMs } = await page.evaluate(
    (scenarioValue) => globalThis.runCesiumDecompressionScenario(scenarioValue),
    scenario,
  );
  return durationMs;
}

async function measureCold(scenario) {
  const samplesMs = [];
  for (let i = 0; i < coldIterations; ++i) {
    const browser = await chromium.launch({ headless: !headed });
    try {
      const { context, page } = await openBenchmarkPage(browser);
      samplesMs.push(await measureOnce(page, scenario));
      await context.close();
    } finally {
      await browser.close();
    }
  }
  return samplesMs;
}

async function measureWarm(scenario) {
  const browser = await chromium.launch({ headless: !headed });
  try {
    const { context, page } = await openBenchmarkPage(browser);
    await measureOnce(page, scenario); // warm-up sample; not recorded
    const samplesMs = [];
    for (let i = 0; i < warmIterations; ++i) {
      samplesMs.push(await measureOnce(page, scenario));
    }
    await context.close();
    return samplesMs;
  } finally {
    await browser.close();
  }
}

test("decompression benchmark", async () => {
  const results = [];

  for (const scenario of scenarios) {
    results.push({
      scenarioId: scenario.id,
      compression: scenario.compression,
      state: "cold",
      ...summarize(await measureCold(scenario)),
    });
    results.push({
      scenarioId: scenario.id,
      compression: scenario.compression,
      state: "warm",
      ...summarize(await measureWarm(scenario)),
    });
  }

  console.table(
    results.map((result) => ({
      scenario: result.scenarioId,
      state: result.state,
      medianMs: result.medianMs.toFixed(1),
      p95Ms: result.p95Ms.toFixed(1),
    })),
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`,
  );
});
