#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const defaultRepositoryRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../..",
);
const benchmarkPage = "/Tools/benchmark/decompression/benchmark.html";
const viewport = { width: 1280, height: 720 };
const assetId = 4547222;
const defaultPort = 8124;
const defaultIterations = 3;
const defaultCloseWindowMs = 30000;
const defaultFarSettleMs = 5000;
const defaultReadyTimeoutMs = 120000;

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
  if (lower === upper) {
    return sorted[lower];
  }
  return (
    sorted[lower] +
    (sorted[upper] - sorted[lower]) * (position - lower)
  );
}

function summarize(values) {
  if (values.length === 0) {
    return { count: 0, median: null, p95: null, min: null, max: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function parseArgs(argv) {
  const options = {
    iterations: defaultIterations,
    routes: ["close", "far-to-close"],
    closeWindowMs: defaultCloseWindowMs,
    farSettleMs: defaultFarSettleMs,
    maximumScreenSpaceError: 4,
    closeRangeFactor: 0.25,
    farRangeFactor: 8,
    readyTimeoutMs: defaultReadyTimeoutMs,
    port: defaultPort,
    root: defaultRepositoryRoot,
    output: undefined,
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
    if (argument.startsWith("--iterations")) {
      options.iterations = Number(valueFor(argument, index));
    } else if (argument.startsWith("--routes")) {
      options.routes = valueFor(argument, index)
        .split(",")
        .filter(Boolean);
    } else if (argument.startsWith("--close-window-ms")) {
      options.closeWindowMs = Number(valueFor(argument, index));
    } else if (argument.startsWith("--far-settle-ms")) {
      options.farSettleMs = Number(valueFor(argument, index));
    } else if (argument.startsWith("--maximum-screen-space-error")) {
      options.maximumScreenSpaceError = Number(valueFor(argument, index));
    } else if (argument.startsWith("--close-range-factor")) {
      options.closeRangeFactor = Number(valueFor(argument, index));
    } else if (argument.startsWith("--far-range-factor")) {
      options.farRangeFactor = Number(valueFor(argument, index));
    } else if (argument.startsWith("--ready-timeout-ms")) {
      options.readyTimeoutMs = Number(valueFor(argument, index));
    } else if (argument.startsWith("--port")) {
      options.port = Number(valueFor(argument, index));
    } else if (argument.startsWith("--root")) {
      options.root = path.resolve(valueFor(argument, index));
    } else if (argument.startsWith("--output")) {
      options.output = valueFor(argument, index);
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
    if (!argument.includes("=")) {
      ++index;
    }
  }

  assert(
    Number.isSafeInteger(options.iterations) && options.iterations > 0,
    "--iterations must be a positive integer",
  );
  assert(
    options.routes.length > 0 &&
      options.routes.every((route) => route === "close" || route === "far-to-close"),
    "--routes must contain close and/or far-to-close",
  );
  for (const [name, value] of [
    ["--close-window-ms", options.closeWindowMs],
    ["--far-settle-ms", options.farSettleMs],
    ["--maximum-screen-space-error", options.maximumScreenSpaceError],
    ["--close-range-factor", options.closeRangeFactor],
    ["--far-range-factor", options.farRangeFactor],
    ["--ready-timeout-ms", options.readyTimeoutMs],
    ["--port", options.port],
  ]) {
    assert(Number.isFinite(value) && value > 0, `${name} must be positive`);
  }
  if (options.output === undefined) {
    options.output = path.join(
      options.root,
      "Build",
      "Performance",
      "Decompression",
      "ion-spz-concurrency-4547222.json",
    );
  }
  return options;
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}${benchmarkPage}`);
      if (response.ok) {
        return;
      }
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function runSample(page, route, options) {
  const response = await page.evaluate(
    async ({
      assetId: browserAssetId,
      route: browserRoute,
      closeWindowMs,
      farSettleMs,
      maximumScreenSpaceError,
      closeRangeFactor,
      farRangeFactor,
    }) => {
      const Cesium = globalThis.Cesium;
      const taskEvents = [];
      const tileEvents = {
        loaded: [],
        visible: [],
      };
      const loadProgress = [];
      const longTasks = [];
      const frameGaps = [];
      const memorySamples = [];
      const oldBenchmarkTiming = Cesium.TaskProcessor._benchmarkTiming;
      const routeStarted = performance.now();
      const taskCallback = (event) => {
        if (event.workerPath?.includes("decodeSpz")) {
          taskEvents.push({
            phase: event.phase,
            timestampMs: event.timestampMs - routeStarted,
            processorId: event.processorId,
            workerId: event.workerId,
            taskId: event.taskId,
            workerTiming: event.workerTiming ?? null,
            benchmarkMetadata: event.benchmarkMetadata ?? null,
          });
        }
      };
      Cesium.TaskProcessor._benchmarkTiming = taskCallback;

      const longTaskObserver =
        typeof PerformanceObserver === "function"
          ? new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                longTasks.push({
                  startMs: entry.startTime - routeStarted,
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
              atMs: performance.now() - routeStarted,
              bytes: measurement.bytes ?? null,
              breakdown: measurement.breakdown ?? null,
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

      function cameraAtFactor(tileset, factor) {
        const radius = tileset.boundingSphere.radius;
        widget.camera.viewBoundingSphere(
          tileset.boundingSphere,
          new Cesium.HeadingPitchRange(
            0.0,
            -0.5,
            Math.max(radius * factor, 1.0),
          ),
        );
        widget.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      }

      function statsSnapshot(tileset) {
        const stats = tileset.statistics;
        return {
          numberOfPendingRequests: stats.numberOfPendingRequests,
          numberOfTilesProcessing: stats.numberOfTilesProcessing,
          numberOfTilesWithContentReady: stats.numberOfTilesWithContentReady,
          numberOfTilesTotal: stats.numberOfTilesTotal,
          numberOfLoadedTilesTotal: stats.numberOfLoadedTilesTotal,
          geometryByteLength: stats.geometryByteLength,
          texturesByteLength: stats.texturesByteLength,
        };
      }

      function taskRecords() {
        const records = new Map();
        for (const event of taskEvents) {
          if (event.taskId === undefined) {
            continue;
          }
          const key = `${event.processorId}:${event.taskId}`;
          const record = records.get(key) ?? {
            processorId: event.processorId,
            workerId: event.workerId,
            taskId: event.taskId,
            scheduledMs: null,
            resultMs: null,
            workerModuleReadyMs: null,
            workerTaskStartedMs: null,
            workerTaskEndedMs: null,
            spzLoadResolvedMs: null,
            benchmarkMetadata: null,
          };
          record.benchmarkMetadata ??= event.benchmarkMetadata;
          if (event.phase === "taskScheduled") {
            record.scheduledMs = event.timestampMs;
          } else if (event.phase === "resultReceived") {
            record.resultMs = event.timestampMs;
            const timing = event.workerTiming;
            if (timing) {
              record.workerModuleReadyMs =
                timing.workerTimeOriginMs +
                timing.workerModuleReadyMs -
                performance.timeOrigin -
                routeStarted;
              record.workerTaskStartedMs =
                timing.workerTimeOriginMs +
                timing.workerTaskStartedMs -
                performance.timeOrigin -
                routeStarted;
              record.workerTaskEndedMs =
                timing.workerTimeOriginMs +
                timing.workerTaskEndedMs -
                performance.timeOrigin -
                routeStarted;
              record.spzLoadResolvedMs =
                timing.spzLoadResolvedMs === undefined
                  ? null
                  : timing.workerTimeOriginMs +
                    timing.spzLoadResolvedMs -
                    performance.timeOrigin -
                    routeStarted;
            }
          }
          records.set(key, record);
        }
        return [...records.values()].map((record) => ({
          ...record,
          contentIdentity: taskContentIdentity(record.benchmarkMetadata),
          queueWaitMs:
            record.scheduledMs !== null && record.workerTaskStartedMs !== null
              ? record.workerTaskStartedMs - record.scheduledMs
              : null,
          decodeMs:
            record.workerTaskStartedMs !== null &&
            record.workerTaskEndedMs !== null
              ? record.workerTaskEndedMs - record.workerTaskStartedMs
              : null,
          workerHandlerToSpzLoadMs:
            record.workerTaskStartedMs !== null &&
            record.spzLoadResolvedMs !== null
              ? record.spzLoadResolvedMs - record.workerTaskStartedMs
              : null,
          spzLoadToResultMs:
            record.resultMs !== null && record.spzLoadResolvedMs !== null
              ? record.resultMs - record.spzLoadResolvedMs
              : null,
        }));
      }

      function taskContentIdentity(metadata) {
        if (metadata === null || metadata === undefined) {
          return null;
        }
        let sourceUrl = metadata.sourceUrl;
        if (typeof sourceUrl === "string") {
          const url = new URL(sourceUrl);
          url.searchParams.delete("access_token");
          sourceUrl = `${url.origin}${url.pathname}${url.search}`;
        }
        return {
          sourceUrl,
          bufferViewId: metadata.bufferViewId ?? null,
          primitivePositionAccessorId:
            metadata.primitivePositionAccessorId ?? null,
        };
      }

      function segmentSummary(records, startMs, endMs) {
        const tasks = records.filter(
          (record) =>
            record.scheduledMs !== null &&
            record.scheduledMs >= startMs &&
            record.scheduledMs <= endMs,
        );
        const intervals = tasks
          .filter(
            (record) =>
              record.workerTaskStartedMs !== null &&
              record.workerTaskEndedMs !== null,
          )
          .flatMap((record) => [
            [record.workerTaskStartedMs, 1],
            [record.workerTaskEndedMs, -1],
          ])
          .sort((left, right) => left[0] - right[0] || right[1] - left[1]);
        const outstandingIntervals = tasks
          .filter(
            (record) =>
              record.scheduledMs !== null && record.resultMs !== null,
          )
          .flatMap((record) => [
            [record.scheduledMs, 1],
            [record.resultMs, -1],
          ])
          .sort((left, right) => left[0] - right[0] || right[1] - left[1]);
        let active = 0;
        let maximumOverlappingWorkerTasks = 0;
        for (const [, delta] of intervals) {
          active += delta;
          maximumOverlappingWorkerTasks = Math.max(
            maximumOverlappingWorkerTasks,
            active,
          );
        }
        active = 0;
        let maximumOutstandingTasks = 0;
        for (const [, delta] of outstandingIntervals) {
          active += delta;
          maximumOutstandingTasks = Math.max(
            maximumOutstandingTasks,
            active,
          );
        }
        const loads = tileEvents.loaded.filter(
          (event) => event.atMs >= startMs && event.atMs <= endMs,
        );
        const visibles = tileEvents.visible.filter(
          (event) => event.atMs >= startMs && event.atMs <= endMs,
        );
        return {
          startMs,
          endMs,
          taskCount: tasks.length,
          completedTaskCount: tasks.filter(
            (record) => record.resultMs !== null,
          ).length,
          maximumOutstandingTasks,
          maximumOverlappingWorkerTasks,
          queueWaitMs: tasks
            .map((record) => record.queueWaitMs)
            .filter((value) => value !== null),
          decodeMs: tasks
            .map((record) => record.decodeMs)
            .filter((value) => value !== null),
          firstTaskResultMs:
            tasks
              .map((record) => record.resultMs)
              .filter((value) => value !== null)
              .sort((left, right) => left - right)[0] ?? null,
          tileLoadCount: loads.length,
          tileVisibleCount: visibles.length,
          firstTileLoadMs: loads[0]?.atMs ?? null,
          firstTileVisibleMs: visibles[0]?.atMs ?? null,
        };
      }

      function resourceTimings() {
        return performance
          .getEntriesByType("resource")
          .filter((entry) => entry.name.includes("assets.ion.cesium.com"))
          .map((entry) => {
            const url = new URL(entry.name);
            url.searchParams.delete("access_token");
            return {
              url: `${url.pathname}${url.search}`,
              startTime: entry.startTime - routeStarted,
              responseEnd: entry.responseEnd - routeStarted,
              transferSize: entry.transferSize,
              encodedBodySize: entry.encodedBodySize,
              decodedBodySize: entry.decodedBodySize,
            };
          });
      }

      let tileset;
      let tileFailure;
      let jumpAtMs = null;
      let farEndMs = null;
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
        tileset.tileLoad.addEventListener(() => {
          tileEvents.loaded.push({ atMs: performance.now() - routeStarted });
        });
        tileset.tileVisible.addEventListener(() => {
          tileEvents.visible.push({ atMs: performance.now() - routeStarted });
        });
        tileset.loadProgress.addEventListener((pending, processing) => {
          loadProgress.push({
            atMs: performance.now() - routeStarted,
            pending,
            processing,
          });
        });
        tileset.tileFailed.addEventListener((error) => {
          tileFailure = {
            message: error.message,
            url: error.url,
          };
        });
        widget.scene.primitives.add(tileset);

        const apiResolvedMs = performance.now() - routeStarted;
        const farStartMs = apiResolvedMs;
        if (browserRoute === "far-to-close") {
          cameraAtFactor(tileset, farRangeFactor);
          const farDeadline = performance.now() + farSettleMs;
          while (performance.now() < farDeadline) {
            widget.render();
            if (tileFailure) {
              throw new Error(`Tile failed: ${tileFailure.message}`);
            }
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          farEndMs = performance.now() - routeStarted;
          jumpAtMs = farEndMs;
          cameraAtFactor(tileset, closeRangeFactor);
        } else {
          cameraAtFactor(tileset, closeRangeFactor);
        }

        const targetEnd = performance.now() + closeWindowMs;
        while (performance.now() < targetEnd) {
          widget.render();
          if (tileFailure) {
            throw new Error(`Tile failed: ${tileFailure.message}`);
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }

        const finishedMs = performance.now() - routeStarted;
        frameActive = false;
        memorySamplingActive = false;
        await memoryPromise;
        const records = taskRecords();
        const segments =
          browserRoute === "far-to-close"
            ? {
                far: segmentSummary(records, farStartMs, farEndMs),
                close: segmentSummary(records, jumpAtMs, finishedMs),
              }
            : {
                close: segmentSummary(records, apiResolvedMs, finishedMs),
              };
        const validMemory = memorySamples.filter(
          (sample) => typeof sample.bytes === "number",
        );
        return {
          ok: true,
          route: browserRoute,
          assetId: browserAssetId,
          timing: {
            apiResolvedMs,
            farEndMs,
            jumpAtMs,
            finishedMs,
            durationMs: finishedMs,
          },
          routeParameters: {
            maximumScreenSpaceError,
            closeRangeFactor,
            farRangeFactor,
            closeWindowMs,
            farSettleMs,
          },
          readiness: {
            tilesLoaded: tileset.tilesLoaded,
            rootContentReady: tileset.root?.contentReady ?? false,
          },
          stats: statsSnapshot(tileset),
          segments,
          tasks: records,
          taskIdentityCount: new Set(
            records
              .map((record) => record.contentIdentity)
              .filter((identity) => identity !== null)
              .map((identity) => JSON.stringify(identity)),
          ).size,
          loadProgress: loadProgress.slice(-200),
          longTasks,
          frameGaps,
          memory: {
            supported:
              typeof performance.measureUserAgentSpecificMemory ===
              "function",
            sampleCount: memorySamples.length,
            peakBytes:
              validMemory.length > 0
                ? Math.max(...validMemory.map((sample) => sample.bytes))
                : null,
            samples: memorySamples,
          },
          resourceTimings: resourceTimings(),
        };
      } catch (error) {
        frameActive = false;
        memorySamplingActive = false;
        await memoryPromise;
        return {
          ok: false,
          route: browserRoute,
          error: {
            name: error?.name,
            message: error?.message ?? String(error),
            stack: error?.stack,
          },
          tasks: taskRecords(),
          longTasks,
          frameGaps,
          memory: {
            supported:
              typeof performance.measureUserAgentSpecificMemory ===
              "function",
            sampleCount: memorySamples.length,
            samples: memorySamples,
          },
          resourceTimings: resourceTimings(),
        };
      } finally {
        longTaskObserver?.disconnect();
        Cesium.TaskProcessor._benchmarkTiming = oldBenchmarkTiming;
        widget.destroy();
      }
    },
    {
      assetId,
      route,
      closeWindowMs: options.closeWindowMs,
      farSettleMs: options.farSettleMs,
      maximumScreenSpaceError: options.maximumScreenSpaceError,
      closeRangeFactor: options.closeRangeFactor,
      farRangeFactor: options.farRangeFactor,
      readyTimeoutMs: options.readyTimeoutMs,
    },
  );

  assert(response.ok, response.error?.message ?? "SPZ route failed");
  return response;
}

function summarizeRuns(runs) {
  const byRoute = {};
  for (const route of ["close", "far-to-close"]) {
    const routeRuns = runs.filter((run) => run.route === route && run.ok);
    const segmentNames = route === "close" ? ["close"] : ["far", "close"];
    byRoute[route] = {
      sampleCount: routeRuns.length,
      durationMs: summarize(
        routeRuns.map((run) => run.timing.durationMs),
      ),
      segments: Object.fromEntries(
        segmentNames.map((segmentName) => {
          const segments = routeRuns
            .map((run) => run.segments[segmentName])
            .filter(Boolean);
          return [
            segmentName,
            {
              taskCount: summarize(
                segments.map((segment) => segment.taskCount),
              ),
              maximumOverlappingWorkerTasks: summarize(
                segments.map(
                  (segment) => segment.maximumOverlappingWorkerTasks,
                ),
              ),
              maximumOutstandingTasks: summarize(
                segments.map((segment) => segment.maximumOutstandingTasks),
              ),
              queueWaitMs: summarize(
                segments.flatMap((segment) => segment.queueWaitMs),
              ),
              decodeMs: summarize(segments.flatMap((segment) => segment.decodeMs)),
              tileLoadCount: summarize(
                segments.map((segment) => segment.tileLoadCount),
              ),
              tileVisibleCount: summarize(
                segments.map((segment) => segment.tileVisibleCount),
              ),
              firstTileLoadMs: summarize(
                segments
                  .map((segment) => segment.firstTileLoadMs)
                  .filter((value) => value !== null),
              ),
              firstTileVisibleMs: summarize(
                segments
                  .map((segment) => segment.firstTileVisibleMs)
                  .filter((value) => value !== null),
              ),
            },
          ];
        }),
      ),
      longTaskCount: summarize(
        routeRuns.map((run) => run.longTasks.length),
      ),
      maxFrameGapMs: summarize(
        routeRuns
          .map((run) =>
            run.frameGaps.length > 0 ? Math.max(...run.frameGaps) : null,
          )
          .filter((value) => value !== null),
      ),
      peakMemoryBytes: summarize(
        routeRuns
          .map((run) => run.memory.peakBytes)
          .filter((value) => value !== null),
      ),
    };
  }
  return byRoute;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = spawn(
    process.execPath,
    [
      path.join(
        defaultRepositoryRoot,
        "Tools/benchmark/decompression/static-server.mjs",
      ),
      "--root",
      options.root,
      "--port",
      String(options.port),
    ],
    { stdio: "ignore" },
  );
  const baseUrl = `http://localhost:${options.port}`;
  const runs = [];
  try {
    await waitForServer(baseUrl);
    for (const route of options.routes) {
      for (let sampleIndex = 0; sampleIndex < options.iterations; ++sampleIndex) {
        const browser = await chromium.launch({ headless: true });
        try {
          const context = await browser.newContext({
            viewport,
            deviceScaleFactor: 1,
          });
          const page = await context.newPage();
          const pageUrl = new URL(benchmarkPage, baseUrl);
          pageUrl.searchParams.set(
            "taskProcessorTiming",
            "enabled",
          );
          pageUrl.searchParams.set(
            "readyTimeoutMs",
            String(options.readyTimeoutMs),
          );
          await page.goto(pageUrl.toString(), {
            waitUntil: "load",
            timeout: options.readyTimeoutMs,
          });
          await page.waitForFunction(
            () => globalThis.decompressionBenchmarkReady === true,
            undefined,
            { timeout: options.readyTimeoutMs },
          );
          const result = await runSample(page, route, options);
          runs.push({ sampleIndex, ...result });
          await context.close();
        } finally {
          await browser.close();
        }
        console.error(
          `${route} sample ${sampleIndex + 1}/${options.iterations} complete`,
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
