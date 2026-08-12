const params = new URL(location.href).searchParams;
const variant = params.get("variant");
if (!["candidate", "baseline"].includes(variant))
  throw new Error("invalid variant");

globalThis.CESIUM_BASE_URL = `/${variant}/packages/engine/Build/`;
const Cesium = await import(
  `/${variant}/packages/engine/Build/Minified/index.js`
);

const container = document.getElementById("cesiumContainer");
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const tilesetUrl = "https://buildings.reearth.land/tileset.json";

function createWidget() {
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

async function renderUntil(widget, predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) return false;
    widget.render();
    await frame();
  }
  widget.render();
  return true;
}

function monitorRoute(start, getSample) {
  const frameGapsMs = [];
  const longTasks = [];
  const samples = [];
  let previous = start;
  let stopped = false;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const overlapStart = Math.max(entry.startTime, start);
      const overlapEnd = entry.startTime + entry.duration;
      if (overlapEnd > overlapStart) {
        longTasks.push({
          startMs: overlapStart - start,
          durationMs: overlapEnd - overlapStart,
        });
      }
    }
  });
  try {
    observer.observe({ type: "longtask", buffered: false });
  } catch {
    // Long Tasks are optional in Chromium.
  }
  function tick(now) {
    frameGapsMs.push(Math.max(0, now - previous));
    previous = now;
    const sample = getSample?.();
    if (sample) samples.push(sample);
    if (!stopped) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return async () => {
    stopped = true;
    for (const entry of observer.takeRecords()) {
      longTasks.push({
        startMs: entry.startTime - start,
        durationMs: entry.duration,
      });
    }
    observer.disconnect();
    return {
      frameGapsMs,
      longTasks,
      samples,
    };
  };
}

function getMemorySample() {
  const memory = performance.memory;
  return memory
    ? {
        jsHeapUsedBytes: memory.usedJSHeapSize,
        jsHeapTotalBytes: memory.totalJSHeapSize,
      }
    : undefined;
}

function summarizeSamples(samples) {
  if (samples.length === 0) return {};
  const max = (key) =>
    samples.reduce(
      (peak, sample) => Math.max(peak, sample[key] ?? 0),
      0,
    );
  const last = samples[samples.length - 1];
  return {
    sampleCount: samples.length,
    peakPendingRequests: max("numberOfPendingRequests"),
    peakTilesProcessing: max("numberOfTilesProcessing"),
    peakTilesTotal: max("numberOfTilesTotal"),
    peakGeometryByteLength: max("geometryByteLength"),
    peakTexturesByteLength: max("texturesByteLength"),
    peakBatchTableByteLength: max("batchTableByteLength"),
    peakFeaturesLoaded: max("numberOfFeaturesLoaded"),
    peakPointsLoaded: max("numberOfPointsLoaded"),
    peakTrianglesLoaded: max("numberOfTrianglesLoaded"),
    peakJsHeapUsedBytes: max("jsHeapUsedBytes"),
    peakJsHeapTotalBytes: max("jsHeapTotalBytes"),
    final: last,
  };
}

function destination(stop) {
  return Cesium.Cartesian3.fromDegrees(
    stop.longitude,
    stop.latitude,
    stop.heightMeters,
  );
}

async function loadCheckpoint(widget, tileset, stop, timeoutMs) {
  const start = performance.now();
  widget.camera.setView({
    destination: destination(stop),
    orientation: {
      heading: 0,
      pitch: -Cesium.Math.PI_OVER_TWO,
      roll: 0,
    },
  });
  const ready = await renderUntil(
    widget,
    () => tileset.tilesLoaded && tileset.root?.contentReady === true,
    timeoutMs,
  );
  return {
    id: stop.id,
    ready,
    durationMs: performance.now() - start,
  };
}

globalThis.reearthRun = async ({
  stops,
  checkpointTimeoutMs = 30000,
  routeTimeoutMs = 600000,
}) => {
  const widget = createWidget();
  const start = performance.now();
  const checkpoints = [];
  let tileset;
  const stopMonitoring = monitorRoute(start, () => {
    if (!tileset) return undefined;
    const statistics = tileset.statistics;
    return {
      numberOfPendingRequests: statistics.numberOfPendingRequests,
      numberOfTilesProcessing: statistics.numberOfTilesProcessing,
      numberOfTilesTotal: statistics.numberOfTilesTotal,
      geometryByteLength: statistics.geometryByteLength,
      texturesByteLength: statistics.texturesByteLength,
      batchTableByteLength: statistics.batchTableByteLength,
      numberOfFeaturesLoaded: statistics.numberOfFeaturesLoaded,
      numberOfPointsLoaded: statistics.numberOfPointsLoaded,
      numberOfTrianglesLoaded: statistics.numberOfTrianglesSelected,
      ...getMemorySample(),
    };
  });
  try {
    tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetUrl, {
      cullRequestsWhileMoving: false,
      maximumScreenSpaceError: 8,
      foveatedScreenSpaceError: false,
    });
    widget.scene.primitives.add(tileset);
    const rootReady = await renderUntil(
      widget,
      () => tileset.root?.contentReady === true,
      checkpointTimeoutMs,
    );
    if (!rootReady) throw new Error("Re:Earth root content did not load");

    for (const stop of stops) {
      if (performance.now() - start >= routeTimeoutMs) break;
      checkpoints.push(
        await loadCheckpoint(widget, tileset, stop, checkpointTimeoutMs),
      );
    }

    const responsiveness = await stopMonitoring();
    return {
      ok: true,
      durationMs: performance.now() - start,
      rootReady,
      checkpoints,
      responsiveness: {
        longTaskCount: responsiveness.longTasks.length,
        longTasks: responsiveness.longTasks,
        maxFrameGapMs: responsiveness.frameGapsMs.reduce(
          (maximum, gap) => Math.max(maximum, gap),
          0,
        ),
        p95FrameGapMs:
          responsiveness.frameGapsMs.length === 0
            ? 0
            : [...responsiveness.frameGapsMs].sort((a, b) => a - b)[
                Math.floor((responsiveness.frameGapsMs.length - 1) * 0.95)
              ],
        tileset: summarizeSamples(responsiveness.samples),
      },
    };
  } finally {
    if (tileset) {
      widget.scene.primitives.remove(tileset);
      if (!tileset.isDestroyed()) tileset.destroy();
    }
    widget.destroy();
  }
};

globalThis.reearthEnvironment = {
  renderer: (() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl?.getParameter(gl.RENDERER);
  })(),
  userAgent: navigator.userAgent,
};
