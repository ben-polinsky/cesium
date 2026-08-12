#!/usr/bin/env node
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../confirmatory/server.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../../..");

function value(argumentsList, index, name) {
  const argument = argumentsList[index];
  if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
  const result = argumentsList[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
  return result;
}

function parseArguments(argumentsList) {
  const options = {
    scenarios: [],
    coldSamples: 10,
    warmSamples: 30,
    output: "Build/Performance/Decompression/full-sweep.json",
    port: 8092,
    headed: false,
    help: false,
  };
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--headed") options.headed = true;
    else if (argument === "--scenario" || argument.startsWith("--scenario=")) {
      options.scenarios.push(...value(argumentsList, index, "--scenario").split(","));
      if (argument === "--scenario") index++;
    } else if (
      argument === "--cold-samples" ||
      argument.startsWith("--cold-samples=")
    ) {
      options.coldSamples = Number(value(argumentsList, index, "--cold-samples"));
      if (argument === "--cold-samples") index++;
    } else if (
      argument === "--warm-samples" ||
      argument.startsWith("--warm-samples=")
    ) {
      options.warmSamples = Number(value(argumentsList, index, "--warm-samples"));
      if (argument === "--warm-samples") index++;
    } else if (argument === "--output" || argument.startsWith("--output=")) {
      options.output = value(argumentsList, index, "--output");
      if (argument === "--output") index++;
    } else if (argument === "--port" || argument.startsWith("--port=")) {
      options.port = Number(value(argumentsList, index, "--port"));
      if (argument === "--port") index++;
    } else throw new Error(`Unknown argument ${argument}`);
  }
  for (const [name, value] of [
    ["--cold-samples", options.coldSamples],
    ["--warm-samples", options.warmSamples],
    ["--port", options.port],
  ]) {
    if (!Number.isInteger(value) || value < 1 || (name === "--port" && value > 65535)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log(
    "Usage: npm run benchmark-decompression:full -- " +
      "[--scenario ID[,ID]] [--cold-samples N] [--warm-samples N] " +
      "[--output FILE] [--port PORT] [--headed]",
  );
  process.exit(0);
}

const manifest = JSON.parse(
  await readFile(path.join(directory, "scenarios.json"), "utf8"),
);
const requested = new Set(options.scenarios.filter(Boolean));
const scenarios = manifest.scenarios.filter(
  (scenario) => requested.size === 0 || requested.has(scenario.id),
);
if (scenarios.length === 0 || scenarios.length !== requested.size && requested.size > 0) {
  throw new Error("No scenario matched one or more --scenario values");
}

const scenarioDetails = await Promise.all(
  scenarios.map(async (scenario) => {
    const runtimeFiles = scenario.runtimeAssetFiles ?? scenario.assetFiles;
    const sizes = await Promise.all(
      runtimeFiles.map((file) => stat(path.join(root, file)).then((item) => item.size)),
    );
    return {
      id: scenario.id,
      api: scenario.api,
      compression: scenario.compression,
      url: scenario.url,
      sizeBytes: sizes.reduce((total, size) => total + size, 0),
    };
  }),
);

const requireFromRoot = createRequire(path.join(root, "package.json"));
const { chromium } = requireFromRoot("@playwright/test");
const server = createServer({
  harness: directory,
  candidate: root,
  baseline: root,
  port: options.port,
});
await new Promise((resolve) => server.once("listening", resolve));

function orderedForSample(values, sampleIndex) {
  return sampleIndex % 2 === 0 ? values : [...values].reverse();
}

async function installGeeRoute(page) {
  const metadata = await readFile(
    path.join(root, "Specs/Data/GoogleEarthEnterprise/gee.metadata"),
  );
  await page.route("**/candidate/Tools/benchmark/decompression/gee/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/dbRoot.v5")) return route.fulfill({ status: 404 });
    if (url.search.includes("q2-0")) {
      return route.fulfill({
        body: metadata,
        contentType: "application/octet-stream",
      });
    }
    return route.continue();
  });
}

async function openPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await installGeeRoute(page);
  await page.goto(
    `http://127.0.0.1:${options.port}/harness/index.html?variant=candidate`,
    { waitUntil: "load" },
  );
  await page.waitForFunction(() => globalThis.fullSweepReady === true);
  return { context, page };
}

async function measure(page, scenario) {
  const result = await page.evaluate(async (item) => {
    try {
      return { ok: true, value: await globalThis.fullSweepRun(item) };
    } catch (error) {
      return { ok: false, message: error.message, stack: error.stack };
    }
  }, scenario);
  if (!result.ok) throw new Error(`${scenario.id}: ${result.message}\n${result.stack ?? ""}`);
  return result.value.publicReadyMs;
}

const runs = [];
for (let sampleIndex = 0; sampleIndex < options.coldSamples; sampleIndex++) {
  for (const scenario of orderedForSample(scenarios, sampleIndex)) {
    const browser = await chromium.launch({
      headless: !options.headed,
      channel: "chromium",
    });
    try {
      const { context, page } = await openPage(browser);
      try {
        runs.push({
          scenarioId: scenario.id,
          state: "cold",
          sampleIndex,
          publicReadyMs: await measure(page, scenario),
        });
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
}

const browser = await chromium.launch({ headless: !options.headed, channel: "chromium" });
try {
  const { context, page } = await openPage(browser);
  try {
    for (const scenario of scenarios) await measure(page, scenario);
    for (let sampleIndex = 0; sampleIndex < options.warmSamples; sampleIndex++) {
      for (const scenario of orderedForSample(scenarios, sampleIndex)) {
        runs.push({
          scenarioId: scenario.id,
          state: "warm",
          sampleIndex,
          publicReadyMs: await measure(page, scenario),
        });
      }
    }
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const report = {
  kind: "14-asset-public-ready-sweep",
  commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  generatedAt: new Date().toISOString(),
  browser: chromium.name(),
  coldSamples: options.coldSamples,
  warmSamples: options.warmSamples,
  scenarios: scenarioDetails,
  runs,
};
await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${options.output}`);
