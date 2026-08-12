const variant = new URL(location.href).searchParams.get("variant");
if (variant !== "candidate") throw new Error("invalid variant");

globalThis.CESIUM_BASE_URL = `/${variant}/packages/engine/Build/`;
const Cesium = await import(
  `/${variant}/packages/engine/Build/Unminified/index.js`
);
const container = document.getElementById("cesiumContainer");
const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(resolve));

function assetUrl(path) {
  return new URL(`/${variant}/${path}`, location.origin).href;
}

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

async function renderUntil(widget, ready, description) {
  const deadline = performance.now() + 120000;
  while (!ready()) {
    if (performance.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    widget.render();
    await nextFrame();
  }
  widget.render();
}

async function loadModel(scenario) {
  const widget = createWidget();
  const started = performance.now();
  try {
    const model = await Cesium.Model.fromGltfAsync({
      url: assetUrl(scenario.url),
    });
    widget.scene.primitives.add(model);
    await renderUntil(widget, () => model.ready, "Model.ready");
    return performance.now() - started;
  } finally {
    widget.destroy();
  }
}

async function loadTileset(scenario) {
  const widget = createWidget();
  const started = performance.now();
  try {
    const tileset = await Cesium.Cesium3DTileset.fromUrl(
      assetUrl(scenario.url),
      {
        cullRequestsWhileMoving: false,
        maximumScreenSpaceError: 16,
      },
    );
    widget.scene.primitives.add(tileset);
    if (tileset.boundingSphere) {
      widget.camera.viewBoundingSphere(
        tileset.boundingSphere,
        new Cesium.HeadingPitchRange(0, -0.5, 0),
      );
    }
    let failure;
    tileset.tileFailed.addEventListener((error) => {
      failure = error;
    });
    await renderUntil(
      widget,
      () => {
        if (failure)
          throw new Error(`Tileset content failed: ${failure.message}`);
        return tileset.tilesLoaded && tileset.root?.contentReady === true;
      },
      "initial tiles",
    );
    return performance.now() - started;
  } finally {
    widget.destroy();
  }
}

async function loadKml(scenario) {
  const widget = createWidget();
  const started = performance.now();
  try {
    const dataSource = await Cesium.KmlDataSource.load(assetUrl(scenario.url));
    await widget.dataSources.add(dataSource);
    let rendered = false;
    await renderUntil(widget, () => !dataSource.isLoading && rendered++, "KML");
    return performance.now() - started;
  } finally {
    widget.destroy();
  }
}

async function loadGee(scenario) {
  const started = performance.now();
  await Cesium.GoogleEarthEnterpriseMetadata.fromUrl(assetUrl(scenario.url));
  return performance.now() - started;
}

globalThis.fullSweepRun = async (scenario) => {
  const publicReadyMs =
    scenario.api === "Model.fromGltfAsync"
      ? await loadModel(scenario)
      : scenario.api === "Cesium3DTileset.fromUrl"
        ? await loadTileset(scenario)
        : scenario.api === "KmlDataSource.load"
          ? await loadKml(scenario)
          : scenario.api.startsWith("GoogleEarthEnterprise")
            ? await loadGee(scenario)
            : undefined;
  if (publicReadyMs === undefined) {
    throw new Error(`Unsupported API ${scenario.api}`);
  }
  return { publicReadyMs };
};

globalThis.fullSweepReady = true;
