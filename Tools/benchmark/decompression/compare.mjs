#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function fail(message) {
  throw new Error(`Benchmark comparison error: ${message}`);
}

function quantile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return undefined;
  }
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deltaPercent(baseline, candidate) {
  return baseline === 0
    ? undefined
    : ((candidate - baseline) / baseline) * 100;
}

function samplesFor(document, scenarioId, state, milestone) {
  return document.runs
    .filter(
      (run) =>
        run.scenarioId === scenarioId &&
        run.state === state &&
        run.timing.milestonesMs[milestone] !== undefined,
    )
    .map((run) => run.timing.milestonesMs[milestone]);
}

function setupSamplesFor(document, state, milestone) {
  return (document.executionSetups ?? [])
    .filter(
      (setup) =>
        setup.state === state && setup.timing[milestone] !== undefined,
    )
    .map((setup) => setup.timing[milestone]);
}

async function readDocument(file) {
  let document;
  try {
    document = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(`unable to read ${file}: ${error.message}`);
  }
  if (document.status !== "ok" || !Array.isArray(document.runs)) {
    fail(`${file} is not a completed benchmark result`);
  }
  return document;
}

function parseArguments(argumentsList) {
  if (argumentsList.length < 2) {
    fail("usage: node compare.mjs <baseline.json> <candidate.json> [--threshold N] [--output path]");
  }

  const options = {
    baseline: path.resolve(argumentsList[0]),
    candidate: path.resolve(argumentsList[1]),
    threshold: 5,
  };
  for (let index = 2; index < argumentsList.length; ++index) {
    const argument = argumentsList[index];
    if (argument === "--threshold" || argument.startsWith("--threshold=")) {
      const equalsIndex = argument.indexOf("=");
      const value =
        equalsIndex === -1
          ? argumentsList[++index]
          : argument.slice(equalsIndex + 1);
      options.threshold = Number(value);
      if (!Number.isFinite(options.threshold) || options.threshold < 0) {
        fail("--threshold must be a non-negative number");
      }
    } else if (argument === "--output" || argument.startsWith("--output=")) {
      const equalsIndex = argument.indexOf("=");
      const value =
        equalsIndex === -1
          ? argumentsList[++index]
          : argument.slice(equalsIndex + 1);
      options.output = path.resolve(value);
    } else {
      fail(`unknown argument ${argument}`);
    }
  }
  return options;
}

function environmentDifferences(baseline, candidate) {
  const baselineRun = baseline.runs[0];
  const candidateRun = candidate.runs[0];
  const fields = [
    ["cesiumCommit", baseline.runner?.git?.commit, candidate.runner?.git?.commit],
    [
      "browserRevision",
      baselineRun?.browser?.browserRevision,
      candidateRun?.browser?.browserRevision,
    ],
    [
      "browserVersion",
      baselineRun?.browser?.browserVersion,
      candidateRun?.browser?.browserVersion,
    ],
    [
      "hardwareConcurrency",
      baselineRun?.browser?.hardwareConcurrency,
      candidateRun?.browser?.hardwareConcurrency,
    ],
    [
      "viewport",
      JSON.stringify(baseline.runner?.browserViewport),
      JSON.stringify(candidate.runner?.browserViewport),
    ],
    ["cpuModel", baseline.runner?.node?.cpuModel, candidate.runner?.node?.cpuModel],
    ["nodeVersion", baseline.runner?.node?.nodeVersion, candidate.runner?.node?.nodeVersion],
    ["os", baseline.runner?.node?.os, candidate.runner?.node?.os],
    [
      "architecture",
      baseline.runner?.node?.architecture,
      candidate.runner?.node?.architecture,
    ],
    [
      "decoderArtifacts",
      JSON.stringify(baseline.decoderArtifacts ?? []),
      JSON.stringify(candidate.decoderArtifacts ?? []),
    ],
  ];
  return fields
    .filter(([, left, right]) => left !== right)
    .map(([field, left, right]) => ({ field, baseline: left, candidate: right }));
}

const options = parseArguments(process.argv.slice(2));
const [baseline, candidate] = await Promise.all([
  readDocument(options.baseline),
  readDocument(options.candidate),
]);

const keys = new Set();
for (const run of baseline.runs.concat(candidate.runs)) {
  for (const milestone of Object.keys(run.timing.milestonesMs)) {
    keys.add(`${run.scenarioId}|${run.state}|${milestone}`);
  }
}

