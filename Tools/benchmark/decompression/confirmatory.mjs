#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./confirmatory-server.mjs";
import {
  hashFiles,
  pairedOrders,
  parseConfirmatoryArguments,
  scenarios,
  verifyVariant,
  workerArtifactFiles,
} from "./confirmatory-utils.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../..");
const options = parseConfirmatoryArguments(process.argv.slice(2));
if (options.help) {
  console.log("Usage: npm run benchmark-decompression:confirmatory -- --candidate PATH --baseline PATH [--candidate-ref REF --baseline-ref REF --output FILE --port PORT]");
  process.exit(0);
}
const [candidate, baseline] = await Promise.all([verifyVariant(options.candidate, options.candidateRef), verifyVariant(options.baseline, options.baselineRef)]);
const requireFromCandidate = createRequire(path.join(candidate.root, "package.json"));
const { chromium } = requireFromCandidate("@playwright/test");
const harnessFiles = ["confirmatory.html", "confirmatory-runner.js", "confirmatory.mjs", "confirmatory-server.mjs", "confirmatory-utils.mjs"];
const artifactFiles = ["packages/engine/Build/Minified/index.js", "packages/engine/Build/Workers/decodeMeshopt.js", "packages/engine/Build/Workers/decodeSpz.js"];
const candidateArtifactFiles = [
  "packages/engine/Build/Minified/index.js",
  ...(await workerArtifactFiles(candidate.root, artifactFiles.slice(1))),
];
const harnessHash = createHash("sha256").update(Buffer.concat(await Promise.all(harnessFiles.map((file) => readFile(path.join(directory, file)))))).digest("hex");
const server = createServer({ harness: directory, candidate: candidate.root, baseline: baseline.root, port: options.port });
await new Promise((resolve) => server.once("listening", resolve));
const browser = await chromium.launch({ headless: !options.headed, channel: "chromium" });
const browserIdentity = {
  version: browser.version(),
  revision:
    chromium.executablePath().match(/(?:chromium|chrome-headless-shell)-(\d+)/)?.[1] ??
    browser.version(),
};
const runs = []; let environment;
const orderName = (order) => `${order[0]}-first`;
try {
  for (const { block, order } of pairedOrders()) for (const scenario of scenarios) for (const variant of order) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${options.port}/harness/confirmatory.html?variant=${variant}`, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.confirmatoryRun !== undefined);
    environment ??= await page.evaluate(() => globalThis.confirmatoryEnvironment);
    const result = await page.evaluate((item) => globalThis.confirmatoryRun(item), scenario);
    runs.push({ block, order: orderName(order), variant, scenarioId: scenario.id, ...result });
    await context.close();
  }
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
const report = {
  kind: "confirmatory-public-ready",
  taskProcessorLifecycleInstrumentation: "disabled (production paths; no benchmark hook is installed)",
  variants: {
    candidate: {
      ...candidate,
      artifacts: await hashFiles(candidate.root, candidateArtifactFiles),
      decoderExecution: {
        meshopt: "packages/engine/Build/Workers/decodeMeshopt.js",
        spz: "packages/engine/Build/Workers/decodeSpz.js",
      },
      wasm: { externalFiles: [] },
    },
    baseline: {
      ...baseline,
      artifacts: await hashFiles(baseline.root, artifactFiles),
      decoderExecution: {
        meshopt: "packages/engine/Build/Minified/index.js",
        spz: "packages/engine/Build/Minified/index.js",
      },
      wasm: { externalFiles: [] },
    },
  },
  harness: { gitCommit: (await import("node:child_process")).execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), files: harnessFiles, sha256: harnessHash },
  browser: { ...browserIdentity, ...environment },
  orderCounts: Object.fromEntries(["candidate-first", "baseline-first"].map((order) => [order, {
    blocks: pairedOrders().filter(({ order: variants }) => orderName(variants) === order).length,
    runs: runs.filter((run) => run.order === order).length,
    byScenario: Object.fromEntries(scenarios.map(({ id }) => [id, runs.filter((run) => run.order === order && run.scenarioId === id).length])),
  }])),
  scenarios: scenarios.map(({ id }) => id), runs,
};
await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${options.output}; candidate-first=${report.orderCounts["candidate-first"].blocks} blocks, baseline-first=${report.orderCounts["baseline-first"].blocks} blocks`);
