import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(scriptDirectory, "../../..");
export const scenarioManifestPath = path.join(
  scriptDirectory,
  "scenarios.json",
);
export const benchmarkStates = Object.freeze([
  "cold",
  "paired-cold",
  "worker-probe-preloaded",
  "worker-wasm-preloaded",
  "asset-cache-warmed",
  "warm",
  "prewarmed",
]);

const prewarmScenarioDefinitions = [
  {
    id: "prewarm-draco-unit-square",
    category: "gltf",
    compression: "draco",
    api: "Model.fromGltfAsync",
    url: "Specs/Data/Models/glTF-2.0/unitSquare/unitSquare11x11_draco.glb",
    resourcePrefix: "Specs/Data/Models/glTF-2.0/unitSquare/",
    assetFiles: [
      "Specs/Data/Models/glTF-2.0/unitSquare/unitSquare11x11_draco.glb",
    ],
    provenance: {
      source: "Existing CesiumJS repository test asset",
      license:
        "Redistributed as versioned CesiumJS test data; see the repository license and the asset metadata.",
      attribution: "CesiumJS test data",
    },
  },
  {
    id: "prewarm-meshopt-unit-square",
    category: "gltf",
    compression: "meshopt",
    api: "Model.fromGltfAsync",
    url: "Specs/Data/Models/glTF-2.0/unitSquare/unitSquare11x11_meshopt.glb",
    resourcePrefix: "Specs/Data/Models/glTF-2.0/unitSquare/",
    assetFiles: [
      "Specs/Data/Models/glTF-2.0/unitSquare/unitSquare11x11_meshopt.glb",
    ],
    provenance: {
      source: "Existing CesiumJS repository test asset",
      license:
        "Redistributed as versioned CesiumJS test data; see the repository license and the asset metadata.",
      attribution: "CesiumJS test data",
    },
  },
  {
    id: "prewarm-meshopt-cube",
    category: "gltf",
    compression: "meshopt",
    api: "Model.fromGltfAsync",
    url: "Specs/Data/Models/glTF-2.0/MeshoptCubeTest/glTF-Meshopt/MeshoptCubeTest.gltf",
    resourcePrefix: "Specs/Data/Models/glTF-2.0/MeshoptCubeTest/glTF-Meshopt/",
    assetFiles: [
      "Specs/Data/Models/glTF-2.0/MeshoptCubeTest/glTF-Meshopt/MeshoptCubeTest.gltf",
      "Specs/Data/Models/glTF-2.0/MeshoptCubeTest/glTF-Meshopt/MeshoptCubeTest.bin",
    ],
    provenance: {
      source: "Khronos glTF-Sample-Assets MeshoptCubeTest, vendored in CesiumJS",
      license:
        "CC0 1.0 Universal; see Specs/Data/Models/glTF-2.0/MeshoptCubeTest/README.md.",
      attribution: "Model by Arseny Kapoulkine",
    },
  },
  {
    id: "prewarm-ktx2-box",
    category: "gltf",
    compression: "ktx2",
    api: "Model.fromGltfAsync",
    url: "Specs/Data/Models/glTF-2.0/BoxTexturedKtx2Basis/glTF/BoxTexturedKtx2Basis.gltf",
    resourcePrefix: "Specs/Data/Models/glTF-2.0/BoxTexturedKtx2Basis/glTF/",
    assetFiles: [
      "Specs/Data/Models/glTF-2.0/BoxTexturedKtx2Basis/glTF/BoxTexturedKtx2Basis.gltf",
      "Specs/Data/Models/glTF-2.0/BoxTexturedKtx2Basis/glTF/BoxTexturedKtx2Basis.bin",
      "Specs/Data/Models/glTF-2.0/BoxTexturedKtx2Basis/glTF/cesium_logo.ktx2",
    ],
    provenance: {
      source: "Existing CesiumJS repository test asset",
      license:
        "Redistributed as versioned CesiumJS test data; see the repository license and the asset metadata.",
      attribution: "CesiumJS test data",
    },
  },
  {
    id: "prewarm-spz-sh-unit-cube",
    category: "3d-tiles",
    compression: "spz",
    api: "Cesium3DTileset.fromUrl",
    url: "Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/tileset.json",
    resourcePrefix: "Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/",
    assetFiles: [
      "Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/tileset.json",
      "Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/0/0.glb",
    ],
    provenance: {
      source: "Existing CesiumJS repository Gaussian splat test asset",
      license:
        "Redistributed as versioned CesiumJS test data; see the repository license and the asset metadata.",
      attribution: "CesiumJS test data",
    },
  },
];

