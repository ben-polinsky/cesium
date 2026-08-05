#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import express from "express";
import path from "node:path";
import process from "node:process";

const repositoryRoot = "/Users/benpolinsky/source/cesium";
const fixtureDirectory = path.join(
  repositoryRoot,
  "Build",
  "Performance",
  "Decompression",
  "MeshoptGranularity",
);
const committedFixtureDirectory = path.join(
  repositoryRoot,
  "Specs",
  "Data",
  "Performance",
  "Decompression",
  "meshopt-task-shapes",
);
const benchmarkPage = "/Tools/benchmark/decompression/benchmark.html";
const viewport = { width: 1280, height: 720 };
const primitiveCount = 200;
const totalCompressedBytes = 9540;
const defaultPort = 8111;
const defaultColdIterations = 10;
const defaultWarmIterations = 30;
const defaultSeed = 12345;

const workloads = [
  {
    id: "meshopt-granularity-1-view",
    label: "1 compressed view",
    uniqueCompressedViews: 1,
    specGroups: [
      {
        recipe: "triangle",
        count: 378,
        byteStride: 56,
        expectedCompressedBytes: 9540,
        instances: 1,
      },
    ],
  },
  {
    id: "meshopt-granularity-10-view",
    label: "10 compressed views",
    uniqueCompressedViews: 10,
    specGroups: [
      {
        recipe: "ramp",
        count: 32,
        byteStride: 80,
        expectedCompressedBytes: 800,
        instances: 4,
      },
      {
        recipe: "grid",
        count: 24,
        byteStride: 80,
        expectedCompressedBytes: 875,
        instances: 1,
      },
      {
        recipe: "ramp",
        count: 128,
        byteStride: 12,
        expectedCompressedBytes: 1093,
        instances: 5,
      },
    ],
  },
  {
    id: "meshopt-granularity-60-view",
    label: "60 compressed views",
    uniqueCompressedViews: 60,
    specGroups: [
      {
        recipe: "grid",
        count: 17,
        byteStride: 20,
        expectedCompressedBytes: 159,
        instances: 60,
      },
    ],
  },
  {
    id: "meshopt-granularity-200-view",
    label: "200 compressed views",
    uniqueCompressedViews: 200,
    specGroups: [
      {
        recipe: "repeat",
        count: 7,
        byteStride: 12,
        expectedCompressedBytes: 45,
        instances: 65,
      },
      {
        recipe: "repeat",
        count: 7,
        byteStride: 16,
        expectedCompressedBytes: 49,
        instances: 135,
      },
    ],
  },
];

function parseArgs(argv) {
  const options = {
    output: path.join(
      "/Users/benpolinsky/.copilot/session-state/8fb6c56b-779c-4fe6-a163-a2f6aa322ec4/files",
      "meshopt-granularity-experiment.json",
    ),
    port: defaultPort,
    coldIterations: defaultColdIterations,
    warmIterations: defaultWarmIterations,
    seed: defaultSeed,
    useCommitted: false,
  };

  function nextValue(argument, index) {
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
    if (argument.startsWith("--output")) {
      options.output = nextValue(argument, index);
      if (!argument.includes("=")) {
        ++index;
      }
      continue;
    }
    if (argument.startsWith("--port")) {
      options.port = Number(nextValue(argument, index));
      if (!argument.includes("=")) {
        ++index;
      }
      continue;
    }
    if (argument.startsWith("--cold-iterations")) {
      options.coldIterations = Number(nextValue(argument, index));
      if (!argument.includes("=")) {
        ++index;
      }
      continue;
    }
    if (argument.startsWith("--warm-iterations")) {
      options.warmIterations = Number(nextValue(argument, index));
      if (!argument.includes("=")) {
        ++index;
      }
      continue;
    }
    if (argument.startsWith("--seed")) {
      options.seed = Number(nextValue(argument, index));
      if (!argument.includes("=")) {
        ++index;
      }
      continue;
    }
    if (argument === "--use-committed") {
      options.useCommitted = true;
      continue;
    }
    throw new Error(`Unknown argument ${argument}`);
  }

  return options;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; --index) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function quantile(sortedValues, fraction) {
  if (sortedValues.length === 0) {
    return null;
  }
  const position = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sortedValues[lower];
  }
  return (
    sortedValues[lower] +
    (sortedValues[upper] - sortedValues[lower]) * (position - lower)
  );
}

