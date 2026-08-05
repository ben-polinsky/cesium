#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const baselineRoot = "/Users/benpolinsky/source/cesium-main-baseline";
const benchmarkPage = "/Tools/benchmark/decompression/benchmark.html";
const viewport = { width: 1280, height: 720 };
const assetId = 4547222;
const defaultCandidatePort = 8131;
const defaultBaselinePort = 8132;
const defaultIterations = 1;
const defaultFarSettleMs = 3000;
const defaultCloseWindowMs = 15000;
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
  return lower === upper
    ? sorted[lower]
    : sorted[lower] +
        (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(values) {
  if (values.length === 0) {
    return { count: 0, median: null, p95: null };
  }
  return {
    count: values.length,
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
  };
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; --index) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function parseArgs(argv) {
  const options = {
    iterations: defaultIterations,
    seed: Math.floor(Math.random() * 0x100000000),
    baselineRoot,
    candidateRoot: repositoryRoot,
    baselinePort: defaultBaselinePort,
    candidatePort: defaultCandidatePort,
    farSettleMs: defaultFarSettleMs,
    closeWindowMs: defaultCloseWindowMs,
    maximumScreenSpaceError: 8,
    closeRangeFactor: 0.25,
    farRangeFactor: 8,
    readyTimeoutMs: defaultReadyTimeoutMs,
    output: path.join(
      repositoryRoot,
      "Build",
      "Performance",
      "Decompression",
      "ion-spz-paired-route-smoke.json",
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
    if (argument.startsWith("--iterations")) {
      options.iterations = Number(valueFor(argument, index));
    } else if (argument.startsWith("--seed")) {
      options.seed = Number(valueFor(argument, index));
    } else if (argument.startsWith("--baseline-root")) {
      options.baselineRoot = path.resolve(valueFor(argument, index));
    } else if (argument.startsWith("--candidate-root")) {
      options.candidateRoot = path.resolve(valueFor(argument, index));
    } else if (argument.startsWith("--baseline-port")) {
      options.baselinePort = Number(valueFor(argument, index));
    } else if (argument.startsWith("--candidate-port")) {
      options.candidatePort = Number(valueFor(argument, index));
    } else if (argument.startsWith("--far-settle-ms")) {
      options.farSettleMs = Number(valueFor(argument, index));
    } else if (argument.startsWith("--close-window-ms")) {
      options.closeWindowMs = Number(valueFor(argument, index));
    } else if (argument.startsWith("--maximum-screen-space-error")) {
      options.maximumScreenSpaceError = Number(valueFor(argument, index));
    } else if (argument.startsWith("--close-range-factor")) {
      options.closeRangeFactor = Number(valueFor(argument, index));
    } else if (argument.startsWith("--far-range-factor")) {
      options.farRangeFactor = Number(valueFor(argument, index));
    } else if (argument.startsWith("--ready-timeout-ms")) {
      options.readyTimeoutMs = Number(valueFor(argument, index));
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
  assert(Number.isSafeInteger(options.seed), "--seed must be an integer");
  for (const [name, value] of [
    ["--baseline-port", options.baselinePort],
    ["--candidate-port", options.candidatePort],
    ["--far-settle-ms", options.farSettleMs],
    ["--close-window-ms", options.closeWindowMs],
    ["--maximum-screen-space-error", options.maximumScreenSpaceError],
    ["--close-range-factor", options.closeRangeFactor],
    ["--far-range-factor", options.farRangeFactor],
    ["--ready-timeout-ms", options.readyTimeoutMs],
  ]) {
    assert(Number.isFinite(value) && value > 0, `${name} must be positive`);
  }
  assert(options.baselineRoot !== options.candidateRoot, "roots must differ");
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

function startServer(root, port) {
  return spawn(
    process.execPath,
    [
      path.join(repositoryRoot, "Tools/benchmark/decompression/static-server.mjs"),
      "--root",
      root,
      "--port",
      String(port),
    ],
    { stdio: "ignore" },
  );
}

const variants = [
  {
    id: "baseline",
    rootKey: "baseline",
    preload: "none",
  },
  {
    id: "candidate-cold",
    rootKey: "candidate",
    preload: "none",
  },
  {
    id: "candidate-worker-created-transfer-probe-complete",
    rootKey: "candidate",
    preload: "worker-created-transfer-probe-complete",
  },
];

async function runSample(page, variant, options) {
  const response = await page.evaluate(
    async ({
      assetId: browserAssetId,
      preloadKind,
      farSettleMs,
      closeWindowMs,
      maximumScreenSpaceError,
      closeRangeFactor,
      farRangeFactor,
    }) => {
      const Cesium = globalThis.Cesium;
      const taskEvents = [];
      const tileEvents = { loaded: [], visible: [] };
      const loadProgress = [];
      const longTasks = [];
      const frameGaps = [];
      const tilesLoadedSamples = [];
      const tilesLoadedTransitions = [];
      const oldBenchmarkTiming = Cesium.TaskProcessor._benchmarkTiming;
      const sampleStarted = performance.now();
      const taskCallback = (event) => {
        if (event.workerPath?.includes("decodeSpz")) {
          taskEvents.push({
            ...event,
            timestampMs: event.timestampMs,
            workerTiming: event.workerTiming ?? null,
            benchmarkMetadata: event.benchmarkMetadata ?? null,
          });
        }
      };
      Cesium.TaskProcessor._benchmarkTiming = taskCallback;

      function stripToken(url) {
        if (typeof url !== "string") {
          return null;
        }
        const parsed = new URL(url, location.href);
        parsed.searchParams.delete("access_token");
        return `${parsed.origin}${parsed.pathname}${parsed.search}`;
      }

      function tileIdentity(tile) {
        const url = tile?._contentResource?.url ?? tile?.content?.url;
        return stripToken(url);
      }

      function statsSnapshot(tileset) {
        const stats = tileset.statistics;
        return {
          numberOfPendingRequests: stats.numberOfPendingRequests,
          numberOfTilesProcessing: stats.numberOfTilesProcessing,
          numberOfTilesWithContentReady: stats.numberOfTilesWithContentReady,
          numberOfTilesTotal: stats.numberOfTilesTotal,
          numberOfLoadedTilesTotal: stats.numberOfLoadedTilesTotal,
        };
      }

      const overlay = document.createElement("div");
      overlay.id = "spz-benchmark-neutral-input-overlay";
      overlay.setAttribute("aria-hidden", "true");
      Object.assign(overlay.style, {
        position: "fixed",
        left: "16px",
        top: "16px",
        width: "180px",
        height: "32px",
        zIndex: "10000",
        background: "rgba(128, 128, 128, 0.16)",
        border: "1px solid rgba(64, 64, 64, 0.2)",
        pointerEvents: "auto",
      });
      document.body.appendChild(overlay);

      const inputProbe = {
        events: [],
        dispatchRequestedMs: null,
        dispatchCompletedMs: null,
      };
      overlay.addEventListener("pointerdown", (event) => {
        const handlerAtMs = performance.now();
        const eventTimeStampMs = event.timeStamp;
        const record = {
          type: event.type,
          eventTimeStampMs,
          handlerAtMs,
          dispatchToHandlerMs: handlerAtMs - eventTimeStampMs,
          handlerToFrameMs: null,
        };
        inputProbe.events.push(record);
        requestAnimationFrame(() => {
          record.handlerToFrameMs = performance.now() - handlerAtMs;
        });
      });

      const preloadStarted = performance.now();
      let preloadResult = {
        kind: "none",
        durationMs: 0,
        decoderTaskPosted: false,
        fixtureDecoded: false,
      };
      if (preloadKind === "worker-created-transfer-probe-complete") {
        if (typeof Cesium.SpzDecoder._preloadWorkerForBenchmark !== "function") {
          throw new Error("Candidate SPZ worker preload hook is unavailable");
        }
        const canTransfer =
          await Cesium.SpzDecoder._preloadWorkerForBenchmark();
        preloadResult = {
          kind: preloadKind,
          canTransfer,
          durationMs: performance.now() - preloadStarted,
          workerCreated: true,
          transferProbeComplete: true,
          decoderTaskPosted: false,
          fixtureDecoded: false,
        };
      }
      const targetStarted = performance.now();
      const targetStartTaskEventIndex = taskEvents.length;
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

      let frameActive = true;
      let previousFrame = performance.now();
      requestAnimationFrame(function frameLoop(timestamp) {
        frameGaps.push(timestamp - previousFrame);
        previousFrame = timestamp;
        if (frameActive) {
          requestAnimationFrame(frameLoop);
        }
      });

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
        widget.camera.viewBoundingSphere(
          tileset.boundingSphere,
          new Cesium.HeadingPitchRange(
            0,
            -0.5,
            Math.max(tileset.boundingSphere.radius * factor, 1),
          ),
        );
        widget.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      }

      function taskContentIdentity(metadata) {
        if (metadata === null || metadata === undefined) {
          return null;
        }
        return {
          sourceUrl: stripToken(metadata.sourceUrl),
          bufferViewId: metadata.bufferViewId ?? null,
          primitivePositionAccessorId:
            metadata.primitivePositionAccessorId ?? null,
        };
      }

      function taskRecords(routeStarted) {
        const records = new Map();
        for (const event of taskEvents.slice(targetStartTaskEventIndex)) {
          if (event.taskId === undefined) {
            continue;
          }
          const key = `${event.processorId}:${event.taskId}`;
          const record = records.get(key) ?? {
            processorId: event.processorId,
            workerId: event.workerId,
            taskId: event.taskId,
            scheduledMs: null,
            handlerEntryMs: null,
            workerTaskStartedMs: null,
            spzLoadResolvedMs: null,
            workerTaskEndedMs: null,
            resultMs: null,
            benchmarkMetadata: null,
          };
          record.benchmarkMetadata ??= event.benchmarkMetadata;
          if (event.phase === "taskScheduled") {
            record.scheduledMs = event.timestampMs - routeStarted;
          } else if (event.phase === "resultReceived") {
            record.resultMs = event.timestampMs - routeStarted;
            const timing = event.workerTiming;
            if (timing && typeof timing.workerTimeOriginMs === "number") {
              const workerTime =
                (field) =>
                  typeof timing[field] === "number"
                    ? timing.workerTimeOriginMs +
                      timing[field] -
                      performance.timeOrigin -
                      routeStarted
                    : null;
              record.handlerEntryMs = workerTime("workerMessageReceivedMs");
              record.workerTaskStartedMs = workerTime("workerTaskStartedMs");
              record.spzLoadResolvedMs = workerTime("spzLoadResolvedMs");
              record.workerTaskEndedMs = workerTime("workerTaskEndedMs");
            }
          }
          records.set(key, record);
        }
        return [...records.values()].map((record) => ({
          ...record,
          contentIdentity: taskContentIdentity(record.benchmarkMetadata),
          scheduledToHandlerMs:
            record.scheduledMs !== null && record.handlerEntryMs !== null
              ? record.handlerEntryMs - record.scheduledMs
              : null,
          handlerToSpzLoadMs:
            record.handlerEntryMs !== null &&
            record.spzLoadResolvedMs !== null
              ? record.spzLoadResolvedMs - record.handlerEntryMs
              : null,
          spzLoadToResultMs:
            record.spzLoadResolvedMs !== null && record.resultMs !== null
              ? record.resultMs - record.spzLoadResolvedMs
              : null,
          serviceLatencyMs:
            record.scheduledMs !== null && record.resultMs !== null
              ? record.resultMs - record.scheduledMs
              : null,
        }));
      }

      function segmentSummary(records, startMs, endMs) {
        const segmentTasks = records
          .filter(
            (record) =>
              record.scheduledMs !== null &&
              record.scheduledMs >= startMs &&
              record.scheduledMs <= endMs,
          )
          .sort((left, right) => left.scheduledMs - right.scheduledMs);
        const completed = segmentTasks.filter(
          (record) => record.resultMs !== null,
        );
        return {
          startMs,
          endMs,
          taskCount: segmentTasks.length,
          completedTaskCount: completed.length,
          firstServiceLatencyMs: completed[0]?.serviceLatencyMs ?? null,
          laterServiceLatencyMs: completed
            .slice(1)
            .map((record) => record.serviceLatencyMs)
            .filter((value) => value !== null),
          scheduledToHandlerMs: segmentTasks
            .map((record) => record.scheduledToHandlerMs)
            .filter((value) => value !== null),
          handlerToSpzLoadMs: segmentTasks
            .map((record) => record.handlerToSpzLoadMs)
            .filter((value) => value !== null),
          spzLoadToResultMs: segmentTasks
            .map((record) => record.spzLoadToResultMs)
            .filter((value) => value !== null),
          serviceLatencyMs: completed
            .map((record) => record.serviceLatencyMs)
            .filter((value) => value !== null),
          firstTaskResultMs: completed[0]?.resultMs ?? null,
        };
      }

      let tileset;
      let tileFailure;
      let jumpAtMs = null;
      let farEndMs = null;
      let firstNewTargetVisibleMs = null;
      let preJumpVisibleTileIds = new Set();
      let postJumpNewTileIds = new Set();
      let tilesLoadedConvergedMs = null;
      let tilesLoadedAfterJump = false;
      let stableTilesLoadedFrames = 0;
      let previousTilesLoaded;
      let lastTilesLoadedState = null;

      function sampleTilesLoaded(atMs) {
        const current = tileset.tilesLoaded;
        tilesLoadedSamples.push({
          atMs,
          tilesLoaded: current,
          stats: statsSnapshot(tileset),
        });
        if (jumpAtMs === null || atMs < jumpAtMs) {
          previousTilesLoaded = current;
          return;
        }
        if (!tilesLoadedAfterJump) {
          tilesLoadedAfterJump = true;
          previousTilesLoaded = undefined;
          stableTilesLoadedFrames = 0;
        }
        if (current !== previousTilesLoaded) {
          tilesLoadedTransitions.push({
            atMs,
            tilesLoaded: current,
          });
          stableTilesLoadedFrames = 0;
        } else if (current) {
          stableTilesLoadedFrames++;
        } else {
          stableTilesLoadedFrames = 0;
        }
        if (
          current &&
          stableTilesLoadedFrames >= 3 &&
          tilesLoadedConvergedMs === null
        ) {
          tilesLoadedConvergedMs = atMs;
        }
        previousTilesLoaded = current;
      }

      async function renderUntil(deadline) {
        while (performance.now() < deadline) {
          widget.render();
          if (tileFailure) {
            throw new Error(`Tile failed: ${tileFailure.message}`);
          }
          const atMs = performance.now() - targetStarted;
          sampleTilesLoaded(atMs);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }

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
        tileset.tileLoad.addEventListener((tile) => {
          tileEvents.loaded.push({
            atMs: performance.now() - targetStarted,
            tileId: tileIdentity(tile),
          });
        });
        tileset.tileVisible.addEventListener((tile) => {
          const atMs = performance.now() - targetStarted;
          const tileId = tileIdentity(tile);
          tileEvents.visible.push({ atMs, tileId });
          if (jumpAtMs !== null && atMs >= jumpAtMs) {
            if (tileId === null || !preJumpVisibleTileIds.has(tileId)) {
              firstNewTargetVisibleMs ??= atMs;
              if (tileId !== null) {
                postJumpNewTileIds.add(tileId);
              }
            }
          }
        });
        tileset.loadProgress.addEventListener((pending, processing) => {
          loadProgress.push({
            atMs: performance.now() - targetStarted,
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

        const farStartMs = apiResolvedMs;
        cameraAtFactor(tileset, farRangeFactor);
        await renderUntil(performance.now() + farSettleMs);
        farEndMs = performance.now() - targetStarted;
        jumpAtMs = farEndMs;
        preJumpVisibleTileIds = new Set(
          tileEvents.visible
            .map((event) => event.tileId)
            .filter((tileId) => tileId !== null),
        );
        cameraAtFactor(tileset, closeRangeFactor);

        inputProbe.dispatchRequestedMs = performance.now() - targetStarted;
        await globalThis.__dispatchBenchmarkInput();
        inputProbe.dispatchCompletedMs = performance.now() - targetStarted;

        await renderUntil(performance.now() + closeWindowMs);
        const finishedMs = performance.now() - targetStarted;
        frameActive = false;
        const records = taskRecords(targetStarted);
        const preloadBenchmarkPhases = taskEvents
          .slice(0, targetStartTaskEventIndex)
          .map((event) => ({
            phase: event.phase,
            atMs: event.timestampMs - sampleStarted,
          }));
        const afterJumpTasks = records
          .filter(
            (record) =>
              record.scheduledMs !== null &&
              record.scheduledMs >= jumpAtMs,
          )
          .sort((left, right) => left.scheduledMs - right.scheduledMs);
        const validInputEvents = inputProbe.events.filter(
          (event) => event.handlerAtMs - targetStarted >= jumpAtMs,
        );
        return {
          ok: true,
          target: {
            apiResolvedMs,
            jumpAtMs,
            farEndMs,
            finishedMs,
            durationMs: finishedMs,
            firstNewTargetVisibleMs,
            firstNewTargetVisibleAfterJumpMs:
              firstNewTargetVisibleMs === null
                ? null
                : firstNewTargetVisibleMs - jumpAtMs,
            preJumpVisibleTileIdentityCount: preJumpVisibleTileIds.size,
            postJumpNewTileIdentityCount: postJumpNewTileIds.size,
          },
          preload: {
            ...preloadResult,
            startedBeforeTargetMs: preloadStarted - sampleStarted,
            endedBeforeTargetMs: targetStarted - sampleStarted,
            benchmarkPhases: preloadBenchmarkPhases,
          },
          taskTiming: {
            source: "TaskProcessor._benchmarkTiming",
            available: records.length > 0,
            eventCount: taskEvents.length - targetStartTaskEventIndex,
          },
          readiness: {
            tilesLoaded: tileset.tilesLoaded,
            rootContentReady: tileset.root?.contentReady ?? false,
            tilesLoadedConvergedMs,
            tilesLoadedConvergedAfterJumpMs:
              tilesLoadedConvergedMs === null
                ? null
                : tilesLoadedConvergedMs - jumpAtMs,
            finalStats: statsSnapshot(tileset),
          },
          segments: {
            far: segmentSummary(records, farStartMs, farEndMs),
            close: segmentSummary(records, jumpAtMs, finishedMs),
          },
          firstVsLaterServiceLatency: {
            firstAfterJumpMs: afterJumpTasks[0]?.serviceLatencyMs ?? null,
            laterAfterJumpMs: afterJumpTasks
              .slice(1)
              .map((record) => record.serviceLatencyMs)
              .filter((value) => value !== null),
          },
          tasks: records,
          taskIdentityCount: new Set(
            records
              .map((record) => record.contentIdentity)
              .filter((identity) => identity !== null)
              .map((identity) => JSON.stringify(identity)),
          ).size,
          loadProgress: loadProgress.slice(-200),
          tilesLoadedSamples: tilesLoadedSamples.slice(-300),
          tilesLoadedTransitions,
          tileEvents,
          input: {
            overlay: {
              id: overlay.id,
              pointerEvents: overlay.style.pointerEvents,
              fixed: overlay.style.position === "fixed",
            },
            dispatchRequestedMs: inputProbe.dispatchRequestedMs,
            dispatchCompletedMs: inputProbe.dispatchCompletedMs,
            events: validInputEvents,
          },
          longTasks,
          frameGaps,
        };
      } catch (error) {
        frameActive = false;
        return {
          ok: false,
          error: {
            name: error?.name,
            message: error?.message ?? String(error),
            stack: error?.stack,
          },
          preload: preloadResult,
          tasks: taskRecords(targetStarted),
          longTasks,
          frameGaps,
        };
      } finally {
        frameActive = false;
        longTaskObserver?.disconnect();
        Cesium.TaskProcessor._benchmarkTiming = oldBenchmarkTiming;
        widget.destroy();
        overlay.remove();
      }
    },
    {
      assetId,
      preloadKind: variant.preload,
      farSettleMs: options.farSettleMs,
      closeWindowMs: options.closeWindowMs,
      maximumScreenSpaceError: options.maximumScreenSpaceError,
      closeRangeFactor: options.closeRangeFactor,
      farRangeFactor: options.farRangeFactor,
    },
  );
  assert(response.ok, response.error?.message ?? "SPZ route failed");
  return response;
}

function summarizeRuns(runs) {
  return Object.fromEntries(
    variants.map((variant) => {
      const variantRuns = runs.filter(
        (run) => run.variantId === variant.id && run.ok,
      );
      const values = (selector) =>
        variantRuns
          .map(selector)
          .filter((value) => typeof value === "number");
      return [
        variant.id,
        {
          sampleCount: variantRuns.length,
          preloadMs: summarize(values((run) => run.preload.durationMs)),
          firstNewTargetVisibleAfterJumpMs: summarize(
            values((run) => run.target.firstNewTargetVisibleAfterJumpMs),
          ),
          tilesLoadedConvergedAfterJumpMs: summarize(
            values((run) => run.readiness.tilesLoadedConvergedAfterJumpMs),
          ),
          firstAfterJumpServiceLatencyMs: summarize(
            values((run) => run.firstVsLaterServiceLatency.firstAfterJumpMs),
          ),
          laterServiceLatencyMs: summarize(
            variantRuns.flatMap(
              (run) => run.firstVsLaterServiceLatency.laterAfterJumpMs,
            ),
          ),
          scheduledToHandlerMs: summarize(
            variantRuns.flatMap((run) =>
              run.segments.close.scheduledToHandlerMs.filter(
                (value) => value !== null,
              ),
            ),
          ),
          handlerToSpzLoadMs: summarize(
            variantRuns.flatMap((run) =>
              run.segments.close.handlerToSpzLoadMs.filter(
                (value) => value !== null,
              ),
            ),
          ),
          spzLoadToResultMs: summarize(
            variantRuns.flatMap((run) =>
              run.segments.close.spzLoadToResultMs.filter(
                (value) => value !== null,
              ),
            ),
          ),
          longTaskCount: summarize(
            variantRuns.map((run) => run.longTasks.length),
          ),
          maxFrameGapMs: summarize(
            variantRuns
              .map((run) =>
                run.frameGaps.length > 0 ? Math.max(...run.frameGaps) : null,
              )
              .filter((value) => value !== null),
          ),
          inputDispatchToHandlerMs: summarize(
            variantRuns.flatMap((run) =>
              run.input.events.map((event) => event.dispatchToHandlerMs),
            ),
          ),
          inputHandlerToFrameMs: summarize(
            variantRuns.flatMap((run) =>
              run.input.events
                .map((event) => event.handlerToFrameMs)
                .filter((value) => value !== null),
            ),
          ),
        },
      ];
    }),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baselineServer = startServer(options.baselineRoot, options.baselinePort);
  const candidateServer = startServer(
    options.candidateRoot,
    options.candidatePort,
  );
  const servers = [baselineServer, candidateServer];
  const urls = {
    baseline: `http://localhost:${options.baselinePort}`,
    candidate: `http://localhost:${options.candidatePort}`,
  };
  const runs = [];
  const random = createRandom(options.seed);
  const browser = await chromium.launch({ headless: true });

  try {
    await Promise.all(Object.values(urls).map(waitForServer));
    for (let blockIndex = 0; blockIndex < options.iterations; ++blockIndex) {
      const order = shuffle(variants, random);
      const pairId = `spz-route-${blockIndex + 1}`;
      for (let orderIndex = 0; orderIndex < order.length; ++orderIndex) {
        const variant = order[orderIndex];
        const context = await browser.newContext({
          viewport,
          deviceScaleFactor: 1,
          serviceWorkers: "block",
        });
        try {
          const page = await context.newPage();
          await page.exposeFunction("__dispatchBenchmarkInput", async () => {
            await page.mouse.click(48, 32);
          });
          const pageUrl = new URL(
            benchmarkPage,
            urls[variant.rootKey],
          );
          pageUrl.searchParams.set("taskProcessorTiming", "enabled");
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
          const result = await runSample(
            page,
            variant,
            options,
          );
          runs.push({
            pairId,
            blockIndex,
            orderIndex,
            variantId: variant.id,
            root: variant.rootKey,
            preloadKind: variant.preload,
            ...result,
          });
          console.error(
            `${pairId} ${orderIndex + 1}/${order.length} ${variant.id} complete`,
          );
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    for (const server of servers) {
      if (server.pid) {
        process.kill(server.pid, "SIGTERM");
      }
    }
  }

  const output = {
    schemaVersion: 1,
    status: runs.length === options.iterations * variants.length &&
      runs.every((run) => run.ok)
      ? "ok"
      : "failed",
    generatedAt: new Date().toISOString(),
    assetId,
    route: "far-to-close",
    plan: {
      ...options,
      baselineRoot: path.resolve(options.baselineRoot),
      candidateRoot: path.resolve(options.candidateRoot),
      variants: variants.map((variant) => ({
        id: variant.id,
        root: variant.rootKey,
        preload: variant.preload,
      })),
      cachePolicy: "fresh Playwright context per variant; service workers blocked",
      preloadPolicy:
        "worker-created plus transferable-probe complete; no decoder task, fixture decode, or decoder/module-ready claim",
      inputPolicy:
        "fixed neutral overlay; Playwright mouse click after camera jump; no camera input",
    },
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
