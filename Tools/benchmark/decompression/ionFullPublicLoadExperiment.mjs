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
const expectedContentTiles = 3410;
const expectedTileNodes = 3499;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseArgs(argv) {
  const options = {
    timeoutMs: 600000,
    maximumScreenSpaceError: 0.5,
    port: 8135,
    output: path.join(
      "/Users/benpolinsky/.copilot/session-state/27128a2d-3741-420e-9184-b996f03451ab/files",
      "ion-4547222-full-public-load.json",
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
    if (argument.startsWith("--timeout-ms")) {
      options.timeoutMs = Number(valueFor(argument, index));
    } else if (argument.startsWith("--maximum-screen-space-error")) {
      options.maximumScreenSpaceError = Number(valueFor(argument, index));
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

  assert(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0);
  assert(
    Number.isFinite(options.maximumScreenSpaceError) &&
      options.maximumScreenSpaceError >= 0,
  );
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
  let result;
  try {
    await waitForServer(baseUrl);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
      });
      const responseRecords = [];
      context.on("response", (response) => {
        if (!response.url().includes("assets.ion.cesium.com")) {
          return;
        }
        const url = new URL(response.url());
        url.searchParams.delete("access_token");
        responseRecords.push({
          url: `${url.pathname}${url.search}`,
          status: response.status(),
          contentLength: Number(response.headers()["content-length"]) || null,
        });
      });
      const page = await context.newPage();
      const pageUrl = new URL(benchmarkPage, baseUrl);
      pageUrl.searchParams.set("taskProcessorTiming", "enabled");
      pageUrl.searchParams.set("readyTimeoutMs", String(options.timeoutMs));
      pageUrl.searchParams.set("arrayBufferMemorySampleIntervalMs", "100");
      await page.goto(pageUrl.toString(), {
        waitUntil: "load",
        timeout: 120000,
      });
      await page.waitForFunction(
        () => globalThis.decompressionBenchmarkReady === true,
        undefined,
        { timeout: 120000 },
      );

      result = await page.evaluate(
        async ({
          browserAssetId,
          timeoutMs,
          maximumScreenSpaceError,
          expectedContent,
          expectedNodes,
        }) => {
          const Cesium = globalThis.Cesium;
          const taskEvents = [];
          const tileLoadEvents = [];
          const progress = [];
          const longTasks = [];
          const frameGaps = [];
          const oldBenchmarkTiming = Cesium.TaskProcessor._benchmarkTiming;
          const started = performance.now();
          Cesium.TaskProcessor._benchmarkTiming = (event) => {
            if (event.workerPath?.includes("decodeSpz")) {
              taskEvents.push({
                phase: event.phase,
                timestampMs: event.timestampMs - started,
                processorId: event.processorId,
                workerId: event.workerId,
                taskId: event.taskId,
                workerTiming: event.workerTiming ?? null,
              });
            }
          };

          const longTaskObserver =
            typeof PerformanceObserver === "function"
              ? new PerformanceObserver((list) => {
                  for (const entry of list.getEntries()) {
                    longTasks.push({
                      startMs: entry.startTime - started,
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

          let previousFrame = performance.now();
          let frameActive = true;
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
            const apiResolvedMs = performance.now() - started;
            tileset.tileLoad.addEventListener((tile) => {
              tileLoadEvents.push({
                atMs: performance.now() - started,
                contentReady: tile.contentReady,
              });
            });
            tileset.loadProgress.addEventListener((pending, processing) => {
              progress.push({
                atMs: performance.now() - started,
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
            widget.camera.viewBoundingSphere(
              tileset.boundingSphere,
              new Cesium.HeadingPitchRange(
                0,
                -0.5,
                Math.max(tileset.boundingSphere.radius * 1.5, 1),
              ),
            );
            widget.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

            let completionReason = "timeout";
            const deadline = performance.now() + timeoutMs;
            while (performance.now() < deadline) {
              widget.render();
              if (tileFailure) {
                throw new Error(`Tile failed: ${tileFailure.message}`);
              }
              const stats = tileset.statistics;
              if (
                stats.numberOfLoadedTilesTotal >= expectedContent &&
                stats.numberOfTilesTotal >= expectedNodes &&
                tileset.tilesLoaded
              ) {
                completionReason = "all-expected-content-loaded";
                break;
              }
              await new Promise((resolve) => requestAnimationFrame(resolve));
            }

            const tasks = new Map();
            for (const event of taskEvents) {
              if (event.taskId === undefined) {
                continue;
              }
              const key = `${event.processorId}:${event.taskId}`;
              const task = tasks.get(key) ?? {
                taskId: event.taskId,
                scheduledMs: null,
                resultMs: null,
                workerTaskStartedMs: null,
                workerTaskEndedMs: null,
              };
              if (event.phase === "taskScheduled") {
                task.scheduledMs = event.timestampMs;
              } else if (event.phase === "resultReceived") {
                task.resultMs = event.timestampMs;
                if (event.workerTiming) {
                  task.workerTaskStartedMs =
                    event.workerTiming.workerTimeOriginMs +
                    event.workerTiming.workerTaskStartedMs -
                    performance.timeOrigin -
                    started;
                  task.workerTaskEndedMs =
                    event.workerTiming.workerTimeOriginMs +
                    event.workerTiming.workerTaskEndedMs -
                    performance.timeOrigin -
                    started;
                }
              }
              tasks.set(key, task);
            }

            const stats = tileset.statistics;
            return {
              ok: true,
              completionReason,
              timing: {
                apiResolvedMs,
                durationMs: performance.now() - started,
              },
              readiness: {
                tilesLoaded: tileset.tilesLoaded,
                numberOfTilesTotal: stats.numberOfTilesTotal,
                numberOfLoadedTilesTotal: stats.numberOfLoadedTilesTotal,
                numberOfTilesWithContentReady:
                  stats.numberOfTilesWithContentReady,
              },
              tileLoadCount: tileLoadEvents.length,
              taskCount: tasks.size,
              completedTaskCount: [...tasks.values()].filter(
                (task) => task.resultMs !== null,
              ).length,
              progress: progress.slice(-500),
              tasks: [...tasks.values()],
              longTasks,
              frameGaps,
            };
          } finally {
            frameActive = false;
            longTaskObserver?.disconnect();
            Cesium.TaskProcessor._benchmarkTiming = oldBenchmarkTiming;
            widget.destroy();
          }
        },
        {
          browserAssetId: assetId,
          timeoutMs: options.timeoutMs,
          maximumScreenSpaceError: options.maximumScreenSpaceError,
          expectedContent: expectedContentTiles,
          expectedNodes: expectedTileNodes,
        },
      );

      await context.close();
      result.network = {
        responseCount: responseRecords.length,
        successfulResponses: responseRecords.filter(
          (response) => response.status === 200,
        ).length,
        contentLengthBytes: responseRecords.reduce(
          (sum, response) => sum + (response.contentLength ?? 0),
          0,
        ),
        glbResponseCount: responseRecords.filter((response) =>
          response.url.endsWith(".glb"),
        ).length,
      };
    } finally {
      await browser.close();
    }
  } finally {
    if (server.pid) {
      process.kill(server.pid, "SIGTERM");
    }
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    assetId,
    plan: {
      timeoutMs: options.timeoutMs,
      maximumScreenSpaceError: options.maximumScreenSpaceError,
      expectedContentTiles,
      expectedTileNodes,
      definition:
        "Public Cesium3DTileset.fromIonAssetId traversal from one full-asset camera view; completion requires all expected cumulative content loads.",
    },
    result,
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${options.output}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  process.exitCode = 1;
});