function fail(message) {
  throw new Error(`Benchmark scenario error: ${message}`);
}

function requireValue(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function isRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split("/").includes("..")
  );
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateScenario(scenario, index) {
  const name = `scenario ${index}`;
  requireValue(scenario && typeof scenario === "object", `${name} is invalid`);
  requireValue(
    typeof scenario.id === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scenario.id),
    `${name}.id is invalid`,
  );
  for (const key of [
    "category",
    "compression",
    "api",
    "url",
    "resourcePrefix",
  ]) {
    requireValue(
      typeof scenario[key] === "string" && scenario[key].length > 0,
      `${name}.${key} is invalid`,
    );
  }
  requireValue(
    Array.isArray(scenario.assetFiles) && scenario.assetFiles.length > 0,
    `${name}.assetFiles must not be empty`,
  );
  for (const assetFile of scenario.assetFiles) {
    requireValue(isRelativePath(assetFile), `${name} has an invalid asset path`);
  }
  if (scenario.runtimeAssetFiles !== undefined) {
    requireValue(
      Array.isArray(scenario.runtimeAssetFiles) &&
        scenario.runtimeAssetFiles.length > 0,
      `${name}.runtimeAssetFiles must not be empty`,
    );
    for (const assetFile of scenario.runtimeAssetFiles) {
      requireValue(
        isRelativePath(assetFile) && scenario.assetFiles.includes(assetFile),
        `${name} has an invalid runtime asset path`,
      );
    }
  }
  requireValue(
    scenario.provenance && typeof scenario.provenance === "object",
    `${name}.provenance is missing`,
  );
  for (const key of ["source", "license", "attribution"]) {
    requireValue(
      typeof scenario.provenance[key] === "string" &&
        scenario.provenance[key].length > 0,
      `${name}.provenance.${key} is invalid`,
    );
  }
}

function resolveRepositoryPath(relativePath) {
  const resolved = path.resolve(repositoryRoot, relativePath);
  requireValue(
    resolved === repositoryRoot ||
      resolved.startsWith(`${repositoryRoot}${path.sep}`),
    `path escapes the repository: ${relativePath}`,
  );
  return resolved;
}

async function describeAsset(relativePath) {
  const absolutePath = resolveRepositoryPath(relativePath);
  let bytes;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    fail(`unable to read ${relativePath}: ${error.message}`);
  }
  return {
    path: relativePath,
    sizeBytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
}

export async function loadScenarios(selectedScenarioIds = []) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(scenarioManifestPath, "utf8"));
  } catch (error) {
    fail(`unable to read ${path.relative(repositoryRoot, scenarioManifestPath)}: ${error.message}`);
  }

  requireValue(manifest.schemaVersion === 1, "unsupported scenario manifest schema");
  requireValue(
    Array.isArray(manifest.scenarios) && manifest.scenarios.length > 0,
    "scenario manifest is empty",
  );

  const requestedIds = new Set(selectedScenarioIds);
  const scenarios = [];
  const allIds = new Set();
  for (let index = 0; index < manifest.scenarios.length; ++index) {
    const scenario = manifest.scenarios[index];
    validateScenario(scenario, index);
    requireValue(!allIds.has(scenario.id), `duplicate scenario id ${scenario.id}`);
    allIds.add(scenario.id);

    if (requestedIds.size > 0 && !requestedIds.has(scenario.id)) {
      continue;
    }

    const assets = [];
    for (const assetFile of scenario.assetFiles) {
      assets.push(await describeAsset(assetFile));
    }
    scenarios.push({ ...scenario, assets });
  }

  for (const requestedId of requestedIds) {
    requireValue(
      allIds.has(requestedId),
      `scenario selection did not match a committed scenario: ${requestedId}`,
    );
  }
  requireValue(scenarios.length > 0, "scenario selection matched no scenarios");
  return scenarios;
}

