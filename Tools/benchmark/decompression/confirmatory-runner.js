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

function widget() {
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
async function waitFor(w, predicate) {
  while (!predicate()) {
    w.render();
    await frame();
  }
  w.render();
}
function monitor(start) {
  const end = start + 1500;
  const gaps = [];
  let previous;
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
  function tick(now) {
    if (previous !== undefined && previous >= start && now <= end)
      gaps.push(now - previous);
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
      windowMs: 1500,
      longTaskCount: longTasks.length,
      longTasks,
      frameGapsMs: gaps,
    };
  };
}
globalThis.confirmatoryRun = async ({ id, type, url }) => {
  const w = widget();
  const start = performance.now();
  const stop = id === "spz-tiles-tower" ? monitor(start) : undefined;
  try {
    if (type === "model") {
      const model = await Cesium.Model.fromGltfAsync({
        url: `/${variant}/${url}`,
      });
      w.scene.primitives.add(model);
      await waitFor(w, () => model.ready);
    } else {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(
        `/${variant}/${url}`,
        { cullRequestsWhileMoving: false, maximumScreenSpaceError: 16 },
      );
      w.scene.primitives.add(tileset);
      if (tileset.boundingSphere)
        w.camera.viewBoundingSphere(
          tileset.boundingSphere,
          new Cesium.HeadingPitchRange(0, -0.5, 0),
        );
      await waitFor(
        w,
        () => tileset.tilesLoaded && tileset.root?.contentReady === true,
      );
    }
    return {
      publicReadyMs: performance.now() - start,
      responsiveness: stop ? await stop() : undefined,
    };
  } finally {
    w.destroy();
  }
};
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
