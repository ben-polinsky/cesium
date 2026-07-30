import { expect, test } from "@playwright/test";
import { startServer } from "./server.js";

let cspServer;

test.beforeAll(async () => {
  cspServer = await startServer();
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => {
    cspServer.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

async function loadResult(page, path) {
  const pageErrors = [];
  const workerUrls = [];
  const workerResponseStart = cspServer.workerResponses.length;
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("worker", (worker) => {
    workerUrls.push(worker.url());
  });

  await page.goto(`${cspServer.url}${path}`);
  await page.waitForFunction(() => window.cspTestResult?.ready);

  return {
    ...(await page.evaluate(() => window.cspTestResult)),
    pageErrors,
    workerResponses: cspServer.workerResponses.slice(workerResponseStart),
    workerUrls,
  };
}

test("the control policy permits the current engine build", async ({
  page,
}) => {
  const result = await loadResult(page, "/csp/control");

  expect(result.imported).toBe(true);
  expect(result.violations).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.pageErrors).toEqual([]);
});

test("loads the engine under a worker-only WASM policy", async ({ page }) => {
  const result = await loadResult(page, "/csp/worker-only");

  expect(result.imported).toBe(true);
  expect(result.violations).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.pageErrors).toEqual([]);
});

function expectSuccessfulWorkerFeature(result, workerName) {
  const workerFile = `/${workerName}.js`;
  expect(result.imported).toBe(true);
  expect(result.workerUrls.some((url) => url.endsWith(workerFile))).toBe(true);
  const workerResponse = result.workerResponses.find(({ path }) =>
    path.endsWith(workerFile),
  );
  expect(workerResponse.policy).toContain(
    "script-src 'self' 'wasm-unsafe-eval'",
  );
  expect(workerResponse.status).toBe(200);
  expect(result.featureCompleted).toBe(true);
  expect(result.violations).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.pageErrors).toEqual([]);
}

test("decodes SPZ with only the worker WASM policy", async ({ page }) => {
  const result = await loadResult(page, "/csp/worker-only?feature=spz");
  expectSuccessfulWorkerFeature(result, "decodeSpz");
});

test("decodes meshopt with only the worker WASM policy", async ({ page }) => {
  const result = await loadResult(page, "/csp/worker-only?feature=meshopt");
  expectSuccessfulWorkerFeature(result, "decodeMeshopt");
});

// The vendored Basis transcoder is built by Emscripten's embind without
// DYNAMIC_EXECUTION=0, so its `new Function` invokers need ordinary
// 'unsafe-eval' rather than just 'wasm-unsafe-eval'. Moving the transcoder into
// a worker was never going to be enough on its own; this passes once
// basis_universal ships a CSP-safe build.
// https://github.com/CesiumGS/cesium/issues/13617
test("transcodes KTX2 with only the worker WASM policy", async ({ page }) => {
  const result = await loadResult(page, "/csp/worker-only?feature=ktx2");
  expect(result.errors).toEqual([]);
  expectSuccessfulWorkerFeature(result, "transcodeKTX2");
  expect(result.featureDetails.width).toBe(4);
  expect(result.featureDetails.height).toBe(4);
  expect(result.featureDetails.byteLength).toBeGreaterThan(0);
});

test("renders meshopt-compressed terrain with only the worker WASM policy", async ({
  page,
}) => {
  const result = await loadResult(page, "/csp/worker-only?feature=terrain");
  expectSuccessfulWorkerFeature(
    result,
    "createVerticesFromCesium3DTilesTerrain",
  );
  expect(result.featureDetails.tile).toEqual({ level: 0, x: 0, y: 0 });
  expect(result.featureDetails.vertexCountWithoutSkirts).toBe(248);
  expect(result.featureDetails.indexCountWithoutSkirts).toBe(1380);
  expect(result.featureDetails.pixel[0]).toBeGreaterThan(
    result.featureDetails.pixel[1],
  );
  expect(result.featureDetails.pixel[0]).toBeGreaterThan(
    result.featureDetails.pixel[2],
  );
  expect(result.featureDetails.pixel[3]).toBe(255);
});

test("blocks direct WASM compilation on the main thread", async ({ page }) => {
  const result = await loadResult(page, "/csp/worker-only?feature=main-wasm");

  expect(result.imported).toBe(true);
  expect(result.wasmBlocked).toBe(true);
  expect(result.workerUrls).toEqual([]);
});