function summarizeNumeric(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    sampleCount: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
  };
}

function recipePosition(recipe, index) {
  if (recipe === "repeat") {
    return [0, 0, 0];
  }
  if (recipe === "triangle") {
    const points = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    return points[index % points.length];
  }
  if (recipe === "grid") {
    return [index % 8, Math.floor(index / 8) % 8, Math.floor(index / 64) % 8];
  }
  if (recipe === "ramp") {
    return [index * 0.1, index * 0.2, index * 0.3];
  }
  throw new Error(`Unsupported recipe ${recipe}`);
}

function createSourceBytes(spec) {
  const source = new ArrayBuffer(spec.count * spec.byteStride);
  const view = new DataView(source);
  let min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  let max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];

  for (let index = 0; index < spec.count; ++index) {
    const offset = index * spec.byteStride;
    const [x, y, z] = recipePosition(spec.recipe, index);
    view.setFloat32(offset + 0, x, true);
    view.setFloat32(offset + 4, y, true);
    view.setFloat32(offset + 8, z, true);
    min = [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)];
    max = [Math.max(max[0], x), Math.max(max[1], y), Math.max(max[2], z)];

    for (let byteOffset = 12; byteOffset < spec.byteStride; byteOffset += 4) {
      if (byteOffset + 4 > spec.byteStride) {
        break;
      }
      let value;
      if (spec.recipe === "repeat") {
        value = 0;
      } else if (spec.recipe === "triangle") {
        value = index % 3;
      } else if (spec.recipe === "grid") {
        value = (index + byteOffset) % 17;
      } else if (spec.recipe === "ramp") {
        value = index + byteOffset;
      }
      view.setFloat32(offset + byteOffset, value, true);
    }
  }

  return {
    bytes: new Uint8Array(source),
    min,
    max,
  };
}

