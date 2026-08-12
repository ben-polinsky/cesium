// This page is the neutral, in-browser measurement harness. The Node runner
// loads this same file for both variants and changes only the URL mount used
// for Cesium and its assets. Keeping the harness identical prevents benchmark
// implementation differences from being mistaken for product differences.
const params = new URL(location.href).searchParams;
const variant = params.get("variant");
if (!["candidate", "baseline"].includes(variant))
  throw new Error("invalid variant");

// Cesium resolves workers relative to CESIUM_BASE_URL. Point it at the selected
// worktree before importing the engine so the candidate fetches its separate
// workers and the baseline uses its own build exactly as shipped.
globalThis.CESIUM_BASE_URL = `/${variant}/packages/engine/Build/`;
const Cesium = await import(
  `/${variant}/packages/engine/Build/Minified/index.js`
);

const container = document.getElementById("cesiumContainer");
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const responsivenessWindowMs = 1500;

function createWidget() {
  container.replaceChildren();

  // Rendering features unrelated to model readiness are disabled. The manual
  // render loop below advances only the public Cesium loading path under test.
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

async function renderUntil(widget, predicate) {
  while (!predicate()) {
    widget.render();
    await frame();
  }
  widget.render();
}

// Observe responsiveness over a fixed wall-clock window that begins at the
// same instant as the public loading call. Frame gaps measure continuity;
// PerformanceObserver long tasks are retained as a separate browser signal.
function monitorResponsiveness(start) {
  const end = start + responsivenessWindowMs;
  const gaps = [];
  // Seed with `start` so the interval between the public call and the first
  // animation-frame callback is measured rather than discarded.
  let previous = start;
  let stopped = false;
  const collectLongTasks = (entries) => {
    for (const entry of entries) {
      const entryEnd = entry.startTime + entry.duration;
      const overlapStart = Math.max(entry.startTime, start);
      const overlapEnd = Math.min(entryEnd, end);
      if (overlapEnd > overlapStart)
        longTasks.push({
          startMs: overlapStart - start,
          durationMs: overlapEnd - overlapStart,
        });
    }
  };
  const observer = new PerformanceObserver((list) =>
    collectLongTasks(list.getEntries()),
  );
  const longTasks = [];
  try {
    observer.observe({ type: "longtask", buffered: false });
  } catch {
    /* browser does not support longtask */
  }
  // A gap is recorded whenever it *begins* inside the window, so a stall that
  // starts before `end` and whose callback lands after it is still counted.
  // Durations are never clipped; a boundary-crossing gap is reported in full.
  // The clamp only ever applies to the seeded first sample: a rAF callback
  // carries its frame's start time, so the first one can predate `start` when
  // a frame was already in flight. That is zero waiting, not a negative gap.
  function tick(now) {
    if (previous < end) gaps.push(Math.max(0, now - previous));
    previous = now;
    if (!stopped && now < end) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return async () => {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, end - performance.now())),
    );
    stopped = true;
    collectLongTasks(observer.takeRecords());
    observer.disconnect();
    return {
      windowMs: responsivenessWindowMs,
      longTaskCount: longTasks.length,
      longTasks,
      frameGapsMs: gaps,
    };
  };
}

globalThis.confirmatoryRun = async ({ id, type, url }) => {
  const widget = createWidget();

  // Engine import, page initialization, and hashing happen before this point.
  // The measurement therefore covers first compressed-asset use, including a
  // separately fetched worker, but not total page or engine startup.
  const start = performance.now();
  const stopResponsivenessMonitor =
    id === "spz-tiles-tower" ? monitorResponsiveness(start) : undefined;

  try {
    if (type === "model") {
      const model = await Cesium.Model.fromGltfAsync({
        url: `/${variant}/${url}`,
      });
      widget.scene.primitives.add(model);
      await renderUntil(widget, () => model.ready);
    } else {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(
        `/${variant}/${url}`,
        // These fixed options avoid request culling while the harness manually
        // positions and renders the camera. They are identical for both builds.
        { cullRequestsWhileMoving: false, maximumScreenSpaceError: 16 },
      );
      widget.scene.primitives.add(tileset);
      if (tileset.boundingSphere)
        widget.camera.viewBoundingSphere(
          tileset.boundingSphere,
          new Cesium.HeadingPitchRange(0, -0.5, 0),
        );

      // tilesLoaded alone can become true before the root's renderable content
      // is ready. Requiring both prevents an early readiness timestamp.
      await renderUntil(
        widget,
        () => tileset.tilesLoaded && tileset.root?.contentReady === true,
      );
    }

    return {
      publicReadyMs: performance.now() - start,
      responsiveness: stopResponsivenessMonitor
        ? await stopResponsivenessMonitor()
        : undefined,
    };
  } finally {
    // A fresh widget is used for every sample. Destroying it prevents Cesium
    // resource state from leaking into the next scenario on the same page.
    widget.destroy();
  }
};

// Record enough browser-side identity to detect comparisons made with a
// different rendering environment. Node records Chromium and machine identity.
globalThis.confirmatoryEnvironment = {
  renderer: (() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl?.getParameter(gl.RENDERER);
  })(),
  userAgent: navigator.userAgent,
};
