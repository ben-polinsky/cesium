#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const repositoryRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../..",
);
const benchmarkPage = "/Tools/benchmark/decompression/benchmark.html";
const viewport = { width: 1280, height: 720 };
const assetId = 4547222;
const defaultPort = 8131;
const defaultIterations = 3;
const defaultTargetWindowMs = 10000;
const defaultReadyTimeoutMs = 120000;

const prewarmFixture = {
  id: "prewarm-spz-sh-unit-cube",
  api: "Cesium3DTileset.fromUrl",
  compression: "spz",
  url: "Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/tileset.json",
  resourcePrefix:
    "Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/",
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function quantile(values, fraction) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper
    ? sorted[lower]
    : sorted[lower] +
        (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(values) {
  if (values.length === 0) {
    return { count: 0, median: null, p95: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
  };
}

function parseArgs(argv) {
  const options = {
    states: [
      "cold",
      "worker-probe-preloaded",
      "asset-cache-warmed",
      "prewarmed",
    ],
    iterations: defaultIterations,
    targetWindowMs: defaultTargetWindowMs,
    maximumScreenSpaceError: 8,
    closeRangeFactor: 0.25,
    readyTimeoutMs: defaultReadyTimeoutMs,
    port: defaultPort,
    output: path.join(
      repositoryRoot,
      "Build",
      "Performance",
      "Decompression",
      "ion-spz-preload-4547222.json",
    ),
  };

  function valueFor(argument, index) {
    const equalsIndex = argument.indexOf("=");
    if (equalsIndex !== -1) {
      return argument.slice(equalsIndex + 1);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    return value;
  }

  for (let index = 0; index < argv.length; ++index) {
    const argument = argv[index];
    if (argument.startsWith("--state")) {
      options.states = valueFor(argument, index).split(",").filter(Boolean);
    } else if (argument.startsWith("--iterations")) {
      options.iterations = Number(valueFor(argument, index));
    } else if (argument.startsWith("--target-window-ms")) {
      options.targetWindowMs = Number(valueFor(argument, index));
    } else if (argument.startsWith("--maximum-screen-space-error")) {
      options.maximumScreenSpaceError = Number(valueFor(argument, index));
    } else if (argument.startsWith("--close-range-factor")) {
      options.closeRangeFactor = Number(valueFor(argument, index));
    } else if (argument.startsWith("--ready-timeout-ms")) {
      options.readyTimeoutMs = Number(valueFor(argument, index));
    } else if (argument.startsWith("--port")) {
      options.port = Number(valueFor(argument, index));
    } else if (argument.startsWith("--output")) {
      options.output = valueFor(argument, index);
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
    if (!argument.includes("=")) {
      ++index;
    }
  }

  const allowedStates = new Set([
    "cold",
    "worker-probe-preloaded",
    "asset-cache-warmed",
    "prewarmed",
  ]);
  assert(
    options.states.length > 0 && options.states.every((state) => allowedStates.has(state)),
    "--state contains an unsupported preload state",
  );
  assert(
    Number.isSafeInteger(options.iterations) && options.iterations > 0,
    "--iterations must be a positive integer",
  );
  for (const [name, value] of [
    ["--target-window-ms", options.targetWindowMs],
    ["--maximum-screen-space-error", options.maximumScreenSpaceError],
    ["--close-range-factor", options.closeRangeFactor],
    ["--ready-timeout-ms", options.readyTimeoutMs],
    ["--port", options.port],
  ]) {
    assert(Number.isFinite(value) && value > 0, `${name} must be positive`);
  }
  return options;
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}${benchmarkPage}`)).ok) {
        return;
      }
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function runState(page, state, options) {
  const response = await page.evaluate(
    async ({
      state: browserState,
      assetId: browserAssetId,
      targetWindowMs,
      maximumScreenSpaceError,
      closeRangeFactor,
    }) => {
      const Cesium = globalThis.Cesium;
      const prewarmFixture = {
        id: "prewarm-spz-sh-unit-cube",
        api: "Cesium3DTileset.fromUrl",
        compression: "spz",
        url: "Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/tileset.json",
        resourcePrefix:
          "Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/",
      };
      const taskEvents = [];
      const tileLoads = [];
      const tileVisibles = [];
      const longTasks = [];
      const frameGaps = [];
      const memorySamples = [];
      const oldBenchmarkTiming = Cesium.TaskProcessor._benchmarkTiming;
      const preloadStarted = performance.now();
      const taskCallback = (event) => {
        if (event.workerPath?.includes("decodeSpz")) {
          taskEvents.push({
            phase: event.phase,
            timestampMs: event.timestampMs,
            processorId: event.processorId,
            workerId: event.workerId,
            taskId: event.taskId,
            workerTiming: event.workerTiming ?? null,
          });
        }
      };

      function stripToken(url) {
        const result = new URL(url);
        result.searchParams.delete("access_token");
        return `${result.pathname}${result.search}`;
      }

      async function preload() {
        if (browserState === "worker-probe-preloaded") {
          const canTransfer =
            await Cesium.SpzDecoder._preloadWorkerForBenchmark();
          return {
            kind: browserState,
            canTransfer,
            decoderTaskPosted: false,
          };
        }
        if (browserState === "asset-cache-warmed") {
          const resource = await Cesium.IonResource.fromAssetId(browserAssetId);
          await resource.fetchJson();
          await resource
            .getDerivedResource({ url: "tile_0.glb" })
            .fetchArrayBuffer();
          return {
            kind: browserState,
            rootAndRepresentativeTileFetched: true,
            decoderTaskPosted: false,
          };
        }
        if (browserState === "prewarmed") {
          const result = await globalThis.runCesiumDecompressionScenario(
            {
              ...prewarmFixture,
            },
          );
          return {
            kind: browserState,
            fixture: prewarmFixture.id,
            fixturePublicReadyMs: result.timing.milestonesMs.publicReady,
            decoderTaskPosted: true,
          };
        }
        return {
          kind: "cold",
          decoderTaskPosted: false,
        };
      }

      const preloadResult = await preload();
      const preloadReadyMs = performance.now() - preloadStarted;
      const targetStarted = performance.now();
      Cesium.TaskProcessor._benchmarkTiming = taskCallback;

      const longTaskObserver =
        typeof PerformanceObserver === "function"
          ? new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                longTasks.push({
                  startMs: entry.startTime - targetStarted,
                  durationMs: entry.duration,
                });
              }
            })
          : undefined;
      try {
        longTaskObserver?.observe({ type: "longtask", buffered: true });
      } catch {
        // Long-task timing is optional.
      }

      let memorySamplingActive =
        typeof performance.measureUserAgentSpecificMemory === "function";
      const memoryPromise = (async () => {
        while (memorySamplingActive) {
          try {
            const measurement =
              await performance.measureUserAgentSpecificMemory();
            memorySamples.push({
              atMs: performance.now() - targetStarted,
              bytes: measurement.bytes ?? null,
            });
          } catch {
            memorySamplingActive = false;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      })();

      let frameActive = true;
      let previousFrame = performance.now();
      const frameLoop = (timestamp) => {
        frameGaps.push(timestamp - previousFrame);
        previousFrame = timestamp;
        if (frameActive) {
          requestAnimationFrame(frameLoop);
        }
      };
      requestAnimationFrame(frameLoop);

      const widget = new Cesium.CesiumWidget(
        document.getElementById("cesiumContainer"),
        {
          baseLayer: false,
          globe: false,
          skyAtmosphere: false,
          skyBox: false,
          useDefaultRenderLoop: false,
          requestRenderMode: false,
          showRenderLoopErrors: false,
        },
      );
      let firstTileLoadMs = null;
      let firstTileVisibleMs = null;
      let tileset;
      let tileFailure;
      try {
        tileset = await Cesium.Cesium3DTileset.fromIonAssetId(
          browserAssetId,
          {
            cullRequestsWhileMoving: false,
            maximumScreenSpaceError,
            skipLevelOfDetail: false,
            immediatelyLoadDesiredLevelOfDetail: true,
            loadSiblings: true,
          },
        );
        const apiResolvedMs = performance.now() - targetStarted;
        tileset.tileLoad.addEventListener(() => {
          const atMs = performance.now() - targetStarted;
          firstTileLoadMs ??= atMs;
          tileLoads.push(atMs);
        });
        tileset.tileVisible.addEventListener(() => {
          const atMs = performance.now() - targetStarted;
          firstTileVisibleMs ??= atMs;
          tileVisibles.push(atMs);
        });
        tileset.tileFailed.addEventListener((error) => {
          tileFailure = {
            message: error.message,
            url: error.url,
          };
        });
        widget.scene.primitives.add(tileset);
        widget.camera.viewBoundingSphere(
          tileset.boundingSphere,
          new Cesium.HeadingPitchRange(
            0,
            -0.5,
            Math.max(tileset.boundingSphere.radius * closeRangeFactor, 1),
          ),
        );
        widget.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

        const deadline = performance.now() + targetWindowMs;
        while (performance.now() < deadline) {
          widget.render();
          if (tileFailure) {
            throw new Error(`Tile failed: ${tileFailure.message}`);
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }

        frameActive = false;
        memorySamplingActive = false;
        await memoryPromise;

        const taskMap = new Map();
        for (const event of taskEvents) {
          if (event.taskId === undefined) {
            continue;
          }
          const key = `${event.processorId}:${event.taskId}`;
          const record = taskMap.get(key) ?? {
            taskId: event.taskId,
            scheduledMs: null,
            resultMs: null,
            workerTaskStartedMs: null,
            workerTaskEndedMs: null,
          };
          if (event.phase === "taskScheduled") {
            record.scheduledMs = event.timestampMs - targetStarted;
          } else if (event.phase === "resultReceived") {
            record.resultMs = event.timestampMs - targetStarted;
            const timing = event.workerTiming;
            if (timing) {
              record.workerTaskStartedMs =
                timing.workerTimeOriginMs +
                timing.workerTaskStartedMs -
                performance.timeOrigin -
                targetStarted;
              record.workerTaskEndedMs =
                timing.workerTimeOriginMs +
                timing.workerTaskEndedMs -
                performance.timeOrigin -
                targetStarted;
            }
          }
          taskMap.set(key, record);
        }
        const tasks = [...taskMap.values()].map((record) => ({
          ...record,
          queueWaitMs:
            record.scheduledMs !== null &&
            record.workerTaskStartedMs !== null
              ? record.workerTaskStartedMs - record.scheduledMs
              : null,
          decodeMs:
            record.workerTaskStartedMs !== null &&
            record.workerTaskEndedMs !== null
              ? record.workerTaskEndedMs - record.workerTaskStartedMs
              : null,
        }));
        const validMemory = memorySamples.filter(
          (sample) => typeof sample.bytes === "number",
        );
        const stats = tileset.statistics;
        return {
          ok: true,
          state: browserState,
          preload: {
            ...preloadResult,
            durationMs: preloadReadyMs,
          },
          target: {
            apiResolvedMs,
            firstTileLoadMs,
            firstTileVisibleMs,
            windowMs: performance.now() - targetStarted,
          },
          taskCount: tasks.length,
          completedTaskCount: tasks.filter(
            (task) => task.resultMs !== null,
          ).length,
          tasks,
          tileLoadCount: tileLoads.length,
          tileVisibleCount: tileVisibles.length,
          stats: {
            numberOfTilesWithContentReady:
              stats.numberOfTilesWithContentReady,
            numberOfLoadedTilesTotal: stats.numberOfLoadedTilesTotal,
            numberOfTilesTotal: stats.numberOfTilesTotal,
          },
          longTasks,
          frameGaps,
          memory: {
            supported:
              typeof performance.measureUserAgentSpecificMemory ===
              "function",
            peakBytes:
              validMemory.length > 0
                ? Math.max(...validMemory.map((sample) => sample.bytes))
                : null,
          },
          resources: performance
            .getEntriesByType("resource")
            .filter((entry) => entry.name.includes("assets.ion.cesium.com"))
            .map((entry) => ({
              url: stripToken(entry.name),
              startTime: entry.startTime - targetStarted,
              responseEnd: entry.responseEnd - targetStarted,
              transferSize: entry.transferSize,
              encodedBodySize: entry.encodedBodySize,
              decodedBodySize: entry.decodedBodySize,
            })),
        };
      } finally {
        frameActive = false;
        memorySamplingActive = false;
        await memoryPromise;
        longTaskObserver?.disconnect();
        Cesium.TaskProcessor._benchmarkTiming = oldBenchmarkTiming;
        widget.destroy();
      }
    },
    {
      state,
      assetId,
      targetWindowMs: options.targetWindowMs,
      maximumScreenSpaceError: options.maximumScreenSpaceError,
      closeRangeFactor: options.closeRangeFactor,
    },
  );
  assert(response.ok, response.error?.message ?? "SPZ preload sample failed");
  return response;
}

function summarizeRuns(runs) {
  return Object.fromEntries(
    [...new Set(runs.map((run) => run.state))].map((state) => {
      const stateRuns = runs.filter((run) => run.state === state && run.ok);
      return [
        state,
        {
          sampleCount: stateRuns.length,
          preloadMs: summarize(
            stateRuns.map((run) => run.preload.durationMs),
          ),
          apiResolvedMs: summarize(
            stateRuns.map((run) => run.target.apiResolvedMs),
          ),
          firstTileLoadMs: summarize(
            stateRuns
              .map((run) => run.target.firstTileLoadMs)
              .filter((value) => value !== null),
          ),
          firstTileVisibleMs: summarize(
            stateRuns
              .map((run) => run.target.firstTileVisibleMs)
              .filter((value) => value !== null),
          ),
          taskCount: summarize(stateRuns.map((run) => run.taskCount)),
          completedTaskCount: summarize(
            stateRuns.map((run) => run.completedTaskCount),
          ),
          longTaskCount: summarize(
            stateRuns.map((run) => run.longTasks.length),
          ),
          maxFrameGapMs: summarize(
            stateRuns
              .map((run) =>
                run.frameGaps.length > 0 ? Math.max(...run.frameGaps) : null,
              )
              .filter((value) => value !== null),
          ),
          peakMemoryBytes: summarize(
            stateRuns
              .map((run) => run.memory.peakBytes)
              .filter((value) => value !== null),
          ),
        },
      ];
    }),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = spawn(
    process.execPath,
    [
      path.join(repositoryRoot, "Tools/benchmark/decompression/static-server.mjs"),
      "--root",
      repositoryRoot,
      "--port",
      String(options.port),
    ],
    { stdio: "ignore" },
  );
  const baseUrl = `http://localhost:${options.port}`;
  const runs = [];
  try {
    await waitForServer(baseUrl);
    for (const state of options.states) {
      for (let sampleIndex = 0; sampleIndex < options.iterations; ++sampleIndex) {
        const browser = await chromium.launch({ headless: true });
        try {
          const context = await browser.newContext({
            viewport,
            deviceScaleFactor: 1,
          });
          const page = await context.newPage();
          const pageUrl = new URL(benchmarkPage, baseUrl);
          pageUrl.searchParams.set("taskProcessorTiming", "enabled");
          await page.goto(pageUrl.toString(), {
            waitUntil: "load",
            timeout: options.readyTimeoutMs,
          });
          await page.waitForFunction(
            () => globalThis.decompressionBenchmarkReady === true,
            undefined,
            { timeout: options.readyTimeoutMs },
          );
          runs.push({
            sampleIndex,
            ...(await runState(page, state, options)),
          });
          await context.close();
        } finally {
          await browser.close();
        }
        console.error(
          `${state} sample ${sampleIndex + 1}/${options.iterations} complete`,
        );
      }
    }
  } finally {
    if (server.pid) {
      process.kill(server.pid, "SIGTERM");
    }
  }

  const output = {
    schemaVersion: 1,
    status: runs.every((run) => run.ok) ? "ok" : "failed",
    generatedAt: new Date().toISOString(),
    assetId,
    plan: options,
    summary: summarizeRuns(runs),
    runs,
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${options.output}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  process.exitCode = 1;
});
