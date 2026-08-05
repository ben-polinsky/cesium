import { chromium, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";

import {
  benchmarkStates,
  createRandom,
  gitIdentity,
  loadPrewarmScenarios,
  loadScenarios,
  nodeEnvironment,
  repositoryRoot,
  shuffled,
  summarizePairedComparisons,
  summarizePairedResponsiveness,
  summarizePreloads,
  summarizeRuns,
  summarizeSetupTimings,
} from "./benchmark-utils.mjs";

const viewport = { width: 1280, height: 720 };
const benchmarkPage = "/Tools/benchmark/decompression/benchmark.html";
const benchmarkPageTimeoutMs = 120000;

function numberOption(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function stringOption(name, fallback) {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function selectedOptions() {
  const selectedScenarios = (process.env.BENCHMARK_SCENARIOS ?? "")
    .split(",")
    .filter(Boolean);
  const states = (process.env.BENCHMARK_STATES ?? "cold,warm")
    .split(",")
    .filter(Boolean);
  const sharedIterations = process.env.BENCHMARK_ITERATIONS;
  const coldIterations = numberOption(
    "BENCHMARK_COLD_ITERATIONS",
    sharedIterations === undefined ? 10 : Number(sharedIterations),
  );
  const warmIterations = numberOption(
    "BENCHMARK_WARM_ITERATIONS",
    sharedIterations === undefined ? 30 : Number(sharedIterations),
  );
  const seed = numberOption("BENCHMARK_SEED", Date.now());
  const taskProcessorTiming = stringOption(
    "BENCHMARK_TASKPROCESSOR_TIMING",
    "enabled",
  ).toLowerCase();
  let variants;
  try {
    variants = JSON.parse(process.env.BENCHMARK_VARIANTS ?? "[]");
  } catch {
    throw new Error("BENCHMARK_VARIANTS must be valid JSON.");
  }
  const readyTimeoutMs = numberOption("BENCHMARK_READY_TIMEOUT_MS", 120000);

  if (
    !Number.isSafeInteger(coldIterations) ||
    coldIterations <= 0 ||
    !Number.isSafeInteger(warmIterations) ||
    warmIterations <= 0 ||
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    states.length === 0 ||
    states.some((state) => !benchmarkStates.includes(state)) ||
    (taskProcessorTiming !== "enabled" && taskProcessorTiming !== "disabled") ||
    !Number.isSafeInteger(readyTimeoutMs) ||
    readyTimeoutMs <= 0 ||
    !Array.isArray(variants) ||
    variants.some(
      (variant) =>
        !variant ||
        typeof variant.id !== "string" ||
        typeof variant.url !== "string",
    ) ||
    (variants.length > 0 &&
      (states.length !== 1 || states[0] !== "paired-cold")) ||
    (states.includes("paired-cold") && variants.length === 0)
  ) {
    throw new Error(
      `Benchmark iteration counts, ready timeout, and seed must be positive integers; states must be one of: ${benchmarkStates.join(", ")}; paired-cold requires variants and variants require paired-cold; and BENCHMARK_TASKPROCESSOR_TIMING must be enabled or disabled.`,
    );
  }

  return {
    selectedScenarios,
    states,
    coldIterations,
    warmIterations,
    seed,
    variants,
    readyTimeoutMs,
    taskProcessorTiming,
    headed: process.env.BENCHMARK_HEADED === "true",
    port: numberOption("BENCHMARK_PORT", 8080),
    output:
      process.env.BENCHMARK_OUTPUT ??
      path.join(
        repositoryRoot,
        "Build",
        "Performance",
        "Decompression",
        "benchmark.json",
      ),
  };
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack,
  };
}

function requestIdentity(request) {
  return {
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
  };
}

function captureDiagnostics(context, page) {
  const diagnostics = {
    pageErrors: [],
    consoleMessages: [],
    failedRequests: [],
    httpErrors: [],
  };
  const onPageError = (error) => {
    diagnostics.pageErrors.push(serializeError(error));
  };
  const onConsole = (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      diagnostics.consoleMessages.push({
        type: message.type(),
        text: message.text(),
        location: message.location(),
      });
    }
  };
  const onRequestFailed = (request) => {
    diagnostics.failedRequests.push({
      ...requestIdentity(request),
      failure: request.failure(),
    });
  };
  const onResponse = (response) => {
    if (response.status() >= 400) {
      diagnostics.httpErrors.push({
        ...requestIdentity(response.request()),
        status: response.status(),
        statusText: response.statusText(),
      });
    }
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  context.on("requestfailed", onRequestFailed);
  context.on("response", onResponse);

  const mark = () =>
    Object.fromEntries(
      Object.entries(diagnostics).map(([key, values]) => [key, values.length]),
    );
  const snapshot = (start = {}) =>
    Object.fromEntries(
      Object.entries(diagnostics).map(([key, values]) => [
        key,
        values.slice(start[key] ?? 0),
      ]),
    );

  return {
    mark,
    snapshot,
    finish() {
      page.off("pageerror", onPageError);
      page.off("console", onConsole);
      context.off("requestfailed", onRequestFailed);
      context.off("response", onResponse);
    },
  };
}

function browserScenario(scenario) {
  return {
    id: scenario.id,
    api: scenario.api,
    compression: scenario.compression,
    url: scenario.url,
    resourcePrefix: scenario.resourcePrefix,
    runtimeAssetFiles: scenario.runtimeAssetFiles,
  };
}

async function evaluateScenario(page, scenario) {
  const response = await page.evaluate(async (browserScenarioValue) => {
    try {
      return {
        ok: true,
        result:
          await globalThis.runCesiumDecompressionScenario(browserScenarioValue),
      };
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
  }, browserScenario(scenario));

  if (!response.ok) {
    throw new Error(
      `${scenario.id} failed in the browser: ${response.error.name ?? "Error"}: ${response.error.message}\n${response.error.stack ?? ""}`,
    );
  }
  return response.result;
}

async function evaluatePreload(page, scenario, kind) {
  const response = await page.evaluate(
    async ({ browserScenarioValue, preloadKind }) => {
      try {
        return {
          ok: true,
          result: await globalThis.runCesiumDecompressionPreload(
            browserScenarioValue,
            preloadKind,
          ),
        };
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
    },
    {
      browserScenarioValue: browserScenario(scenario),
      preloadKind: kind,
    },
  );

  if (!response.ok) {
    throw new Error(
      `${scenario.id} ${kind} preload failed in the browser: ${response.error.name ?? "Error"}: ${response.error.message}\n${response.error.stack ?? ""}`,
    );
  }
  return response.result;
}

function browserRevision(executablePath, browserVersion) {
  const match = executablePath.match(
    /(?:chromium|chrome-headless-shell|firefox|webkit)-([0-9]+)/,
  );
  return match ? match[1] : browserVersion;
}

function artifactKind(url) {
  const pathname = new URL(url).pathname;
  if (!pathname.startsWith("/Build/CesiumUnminified/")) {
    return undefined;
  }
  if (pathname.endsWith("/Cesium.js")) {
    return "bundle";
  }
  if (pathname.includes("/Workers/")) {
    return pathname.endsWith(".wasm") ? "wasm" : "worker";
  }
  if (
    pathname.includes("/ThirdParty/") &&
    (pathname.endsWith(".wasm") ||
      pathname.includes("draco") ||
      pathname.includes("basis") ||
      pathname.includes("spz") ||
      pathname.includes("google-earth"))
  ) {
    return pathname.endsWith(".wasm") ? "wasm" : "module";
  }
  return undefined;
}

function captureArtifacts(context) {
  const responses = new Map();
  const onResponse = (response) => {
    const kind = artifactKind(response.url());
    if (kind === undefined) {
      return;
    }

    const artifactPath = new URL(response.url()).pathname;
    responses.set(
      artifactPath,
      response.status() === 200
        ? response.body().then((body) => ({
            kind,
            path: artifactPath,
            sizeBytes: body.byteLength,
            sha256: createHash("sha256").update(body).digest("hex"),
            status: response.status(),
          }))
        : Promise.resolve({
            kind,
            path: artifactPath,
            status: response.status(),
          }),
    );
  };
  context.on("response", onResponse);

  return {
    async finish() {
      context.off("response", onResponse);
      return (await Promise.all(responses.values())).sort((left, right) =>
        left.path.localeCompare(right.path),
      );
    },
  };
}

async function installGeeRoutes(page) {
  const metadata = await readFile(
    path.join(
      repositoryRoot,
      "Specs",
      "Data",
      "GoogleEarthEnterprise",
      "gee.metadata",
    ),
  );
  await page.route("**/Tools/benchmark/decompression/gee/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname.endsWith("/dbRoot.v5")) {
      await route.fulfill({ status: 404 });
      return;
    }
    if (requestUrl.search.includes("q2-0")) {
      await route.fulfill({
        body: metadata,
        contentType: "application/octet-stream",
      });
      return;
    }
    await route.continue();
  });
}

async function openExecution(browser, baseURL, scenarios, setup) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
  });
  await installGeeRoutes(await context.newPage());
  const page = context.pages()[0];
  const diagnostics = captureDiagnostics(context, page);
  const artifacts = captureArtifacts(context);
  const benchmarkUrl = new URL(benchmarkPage, baseURL);
  benchmarkUrl.searchParams.set(
    "taskProcessorTiming",
    setup.taskProcessorTiming ?? "enabled",
  );
  benchmarkUrl.searchParams.set("arrayBufferMemorySampleIntervalMs", "50");
  benchmarkUrl.searchParams.set("frameGapLongThresholdMs", "50");
  benchmarkUrl.searchParams.set("readyTimeoutMs", String(setup.readyTimeoutMs));

  const pageLoadStartedAt = performance.now();
  let pageLoadCompletedAt;
  let benchmarkReadyAt;
  try {
    await page.goto(benchmarkUrl.toString(), {
      waitUntil: "load",
      timeout: benchmarkPageTimeoutMs,
    });
    pageLoadCompletedAt = performance.now();
    await page.waitForFunction(
      () => globalThis.decompressionBenchmarkReady === true,
      undefined,
      { timeout: benchmarkPageTimeoutMs },
    );
    benchmarkReadyAt = performance.now();
  } catch (error) {
    error.benchmarkDiagnostics = diagnostics.snapshot();
    error.benchmarkSetupTiming = {
      browserLaunchMs: setup.browserLaunchCompletedAt - setup.startedAt,
      pageLoadMs:
        pageLoadCompletedAt === undefined
          ? null
          : pageLoadCompletedAt - pageLoadStartedAt,
      pageToBenchmarkReadyMs: null,
      benchmarkReadyMs: null,
    };
    diagnostics.finish();
    await context.close();
    throw error;
  }

  const pageEnvironment = await page.evaluate(() => ({
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  }));
  const executablePath = browser.browserType().executablePath();
  const browserVersion = browser.version();
  const identity = {
    browserName: browser.browserType().name(),
    browserVersion,
    browserRevision: browserRevision(executablePath, browserVersion),
    executablePath,
    hardwareConcurrency: pageEnvironment.hardwareConcurrency,
    userAgent: pageEnvironment.userAgent,
    devicePixelRatio: pageEnvironment.devicePixelRatio,
    viewport,
  };

  return {
    id: setup.id,
    browser,
    context,
    page,
    artifacts,
    diagnostics,
    identity,
    pageEnvironment,
    scenarios,
    setupTiming: {
      browserLaunchMs: setup.browserLaunchCompletedAt - setup.startedAt,
      pageLoadMs: pageLoadCompletedAt - pageLoadStartedAt,
      pageToBenchmarkReadyMs: benchmarkReadyAt - pageLoadStartedAt,
      benchmarkReadyMs: benchmarkReadyAt - setup.startedAt,
    },
  };
}