const comparisons = Array.from(keys)
  .sort()
  .map((key) => {
    const [scenarioId, state, milestone] = key.split("|");
    const baselineSamples = samplesFor(baseline, scenarioId, state, milestone);
    const candidateSamples = samplesFor(candidate, scenarioId, state, milestone);
    if (baselineSamples.length === 0 || candidateSamples.length === 0) {
      return {
        scenarioId,
        state,
        milestone,
        status: "missing",
        baselineSampleCount: baselineSamples.length,
        candidateSampleCount: candidateSamples.length,
      };
    }

    const baselineMedianMs = quantile(baselineSamples, 0.5);
    const candidateMedianMs = quantile(candidateSamples, 0.5);
    const baselineP95Ms = quantile(baselineSamples, 0.95);
    const candidateP95Ms = quantile(candidateSamples, 0.95);
    const baselineMeanMs = mean(baselineSamples);
    const candidateMeanMs = mean(candidateSamples);
    const medianDeltaPercent = deltaPercent(
      baselineMedianMs,
      candidateMedianMs,
    );
    return {
      scenarioId,
      state,
      milestone,
      status:
        medianDeltaPercent > options.threshold
          ? "regression"
          : "within-threshold",
      baselineSampleCount: baselineSamples.length,
      candidateSampleCount: candidateSamples.length,
      baselineMedianMs,
      candidateMedianMs,
      baselineP95Ms,
      candidateP95Ms,
      baselineMeanMs,
      candidateMeanMs,
      deltaPercent: medianDeltaPercent,
      p95DeltaPercent: deltaPercent(baselineP95Ms, candidateP95Ms),
      meanDeltaPercent: deltaPercent(baselineMeanMs, candidateMeanMs),
    };
  });

const setupKeys = new Set();
for (const setup of (baseline.executionSetups ?? []).concat(
  candidate.executionSetups ?? [],
)) {
  for (const milestone of Object.keys(setup.timing)) {
    setupKeys.add(`${setup.state}|${milestone}`);
  }
}

const setupComparisons = Array.from(setupKeys)
  .sort()
  .map((key) => {
    const [state, milestone] = key.split("|");
    const baselineSamples = setupSamplesFor(baseline, state, milestone);
    const candidateSamples = setupSamplesFor(candidate, state, milestone);
    if (baselineSamples.length === 0 || candidateSamples.length === 0) {
      return {
        state,
        milestone,
        status: "missing",
        baselineSampleCount: baselineSamples.length,
        candidateSampleCount: candidateSamples.length,
      };
    }

    const baselineMedianMs = quantile(baselineSamples, 0.5);
    const candidateMedianMs = quantile(candidateSamples, 0.5);
    const baselineP95Ms = quantile(baselineSamples, 0.95);
    const candidateP95Ms = quantile(candidateSamples, 0.95);
    const baselineMeanMs = mean(baselineSamples);
    const candidateMeanMs = mean(candidateSamples);
    return {
      state,
      milestone,
      status: "informational",
      baselineSampleCount: baselineSamples.length,
      candidateSampleCount: candidateSamples.length,
      baselineMedianMs,
      candidateMedianMs,
      baselineP95Ms,
      candidateP95Ms,
      baselineMeanMs,
      candidateMeanMs,
      deltaPercent: deltaPercent(baselineMedianMs, candidateMedianMs),
      p95DeltaPercent: deltaPercent(baselineP95Ms, candidateP95Ms),
      meanDeltaPercent: deltaPercent(baselineMeanMs, candidateMeanMs),
    };
  });

const hasMissingComparisons = comparisons.some(
  (comparison) => comparison.status === "missing",
);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  baseline: {
    file: options.baseline,
    commit: baseline.runner?.git?.commit,
  },
  candidate: {
    file: options.candidate,
    commit: candidate.runner?.git?.commit,
  },
  thresholdPercent: options.threshold,
  environmentDifferences: environmentDifferences(baseline, candidate),
  comparisons,
  setupComparisons,
  status: hasMissingComparisons
    ? "missing"
    : comparisons.some((comparison) => comparison.status === "regression")
      ? "regression"
      : "ok",
};

console.table(
  comparisons.map((comparison) => ({
    scenario: comparison.scenarioId,
    state: comparison.state,
    milestone: comparison.milestone,
    baselineMedianMs: comparison.baselineMedianMs,
    candidateMedianMs: comparison.candidateMedianMs,
    deltaPercent: comparison.deltaPercent,
    p95DeltaPercent: comparison.p95DeltaPercent,
    status: comparison.status,
  })),
);

console.log("Browser/process setup comparisons (informational only)");
console.table(
  setupComparisons.map((comparison) => ({
    state: comparison.state,
    milestone: comparison.milestone,
    baselineMedianMs: comparison.baselineMedianMs,
    candidateMedianMs: comparison.candidateMedianMs,
    deltaPercent: comparison.deltaPercent,
    p95DeltaPercent: comparison.p95DeltaPercent,
    status: comparison.status,
  })),
);

if (result.environmentDifferences.length > 0) {
  console.warn(
    "Baseline and candidate environments differ:",
    result.environmentDifferences,
  );
}

if (options.output) {
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

if (result.status !== "ok") {
  process.exitCode = 1;
}
