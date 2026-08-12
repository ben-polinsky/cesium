#!/usr/bin/env node
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./server.mjs";
import {
  buildVariant,
  requireArtifacts,
  verifyVariant,
} from "../confirmatory/utils.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const defaultCandidateRef = "7e620929194becfe04c5ad019c030159cfe0aa34";
const defaultBaselineRef = "6d5d8b1f0725b6f831b336463f4b11c98023427b";

function value(argumentsList, index, name) {
  const argument = argumentsList[index];
  if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
  const result = argumentsList[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
  return result;
}

function parseArguments(argumentsList) {
  const options = {
    candidate: process.env.REARTH_CANDIDATE,
    baseline: process.env.REARTH_BASELINE,
    candidateRef: defaultCandidateRef,
    baselineRef: defaultBaselineRef,
    port: Number(process.env.REARTH_PORT ?? 8097),
    output:
      process.env.REARTH_OUTPUT ??
      "Build/Performance/Decompression/reearth-large-smoke.json",
    skipBuild: process.env.REARTH_SKIP_BUILD === "1",
    smoke: false,
    oneStop: false,
    discovery: false,
    help: false,
  };
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--skip-build") options.skipBuild = true;
    else if (argument === "--smoke") options.smoke = true;
    else if (argument === "--one-stop") options.oneStop = true;
    else if (argument === "--discover") options.discovery = true;
    else if (argument === "--candidate" || argument.startsWith("--candidate=")) {
      options.candidate = value(argumentsList, index, "--candidate");
      if (argument === "--candidate") index++;
    } else if (argument === "--baseline" || argument.startsWith("--baseline=")) {
      options.baseline = value(argumentsList, index, "--baseline");
      if (argument === "--baseline") index++;
    } else if (
      argument === "--candidate-ref" ||
      argument.startsWith("--candidate-ref=")
    ) {
      options.candidateRef = value(argumentsList, index, "--candidate-ref");
      if (argument === "--candidate-ref") index++;
    } else if (
      argument === "--baseline-ref" ||
      argument.startsWith("--baseline-ref=")
    ) {
      options.baselineRef = value(argumentsList, index, "--baseline-ref");
      if (argument === "--baseline-ref") index++;
    } else if (argument === "--port" || argument.startsWith("--port=")) {
      options.port = Number(value(argumentsList, index, "--port"));
      if (argument === "--port") index++;
    } else if (argument === "--output" || argument.startsWith("--output=")) {
      options.output = value(argumentsList, index, "--output");
      if (argument === "--output") index++;
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (options.help) return options;
  if (!options.candidate || !options.baseline) {
    throw new Error("--candidate and --baseline are required");
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log(
    "Usage: npm run benchmark-decompression:reearth -- --candidate PATH --baseline PATH " +
      "[--candidate-ref REF --baseline-ref REF --output FILE --port PORT --skip-build] " +
      "[--smoke --one-stop --discover]",
  );
  process.exit(0);
}

const candidateRoot = options.candidate;
const baselineRoot = options.baseline;
const candidateRef = options.candidateRef;
const baselineRef = options.baselineRef;
const port = options.port;
const output = options.output;
const smoke = options.smoke;
const oneStop = options.oneStop;
const discovery = options.discovery;
const iterations = smoke || discovery ? 1 : 12;
const checkpointTimeoutMs = Number(
  process.env.REARTH_CHECKPOINT_TIMEOUT_MS ?? (smoke ? 20000 : 45000),
);
const routeTimeoutMs = Number(
  process.env.REARTH_ROUTE_TIMEOUT_MS ?? (smoke ? 90000 : 1800000),
);
const maxStops = Number(process.env.REARTH_MAX_STOPS ?? 0);
const routeHeightMeters = Number(
  process.env.REARTH_HEIGHT_METERS ?? (smoke ? 5000 : 2500),
);
const denseRoute = process.env.REARTH_DENSE === "1";
const denseOffsetDegrees = Number(
  process.env.REARTH_DENSE_OFFSET_DEGREES ?? 0.08,
);

const cityStops = [
  ["tokyo", 139.6917, 35.6895],
  ["osaka", 135.5023, 34.6937],
  ["seoul", 126.978, 37.5665],
  ["beijing", 116.4074, 39.9042],
  ["shanghai", 121.4737, 31.2304],
  ["singapore", 103.8198, 1.3521],
  ["sydney", 151.2093, -33.8688],
  ["melbourne", 144.9631, -37.8136],
  ["auckland", 174.7633, -36.8485],
  ["san-francisco", -122.4194, 37.7749],
  ["los-angeles", -118.2437, 34.0522],
  ["seattle", -122.3321, 47.6062],
  ["denver", -104.9903, 39.7392],
  ["chicago", -87.6298, 41.8781],
  ["new-york", -74.006, 40.7128],
  ["boston", -71.0589, 42.3601],
  ["mexico-city", -99.1332, 19.4326],
  ["sao-paulo", -46.6333, -23.5505],
  ["buenos-aires", -58.3816, -34.6037],
  ["london", -0.1276, 51.5072],
  ["paris", 2.3522, 48.8566],
  ["amsterdam", 4.9041, 52.3676],
  ["brussels", 4.3517, 50.8503],
  ["berlin", 13.405, 52.52],
  ["prague", 14.4378, 50.0755],
  ["vienna", 16.3738, 48.2082],
  ["warsaw", 21.0122, 52.2297],
  ["madrid", -3.7038, 40.4168],
  ["rome", 12.4964, 41.9028],
  ["istanbul", 28.9784, 41.0082],
  ["cairo", 31.2357, 30.0444],
  ["johannesburg", 28.0473, -26.2041],
  ["mumbai", 72.8777, 19.076],
  ["delhi", 77.1025, 28.7041],
  ["bangkok", 100.5018, 13.7563],
  ["jakarta", 106.8456, -6.2088],
  ["manila", 120.9842, 14.5995],
  ["taipei", 121.5654, 25.033],
  ["hong-kong", 114.1694, 22.3193],
  ["perth", 115.8575, -31.9505],
].map(([id, longitude, latitude]) => ({
  id,
  longitude,
  latitude,
  heightMeters: routeHeightMeters,
}));

const selectedCities = oneStop
  ? cityStops.slice(0, 1)
  : smoke
    ? cityStops.slice(0, 3)
    : maxStops > 0
      ? cityStops.slice(0, maxStops)
      : cityStops;
const denseOffsets = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [0, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];
const stops = denseRoute
  ? selectedCities.flatMap((city) =>
      denseOffsets.map(([longitudeOffset, latitudeOffset]) => ({
        ...city,
        id: `${city.id}-${longitudeOffset + 1}-${latitudeOffset + 1}`,
        longitude:
          city.longitude +
          (longitudeOffset * denseOffsetDegrees) /
            Math.max(0.2, Math.cos((city.latitude * Math.PI) / 180)),
        latitude: city.latitude + latitudeOffset * denseOffsetDegrees,
      })),
    )
  : selectedCities;
const [candidate, baseline] = await Promise.all([
  verifyVariant(candidateRoot, candidateRef),
  verifyVariant(baselineRoot, baselineRef),
]);

if (!options.skipBuild) {
  await buildVariant(candidate.root);
  await buildVariant(baseline.root);
}
await Promise.all([
  requireArtifacts(candidate.root),
  requireArtifacts(baseline.root),
]);

const requireFromCandidate = createRequire(
  path.join(candidate.root, "package.json"),
);
const { chromium } = requireFromCandidate("@playwright/test");
const server = createServer({
  harness: directory,
  candidate: candidate.root,
  baseline: baseline.root,
  port,
});
await new Promise((resolve) => server.once("listening", resolve));

const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
});
const runs = [];
try {
  const orders = [
    ["candidate", "baseline"],
    ["baseline", "candidate"],
  ];
  for (let block = 0; block < iterations; block++) {
    const blockVariants = discovery ? ["candidate"] : orders[block % 2];
    for (const variant of blockVariants) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();
      const responses = new Map();
      const failures = [];
      const pageErrors = [];
      let glbResponseCount = 0;
      let glbRequestFailureCount = 0;
      page.on("pageerror", (error) =>
        pageErrors.push({
          type: "pageerror",
          message: error.message,
          stack: error.stack,
        }),
      );
      page.on("console", (message) => {
        if (message.type() === "error") {
          pageErrors.push({ type: "console.error", message: message.text() });
        }
      });
      page.on("response", (response) => {
        const url = response.url();
        if (response.status() >= 400) {
          pageErrors.push({
            type: "response",
            status: response.status(),
            url,
          });
        }
        if (!/buildings\.reearth\.land\/.*\.glb(?:\?|$)/i.test(url)) return;
        glbResponseCount++;
        const existing = responses.get(url);
        if (!existing || (response.status() === 200 && existing.status !== 200)) {
          const headers = response.headers();
          responses.set(url, {
            url,
            status: response.status(),
            contentLength: Number(headers["content-length"]) || null,
            contentType: headers["content-type"] ?? null,
          });
        }
      });
      page.on("requestfailed", (request) => {
        const url = request.url();
        if (/buildings\.reearth\.land\/.*\.glb(?:\?|$)/i.test(url)) {
          glbRequestFailureCount++;
        }
        failures.push(url);
      });
      try {
        await page.goto(
          `http://127.0.0.1:${port}/harness/index.html?variant=${variant}`,
          { waitUntil: "load" },
        );
        await page.waitForFunction(
          () => globalThis.reearthRun !== undefined,
        );
        const invocation = await page.evaluate(
          ({
            stops: routeStops,
            checkpointTimeoutMs: checkpointTimeout,
            routeTimeoutMs: routeTimeout,
          }) =>
            globalThis.reearthRun({
              stops: routeStops,
              checkpointTimeoutMs: checkpointTimeout,
              routeTimeoutMs: routeTimeout,
            })
              .then((result) => ({ ok: true, result }))
              .catch((error) => ({
                ok: false,
                error: {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                },
              })),
          {
            stops,
            checkpointTimeoutMs,
            routeTimeoutMs,
            routeHeightMeters,
          },
        );
        if (!invocation.ok) {
          throw new Error(JSON.stringify(invocation.error));
        }
        const result = invocation.result;
        const compressedBytes = [...responses.values()]
          .map((item) => item.contentLength ?? 0)
          .reduce((sum, bytes) => sum + bytes, 0);
        runs.push({
          block,
          variant,
          ok: true,
          result,
          content: {
            uniqueGlbCount: responses.size,
            uniqueCompressedBytesFromHeaders: compressedBytes,
            glbResponseCount,
            glbRequestFailureCount,
            duplicateGlbResponses: Math.max(
              0,
              glbResponseCount - responses.size,
            ),
            responses: [...responses.values()],
          },
          failures,
          pageErrors,
        });
        console.log(
          `Completed block ${block} ${variant}: ` +
            `${Math.round(result.durationMs)} ms, ` +
            `${responses.size} unique GLBs, ` +
            `${compressedBytes} compressed bytes`,
        );
      } catch (error) {
        runs.push({
          block,
          variant,
          ok: false,
          error: error.message,
          content: {
            uniqueGlbCount: responses.size,
            uniqueCompressedBytesFromHeaders: [...responses.values()]
              .map((item) => item.contentLength ?? 0)
              .reduce((sum, bytes) => sum + bytes, 0),
            glbResponseCount,
            glbRequestFailureCount,
            duplicateGlbResponses: Math.max(
              0,
              glbResponseCount - responses.size,
            ),
            responses: [...responses.values()],
          },
          failures,
          pageErrors,
        });
        console.log(`Failed block ${block} ${variant}: ${error.message}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const report = {
  kind: "reearth-production-meshopt-route",
  generatedAt: new Date().toISOString(),
  route: {
    tilesetUrl: "https://buildings.reearth.land/tileset.json",
    stops,
    screenSpaceError: 8,
    viewport: { width: 1280, height: 720 },
    iterations,
    smoke,
    discovery,
    checkpointTimeoutMs,
    routeTimeoutMs,
    denseRoute,
    denseOffsetDegrees,
  },
  variants: {
    candidate: { commit: candidate.commit, root: candidate.root },
    baseline: { commit: baseline.commit, root: baseline.root },
  },
  runs,
};
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${output}`);
