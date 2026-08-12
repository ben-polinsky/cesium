import assert from "node:assert/strict";
import test from "node:test";

import {
  benchmarkStates,
  loadScenarios,
  parseBenchmarkArguments,
  summarizePairedComparisons,
  summarizePairedResponsiveness,
  summarizePreloads,
  summarizeRuns,
} from "./benchmark-utils.mjs";

test("parses every non-comparison benchmark state", () => {
  const states = benchmarkStates.filter((state) => state !== "paired-cold");
  const options = parseBenchmarkArguments([
    "--state",
    states.join(","),
    "--iterations",
    "1",
  ]);

  assert.deepEqual(options.states, states);
  assert.equal(options.coldIterations, 1);
  assert.equal(options.warmIterations, 1);
});

test("rejects unknown benchmark states", () => {
  assert.throws(
    () => parseBenchmarkArguments(["--state", "decoder-only"]),
    /unsupported benchmark state/,
  );
});

test("parses ready timeout and repeated paired-cold variants", () => {
  const options = parseBenchmarkArguments([
    "--state",
    "paired-cold",
    "--variant",
    "candidate=http://localhost:8081",
    "--variant=control=http://localhost:8080",
    "--ready-timeout-ms",
    "2500",
  ]);

  assert.equal(options.readyTimeoutMs, 2500);
  assert.deepEqual(options.variants, [
    { id: "candidate", url: "http://localhost:8081/" },
    { id: "control", url: "http://localhost:8080/" },
  ]);
});

test("validates paired-cold variant usage", () => {
  assert.throws(
    () =>
      parseBenchmarkArguments([
        "--variant",
        "candidate=http://localhost:8081",
      ]),
    /only be used with --state paired-cold/,
  );
  assert.throws(
    () => parseBenchmarkArguments(["--state", "paired-cold"]),
    /requires at least one --variant/,
  );
  assert.throws(
    () =>
      parseBenchmarkArguments([
        "--state",
        "paired-cold",
        "--variant",
        "primary=http://localhost:8081",
      ]),
    /invalid variant id/,
  );
});

test("codec scenarios declare explicit runtime assets", async () => {
  const scenarios = await loadScenarios([
    "draco-model-cesium-man",
    "meshopt-model-unit-square",
    "ktx2-model-box",
    "spz-tiles-tower",
  ]);

  for (const scenario of scenarios) {
    assert.ok(scenario.runtimeAssetFiles.length > 0);
    for (const assetFile of scenario.runtimeAssetFiles) {
      assert.ok(scenario.assetFiles.includes(assetFile));
    }
  }
});

test("summarizes preload timing separately from target timing", () => {
  const summaries = summarizePreloads([
    {
      scenarioId: "meshopt-model-unit-square",
      state: "worker-probe-preloaded",
      preload: {
        timing: {
          milestonesMs: {
            preloadReady: 12,
          },
        },
      },
    },
  ]);

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].milestone, "preloadReady");
  assert.equal(summaries[0].medianMs, 12);
});

test("summaries distinguish variants and skip failed samples", () => {
  const summaries = summarizeRuns([
    {
      scenarioId: "meshopt",
      state: "paired-cold",
      variantId: "primary",
      timing: { milestonesMs: { publicReady: 10 } },
    },
    {
      scenarioId: "meshopt",
      state: "paired-cold",
      variantId: "candidate",
      timing: { milestonesMs: { publicReady: 12 } },
    },
    {
      scenarioId: "meshopt",
      state: "paired-cold",
      variantId: "candidate",
      status: "failed",
      timing: null,
    },
  ]);

  assert.deepEqual(
    summaries.map((summary) => [summary.variantId, summary.sampleCount]),
    [
      ["candidate", 1],
      ["primary", 1],
    ],
  );
});

test("summarizes paired cold deltas by pair and comparison variant", () => {
  const run = (pairId, variantId, publicReady) => ({
    pairId,
    scenarioId: "meshopt",
    state: "paired-cold",
    variantId,
    timing: { milestonesMs: { publicReady } },
  });
  const summaries = summarizePairedComparisons([
    run("pair-0", "primary", 10),
    run("pair-0", "candidate", 12),
    run("pair-1", "candidate", 9),
    run("pair-1", "primary", 10),
  ]);

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].comparisonVariantId, "candidate");
  assert.equal(summaries[0].meanDeltaMs, 0.5);
  assert.equal(summaries[0].medianAbsoluteDeltaMs, 1.5);
  assert.equal(summaries[0].confidenceIntervals.level, 0.95);
  assert.ok(
    summaries[0].confidenceIntervals.medianDeltaMs.lowerMs <=
      summaries[0].medianDeltaMs,
  );
  assert.ok(
    summaries[0].confidenceIntervals.medianDeltaMs.upperMs >=
      summaries[0].medianDeltaMs,
  );
  assert.deepEqual(
    summaries[0].rawDeltas.map((delta) => delta.deltaMs),
    [2, -1],
  );
});

test("summarizes paired responsiveness deltas with uncertainty", () => {
  const run = (pairId, variantId, frameGapMaxMs) => ({
    pairId,
    scenarioId: "meshopt",
    state: "paired-cold",
    variantId,
    mainThread: {
      longTasks: { count: 0, totalDurationMs: 0 },
      frameGaps: {
        p95: frameGapMaxMs,
        max: frameGapMaxMs,
        longGapCount: 0,
      },
    },
  });
  const summaries = summarizePairedResponsiveness([
    run("pair-0", "primary", 10),
    run("pair-0", "candidate", 12),
    run("pair-1", "candidate", 9),
    run("pair-1", "primary", 10),
  ]);
  const frameGapMax = summaries.find(
    (summary) => summary.metric === "frameGapMaxMs",
  );

  assert.equal(frameGapMax.comparisonVariantId, "candidate");
  assert.equal(frameGapMax.medianDelta, 0.5);
  assert.equal(frameGapMax.sampleCount, 2);
  assert.equal(frameGapMax.confidenceIntervals.level, 0.95);
  assert.ok(
    frameGapMax.confidenceIntervals.medianDelta.lowerMs <=
      frameGapMax.medianDelta,
  );
  assert.ok(
    frameGapMax.confidenceIntervals.medianDelta.upperMs >=
      frameGapMax.medianDelta,
  );
});