async function closeExecution(execution) {
  execution.diagnostics.finish();
  await execution.context.close();
  await execution.browser.close();
}

async function closeExecutionContext(execution) {
  execution.diagnostics.finish();
  await execution.context.close();
}

function buildRun(
  execution,
  scenario,
  state,
  sampleIndex,
  orderIndex,
  result,
  metadata = {},
) {
  return {
    executionId: execution.id,
    scenarioId: scenario.id,
    category: scenario.category,
    compression: scenario.compression,
    api: scenario.api,
    state,
    sampleIndex,
    orderIndex,
    status: "ok",
    variantId: metadata.variantId ?? "primary",
    variantOrderIndex: metadata.variantOrderIndex ?? 0,
    variantOrder: metadata.variantOrder ?? ["primary"],
    pairId: metadata.pairId ?? null,
    timing: result.timing,
    resourceTiming: result.resourceTiming,
    readiness: result.readiness,
    mainThread: result.mainThread,
    decoderLifecycle: result.decoderLifecycle,
    measurements: {
      preloadTriggerToReadyMs: null,
      targetPublicApiToReadyMs: result.timing.durationMs,
    },
    browser: execution.identity,
    pageEnvironment: execution.pageEnvironment,
    cachePolicy: cachePolicyForState(state),
  };
}