export async function loadPrewarmScenarios() {
  const scenarios = [];
  const ids = new Set();
  for (let index = 0; index < prewarmScenarioDefinitions.length; ++index) {
    const scenario = prewarmScenarioDefinitions[index];
    validateScenario(scenario, index);
    requireValue(
      !ids.has(scenario.id),
      `duplicate prewarm scenario id ${scenario.id}`,
    );
    ids.add(scenario.id);

    const assets = [];
    for (const assetFile of scenario.assetFiles) {
      assets.push(await describeAsset(assetFile));
    }
    scenarios.push({ ...scenario, assets });
  }
  return scenarios;
}

function numberOption(value, name) {
  const parsed = Number(value);
  requireValue(Number.isFinite(parsed), `${name} must be a number`);
  return parsed;
}

function integerOption(value, name, minimum = 1) {
  const parsed = numberOption(value, name);
  requireValue(
    Number.isSafeInteger(parsed) && parsed >= minimum,
    `${name} must be an integer >= ${minimum}`,
  );
  return parsed;
}

export function parseBenchmarkArguments(argumentsList) {
  const options = {
    scenarios: [],
    states: ["cold", "warm"],
    variants: [],
    coldIterations: 10,
    warmIterations: 30,
    readyTimeoutMs: 120000,
    seed: Date.now(),
    output: path.join(
      repositoryRoot,
      "Build",
      "Performance",
      "Decompression",
      `benchmark-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`,
    ),
    headed: false,
    port: 8080,
  };

  function valueFor(argument, index) {
    const equalsIndex = argument.indexOf("=");
    if (equalsIndex !== -1) {
      return argument.slice(equalsIndex + 1);
    }
    const value = argumentsList[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${argument} requires a value`);
    }
    return value;
  }

  for (let index = 0; index < argumentsList.length; ++index) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--headed") {
      options.headed = true;
      continue;
    }

    if (argument.startsWith("--scenario")) {
      const value = valueFor(argument, index);
      if (!argument.includes("=")) {
        ++index;
      }
      options.scenarios.push(...value.split(",").filter(Boolean));
      continue;
    }
    if (argument.startsWith("--state")) {
      const value = valueFor(argument, index);
      if (!argument.includes("=")) {
        ++index;
      }
      options.states = value.split(",").filter(Boolean);
      requireValue(options.states.length > 0, "--state must select at least one state");
      requireValue(
        options.states.every((state) => benchmarkStates.includes(state)),
        `unsupported benchmark state: ${value}`,
      );
      continue;
    }
    if (argument.startsWith("--variant")) {
      const value = valueFor(argument, index);
      if (!argument.includes("=")) {
        ++index;
      }
      const separatorIndex = value.indexOf("=");
      requireValue(
        separatorIndex > 0 && separatorIndex < value.length - 1,
        "--variant must use id=url",
      );
      const id = value.slice(0, separatorIndex);
      const url = value.slice(separatorIndex + 1);
      requireValue(
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && id !== "primary",
        `invalid variant id: ${id}`,
      );
      requireValue(
        !options.variants.some((variant) => variant.id === id),
        `duplicate variant id: ${id}`,
      );
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        fail(`invalid variant URL: ${url}`);
      }
      requireValue(
        parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:",
        `variant URL must use http or https: ${url}`,
      );
      options.variants.push({ id, url: parsedUrl.href });
      continue;
    }
    if (argument.startsWith("--iterations")) {
      const value = valueFor(argument, index);
      if (!argument.includes("=")) {
        ++index;
      }
      const iterations = integerOption(value, "--iterations");
      options.coldIterations = iterations;
      options.warmIterations = iterations;
      continue;
    }
    if (argument.startsWith("--cold-iterations")) {
      const value = valueFor(argument, index);
      if (!argument.includes("=")) {
        ++index;
      }
      options.coldIterations = integerOption(value, "--cold-iterations");
      continue;
    }
    if (argument.startsWith("--warm-iterations")) {
      const value = valueFor(argument, index);
      if (!argument.includes("=")) {
        ++index;
      }
      options.warmIterations = integerOption(value, "--warm-iterations");
      continue;
    }
    if (argument.startsWith("--seed")) {
      const value = valueFor(argument, index);
      if (!argument.includes("=")) {
        ++index;
      }
      options.seed = integerOption(value, "--seed", 0);
      continue;
    }
    if (argument.startsWith("--output")) {
      const value = valueFor(argument, index);
      if (!argument.includes("=")) {
        ++index;
      }
      options.output = path.resolve(repositoryRoot, value);
      continue;
    }
    if (argument.startsWith("--port")) {
      const value = valueFor(argument, index);
      if (!argument.includes("=")) {
        ++index;
      }
      options.port = integerOption(value, "--port");
      requireValue(options.port < 65536, "--port must be less than 65536");
      continue;
    }
    if (argument.startsWith("--ready-timeout-ms")) {
      const value = valueFor(argument, index);
      if (!argument.includes("=")) {
        ++index;
      }
      options.readyTimeoutMs = integerOption(value, "--ready-timeout-ms");
      continue;
    }

    fail(`unknown argument ${argument}`);
  }

  requireValue(
    options.variants.length === 0 ||
      (options.states.length === 1 && options.states[0] === "paired-cold"),
    "--variant may only be used with --state paired-cold",
  );
  requireValue(
    !options.states.includes("paired-cold") || options.variants.length > 0,
    "--state paired-cold requires at least one --variant id=url",
  );

  return options;
}

export function printBenchmarkHelp() {
  console.log(`Usage: npm run benchmark-decompression -- [options]

Options:
  --scenario id[,id]        Scenario selection (default: all)
  --state ${benchmarkStates.join(",")}
                            Cache/process states (default: cold,warm)
  --variant id=url          Comparison URL; repeat with paired-cold
  --iterations N            Override both state sample counts
  --cold-iterations N       Fresh browser process samples (default: 10)
  --warm-iterations N       Warm shared-context samples (default: 30)
  --ready-timeout-ms N      Public readiness timeout (default: 120000)
  --seed N                  Reproducible randomized scenario order
  --output path             Durable JSON output path
  --headed                  Launch Chromium headed
  --port N                  Local server port (default: 8080)
`);
}

export function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; --index) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function quantile(values, fraction) {
  if (values.length === 0) {
    return undefined;
  }
  const position = (values.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return values[lower];
  }
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
}

function arithmeticMean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  return quantile([...values].sort((left, right) => left - right), 0.5);
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; ++index) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function bootstrapConfidenceInterval(values, statistic, seed) {
  const bootstrapIterations = 10000;
  const random = createRandom(seed);
  const estimates = [];
  const sample = new Array(values.length);

  for (let iteration = 0; iteration < bootstrapIterations; ++iteration) {
    for (let index = 0; index < values.length; ++index) {
      sample[index] = values[Math.floor(random() * values.length)];
    }
    estimates.push(statistic(sample));
  }

  estimates.sort((left, right) => left - right);
  return {
    lowerMs: quantile(estimates, 0.025),
    upperMs: quantile(estimates, 0.975),
    method: "percentile bootstrap",
    iterations: bootstrapIterations,
  };
}

export function summarizeRuns(runs) {
  const groups = new Map();
  for (const run of runs) {
    if (run.status === "failed" || !run.timing?.milestonesMs) {
      continue;
    }
    for (const [milestone, value] of Object.entries(
      run.timing.milestonesMs,
    )) {
      const variantId = run.variantId ?? "primary";
      const key = `${run.scenarioId}|${run.state}|${variantId}|${milestone}`;
      const values = groups.get(key) ?? [];
      values.push(value);
      groups.set(key, values);
    }
  }

  return Array.from(groups.entries())
    .map(([key, values]) => {
      const [scenarioId, state, variantId, milestone] = key.split("|");
      const sorted = [...values].sort((left, right) => left - right);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return {
        scenarioId,
        state,
        variantId,
        milestone,
        sampleCount: values.length,
        samplesMs: values,
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
        meanMs: mean,
        medianMs: quantile(sorted, 0.5),
        p95Ms: quantile(sorted, 0.95),
      };
    })
    .sort((left, right) =>
      `${left.scenarioId}|${left.state}|${left.variantId}|${left.milestone}`.localeCompare(
        `${right.scenarioId}|${right.state}|${right.variantId}|${right.milestone}`,
      ),
    );
}

export function summarizePreloads(runs) {
  return summarizeRuns(
    runs
      .filter((run) => run.preload?.timing)
      .map((run) => ({
        scenarioId: run.scenarioId,
        state: run.state,
        variantId: run.variantId,
        timing: run.preload.timing,
      })),
  );
}

export function summarizeSetupTimings(executionSetups) {
  const groups = new Map();
  for (const setup of executionSetups) {
    for (const [milestone, value] of Object.entries(setup.timing)) {
      if (typeof value !== "number") {
        continue;
      }
      const variantId = setup.variantId ?? "primary";
      const key = `${setup.state}|${variantId}|${milestone}`;
      const values = groups.get(key) ?? [];
      values.push(value);
      groups.set(key, values);
    }
  }

  return Array.from(groups.entries())
    .map(([key, values]) => {
      const [state, variantId, milestone] = key.split("|");
      const sorted = [...values].sort((left, right) => left - right);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return {
        state,
        variantId,
        milestone,
        sampleCount: values.length,
        samplesMs: values,
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
        meanMs: mean,
        medianMs: quantile(sorted, 0.5),
        p95Ms: quantile(sorted, 0.95),
      };
    })
    .sort((left, right) =>
      `${left.state}|${left.variantId}|${left.milestone}`.localeCompare(
        `${right.state}|${right.variantId}|${right.milestone}`,
      ),
    );
}

export function summarizePairedComparisons(runs) {
  const pairs = new Map();
  for (const run of runs) {
    if (
      run.state !== "paired-cold" ||
      run.status === "failed" ||
      !run.pairId ||
      !run.timing?.milestonesMs
    ) {
      continue;
    }
    const pair = pairs.get(run.pairId) ?? new Map();
    pair.set(run.variantId ?? "primary", run);
    pairs.set(run.pairId, pair);
  }

  const groups = new Map();
  for (const [pairId, pair] of pairs) {
    const primary = pair.get("primary");
    if (!primary) {
      continue;
    }
    for (const [variantId, comparison] of pair) {
      if (variantId === "primary") {
        continue;
      }
      for (const [milestone, comparisonMs] of Object.entries(
        comparison.timing.milestonesMs,
      )) {
        const primaryMs = primary.timing.milestonesMs[milestone];
        if (typeof primaryMs !== "number" || typeof comparisonMs !== "number") {
          continue;
        }
        const key = `${primary.scenarioId}|${variantId}|${milestone}`;
        const deltas = groups.get(key) ?? [];
        const deltaMs = comparisonMs - primaryMs;
        deltas.push({
          pairId,
          primaryMs,
          comparisonMs,
          deltaMs,
          absoluteDeltaMs: Math.abs(deltaMs),
        });
        groups.set(key, deltas);
      }
    }
  }

  return Array.from(groups.entries())
    .map(([key, rawDeltas]) => {
      const [scenarioId, comparisonVariantId, milestone] = key.split("|");
      const deltas = rawDeltas.map((entry) => entry.deltaMs);
      const absoluteDeltas = rawDeltas.map((entry) => entry.absoluteDeltaMs);
      const sorted = [...deltas].sort((left, right) => left - right);
      const sortedAbsolute = [...absoluteDeltas].sort(
        (left, right) => left - right,
      );
      return {
        scenarioId,
        state: "paired-cold",
        milestone,
        primaryVariantId: "primary",
        comparisonVariantId,
        deltaDefinition: "comparison minus primary, in milliseconds",
        sampleCount: deltas.length,
        rawDeltas,
        meanDeltaMs:
          arithmeticMean(deltas),
        medianDeltaMs: quantile(sorted, 0.5),
        p95DeltaMs: quantile(sorted, 0.95),
        meanAbsoluteDeltaMs:
          arithmeticMean(absoluteDeltas),
        medianAbsoluteDeltaMs: quantile(sortedAbsolute, 0.5),
        p95AbsoluteDeltaMs: quantile(sortedAbsolute, 0.95),
        confidenceIntervals: {
          level: 0.95,
          medianDeltaMs: bootstrapConfidenceInterval(
            deltas,
            median,
            hashString(`${key}|median`),
          ),
          meanDeltaMs: bootstrapConfidenceInterval(
            deltas,
            arithmeticMean,
            hashString(`${key}|mean`),
          ),
        },
      };
    })
    .sort((left, right) =>
      `${left.scenarioId}|${left.comparisonVariantId}|${left.milestone}`.localeCompare(
        `${right.scenarioId}|${right.comparisonVariantId}|${right.milestone}`,
      ),
    );
}

const pairedResponsivenessMetrics = [
  {
    id: "longTaskCount",
    description: "main-thread long task count",
    getValue: (run) => run.mainThread?.longTasks?.count,
  },
  {
    id: "longTaskTotalDurationMs",
    description: "total main-thread long task duration in milliseconds",
    getValue: (run) => run.mainThread?.longTasks?.totalDurationMs,
  },
  {
    id: "frameGapP95Ms",
    description: "95th-percentile animation-frame gap in milliseconds",
    getValue: (run) => run.mainThread?.frameGaps?.p95,
  },
  {
    id: "frameGapMaxMs",
    description: "maximum animation-frame gap in milliseconds",
    getValue: (run) => run.mainThread?.frameGaps?.max,
  },
  {
    id: "longFrameGapCount",
    description: "animation-frame gaps at or above the configured threshold",
    getValue: (run) => run.mainThread?.frameGaps?.longGapCount,
  },
];

export function summarizePairedResponsiveness(runs) {
  const pairs = new Map();
  for (const run of runs) {
    if (
      run.state !== "paired-cold" ||
      run.status === "failed" ||
      !run.pairId ||
      !run.mainThread
    ) {
      continue;
    }
    const pair = pairs.get(run.pairId) ?? new Map();
    pair.set(run.variantId ?? "primary", run);
    pairs.set(run.pairId, pair);
  }

  const groups = new Map();
  for (const [pairId, pair] of pairs) {
    const primary = pair.get("primary");
    if (!primary) {
      continue;
    }
    for (const [variantId, comparison] of pair) {
      if (variantId === "primary") {
        continue;
      }
      for (const metric of pairedResponsivenessMetrics) {
        const primaryValue = metric.getValue(primary);
        const comparisonValue = metric.getValue(comparison);
        if (
          typeof primaryValue !== "number" ||
          typeof comparisonValue !== "number"
        ) {
          continue;
        }
        const key = `${primary.scenarioId}|${variantId}|${metric.id}`;
        const group = groups.get(key) ?? {
          description: metric.description,
          deltas: [],
        };
        const deltaMs = comparisonValue - primaryValue;
        group.deltas.push({
          pairId,
          primaryValue,
          comparisonValue,
          deltaMs,
          absoluteDeltaMs: Math.abs(deltaMs),
        });
        groups.set(key, group);
      }
    }
  }

  return Array.from(groups.entries())
    .map(([key, group]) => {
      const [scenarioId, comparisonVariantId, metric] = key.split("|");
      const deltas = group.deltas.map((entry) => entry.deltaMs);
      const absoluteDeltas = group.deltas.map(
        (entry) => entry.absoluteDeltaMs,
      );
      const sorted = [...deltas].sort((left, right) => left - right);
      const sortedAbsolute = [...absoluteDeltas].sort(
        (left, right) => left - right,
      );
      return {
        scenarioId,
        state: "paired-cold",
        metric,
        description: group.description,
        primaryVariantId: "primary",
        comparisonVariantId,
        deltaDefinition:
          "comparison minus primary; positive values mean more blocking or a longer frame gap",
        sampleCount: deltas.length,
        rawDeltas: group.deltas,
        meanDelta: arithmeticMean(deltas),
        medianDelta: quantile(sorted, 0.5),
        p95Delta: quantile(sorted, 0.95),
        meanAbsoluteDelta: arithmeticMean(absoluteDeltas),
        medianAbsoluteDelta: quantile(sortedAbsolute, 0.5),
        p95AbsoluteDelta: quantile(sortedAbsolute, 0.95),
        confidenceIntervals: {
          level: 0.95,
          medianDelta: bootstrapConfidenceInterval(
            deltas,
            median,
            hashString(`${key}|median`),
          ),
          meanDelta: bootstrapConfidenceInterval(
            deltas,
            arithmeticMean,
            hashString(`${key}|mean`),
          ),
        },
      };
    })
    .sort((left, right) =>
      `${left.scenarioId}|${left.comparisonVariantId}|${left.metric}`.localeCompare(
        `${right.scenarioId}|${right.comparisonVariantId}|${right.metric}`,
      ),
    );
}

export function gitIdentity() {
  const command = (args) =>
    execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();

  return {
    commit: command(["rev-parse", "HEAD"]),
    branch: command(["branch", "--show-current"]),
    dirty: command(["status", "--porcelain"]).length > 0,
  };
}

export function nodeEnvironment() {
  const cpu = os.cpus()[0];
  return {
    os: `${process.platform} ${os.release()}`,
    architecture: process.arch,
    cpuModel: cpu?.model,
    logicalCpuCount: os.cpus().length,
    nodeVersion: process.version,
  };
}