async function generateWorkloads() {
  await MeshoptEncoder.ready;
  await mkdir(fixtureDirectory, { recursive: true });

  const generated = [];
  for (const workload of workloads) {
    const uniqueViews = [];
    let actualCompressedBytes = 0;
    let totalDecodedBytes = 0;

    for (const group of workload.specGroups) {
      for (let index = 0; index < group.instances; ++index) {
        const source = createSourceBytes(group);
        const compressed = MeshoptEncoder.encodeGltfBuffer(
          source.bytes,
          group.count,
          group.byteStride,
          "ATTRIBUTES",
        );
        assert(
          compressed.length === group.expectedCompressedBytes,
          `${workload.id} expected ${group.expectedCompressedBytes} compressed bytes for ${group.recipe}/${group.count}/${group.byteStride}, got ${compressed.length}`,
        );
        uniqueViews.push({
          recipe: group.recipe,
          count: group.count,
          byteStride: group.byteStride,
          compressedBytes: compressed.length,
          decodedBytes: source.bytes.byteLength,
          min: source.min,
          max: source.max,
          compressed,
        });
        actualCompressedBytes += compressed.length;
        totalDecodedBytes += source.bytes.byteLength;
      }
    }

    assert(
      uniqueViews.length === workload.uniqueCompressedViews,
      `${workload.id} generated ${uniqueViews.length} unique views instead of ${workload.uniqueCompressedViews}`,
    );
    assert(
      actualCompressedBytes === totalCompressedBytes,
      `${workload.id} compressed byte total ${actualCompressedBytes} did not match ${totalCompressedBytes}`,
    );

    let compressedOffset = 0;
    let fallbackOffset = 0;
    const bufferViews = [];
    const accessors = [];
    const primitives = [];
    const binaryChunks = [];

    for (let index = 0; index < uniqueViews.length; ++index) {
      const view = uniqueViews[index];
      bufferViews.push({
        buffer: 1,
        byteOffset: fallbackOffset,
        byteLength: view.decodedBytes,
        byteStride: view.byteStride,
        target: 34962,
        extensions: {
          KHR_meshopt_compression: {
            buffer: 0,
            byteOffset: compressedOffset,
            byteLength: view.compressedBytes,
            byteStride: view.byteStride,
            count: view.count,
            mode: "ATTRIBUTES",
            filter: "NONE",
          },
        },
      });
      accessors.push({
        bufferView: index,
        byteOffset: 0,
        componentType: 5126,
        count: view.count,
        type: "VEC3",
        min: view.min,
        max: view.max,
      });
      compressedOffset += view.compressedBytes;
      fallbackOffset += view.decodedBytes;
      binaryChunks.push(Buffer.from(view.compressed));
    }

    const indexByteOffset = compressedOffset % 2 === 0 ? compressedOffset : compressedOffset + 1;
    if (indexByteOffset !== compressedOffset) {
      binaryChunks.push(Buffer.from([0]));
      compressedOffset = indexByteOffset;
    }

    const indexBufferViewIndex = bufferViews.length;
    const indexAccessorIndex = accessors.length;
    const indexBytes = Buffer.from([0, 0, 1, 0, 2, 0]);
    binaryChunks.push(indexBytes);
    bufferViews.push({
      buffer: 0,
      byteOffset: indexByteOffset,
      byteLength: indexBytes.byteLength,
      target: 34963,
    });
    accessors.push({
      bufferView: indexBufferViewIndex,
      byteOffset: 0,
      componentType: 5123,
      count: 3,
      type: "SCALAR",
      min: [0],
      max: [2],
    });

    for (let primitiveIndex = 0; primitiveIndex < primitiveCount; ++primitiveIndex) {
      primitives.push({
        attributes: {
          POSITION: primitiveIndex % uniqueViews.length,
        },
        indices: indexAccessorIndex,
        material: 0,
      });
    }

    const gltf = {
      asset: { version: "2.0" },
      extensionsUsed: ["KHR_meshopt_compression"],
      extensionsRequired: ["KHR_meshopt_compression"],
      buffers: [
        {
          uri: `${workload.id}.bin`,
          byteLength: indexByteOffset + indexBytes.byteLength,
        },
        {
          byteLength: totalDecodedBytes,
          extensions: {
            KHR_meshopt_compression: {
              fallback: true,
            },
          },
        },
      ],
      bufferViews,
      accessors,
      materials: [{ pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } }],
      meshes: [{ primitives }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    };

    const gltfPath = path.join(fixtureDirectory, `${workload.id}.gltf`);
    const binPath = path.join(fixtureDirectory, `${workload.id}.bin`);
    await writeFile(gltfPath, `${JSON.stringify(gltf, null, 2)}\n`, "utf8");
    await writeFile(binPath, Buffer.concat(binaryChunks));

    generated.push({
      id: workload.id,
      label: workload.label,
      category: "gltf",
      compression: "meshopt",
      api: "Model.fromGltfAsync",
      url: path.relative(repositoryRoot, gltfPath).replaceAll(path.sep, "/"),
      resourcePrefix: path
        .relative(repositoryRoot, fixtureDirectory)
        .replaceAll(path.sep, "/"),
      fixtureFiles: [
        path.relative(repositoryRoot, gltfPath).replaceAll(path.sep, "/"),
        path.relative(repositoryRoot, binPath).replaceAll(path.sep, "/"),
      ],
      construction: {
        totalCompressedBytes,
        totalDecodedBytes,
        uniqueCompressedViews: workload.uniqueCompressedViews,
        primitiveCount,
        primitiveToUniqueViewMapping: "primitiveIndex % uniqueCompressedViews",
        specGroups: workload.specGroups,
      },
    });
  }

  return generated;
}