function buildFailedRun({
  execution,
  executionId,
  scenario,
  state,
  sampleIndex,
  orderIndex,
  error,
  diagnostics,
  metadata = {},
}) {
  return {
    executionId: execution?.id ?? executionId,
    scenarioId: scenario.id,
    category: scenario.category,
    compression: scenario.compression,
    api: scenario.api,
    state,
    sampleIndex,
    orderIndex,
    status: "failed",
    variantId: metadata.variantId ?? "primary",
    variantOrderIndex: metadata.variantOrderIndex ?? 0,
    variantOrder: metadata.variantOrder ?? ["primary"],
    pairId: metadata.pairId ?? null,
    error: serializeError(error),
    diagnostics: diagnostics ??
      error.benchmarkDiagnostics ?? {
        pageErrors: [],
        consoleMessages: [],
        failedRequests: [],
        httpErrors: [],
      },
    timing: null,
    resourceTiming: null,
    readiness: null,
    mainThread: null,
    decoderLifecycle: null,
    measurements: {
      preloadTriggerToReadyMs: null,
      targetPublicApiToReadyMs: null,
    },
    browser: execution?.identity ?? null,
    pageEnvironment: execution?.pageEnvironment ?? null,
    cachePolicy: cachePolicyForState(state),
  };
}

function cachePolicyForState(state) {
  const shared = {
    osCache: "not reset",
    browserStartupIncluded: false,
  };
  if (state === "cold") {
    return {
      browserProcess: "fresh per scenario sample",
      profile: "fresh ephemeral Playwright profile",
      httpCache: "fresh with the browser process",
      cesiumResourceCache: "fresh",
      workerAndWasmState: "fresh",
      ...shared,
    };
  }
  if (state === "paired-cold") {
    return {
      browserProcess:
        "fresh per scenario pair and shared only by pair variants",
      profile: "fresh context per variant",
      httpCache: "fresh per variant context",
      cesiumResourceCache: "fresh per variant context",
      workerAndWasmState: "fresh per variant context",
      ...shared,
    };
  }
  if (state === "warm") {
    return {
      browserProcess: "shared for all warm samples",
      profile: "shared context",
      httpCache: "retained",
      cesiumResourceCache: "warmed through the public API",
      workerAndWasmState: "warmed through the public API",
      ...shared,
    };
  }
  if (state === "worker-probe-preloaded") {
    return {
      browserProcess: "fresh per scenario sample",
      profile: "fresh ephemeral Playwright profile",
      httpCache: "fresh except codec worker artifacts requested by preload",
      cesiumResourceCache: "fresh",
      workerAndWasmState:
        "shared codec worker constructed and transferable-buffer probe settled; no decoder task or explicit WASM initialization",
      ...shared,
    };
  }
  if (state === "worker-wasm-preloaded") {
    return {
      browserProcess: "fresh per scenario sample",
      profile: "fresh ephemeral Playwright profile",
      httpCache:
        "fresh except codec worker and WASM artifacts requested by preload",
      cesiumResourceCache: "fresh",
      workerAndWasmState:
        "shared codec worker, transferable-buffer probe, and existing codec WASM initialization completed; no decoder task",
      ...shared,
    };
  }
  if (state === "asset-cache-warmed") {
    return {
      browserProcess: "fresh per scenario sample",
      profile: "fresh ephemeral Playwright profile",
      httpCache: "explicit runtime asset URLs fetched before the target",
      cesiumResourceCache: "fresh",
      workerAndWasmState: "fresh",
      ...shared,
    };
  }
  return {
    browserProcess: "fresh per prewarmed scenario sample",
    profile: "fresh ephemeral Playwright profile",
    httpCache:
      "fresh before the documented public-API prewarm, then retained for the target",
    cesiumResourceCache:
      "prewarm asset loaded through the public API before the target",
    workerAndWasmState:
      "relevant decoder initialized through the public API before the target",
    ...shared,
  };
}

