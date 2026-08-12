const Cesium = globalThis.Cesium;

if (!Cesium) {
  throw new Error("Cesium production bundle was not loaded.");
}

// Page configuration is supplied by the Playwright harness. Keeping these as
// URL parameters lets the same browser page serve all sample states.
const statusElement = document.getElementById("status");
const defaultReadyTimeoutMs = 120000;
const decoderWorkerByCompression = {
  draco: "decodeDraco",
  ktx2: "transcodeKTX2",
  meshopt: "decodeMeshopt",
  spz: "decodeSpz",
};
const benchmarkSearchParams = new URL(location.href).searchParams;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Public decompression benchmark failed: ${message}`);
  }
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function resolveUrl(path) {
  return new URL(path.replace(/^\/+/, ""), `${location.origin}/`).href;
}

function numberSearchParam(name, fallback) {
  const parameter = benchmarkSearchParams.get(name);
  if (parameter === null) {
    return fallback;
  }
  const value = Number(parameter);
  return Number.isFinite(value) ? value : fallback;
}

function benchmarkTaskProcessorTimingEnabled() {
  return benchmarkSearchParams.get("taskProcessorTiming") !== "disabled";
}

const arrayBufferMemorySampleIntervalMs = Math.max(
  25,
  numberSearchParam("arrayBufferMemorySampleIntervalMs", 50),
);
const frameGapLongThresholdMs = Math.max(
  16,
  numberSearchParam("frameGapLongThresholdMs", 50),
);
const readyTimeoutMs = Math.max(
  1,
  numberSearchParam("readyTimeoutMs", defaultReadyTimeoutMs),
);

// The lifecycle collector is optional instrumentation around TaskProcessor.
// It records decoder phases for diagnostics; publicReady remains the reported
// end-to-end metric for the cold/warm sweep.
function estimatePerformanceNowResolution() {
  const deltas = [];
  let previous = performance.now();
  for (let index = 0; index < 10000 && deltas.length < 20; ++index) {
    const current = performance.now();
    if (current > previous) {
      deltas.push(current - previous);
      previous = current;
    }
  }
  return deltas.length > 0 ? Math.min(...deltas) : null;
}

function workerPathMatches(workerPath, decoderWorker) {
  if (typeof workerPath !== "string" || decoderWorker === undefined) {
    return false;
  }
  const workerPathWithoutQuery = workerPath.split(/[?#]/, 1)[0];
  return (
    workerPathWithoutQuery === decoderWorker ||
    workerPathWithoutQuery.endsWith(`/${decoderWorker}.js`)
  );
}

function firstTiming(events, phase, timingField) {
  for (const event of events) {
    if (event.phase !== phase) {
      continue;
    }
    const value = timingField
      ? event.workerTiming?.[timingField]
      : event.timestampMs;
    if (typeof value === "number") {
      return value;
    }
  }
  return null;
}

function firstWorkerTiming(events, phase, timingField, started) {
  for (const event of events) {
    if (event.phase !== phase) {
      continue;
    }
    const workerTiming = event.workerTiming;
    const value = workerTiming?.[timingField];
    const workerTimeOriginMs = workerTiming?.workerTimeOriginMs;
    if (typeof value === "number" && typeof workerTimeOriginMs === "number") {
      return workerTimeOriginMs + value - performance.timeOrigin - started;
    }
  }
  return null;
}

// TaskProcessor reports events for every worker. Keep only the codec worker
// used by this scenario, then normalize worker-clock timestamps to the public
// loading timer started below.
function createDecoderLifecycleCollector(scenario) {
  const decoderWorker = decoderWorkerByCompression[scenario.compression];
  const events = [];

  return {
    callback(event) {
      if (workerPathMatches(event.workerPath, decoderWorker)) {
        events.push(event);
      }
    },
    result(started, terminalPoints) {
      const taskEvents = events.filter(
        (event) => event.workerTiming?.operation === "task",
      );
      const points = {
        inputCopyStartedMs: firstTiming(events, "inputCopyStarted"),
        inputCopyCompletedMs: firstTiming(events, "inputCopyCompleted"),
        transferableProbeStartedMs: firstTiming(
          events,
          "transferableProbeStarted",
        ),
        transferableProbeReadyMs: firstTiming(events, "transferableProbeReady"),
        workerCreatedMs: firstTiming(events, "workerCreated"),
        workerPreloadReadyMs: firstTiming(events, "workerPreloadReady"),
        taskScheduledMs: firstTiming(events, "taskScheduled"),
        taskPostedMs: firstTiming(events, "taskPosted"),
        workerModuleReadyMs: firstWorkerTiming(
          events,
          "wasmInitializationResultReceived",
          "workerModuleReadyMs",
          started,
        ),
        wasmDecoderReadyMs: firstWorkerTiming(
          events,
          "wasmInitializationResultReceived",
          "wasmDecoderReadyMs",
          started,
        ),
        decoderReadyMs: firstWorkerTiming(
          taskEvents,
          "resultReceived",
          "decoderReadyMs",
          started,
        ),
        decodeStartMs: firstWorkerTiming(
          taskEvents,
          "resultReceived",
          "workerTaskStartedMs",
          started,
        ),
        workerReceivedMs: firstWorkerTiming(
          taskEvents,
          "resultReceived",
          "workerMessageReceivedMs",
          started,
        ),
        spzLoadResolvedMs: firstWorkerTiming(
          taskEvents,
          "resultReceived",
          "spzLoadResolvedMs",
          started,
        ),
        decodeEndMs: firstWorkerTiming(
          taskEvents,
          "resultReceived",
          "workerTaskEndedMs",
          started,
        ),
        resultReceivedMs: firstTiming(taskEvents, "resultReceived"),
        ...terminalPoints,
      };

      if (points.workerModuleReadyMs === null) {
        points.workerModuleReadyMs = firstWorkerTiming(
          taskEvents,
          "resultReceived",
          "workerModuleReadyMs",
          started,
        );
      }

      for (const key of [
        "inputCopyStartedMs",
        "inputCopyCompletedMs",
        "transferableProbeStartedMs",
        "transferableProbeReadyMs",
        "workerCreatedMs",
        "workerPreloadReadyMs",
        "taskScheduledMs",
        "taskPostedMs",
        "resultReceivedMs",
      ]) {
        if (points[key] !== null) {
          points[key] -= started;
        }
      }

      const serializedEvents = events.map((event) => ({
        ...event,
        timestampMs: event.timestampMs - started,
        workerTiming: event.workerTiming
          ? Object.fromEntries(
              Object.entries(event.workerTiming).map(([key, value]) => [
                key,
                key === "workerTimeOriginMs"
                  ? value
                  : typeof value === "number"
                    ? event.workerTiming.workerTimeOriginMs +
                      value -
                      performance.timeOrigin -
                      started
                    : value,
              ]),
            )
          : null,
      }));
      return {
        source: "TaskProcessor._benchmarkTiming",
        enabled: true,
        decoderWorker: decoderWorker ?? null,
        points,
        unavailable: Object.keys(points).filter((key) => points[key] === null),
        events: serializedEvents,
      };
    },
  };
}

function disabledDecoderLifecycle(scenario, reason) {
  return {
    source: "TaskProcessor._benchmarkTiming",
    enabled: false,
    decoderWorker: decoderWorkerByCompression[scenario.compression] ?? null,
    reason,
    points: null,
    unavailable: ["disabled"],
    events: [],
  };
}

// Main-thread diagnostics are retained beside readiness timing so a slower or
// faster public-ready result can be inspected for frame and long-task effects.
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
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarizeNumericValues(values) {
  if (values.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      p95: null,
    };
  }
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    p95: quantile(values, 0.95),
  };
}

function serializeLongTaskEntries(entries) {
  return Array.from(entries, (entry) => ({
    startTime: entry.startTime,
    duration: entry.duration,
    name: entry.name,
    entryType: entry.entryType,
  }));
}

async function measureArrayBufferMemory() {
  const requestedAtMs = performance.now();
  const measurement = await performance.measureUserAgentSpecificMemory();
  const capturedAtMs = performance.now();
  let arrayBufferBytes = 0;
  let sawArrayBufferBreakdown = false;

  for (const breakdown of measurement.breakdown ?? []) {
    const types = Array.isArray(breakdown.types) ? breakdown.types : [];
    if (
      types.some(
        (type) =>
          typeof type === "string" && type.toLowerCase() === "arraybuffer",
      )
    ) {
      sawArrayBufferBreakdown = true;
      arrayBufferBytes += breakdown.bytes ?? 0;
    }
  }

  return {
    requestedAtMs,
    capturedAtMs,
    totalBytes:
      typeof measurement.bytes === "number" ? measurement.bytes : null,
    arrayBufferBytes: sawArrayBufferBreakdown ? arrayBufferBytes : null,
    sawArrayBufferBreakdown,
  };
}

// Start observers before the public API call, but clip their reported window
// to the call's start/end timestamps. Sampling is best-effort because Chrome
// may not expose measureUserAgentSpecificMemory in every environment.
function createMainThreadMonitor() {
  const longTaskEntries = [];
  let longTaskSupported = false;
  let longTaskUnavailableReason = null;
  let longTaskObserver;

  if (typeof PerformanceObserver === "function") {
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        longTaskEntries.push(...serializeLongTaskEntries(list.getEntries()));
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
      longTaskSupported = true;
    } catch (error) {
      longTaskUnavailableReason = error.message;
    }
  } else {
    longTaskUnavailableReason = "PerformanceObserver is unavailable";
  }

  const frameTimestamps = [];
  let frameRequestId;
  let frameMonitorActive = true;
  const onFrame = (timestamp) => {
    frameTimestamps.push(timestamp);
    if (frameMonitorActive) {
      frameRequestId = requestAnimationFrame(onFrame);
    }
  };
  frameRequestId = requestAnimationFrame(onFrame);

  const memorySamples = [];
  let memorySupported =
    typeof performance.measureUserAgentSpecificMemory === "function";
  let memoryUnavailableReason = memorySupported
    ? null
    : "performance.measureUserAgentSpecificMemory is unavailable";
  let memorySamplingActive = memorySupported;
  const memorySamplingPromise = memorySupported
    ? (async () => {
        while (memorySamplingActive) {
          try {
            memorySamples.push(await measureArrayBufferMemory());
          } catch (error) {
            memorySupported = false;
            memoryUnavailableReason = error.message;
            break;
          }

          if (!memorySamplingActive) {
            break;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, arrayBufferMemorySampleIntervalMs),
          );
        }
      })()
    : Promise.resolve();

  return {
    async stop(started, finished) {
      frameMonitorActive = false;
      if (frameRequestId !== undefined) {
        cancelAnimationFrame(frameRequestId);
      }

      if (longTaskObserver) {
        longTaskEntries.push(
          ...serializeLongTaskEntries(longTaskObserver.takeRecords()),
        );
        longTaskObserver.disconnect();
      }

      memorySamplingActive = false;
      await memorySamplingPromise;

      const longTasks = longTaskEntries
        .filter(
          (entry) =>
            entry.startTime <= finished &&
            entry.startTime + entry.duration >= started,
        )
        .map((entry) => ({
          ...entry,
          startMs: Math.max(0, entry.startTime - started),
        }));
      const longTaskDurations = longTasks.map((entry) => entry.duration);

      const frameGapsMs = [];
      for (let index = 1; index < frameTimestamps.length; ++index) {
        const current = frameTimestamps[index];
        if (current < started || current > finished) {
          continue;
        }
        frameGapsMs.push(current - frameTimestamps[index - 1]);
      }

      const arrayBufferSamples = memorySamples
        .filter(
          (sample) =>
            sample.requestedAtMs <= finished && sample.capturedAtMs >= started,
        )
        .map((sample) => ({
          ...sample,
          requestedMs: sample.requestedAtMs - started,
          capturedMs: sample.capturedAtMs - started,
        }));
      const validArrayBufferSamples = arrayBufferSamples.filter(
        (sample) => typeof sample.arrayBufferBytes === "number",
      );
      const peakArrayBufferSample = validArrayBufferSamples.reduce(
        (peak, sample) =>
          peak === null || sample.arrayBufferBytes > peak.arrayBufferBytes
            ? sample
            : peak,
        null,
      );

      return {
        longTasks: {
          supported: longTaskSupported,
          unavailableReason: longTaskSupported
            ? null
            : longTaskUnavailableReason,
          count: longTasks.length,
          totalDurationMs: longTaskDurations.reduce(
            (sum, value) => sum + value,
            0,
          ),
          p95DurationMs: quantile(longTaskDurations, 0.95),
          ...summarizeNumericValues(longTaskDurations),
          entries: longTasks,
        },
        frameGaps: {
          thresholdMs: frameGapLongThresholdMs,
          ...summarizeNumericValues(frameGapsMs),
          longGapCount: frameGapsMs.filter(
            (value) => value >= frameGapLongThresholdMs,
          ).length,
          entriesMs: frameGapsMs,
        },
        arrayBufferMemory: {
          supported: memorySupported,
          unavailableReason: memorySupported ? null : memoryUnavailableReason,
          samplingIntervalMs: arrayBufferMemorySampleIntervalMs,
          sampleCount: arrayBufferSamples.length,
          peakBytes: peakArrayBufferSample?.arrayBufferBytes ?? null,
          peakCapturedMs: peakArrayBufferSample?.capturedMs ?? null,
          firstBytes: validArrayBufferSamples[0]?.arrayBufferBytes ?? null,
          lastBytes:
            validArrayBufferSamples[validArrayBufferSamples.length - 1]
              ?.arrayBufferBytes ?? null,
          samples: arrayBufferSamples,
        },
      };
    },
  };
}

function collectResourceTiming(scenario, started, finished) {
  const prefix = new URL(scenario.resourcePrefix, `${location.origin}/`)
    .pathname;
  const entries = performance
    .getEntriesByType("resource")
    .filter(
      (entry) =>
        new URL(entry.name).pathname.startsWith(prefix) &&
        entry.startTime >= started &&
        entry.startTime <= finished,
    );

  const firstRequestStart = entries.reduce(
    (value, entry) => Math.min(value, entry.startTime),
    Number.POSITIVE_INFINITY,
  );
  const lastResponseEnd = entries.reduce(
    (value, entry) => Math.max(value, entry.responseEnd),
    0,
  );

  return {
    resourceCount: entries.length,
    firstRequestStart:
      firstRequestStart === Number.POSITIVE_INFINITY
        ? undefined
        : firstRequestStart,
    lastResponseEnd: lastResponseEnd || undefined,
    resources: entries.map((entry) => ({
      name: entry.name,
      startTime: entry.startTime,
      requestStart: entry.requestStart,
      responseStart: entry.responseStart,
      responseEnd: entry.responseEnd,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
    })),
  };
}

// Every asset type uses the same minimal widget configuration and manual
// render loop. This avoids unrelated globe, imagery, and default-loop work
// affecting the readiness condition.
function createWidget() {
  const container = document.getElementById("cesiumContainer");
  assert(container, "benchmark container is missing");
  container.replaceChildren();

  return new Cesium.CesiumWidget(container, {
    baseLayer: false,
    globe: false,
    skyAtmosphere: false,
    skyBox: false,
    useDefaultRenderLoop: false,
    requestRenderMode: false,
    showRenderLoopErrors: false,
  });
}

async function waitForWidget(widget, predicate, description) {
  const deadline = performance.now() + readyTimeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    widget.render();
    await nextFrame();
  }
  widget.render();
}

// These loaders define the public readiness boundary for each API represented
// in scenarios.json. The timer starts immediately before the public call and
// ends only after the documented renderable/loaded condition is true.
function viewBoundingSphere(widget, object) {
  if (object.boundingSphere) {
    widget.camera.viewBoundingSphere(
      object.boundingSphere,
      new Cesium.HeadingPitchRange(0.0, -0.5, 0.0),
    );
  }
}

async function runModelScenario(scenario) {
  const widget = createWidget();
  const started = performance.now();
  try {
    const model = await Cesium.Model.fromGltfAsync({
      url: resolveUrl(scenario.url),
    });
    const apiResolved = performance.now() - started;
    widget.scene.primitives.add(model);
    await waitForWidget(widget, () => model.ready, "Model.ready");
    const publicReady = performance.now() - started;

    return {
      started,
      milestones: { apiResolved, publicReady },
      readiness: { modelReady: model.ready },
    };
  } finally {
    widget.destroy();
  }
}

async function runTilesetScenario(scenario) {
  const widget = createWidget();
  const started = performance.now();
  try {
    const tileset = await Cesium.Cesium3DTileset.fromUrl(
      resolveUrl(scenario.url),
      {
        cullRequestsWhileMoving: false,
        maximumScreenSpaceError: 16,
      },
    );
    const apiResolved = performance.now() - started;
    widget.scene.primitives.add(tileset);
    viewBoundingSphere(widget, tileset);
    let tileFailure;
    tileset.tileFailed.addEventListener((error) => {
      tileFailure = error;
    });
    await waitForWidget(
      widget,
      () => {
        if (tileFailure) {
          throw new Error(
            `Tileset content failed to load: ${tileFailure.message}`,
          );
        }
        return tileset.tilesLoaded && tileset.root?.contentReady === true;
      },
      "initial tiles",
    );
    const publicReady = performance.now() - started;

    return {
      started,
      milestones: { apiResolved, publicReady },
      readiness: {
        tilesLoaded: tileset.tilesLoaded,
        rootContentReady: tileset.root?.contentReady ?? false,
      },
    };
  } finally {
    widget.destroy();
  }
}

async function runI3SScenario(scenario) {
  const widget = createWidget();
  const started = performance.now();
  try {
    const provider = await Cesium.I3SDataProvider.fromUrl(
      resolveUrl(scenario.url),
      {
        cesium3dTilesetOptions: {
          cullRequestsWhileMoving: false,
          maximumScreenSpaceError: 16,
        },
      },
    );
    const apiResolved = performance.now() - started;
    widget.scene.primitives.add(provider);
    const tilesets = provider.layers
      .map((layer) => layer.tileset)
      .filter((tileset) => tileset !== undefined);
    assert(
      tilesets.length > 0,
      "I3S provider created no public layer tilesets",
    );
    for (const tileset of tilesets) {
      viewBoundingSphere(widget, tileset);
    }

    await waitForWidget(
      widget,
      () => tilesets.every((tileset) => tileset.tilesLoaded),
      "I3S initial tiles",
    );
    const publicReady = performance.now() - started;

    return {
      started,
      milestones: { apiResolved, publicReady },
      readiness: {
        layerCount: provider.layers.length,
        tilesLoaded: tilesets.every((tileset) => tileset.tilesLoaded),
      },
    };
  } finally {
    widget.destroy();
  }
}

async function runKmlScenario(scenario) {
  const widget = createWidget();
  const started = performance.now();
  try {
    const dataSource = await Cesium.KmlDataSource.load(
      resolveUrl(scenario.url),
    );
    const apiResolved = performance.now() - started;
    await widget.dataSources.add(dataSource);
    let renderedFrames = 0;
    await waitForWidget(
      widget,
      () => !dataSource.isLoading && renderedFrames++ >= 1,
      "KML data source",
    );
    const publicReady = performance.now() - started;

    return {
      started,
      milestones: { apiResolved, publicReady },
      readiness: {
        entityCount: dataSource.entities.values.length,
        isLoading: dataSource.isLoading,
      },
    };
  } finally {
    widget.destroy();
  }
}

async function runGeeScenario(scenario) {
  const started = performance.now();
  const metadata = await Cesium.GoogleEarthEnterpriseMetadata.fromUrl(
    resolveUrl(scenario.url),
  );
  const apiResolved = performance.now() - started;
  const publicReady = performance.now() - started;

  return {
    started,
    milestones: { apiResolved, publicReady },
    readiness: {
      metadata: metadata.constructor.name,
      metadataUrl: metadata.url,
    },
  };
}

// This is the browser entry point called by benchmark.spec.js. It dispatches
// to the matching public Cesium API, then attaches diagnostics to the same
// public-ready interval without changing that interval's start or end.
async function runScenario(scenario) {
  statusElement.textContent = `Running ${scenario.id}...`;
  const timerResolutionMs = estimatePerformanceNowResolution();
  const monitor = createMainThreadMonitor();
  const taskProcessorTimingEnabled = benchmarkTaskProcessorTimingEnabled();
  const lifecycleCollector = taskProcessorTimingEnabled
    ? createDecoderLifecycleCollector(scenario)
    : undefined;
  const previousBenchmarkTiming = Cesium.TaskProcessor._benchmarkTiming;
  if (taskProcessorTimingEnabled) {
    assert(
      previousBenchmarkTiming === undefined,
      "TaskProcessor benchmark timing is already enabled",
    );
    Cesium.TaskProcessor._benchmarkTiming = lifecycleCollector.callback;
  }
  let result;
  try {
    result =
      scenario.api === "Model.fromGltfAsync"
        ? await runModelScenario(scenario)
        : scenario.api === "Cesium3DTileset.fromUrl"
          ? await runTilesetScenario(scenario)
          : scenario.api === "I3SDataProvider.fromUrl"
            ? await runI3SScenario(scenario)
            : scenario.api === "KmlDataSource.load"
              ? await runKmlScenario(scenario)
              : scenario.api.startsWith("GoogleEarthEnterprise")
                ? await runGeeScenario(scenario)
                : undefined;
  } finally {
    if (taskProcessorTimingEnabled) {
      Cesium.TaskProcessor._benchmarkTiming = previousBenchmarkTiming;
    }
  }

  assert(result, `unsupported public API ${scenario.api}`);
  const publicReadyMs = result.milestones.publicReady;
  const mainThread = await monitor.stop(
    result.started,
    result.started + publicReadyMs,
  );
  const resourceTiming = collectResourceTiming(
    scenario,
    result.started,
    result.started + publicReadyMs,
  );
  return {
    scenarioId: scenario.id,
    api: scenario.api,
    compression: scenario.compression,
    timing: {
      durationMs: publicReadyMs,
      milestonesMs: result.milestones,
      timerResolutionMs,
      belowTimerResolution:
        timerResolutionMs !== null && publicReadyMs <= timerResolutionMs,
    },
    resourceTiming,
    readiness: result.readiness,
    mainThread,
    decoderLifecycle: taskProcessorTimingEnabled
      ? lifecycleCollector.result(result.started, {
          publicReadyMs: result.milestones.publicReady,
        })
      : disabledDecoderLifecycle(
          scenario,
          "Disabled by benchmark page taskProcessorTiming=disabled",
        ),
  };
}

// The following helpers support optional preload experiment states. The normal
// 14-asset cold/warm sweep does not call runPreload.
function codecWorkerPreloader(compression) {
  return compression === "draco"
    ? Cesium.DracoLoader._preloadWorkerForBenchmark
    : compression === "meshopt"
      ? Cesium.GltfBufferViewLoader._preloadMeshoptWorkerForBenchmark
      : compression === "ktx2"
        ? Cesium.KTX2Transcoder._preloadWorkerForBenchmark
        : compression === "spz"
          ? Cesium.SpzDecoder._preloadWorkerForBenchmark
          : undefined;
}

function codecWasmPreloader(compression) {
  return compression === "draco"
    ? Cesium.DracoLoader._preloadWorkerAndWasmForBenchmark
    : compression === "ktx2"
      ? Cesium.KTX2Transcoder._preloadWorkerAndWasmForBenchmark
      : undefined;
}

async function preloadRuntimeAssets(scenario) {
  assert(
    Array.isArray(scenario.runtimeAssetFiles) &&
      scenario.runtimeAssetFiles.length > 0,
    `${scenario.id} has no runtime asset list`,
  );

  let bytesRead = 0;
  for (const assetFile of scenario.runtimeAssetFiles) {
    const response = await fetch(resolveUrl(assetFile), {
      cache: "force-cache",
    });
    assert(response.ok, `asset preload failed for ${assetFile}`);
    bytesRead += (await response.arrayBuffer()).byteLength;
  }

  return {
    definition: "browser HTTP cache populated from explicit runtime asset URLs",
    assetCount: scenario.runtimeAssetFiles.length,
    bytesRead,
    cesiumResourceCacheTouched: false,
    decoderTaskPosted: false,
  };
}

async function runPreload(scenario, kind) {
  statusElement.textContent = `Preloading ${kind} for ${scenario.id}...`;
  const timerResolutionMs = estimatePerformanceNowResolution();
  const taskProcessorTimingEnabled = benchmarkTaskProcessorTimingEnabled();
  const lifecycleCollector = taskProcessorTimingEnabled
    ? createDecoderLifecycleCollector(scenario)
    : undefined;
  const previousBenchmarkTiming = Cesium.TaskProcessor._benchmarkTiming;
  if (taskProcessorTimingEnabled) {
    assert(
      previousBenchmarkTiming === undefined,
      "TaskProcessor benchmark timing is already enabled",
    );
    Cesium.TaskProcessor._benchmarkTiming = lifecycleCollector.callback;
  }

  const started = performance.now();
  let readiness;
  try {
    if (kind === "worker-probe") {
      const preload = codecWorkerPreloader(scenario.compression);
      assert(
        typeof preload === "function",
        `${scenario.compression} has no worker/probe preload hook`,
      );
      const canTransferArrayBuffer = await preload();
      readiness = {
        definition:
          "shared codec worker constructed and transferable ArrayBuffer probe settled; worker module evaluation is not asserted",
        canTransferArrayBuffer,
        decoderTaskPosted: false,
        wasmReady: false,
      };
    } else if (kind === "worker-wasm") {
      const preload = codecWasmPreloader(scenario.compression);
      assert(
        typeof preload === "function",
        `${scenario.compression} has no worker plus WASM readiness hook`,
      );
      const canTransferArrayBuffer = await preload();
      readiness = {
        definition:
          "shared codec worker constructed, transferable ArrayBuffer probe settled, and existing codec WASM initialization promise resolved",
        canTransferArrayBuffer,
        decoderTaskPosted: false,
        wasmReady: true,
      };
    } else if (kind === "asset-cache") {
      readiness = await preloadRuntimeAssets(scenario);
    } else {
      throw new Error(`Unsupported preload kind ${kind}`);
    }
  } finally {
    if (taskProcessorTimingEnabled) {
      Cesium.TaskProcessor._benchmarkTiming = previousBenchmarkTiming;
    }
  }

  const finished = performance.now();
  const durationMs = finished - started;
  return {
    kind,
    timing: {
      durationMs,
      milestonesMs: { preloadReady: durationMs },
      timerResolutionMs,
      belowTimerResolution:
        timerResolutionMs !== null && durationMs <= timerResolutionMs,
    },
    readiness,
    resourceTiming: collectResourceTiming(scenario, started, finished),
    decoderLifecycle: taskProcessorTimingEnabled
      ? lifecycleCollector.result(started, {
          preloadReadyMs: durationMs,
        })
      : disabledDecoderLifecycle(
          scenario,
          "Disabled by benchmark page taskProcessorTiming=disabled",
        ),
  };
}

// Expose only the two operations used by the Node/Playwright harness after the
// module finishes loading.
globalThis.decompressionBenchmarkReady = true;
globalThis.runCesiumDecompressionScenario = runScenario;
globalThis.runCesiumDecompressionPreload = runPreload;
