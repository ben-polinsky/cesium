import assert from "node:assert/strict";
import test from "node:test";

import {
  median,
  pairScenario,
  quantile,
  summarizeMetric,
} from "./confirmatory-summary.mjs";

const runs = [
  { block: 0, order: "candidate-first", variant: "candidate", scenarioId: "s", publicReadyMs: 30 },
  { block: 0, order: "candidate-first", variant: "baseline", scenarioId: "s", publicReadyMs: 10 },
  { block: 1, order: "baseline-first", variant: "baseline", scenarioId: "s", publicReadyMs: 20 },
  { block: 1, order: "baseline-first", variant: "candidate", scenarioId: "s", publicReadyMs: 60 },
  { block: 2, order: "candidate-first", variant: "candidate", scenarioId: "s", publicReadyMs: 5 },
  { block: 2, order: "candidate-first", variant: "baseline", scenarioId: "s", publicReadyMs: 15 },
  { block: 0, order: "candidate-first", variant: "candidate", scenarioId: "other", publicReadyMs: 999 },
];

test("interpolates quantiles and medians the same way the older harness does", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([10], 0.95), 10);
  assert.equal(quantile([], 0.5), undefined);
  assert.equal(median([3, 1, 2]), 2);
});

test("pairs runs by block and ignores other scenarios", () => {
  const pairs = pairScenario(runs, "s", "publicReadyMs");
  assert.deepEqual(
    pairs.map(({ block, delta }) => ({ block, delta })),
    [
      { block: 0, delta: 20 },
      { block: 1, delta: 40 },
      { block: 2, delta: -10 },
    ],
  );
});

test("drops blocks that are missing one variant", () => {
  const partial = runs.filter(
    (run) => !(run.block === 1 && run.variant === "baseline"),
  );
  assert.deepEqual(
    pairScenario(partial, "s", "publicReadyMs").map(({ block }) => block),
    [0, 2],
  );
});

test("reports paired medians and a split by run order", () => {
  const summary = summarizeMetric(runs, "s", "publicReadyMs");
  assert.equal(summary.pairs, 3);
  assert.equal(summary.baselineMedian, 15);
  assert.equal(summary.candidateMedian, 30);
  assert.equal(summary.pairedMedianDelta, 20);
  assert.equal(summary.minDelta, -10);
  assert.equal(summary.maxDelta, 40);
  assert.equal(summary.candidateHigherPairs, 2);
  assert.equal(summary.candidateLowerPairs, 1);
  assert.deepEqual(summary.byOrder["candidate-first"], { pairs: 2, medianDelta: 5 });
  assert.deepEqual(summary.byOrder["baseline-first"], { pairs: 1, medianDelta: 40 });
});

test("derives responsiveness metrics from the raw frame gaps", () => {
  const responsivenessRuns = [
    {
      block: 0,
      order: "candidate-first",
      variant: "candidate",
      scenarioId: "spz",
      responsiveness: {
        frameGapsMs: [8, 9, 83],
        longTaskCount: 1,
        longTasks: [{ startMs: 10, durationMs: 84 }],
      },
    },
    {
      block: 0,
      order: "candidate-first",
      variant: "baseline",
      scenarioId: "spz",
      responsiveness: {
        frameGapsMs: [8, 9, 224, 60],
        longTaskCount: 2,
        longTasks: [
          { startMs: 10, durationMs: 84 },
          { startMs: 300, durationMs: 16 },
        ],
      },
    },
  ];
  assert.equal(
    summarizeMetric(responsivenessRuns, "spz", "maxFrameGapMs").pairedMedianDelta,
    83 - 224,
  );
  assert.equal(
    summarizeMetric(responsivenessRuns, "spz", "longTaskDurationMs").pairedMedianDelta,
    84 - 100,
  );
  assert.deepEqual(
    summarizeMetric(responsivenessRuns, "spz", "gapsOver50Ms").deltas,
    [1 - 2],
  );
});

test("omits responsiveness summaries for scenarios that do not record them", () => {
  assert.equal(summarizeMetric(runs, "s", "maxFrameGapMs"), undefined);
});