function prewarmScenarioFor(scenario, prewarmScenarios) {
  const candidates = prewarmScenarios.filter(
    (candidate) => candidate.compression === scenario.compression,
  );
  const prewarmScenario =
    candidates.find((candidate) => candidate.url !== scenario.url) ??
    candidates[0];
  if (prewarmScenario === undefined) {
    throw new Error(
      `No public-API prewarm scenario is configured for ${scenario.compression}.`,
    );
  }
  return prewarmScenario;
}

async function runWarmSamples({
  baseURL,
  scenarios,
  options,
  random,
  runs,
  sampleOrder,
  executionSetups,
}) {
  const setupStartedAt = performance.now();
  const browser = await chromium.launch({ headless: !options.headed });
  const browserLaunchCompletedAt = performance.now();
  const execution = await openExecution(browser, baseURL, scenarios, {
    id: "warm",
    startedAt: setupStartedAt,
    browserLaunchCompletedAt,
    taskProcessorTiming: options.taskProcessorTiming,
    readyTimeoutMs: options.readyTimeoutMs,
  });
  executionSetups.push({
    id: execution.id,
    state: "warm",
    sampleIndex: null,
    scenarioId: null,
    timing: execution.setupTiming,
    browser: execution.identity,
  });
  try {
    const warmupOrder = shuffled(scenarios, random);
    for (let orderIndex = 0; orderIndex < warmupOrder.length; ++orderIndex) {
      const scenario = warmupOrder[orderIndex];
      const diagnosticMark = execution.diagnostics.mark();
      try {
        await evaluateScenario(execution.page, scenario);
      } catch (error) {
        runs.push(
          buildFailedRun({
            execution,
            scenario,
            state: "warm",
            sampleIndex: -1,
            orderIndex,
            error,
            diagnostics: execution.diagnostics.snapshot(diagnosticMark),
          }),
        );
        throw error;
      }
    }

    for (
      let sampleIndex = 0;
      sampleIndex < options.warmIterations;
      ++sampleIndex
    ) {
      const order = shuffled(scenarios, random);
      sampleOrder.push({
        state: "warm",
        sampleIndex,
        scenarioIds: order.map((scenario) => scenario.id),
      });
      for (let orderIndex = 0; orderIndex < order.length; ++orderIndex) {
        const scenario = order[orderIndex];
        const diagnosticMark = execution.diagnostics.mark();
        try {
          const result = await evaluateScenario(execution.page, scenario);
          runs.push(
            buildRun(
              execution,
              scenario,
              "warm",
              sampleIndex,
              orderIndex,
              result,
            ),
          );
        } catch (error) {
          runs.push(
            buildFailedRun({
              execution,
              scenario,
              state: "warm",
              sampleIndex,
              orderIndex,
              error,
              diagnostics: execution.diagnostics.snapshot(diagnosticMark),
            }),
          );
          throw error;
        }
      }
    }

    return await execution.artifacts.finish();
  } finally {
    await closeExecution(execution);
  }
}

async function runColdSamples({
  baseURL,
  scenarios,
  options,
  random,
  runs,
  sampleOrder,
  executionSetups,
}) {
  const artifacts = [];
  for (
    let sampleIndex = 0;
    sampleIndex < options.coldIterations;
    ++sampleIndex
  ) {
    const order = shuffled(scenarios, random);
    sampleOrder.push({
      state: "cold",
      sampleIndex,
      scenarioIds: order.map((scenario) => scenario.id),
    });

    for (let orderIndex = 0; orderIndex < order.length; ++orderIndex) {
      const scenario = order[orderIndex];
      const setupStartedAt = performance.now();
      const executionId = `cold-${sampleIndex}-${scenario.id}`;
      let browser;
      let execution;
      let diagnosticMark;
      try {
        browser = await chromium.launch({
          headless: !options.headed,
        });
        const browserLaunchCompletedAt = performance.now();
        execution = await openExecution(browser, baseURL, scenarios, {
          id: executionId,
          startedAt: setupStartedAt,
          browserLaunchCompletedAt,
          taskProcessorTiming: options.taskProcessorTiming,
          readyTimeoutMs: options.readyTimeoutMs,
        });
        executionSetups.push({
          id: execution.id,
          state: "cold",
          variantId: "primary",
          sampleIndex,
          scenarioId: scenario.id,
          status: "ok",
          timing: execution.setupTiming,
          browser: execution.identity,
        });
        diagnosticMark = execution.diagnostics.mark();
        const result = await evaluateScenario(execution.page, scenario);
        const executionArtifacts = await execution.artifacts.finish();
        runs.push(
          buildRun(
            execution,
            scenario,
            "cold",
            sampleIndex,
            orderIndex,
            result,
          ),
        );
        artifacts.push(...executionArtifacts);
      } catch (error) {
        if (!execution) {
          executionSetups.push({
            id: executionId,
            state: "cold",
            variantId: "primary",
            sampleIndex,
            scenarioId: scenario.id,
            status: "failed",
            timing: error.benchmarkSetupTiming ?? {},
            browser: null,
            error: serializeError(error),
            diagnostics: error.benchmarkDiagnostics,
          });
        }
        runs.push(
          buildFailedRun({
            execution,
            executionId,
            scenario,
            state: "cold",
            sampleIndex,
            orderIndex,
            error,
            diagnostics: execution?.diagnostics.snapshot(diagnosticMark),
          }),
        );
      } finally {
        if (execution) {
          await closeExecution(execution);
        } else if (browser) {
          await browser.close();
        }
      }
    }
  }
  return artifacts;
}

