// Public 14-asset decompression benchmark page.
//
// Playwright calls runCesiumDecompressionScenario(scenario) for each row in
// scenarios.json. This loads that asset through its public Cesium API and
// times how long it takes to reach that API's own "ready" condition -
// nothing internal to Cesium is measured or instrumented.
const Cesium = globalThis.Cesium;

if (!Cesium) {
  throw new Error("Cesium production bundle was not loaded.");
}

const statusElement = document.getElementById("status");
const readyTimeoutMs = 120000;

function resolveUrl(relativePath) {
  return new URL(relativePath, `${location.origin}/`).href;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

// Every scenario uses the same minimal widget: no globe/imagery/atmosphere and
// a manually driven render loop, so only the asset under test affects timing.
function createWidget() {
  const container = document.getElementById("cesiumContainer");
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

async function waitUntil(widget, predicate, description) {
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

async function runModelScenario(scenario) {
  const widget = createWidget();
  try {
    const started = performance.now();
    const model = await Cesium.Model.fromGltfAsync({
      url: resolveUrl(scenario.url),
    });
    widget.scene.primitives.add(model);
    await waitUntil(widget, () => model.ready, "Model.ready");
    return performance.now() - started;
  } finally {
    widget.destroy();
  }
}

async function runTilesetScenario(scenario) {
  const widget = createWidget();
  try {
    const started = performance.now();
    const tileset = await Cesium.Cesium3DTileset.fromUrl(
      resolveUrl(scenario.url),
      { maximumScreenSpaceError: 16 },
    );
    widget.scene.primitives.add(tileset);
    await waitUntil(
      widget,
      () => tileset.tilesLoaded && tileset.root?.contentReady === true,
      "initial tiles",
    );
    return performance.now() - started;
  } finally {
    widget.destroy();
  }
}

async function runI3SScenario(scenario) {
  const widget = createWidget();
  try {
    const started = performance.now();
    const provider = await Cesium.I3SDataProvider.fromUrl(
      resolveUrl(scenario.url),
      { cesium3dTilesetOptions: { maximumScreenSpaceError: 16 } },
    );
    widget.scene.primitives.add(provider);
    const tilesets = provider.layers
      .map((layer) => layer.tileset)
      .filter((tileset) => tileset !== undefined);
    await waitUntil(
      widget,
      () => tilesets.every((tileset) => tileset.tilesLoaded),
      "I3S initial tiles",
    );
    return performance.now() - started;
  } finally {
    widget.destroy();
  }
}

async function runKmlScenario(scenario) {
  const widget = createWidget();
  try {
    const started = performance.now();
    const dataSource = await Cesium.KmlDataSource.load(
      resolveUrl(scenario.url),
    );
    await widget.dataSources.add(dataSource);
    await waitUntil(widget, () => !dataSource.isLoading, "KML data source");
    return performance.now() - started;
  } finally {
    widget.destroy();
  }
}

async function runGeeScenario(scenario) {
  const started = performance.now();
  await Cesium.GoogleEarthEnterpriseMetadata.fromUrl(resolveUrl(scenario.url));
  return performance.now() - started;
}

const scenarioRunnersByApi = {
  "Model.fromGltfAsync": runModelScenario,
  "Cesium3DTileset.fromUrl": runTilesetScenario,
  "I3SDataProvider.fromUrl": runI3SScenario,
  "KmlDataSource.load": runKmlScenario,
  "GoogleEarthEnterpriseMetadata.fromUrl": runGeeScenario,
};

async function runScenario(scenario) {
  statusElement.textContent = `Running ${scenario.id}...`;
  const run = scenarioRunnersByApi[scenario.api];
  if (!run) {
    throw new Error(`Unsupported public API ${scenario.api}`);
  }
  const durationMs = await run(scenario);
  return { durationMs };
}

globalThis.decompressionBenchmarkReady = true;
globalThis.runCesiumDecompressionScenario = runScenario;