async function loadCommittedWorkloads() {
  const manifestPath = path.join(committedFixtureDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert(
    manifest.encoder?.package === "meshoptimizer" &&
      manifest.encoder.version === "1.2.0",
    "committed Meshopt corpus has unexpected encoder provenance",
  );

  return manifest.fixtures.map((fixture) => ({
    id: fixture.id,
    label: fixture.label,
    category: "gltf",
    compression: "meshopt",
    api: "Model.fromGltfAsync",
    url: fixture.gltf,
    resourcePrefix: `${path.posix.dirname(fixture.gltf)}/`,
    fixtureFiles: [
      fixture.gltf,
      fixture.binary,
      "Specs/Data/Performance/Decompression/meshopt-task-shapes/manifest.json",
    ],
    uniqueCompressedViews: fixture.construction.uniqueCompressedViews,
    construction: {
      totalCompressedBytes: fixture.construction.compressedBytes,
      totalDecodedBytes: fixture.construction.decodedAttributeBytes,
      uniqueCompressedViews: fixture.construction.uniqueCompressedViews,
      primitiveCount: fixture.construction.primitiveCount,
      primitiveToUniqueViewMapping:
        fixture.construction.primitiveToUniqueViewMapping,
      specGroups: fixture.construction.specGroups,
    },
  }));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore while waiting
    }
    await wait(500);
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function startServer(port) {
  const app = express();
  app.use(express.static(repositoryRoot));
  const server = await new Promise((resolve, reject) => {
    const created = app.listen(port, "127.0.0.1", () => resolve(created));
    created.on("error", reject);
  });
  await waitForServer(`http://localhost:${port}`);
  return server;
}

async function stopServer(server) {
  if (!server?.listening) {
    return;
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function openBenchmarkPage(browser, baseUrl) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${baseUrl}${benchmarkPage}`, { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.decompressionBenchmarkReady === true);
  const pageEnvironment = await page.evaluate(() => ({
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    performanceMemorySupported:
      typeof performance.memory?.usedJSHeapSize === "number",
    userAgentSpecificMemorySupported:
      typeof performance.measureUserAgentSpecificMemory === "function",
    longTaskSupported:
      Array.isArray(PerformanceObserver?.supportedEntryTypes) &&
      PerformanceObserver.supportedEntryTypes.includes("longtask"),
  }));
  return { context, page, pageEnvironment };
}

async function runMeasuredScenario(page, scenario) {
  const response = await page.evaluate(async (browserScenarioValue) => {
    const metrics = {
      longTasks: {
        supported: Array.isArray(PerformanceObserver?.supportedEntryTypes) &&
          PerformanceObserver.supportedEntryTypes.includes("longtask"),
        entries: [],
      },
      frameGaps: {
        entries: [],
      },
      memory: {
        jsHeapBefore: typeof performance.memory?.usedJSHeapSize === "number"
          ? performance.memory.usedJSHeapSize
          : null,
        jsHeapAfter: null,
        jsHeapDelta: null,
        userAgentSpecificAfterBytes: null,
        userAgentSpecificError: null,
      },
    };

    const measurementStart = performance.now();
    let observer;
    if (metrics.longTasks.supported) {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime < measurementStart) {
            continue;
          }
          metrics.longTasks.entries.push({
            startTime: entry.startTime,
            duration: entry.duration,
            name: entry.name,
          });
        }
      });
      observer.observe({ type: "longtask" });
    }

    let rafActive = true;
    let lastFrame = performance.now();
    let resolveFrames;
    const framesFinished = new Promise((resolve) => {
      resolveFrames = resolve;
    });

    function onFrame(timestamp) {
      metrics.frameGaps.entries.push(timestamp - lastFrame);
      lastFrame = timestamp;
      if (rafActive) {
        requestAnimationFrame(onFrame);
      } else {
        resolveFrames();
      }
    }
    requestAnimationFrame(onFrame);

    try {
      const result = await globalThis.runCesiumDecompressionScenario(
        browserScenarioValue,
      );
      rafActive = false;
      await framesFinished;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (observer) {
        observer.disconnect();
      }
      metrics.memory.jsHeapAfter =
        typeof performance.memory?.usedJSHeapSize === "number"
          ? performance.memory.usedJSHeapSize
          : null;
      metrics.memory.jsHeapDelta =
        metrics.memory.jsHeapAfter !== null && metrics.memory.jsHeapBefore !== null
          ? metrics.memory.jsHeapAfter - metrics.memory.jsHeapBefore
          : null;
      if (typeof performance.measureUserAgentSpecificMemory === "function") {
        try {
          const snapshot = await performance.measureUserAgentSpecificMemory();
          metrics.memory.userAgentSpecificAfterBytes = snapshot.bytes;
        } catch (error) {
          metrics.memory.userAgentSpecificError =
            error?.message ?? String(error);
        }
      }
      return { ok: true, result, metrics };
    } catch (error) {
      rafActive = false;
      await framesFinished;
      if (observer) {
        observer.disconnect();
      }
      return {
        ok: false,
        error: {
          name: error?.name,
          message: error?.message ?? String(error),
          stack: error?.stack,
        },
      };
    }
  }, scenario);

  if (!response.ok) {
    throw new Error(
      `${scenario.id} failed in the browser: ${response.error.name ?? "Error"}: ${response.error.message}\n${response.error.stack ?? ""}`,
    );
  }
  return response;
}

function createScenarioDescriptor(workload) {
  return {
    id: workload.id,
    api: workload.api,
    compression: workload.compression,
    url: workload.url,
    resourcePrefix: `${workload.resourcePrefix}/`,
  };
}

function browserIdentity(browser, pageEnvironment) {
  return {
    browserName: browser.browserType().name(),
    browserVersion: browser.version(),
    executablePath: browser.browserType().executablePath(),
    hardwareConcurrency: pageEnvironment.hardwareConcurrency,
    userAgent: pageEnvironment.userAgent,
    devicePixelRatio: pageEnvironment.devicePixelRatio,
    viewport,
  };
}

function measureLongTasks(entries) {
  const durations = entries.map((entry) => entry.duration);
  return {
    supported: entries !== null,
    count: durations.length,
    totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
    maxDurationMs: durations.length > 0 ? Math.max(...durations) : 0,
    p95DurationMs: durations.length > 0
      ? quantile([...durations].sort((a, b) => a - b), 0.95)
      : 0,
  };
}

function measureFrameGaps(entries) {
  const filtered = entries.filter((value) => Number.isFinite(value) && value > 0);
  const sorted = [...filtered].sort((left, right) => left - right);
  return {
    sampleCount: filtered.length,
    maxGapMs: filtered.length > 0 ? sorted[sorted.length - 1] : 0,
    p95GapMs: filtered.length > 0 ? quantile(sorted, 0.95) : 0,
    over50Ms: filtered.filter((value) => value > 50).length,
  };
}

function buildRun({
  workload,
  state,
  sampleIndex,
  orderIndex,
  response,
  browser,
  pageEnvironment,
}) {
  return {
    scenarioId: workload.id,
    label: workload.label,
    uniqueCompressedViews: workload.uniqueCompressedViews,
    totalCompressedBytes: workload.construction.totalCompressedBytes,
    totalDecodedBytes: workload.construction.totalDecodedBytes,
    state,
    sampleIndex,
    orderIndex,
    timing: response.result.timing,
    resourceTiming: response.result.resourceTiming,
    readiness: response.result.readiness,
    decoderLifecycle: response.result.decoderLifecycle,
    browser: browserIdentity(browser, pageEnvironment),
    pageEnvironment,
    diagnostics: {
      longTasks: response.metrics.longTasks.supported
        ? measureLongTasks(response.metrics.longTasks.entries)
        : {
            supported: false,
            count: null,
            totalDurationMs: null,
            maxDurationMs: null,
            p95DurationMs: null,
          },
      frameGaps: measureFrameGaps(response.metrics.frameGaps.entries),
      memory: response.metrics.memory,
    },
  };
}

async function runColdSamples(baseUrl, scenarios, options) {
  const random = createRandom(options.seed);
  const runs = [];
  const sampleOrder = [];

  for (let sampleIndex = 0; sampleIndex < options.coldIterations; ++sampleIndex) {
    const order = shuffled(scenarios, random);
    sampleOrder.push({ state: "cold", sampleIndex, scenarioIds: order.map((scenario) => scenario.id) });
    for (let orderIndex = 0; orderIndex < order.length; ++orderIndex) {
      const workload = order[orderIndex];
      const browser = await chromium.launch({ headless: true });
      try {
        const execution = await openBenchmarkPage(browser, baseUrl);
        try {
          const response = await runMeasuredScenario(
            execution.page,
            createScenarioDescriptor(workload),
          );
          runs.push(
            buildRun({
              workload,
              state: "cold",
              sampleIndex,
              orderIndex,
              response,
              browser,
              pageEnvironment: execution.pageEnvironment,
            }),
          );
        } finally {
          await execution.context.close();
        }
      } finally {
        await browser.close();
      }
    }
  }

  return { runs, sampleOrder };
}

async function warmPage(baseUrl, workloads, options) {
  const random = createRandom(options.seed ^ 0x9e3779b9);
  const browser = await chromium.launch({ headless: true });
  const execution = await openBenchmarkPage(browser, baseUrl);
  const order = shuffled(workloads, random);
  for (const workload of order) {
    const response = await execution.page.evaluate(async (browserScenarioValue) => {
      try {
        await globalThis.runCesiumDecompressionScenario(browserScenarioValue);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: {
            name: error?.name,
            message: error?.message ?? String(error),
            stack: error?.stack,
          },
        };
      }
    }, createScenarioDescriptor(workload));
    if (!response.ok) {
      await execution.context.close();
      await browser.close();
      throw new Error(
        `Warmup failed for ${workload.id}: ${response.error.name ?? "Error"}: ${response.error.message}\n${response.error.stack ?? ""}`,
      );
    }
  }
  return { browser, execution };
}

async function runWarmSamples(baseUrl, scenarios, options) {
  const random = createRandom(options.seed ^ 0x85ebca6b);
  const runs = [];
  const sampleOrder = [];
  const { browser, execution } = await warmPage(baseUrl, scenarios, options);

  try {
    for (let sampleIndex = 0; sampleIndex < options.warmIterations; ++sampleIndex) {
      const order = shuffled(scenarios, random);
      sampleOrder.push({ state: "warm", sampleIndex, scenarioIds: order.map((scenario) => scenario.id) });
      for (let orderIndex = 0; orderIndex < order.length; ++orderIndex) {
        const workload = order[orderIndex];
        const response = await runMeasuredScenario(
          execution.page,
          createScenarioDescriptor(workload),
        );
        runs.push(
          buildRun({
            workload,
            state: "warm",
            sampleIndex,
            orderIndex,
            response,
            browser,
            pageEnvironment: execution.pageEnvironment,
          }),
        );
      }
    }
  } finally {
    await execution.context.close();
    await browser.close();
  }

  return { runs, sampleOrder };
}

function summarizeRuns(runs, workloadDefinitions) {
  return workloadDefinitions.map((workload) => {
    const byState = {};
    for (const state of ["cold", "warm"]) {
      const stateRuns = runs.filter(
        (run) => run.scenarioId === workload.id && run.state === state,
      );
      byState[state] = {
        publicReadyMs: summarizeNumeric(
          stateRuns.map((run) => run.timing.milestonesMs.publicReady),
        ),
        apiResolvedMs: summarizeNumeric(
          stateRuns.map((run) => run.timing.milestonesMs.apiResolved),
        ),
        longTaskCount: summarizeNumeric(
          stateRuns
            .map((run) => run.diagnostics.longTasks.count)
            .filter((value) => value !== null),
        ),
        longTaskTotalDurationMs: summarizeNumeric(
          stateRuns
            .map((run) => run.diagnostics.longTasks.totalDurationMs)
            .filter((value) => value !== null),
        ),
        frameGapMaxMs: summarizeNumeric(
          stateRuns.map((run) => run.diagnostics.frameGaps.maxGapMs),
        ),
        frameGapP95Ms: summarizeNumeric(
          stateRuns.map((run) => run.diagnostics.frameGaps.p95GapMs),
        ),
        jsHeapDeltaBytes: summarizeNumeric(
          stateRuns
            .map((run) => run.diagnostics.memory.jsHeapDelta)
            .filter((value) => value !== null),
        ),
        userAgentSpecificAfterBytes: summarizeNumeric(
          stateRuns
            .map((run) => run.diagnostics.memory.userAgentSpecificAfterBytes)
            .filter((value) => value !== null),
        ),
      };
    }
    return {
      scenarioId: workload.id,
      label: workload.label,
      uniqueCompressedViews: workload.uniqueCompressedViews,
      totalCompressedBytes: workload.construction.totalCompressedBytes,
      totalDecodedBytes: workload.construction.totalDecodedBytes,
      states: byState,
    };
  });
}

function compareToBaseline(summary, state, baselineScenarioId, candidateScenarioId) {
  const baseline = summary.find((entry) => entry.scenarioId === baselineScenarioId);
  const candidate = summary.find((entry) => entry.scenarioId === candidateScenarioId);
  const baselineMedian = baseline?.states?.[state]?.publicReadyMs?.median;
  const candidateMedian = candidate?.states?.[state]?.publicReadyMs?.median;
  if (baselineMedian === null || baselineMedian === undefined || candidateMedian === null || candidateMedian === undefined) {
    return null;
  }
  const deltaMs = candidateMedian - baselineMedian;
  const deltaPercent = baselineMedian === 0 ? null : (deltaMs / baselineMedian) * 100;
  return {
    state,
    baselineScenarioId,
    candidateScenarioId,
    baselineMedianMs: baselineMedian,
    candidateMedianMs: candidateMedian,
    deltaMs,
    deltaPercent,
    exceedsGate:
      deltaMs > 5 ||
      (deltaPercent !== null && deltaPercent > 5),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const activeWorkloads = options.useCommitted
    ? await loadCommittedWorkloads()
    : workloads;
  if (!options.useCommitted) {
    const generatedWorkloads = await generateWorkloads();
    for (const generated of generatedWorkloads) {
      const workload = workloads.find((entry) => entry.id === generated.id);
      workload.api = generated.api;
      workload.compression = generated.compression;
      workload.url = generated.url;
      workload.resourcePrefix = generated.resourcePrefix;
      workload.fixtureFiles = generated.fixtureFiles;
      workload.construction = generated.construction;
    }
  }

  const baseUrl = `http://localhost:${options.port}`;
  const server = await startServer(options.port);
  let outputDocument;
  try {
    const cold = await runColdSamples(baseUrl, activeWorkloads, options);
    const warm = await runWarmSamples(baseUrl, activeWorkloads, options);
    const runs = [...cold.runs, ...warm.runs];
    const summary = summarizeRuns(runs, activeWorkloads);
    const baselineScenarioId = options.useCommitted
      ? "meshopt-task-shape-1-view"
      : "meshopt-granularity-1-view";
    const manyViewScenarioId = options.useCommitted
      ? "meshopt-task-shape-200-view"
      : "meshopt-granularity-200-view";
    const sixtyViewScenarioId = options.useCommitted
      ? "meshopt-task-shape-60-view"
      : "meshopt-granularity-60-view";
    const decision = [
      compareToBaseline(summary, "cold", baselineScenarioId, manyViewScenarioId),
      compareToBaseline(summary, "warm", baselineScenarioId, manyViewScenarioId),
      compareToBaseline(summary, "cold", baselineScenarioId, sixtyViewScenarioId),
      compareToBaseline(summary, "warm", baselineScenarioId, sixtyViewScenarioId),
    ].filter(Boolean);

    outputDocument = {
      schemaVersion: 1,
      status: "ok",
      generatedAt: new Date().toISOString(),
      runner: {
        cwd: process.cwd(),
        repositoryRoot,
        gitHead: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repositoryRoot,
          encoding: "utf8",
        }).trim(),
        dirty: execFileSync("git", ["status", "--short"], {
          cwd: repositoryRoot,
          encoding: "utf8",
        })
          .trim()
          .length > 0,
        nodeVersion: process.version,
      },
      plan: {
        states: ["cold", "warm"],
        coldIterations: options.coldIterations,
        warmIterations: options.warmIterations,
        seed: options.seed,
        port: options.port,
        timer: "browser performance.now() from public API call to Model.ready",
        primitiveCount,
        equalCompressedBytesTarget: totalCompressedBytes,
        corpus: options.useCommitted ? "committed" : "generated",
      },
      scenarios: activeWorkloads.map((workload) => ({
        id: workload.id,
        label: workload.label,
        url: workload.url,
        resourcePrefix: workload.resourcePrefix,
        fixtureFiles: workload.fixtureFiles,
        construction: workload.construction,
      })),
      sampleOrder: [...cold.sampleOrder, ...warm.sampleOrder],
      summary,
      decisionGate: {
        rule: "> 5 ms or 5% median publicReady increase versus 1-view baseline indicates batching is justified",
        comparisons: decision,
        batchingJustified: decision.some((entry) => entry.exceedsGate),
      },
      rawRuns: runs,
    };
  } finally {
    await stopServer(server);
  }

  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(outputDocument, null, 2)}\n`, "utf8");
  console.log(`Wrote ${options.output}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  process.exitCode = 1;
});