async function runPairedColdSamples({
  baseURL,
  scenarios,
  options,
  random,
  runs,
  sampleOrder,
  executionSetups,
}) {
  const artifacts = [];
  const variants = [
    { id: "primary", url: baseURL, primary: true },
    ...options.variants,
  ];

  for (
    let sampleIndex = 0;
    sampleIndex < options.coldIterations;
    ++sampleIndex
  ) {
    const scenarioOrder = shuffled(scenarios, random);
    const orderRecord = {
      state: "paired-cold",
      sampleIndex,
      scenarioIds: scenarioOrder.map((scenario) => scenario.id),
      pairs: [],
    };
    sampleOrder.push(orderRecord);

    for (let orderIndex = 0; orderIndex < scenarioOrder.length; ++orderIndex) {
      const scenario = scenarioOrder[orderIndex];
      const pairId = `pair-${sampleIndex}-${scenario.id}`;
      const variantOrder = shuffled(variants, random);
      const variantIds = variantOrder.map((variant) => variant.id);
      orderRecord.pairs.push({
        pairId,
        scenarioId: scenario.id,
        variantIds,
      });

      const setupStartedAt = performance.now();
      let browser;
      try {
        browser = await chromium.launch({
          headless: !options.headed,
        });
        const browserLaunchCompletedAt = performance.now();

        for (
          let variantOrderIndex = 0;
          variantOrderIndex < variantOrder.length;
          ++variantOrderIndex
        ) {
          const variant = variantOrder[variantOrderIndex];
          const executionId = `${pairId}-${variant.id}`;
          let execution;
          let diagnosticMark;
          try {
            execution = await openExecution(browser, variant.url, scenarios, {
              id: executionId,
              startedAt: setupStartedAt,
              browserLaunchCompletedAt,
              taskProcessorTiming: options.taskProcessorTiming,
              readyTimeoutMs: options.readyTimeoutMs,
            });
            executionSetups.push({
              id: execution.id,
              state: "paired-cold",
              variantId: variant.id,
              variantOrderIndex,
              variantOrder: variantIds,
              pairId,
              sampleIndex,
              scenarioId: scenario.id,
              status: "ok",
              timing: execution.setupTiming,
              browser: execution.identity,
            });
            diagnosticMark = execution.diagnostics.mark();
            const result = await evaluateScenario(execution.page, scenario);
            const executionArtifacts = await execution.artifacts.finish();
            runs.push(
              buildRun(
                execution,
                scenario,
                "paired-cold",
                sampleIndex,
                orderIndex,
                result,
                {
                  variantId: variant.id,
                  variantOrderIndex,
                  variantOrder: variantIds,
                  pairId,
                },
              ),
            );
            artifacts.push(...executionArtifacts);
          } catch (error) {
            if (!execution) {
              executionSetups.push({
                id: executionId,
                state: "paired-cold",
                variantId: variant.id,
                variantOrderIndex,
                variantOrder: variantIds,
                pairId,
                sampleIndex,
                scenarioId: scenario.id,
                status: "failed",
                timing: error.benchmarkSetupTiming ?? {},
                browser: null,
                error: serializeError(error),
                diagnostics: error.benchmarkDiagnostics,
              });
            }
            runs.push(
              buildFailedRun({
                execution,
                executionId,
                scenario,
                state: "paired-cold",
                sampleIndex,
                orderIndex,
                error,
                diagnostics: execution?.diagnostics.snapshot(diagnosticMark),
                metadata: {
                  variantId: variant.id,
                  variantOrderIndex,
                  variantOrder: variantIds,
                  pairId,
                },
              }),
            );
          } finally {
            if (execution) {
              await closeExecutionContext(execution);
            }
          }
        }
      } catch (error) {
        for (
          let variantOrderIndex = 0;
          variantOrderIndex < variantOrder.length;
          ++variantOrderIndex
        ) {
          const variant = variantOrder[variantOrderIndex];
          const executionId = `${pairId}-${variant.id}`;
          if (runs.some((run) => run.executionId === executionId)) {
            continue;
          }
          executionSetups.push({
            id: executionId,
            state: "paired-cold",
            variantId: variant.id,
            variantOrderIndex,
            variantOrder: variantIds,
            pairId,
            sampleIndex,
            scenarioId: scenario.id,
            status: "failed",
            timing: {},
            browser: null,
            error: serializeError(error),
          });
          runs.push(
            buildFailedRun({
              executionId,
              scenario,
              state: "paired-cold",
              sampleIndex,
              orderIndex,
              error,
              metadata: {
                variantId: variant.id,
                variantOrderIndex,
                variantOrder: variantIds,
                pairId,
              },
            }),
          );
        }
      } finally {
        if (browser) {
          await browser.close();
        }
      }
    }
  }
  return artifacts;
}

async function runPrewarmedSamples({
  baseURL,
  scenarios,
  prewarmScenarios,
  options,
  random,
  runs,
  sampleOrder,
  executionSetups,
}) {
  const artifacts = [];
  for (
    let sampleIndex = 0;
    sampleIndex < options.coldIterations;
    ++sampleIndex
  ) {
    const order = shuffled(scenarios, random);
    sampleOrder.push({
      state: "prewarmed",
      sampleIndex,
      scenarioIds: order.map((scenario) => scenario.id),
    });

    for (let orderIndex = 0; orderIndex < order.length; ++orderIndex) {
      const scenario = order[orderIndex];
      const prewarmScenario = prewarmScenarioFor(scenario, prewarmScenarios);
      const setupStartedAt = performance.now();
      const browser = await chromium.launch({
        headless: !options.headed,
      });
      const browserLaunchCompletedAt = performance.now();
      const execution = await openExecution(browser, baseURL, scenarios, {
        id: `prewarmed-${sampleIndex}-${scenario.id}`,
        startedAt: setupStartedAt,
        browserLaunchCompletedAt,
        taskProcessorTiming: options.taskProcessorTiming,
        readyTimeoutMs: options.readyTimeoutMs,
      });
      executionSetups.push({
        id: execution.id,
        state: "prewarmed",
        sampleIndex,
        scenarioId: scenario.id,
        timing: execution.setupTiming,
        browser: execution.identity,
      });
      const diagnosticMark = execution.diagnostics.mark();
      try {
        const prewarmResult = await evaluateScenario(
          execution.page,
          prewarmScenario,
        );
        const result = await evaluateScenario(execution.page, scenario);
        const run = buildRun(
          execution,
          scenario,
          "prewarmed",
          sampleIndex,
          orderIndex,
          result,
        );
        run.prewarm = {
          scenarioId: prewarmScenario.id,
          api: prewarmScenario.api,
          compression: prewarmScenario.compression,
          timing: prewarmResult.timing,
          decoderLifecycle: prewarmResult.decoderLifecycle,
          readiness: prewarmResult.readiness,
        };
        run.preload = {
          kind: "public-fixture",
          scenarioId: prewarmScenario.id,
          api: prewarmScenario.api,
          compression: prewarmScenario.compression,
          timing: {
            ...prewarmResult.timing,
            milestonesMs: {
              preloadReady: prewarmResult.timing.durationMs,
            },
          },
          resourceTiming: prewarmResult.resourceTiming,
          decoderLifecycle: prewarmResult.decoderLifecycle,
          readiness: prewarmResult.readiness,
        };
        run.measurements.preloadTriggerToReadyMs =
          prewarmResult.timing.durationMs;
        const executionArtifacts = await execution.artifacts.finish();
        runs.push(run);
        artifacts.push(...executionArtifacts);
      } catch (error) {
        runs.push(
          buildFailedRun({
            execution,
            scenario,
            state: "prewarmed",
            sampleIndex,
            orderIndex,
            error,
            diagnostics: execution.diagnostics.snapshot(diagnosticMark),
          }),
        );
        throw error;
      } finally {
        await closeExecution(execution);
      }
    }
  }
  return artifacts;
}

const preloadKindByState = {
  "worker-probe-preloaded": "worker-probe",
  "worker-wasm-preloaded": "worker-wasm",
  "asset-cache-warmed": "asset-cache",
};

async function runExplicitPreloadSamples({
  baseURL,
  scenarios,
  state,
  options,
  random,
  runs,
  sampleOrder,
  executionSetups,
}) {
  const artifacts = [];
  const preloadKind = preloadKindByState[state];
  for (
    let sampleIndex = 0;
    sampleIndex < options.coldIterations;
    ++sampleIndex
  ) {
    const order = shuffled(scenarios, random);
    sampleOrder.push({
      state,
      sampleIndex,
      scenarioIds: order.map((scenario) => scenario.id),
    });

    for (let orderIndex = 0; orderIndex < order.length; ++orderIndex) {
      const scenario = order[orderIndex];
      const setupStartedAt = performance.now();
      const browser = await chromium.launch({
        headless: !options.headed,
      });
      const browserLaunchCompletedAt = performance.now();
      const execution = await openExecution(browser, baseURL, scenarios, {
        id: `${state}-${sampleIndex}-${scenario.id}`,
        startedAt: setupStartedAt,
        browserLaunchCompletedAt,
        taskProcessorTiming: options.taskProcessorTiming,
        readyTimeoutMs: options.readyTimeoutMs,
      });
      executionSetups.push({
        id: execution.id,
        state,
        sampleIndex,
        scenarioId: scenario.id,
        timing: execution.setupTiming,
        browser: execution.identity,
      });
      const diagnosticMark = execution.diagnostics.mark();
      try {
        const preload = await evaluatePreload(
          execution.page,
          scenario,
          preloadKind,
        );
        const result = await evaluateScenario(execution.page, scenario);
        const run = buildRun(
          execution,
          scenario,
          state,
          sampleIndex,
          orderIndex,
          result,
        );
        run.preload = preload;
        run.measurements.preloadTriggerToReadyMs = preload.timing.durationMs;
        const executionArtifacts = await execution.artifacts.finish();
        runs.push(run);
        artifacts.push(...executionArtifacts);
      } catch (error) {
        runs.push(
          buildFailedRun({
            execution,
            scenario,
            state,
            sampleIndex,
            orderIndex,
            error,
            diagnostics: execution.diagnostics.snapshot(diagnosticMark),
          }),
        );
        throw error;
      } finally {
        await closeExecution(execution);
      }
    }
  }
  return artifacts;
}

function publicScenarioIdentity(scenario) {
  return {
    id: scenario.id,
    category: scenario.category,
    compression: scenario.compression,
    api: scenario.api,
    url: scenario.url,
    resourcePrefix: scenario.resourcePrefix,
    runtimeAssetFiles: scenario.runtimeAssetFiles,
    assets: scenario.assets,
    provenance: scenario.provenance,
  };
}

async function writeResults(output, value) {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateStateScenarios(states, scenarios, prewarmScenarios) {
  const workerCompressions = new Set(["draco", "meshopt", "ktx2", "spz"]);
  for (const scenario of scenarios) {
    if (
      states.includes("worker-probe-preloaded") &&
      !workerCompressions.has(scenario.compression)
    ) {
      throw new Error(
        `${scenario.id} does not have a codec-specific worker/probe preload hook.`,
      );
    }
    if (
      states.includes("worker-wasm-preloaded") &&
      scenario.compression !== "draco" &&
      scenario.compression !== "ktx2"
    ) {
      throw new Error(
        `${scenario.id} cannot use worker-wasm-preloaded because the current codec API exposes no separate WASM readiness promise.`,
      );
    }
    if (
      states.includes("asset-cache-warmed") &&
      (!Array.isArray(scenario.runtimeAssetFiles) ||
        scenario.runtimeAssetFiles.length === 0)
    ) {
      throw new Error(
        `${scenario.id} has no explicit runtime asset list for asset-cache-warmed.`,
      );
    }
    if (states.includes("prewarmed")) {
      prewarmScenarioFor(scenario, prewarmScenarios);
    }
  }
}

function consoleTable(document) {
  console.table(
    document.summaries.map((summary) => ({
      scenario: summary.scenarioId,
      state: summary.state,
      variant: summary.variantId,
      milestone: summary.milestone,
      samples: summary.sampleCount,
      medianMs: summary.medianMs,
      p95Ms: summary.p95Ms,
      meanMs: summary.meanMs,
    })),
  );
  console.log(
    "Browser/process setup timings (not included in public API samples)",
  );
  console.table(
    document.setupSummaries.map((summary) => ({
      state: summary.state,
      variant: summary.variantId,
      milestone: summary.milestone,
      samples: summary.sampleCount,
      medianMs: summary.medianMs,
      p95Ms: summary.p95Ms,
      meanMs: summary.meanMs,
    })),
  );
  if (document.preloadSummaries.length > 0) {
    console.log(
      "Preload trigger-to-ready timings (separate from target public API timings)",
    );
    console.table(
      document.preloadSummaries.map((summary) => ({
        scenario: summary.scenarioId,
        state: summary.state,
        milestone: summary.milestone,
        samples: summary.sampleCount,
        medianMs: summary.medianMs,
        p95Ms: summary.p95Ms,
        meanMs: summary.meanMs,
      })),
    );
  }
  if (document.pairedComparisonSummaries.length > 0) {
    console.log("Paired cold deltas (comparison minus primary)");
    console.table(
      document.pairedComparisonSummaries.map((summary) => ({
        scenario: summary.scenarioId,
        comparison: summary.comparisonVariantId,
        milestone: summary.milestone,
        samples: summary.sampleCount,
        medianDeltaMs: summary.medianDeltaMs,
        p95DeltaMs: summary.p95DeltaMs,
        meanDeltaMs: summary.meanDeltaMs,
        medianCi95Ms: summary.confidenceIntervals.medianDeltaMs,
      })),
    );
  }
  if (document.pairedResponsivenessSummaries.length > 0) {
    console.log("Paired cold responsiveness deltas (comparison minus primary)");
    console.table(
      document.pairedResponsivenessSummaries.map((summary) => ({
        scenario: summary.scenarioId,
        comparison: summary.comparisonVariantId,
        metric: summary.metric,
        samples: summary.sampleCount,
        medianDelta: summary.medianDelta,
        p95Delta: summary.p95Delta,
        meanDelta: summary.meanDelta,
        medianCi95: summary.confidenceIntervals.medianDelta,
      })),
    );
  }
}

test("runs public Cesium decompression/loading benchmarks", async ({
  baseURL,
}) => {
  const options = selectedOptions();
  const scenarios = await loadScenarios(options.selectedScenarios);
  const prewarmScenarios = options.states.includes("prewarmed")
    ? await loadPrewarmScenarios()
    : [];
  validateStateScenarios(options.states, scenarios, prewarmScenarios);
  const random = createRandom(options.seed);
  const runArtifacts = [];
  const document = {
    schemaVersion: 6,
    status: "running",
    generatedAt: new Date().toISOString(),
    command: "npm run benchmark-decompression",
    runner: {
      git: gitIdentity(),
      node: nodeEnvironment(),
      cpu: os.cpus()[0]?.model,
      browserViewport: viewport,
    },
    plan: {
      states: options.states,
      variants: [{ id: "primary", url: baseURL }, ...options.variants],
      coldIterations: options.coldIterations,
      warmIterations: options.warmIterations,
      workerProbePreloadedIterations: options.coldIterations,
      workerWasmPreloadedIterations: options.coldIterations,
      assetCacheWarmedIterations: options.coldIterations,
      prewarmedIterations: options.coldIterations,
      seed: options.seed,
      readyTimeoutMs: options.readyTimeoutMs,
      randomizedScenarioOrder: true,
      timer: "browser performance.now()",
      timingDefinition:
        "Each sample starts immediately before the public loading API and ends at its documented public readiness milestone. Browser startup is not included.",
      preloadTimingDefinition:
        "States with preload work separately record preloadTriggerToReadyMs from the explicit preload trigger until that state's documented readiness condition, and targetPublicApiToReadyMs from the normal public Cesium loading API call to public readiness. Neither field is decoder-only timing.",
      setupTimingDefinition:
        "Each execution separately records Node-side browser launch, page load, and benchmark-ready time. Setup timings are informational and are not included in public API samples or regression thresholds.",
      taskProcessorTiming:
        options.taskProcessorTiming === "enabled"
          ? "TaskProcessor lifecycle hook enabled for benchmark samples."
          : "TaskProcessor lifecycle hook disabled for benchmark samples.",
    },
    cachePolicy: {
      networkInclusive: true,
      cold: "Each scenario sample uses a fresh Chromium process and ephemeral profile. HTTP, Cesium resource, worker, and WASM state start fresh; OS caches are not reset.",
      pairedCold:
        "Each scenario pair uses one fresh Chromium process. Every variant uses a fresh context and page, and variant order is randomized independently for each scenario sample.",
      workerProbePreloaded:
        "Each target starts fresh. The existing shared codec worker is constructed and the transferable-buffer probe settles before the target; no fixture, decoder task, generic pool, or explicit WASM initialization is used.",
      workerWasmPreloaded:
        "Each target starts fresh. For Draco and KTX2 only, the shared codec worker/probe and the codec's existing WASM initialization promise complete before the target; no fixture or decoder task is used.",
      assetCacheWarmed:
        "Each target starts fresh except its explicit runtime asset URLs are fetched into the browser HTTP cache. Cesium ResourceCache and worker/WASM state remain fresh.",
      warm: "Each scenario is warmed once through the same public API in a shared browser context. HTTP, Cesium resource, worker, and WASM caches are retained.",
      prewarmed:
        "Each target starts in a fresh Chromium process and profile. A documented small public-API scenario for the target compression runs to readiness before the target timer starts; its cache and decoder side effects are retained.",
      comparison:
        "Every state is reported separately. No transport or calibration value is subtracted, and no cache-free or decoder-only CPU claim is made.",
    },
    scenarios: scenarios.map(publicScenarioIdentity),
    prewarmScenarios: prewarmScenarios.map(publicScenarioIdentity),
    sampleOrder: [],
    executionSetups: [],
    decoderArtifacts: [],
    runs: [],
    summaries: [],
    preloadSummaries: [],
    setupSummaries: [],
    pairedComparisonSummaries: [],
    pairedResponsivenessSummaries: [],
  };

  try {
    for (const state of options.states) {
      if (state === "warm") {
        runArtifacts.push(
          ...(await runWarmSamples({
            baseURL,
            scenarios,
            options,
            random,
            runs: document.runs,
            sampleOrder: document.sampleOrder,
            executionSetups: document.executionSetups,
          })),
        );
      } else if (state === "cold") {
        runArtifacts.push(
          ...(await runColdSamples({
            baseURL,
            scenarios,
            options,
            random,
            runs: document.runs,
            sampleOrder: document.sampleOrder,
            executionSetups: document.executionSetups,
          })),
        );
      } else if (state === "paired-cold") {
        runArtifacts.push(
          ...(await runPairedColdSamples({
            baseURL,
            scenarios,
            options,
            random,
            runs: document.runs,
            sampleOrder: document.sampleOrder,
            executionSetups: document.executionSetups,
          })),
        );
      } else if (state === "prewarmed") {
        runArtifacts.push(
          ...(await runPrewarmedSamples({
            baseURL,
            scenarios,
            prewarmScenarios,
            options,
            random,
            runs: document.runs,
            sampleOrder: document.sampleOrder,
            executionSetups: document.executionSetups,
          })),
        );
      } else {
        runArtifacts.push(
          ...(await runExplicitPreloadSamples({
            baseURL,
            scenarios,
            state,
            options,
            random,
            runs: document.runs,
            sampleOrder: document.sampleOrder,
            executionSetups: document.executionSetups,
          })),
        );
      }
    }

    document.decoderArtifacts = Array.from(
      new Map(
        runArtifacts.map((artifact) => [
          `${artifact.path}|${artifact.sha256 ?? artifact.status}`,
          artifact,
        ]),
      ).values(),
    ).sort((left, right) => left.path.localeCompare(right.path));
    document.summaries = summarizeRuns(document.runs);
    document.preloadSummaries = summarizePreloads(document.runs);
    document.setupSummaries = summarizeSetupTimings(document.executionSetups);
    document.pairedComparisonSummaries = summarizePairedComparisons(
      document.runs,
    );
    document.pairedResponsivenessSummaries = summarizePairedResponsiveness(
      document.runs,
    );
    document.failureCount = document.runs.filter(
      (run) => run.status === "failed",
    ).length;
    document.status = document.failureCount === 0 ? "ok" : "failed";
    await writeResults(options.output, document);
    console.log(`Decompression benchmark results written to ${options.output}`);
    consoleTable(document);
    if (document.failureCount > 0) {
      throw new Error(
        `${document.failureCount} benchmark sample(s) failed; see ${options.output} for diagnostics.`,
      );
    }
  } catch (error) {
    document.status = "failed";
    document.error = serializeError(error);
    document.summaries = summarizeRuns(document.runs);
    document.preloadSummaries = summarizePreloads(document.runs);
    document.setupSummaries = summarizeSetupTimings(document.executionSetups);
    document.pairedComparisonSummaries = summarizePairedComparisons(
      document.runs,
    );
    document.pairedResponsivenessSummaries = summarizePairedResponsiveness(
      document.runs,
    );
    document.failureCount = document.runs.filter(
      (run) => run.status === "failed",
    ).length;
    await writeResults(options.output, document);
    throw error;
  }
});
