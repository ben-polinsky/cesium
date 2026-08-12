#!/usr/bin/env node
// Deterministic paired analysis of a confirmatory report. Every number that
// gets relayed as PR evidence should come from here rather than being
// recomputed by hand from the raw runs.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function quantile(values, fraction) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function median(values) {
  return quantile(values, 0.5);
}

// Metric readers deliberately derive responsiveness values from the retained
// raw observations. This keeps the report auditable and avoids trusting a
// second set of precomputed values produced during measurement.
const metrics = Object.freeze({
  publicReadyMs: (run) => run.publicReadyMs,
  maxFrameGapMs: (run) =>
    run.responsiveness
      ? Math.max(...run.responsiveness.frameGapsMs)
      : undefined,
  p95FrameGapMs: (run) =>
    run.responsiveness
      ? quantile(run.responsiveness.frameGapsMs, 0.95)
      : undefined,
  longTaskCount: (run) => run.responsiveness?.longTaskCount,
  longTaskDurationMs: (run) =>
    run.responsiveness?.longTasks.reduce(
      (sum, task) => sum + task.durationMs,
      0,
    ),
  gapsOver50Ms: (run) =>
    run.responsiveness?.frameGapsMs.filter((gap) => gap > 50).length,
});

// Pairs are matched by block, never by array position. Each delta therefore
// compares candidate and baseline samples collected in the same local portion
// of the run, reducing sensitivity to browser warming and machine drift.
// Positive deltas always mean candidate - baseline.
export function pairScenario(runs, scenarioId, metric) {
  const read = metrics[metric];
  const blocks = new Map();
  for (const run of runs) {
    if (run.scenarioId !== scenarioId) continue;
    const value = read(run);
    if (value === undefined) continue;
    const pair = blocks.get(run.block) ?? {
      block: run.block,
      order: run.order,
    };
    pair[run.variant] = value;
    blocks.set(run.block, pair);
  }
  return [...blocks.values()]
    .filter(
      (pair) => pair.candidate !== undefined && pair.baseline !== undefined,
    )
    .sort((left, right) => left.block - right.block)
    .map((pair) => ({ ...pair, delta: pair.candidate - pair.baseline }));
}

export function summarizeMetric(runs, scenarioId, metric) {
  const pairs = pairScenario(runs, scenarioId, metric);
  if (pairs.length === 0) return undefined;
  const deltas = pairs.map((pair) => pair.delta);
  return {
    pairs: pairs.length,
    baselineMedian: median(pairs.map((pair) => pair.baseline)),
    candidateMedian: median(pairs.map((pair) => pair.candidate)),
    pairedMedianDelta: median(deltas),
    // These are the extrema actually observed in the twelve pairs. They are
    // intentionally not labeled or interpreted as a confidence interval.
    minDelta: Math.min(...deltas),
    maxDelta: Math.max(...deltas),
    candidateHigherPairs: deltas.filter((delta) => delta > 0).length,
    candidateLowerPairs: deltas.filter((delta) => delta < 0).length,
    // Order is alternated, so a split by order shows whether elapsed-time drift
    // rather than the variant explains the delta.
    byOrder: Object.fromEntries(
      ["candidate-first", "baseline-first"].map((order) => {
        const subset = pairs.filter((pair) => pair.order === order);
        return [
          order,
          {
            pairs: subset.length,
            medianDelta: median(subset.map((pair) => pair.delta)),
          },
        ];
      }),
    ),
    deltas,
  };
}

export function summarizeConfirmatory(report) {
  const responsivenessMetrics = [
    "maxFrameGapMs",
    "p95FrameGapMs",
    "longTaskCount",
    "longTaskDurationMs",
    "gapsOver50Ms",
  ];
  return {
    // Preserve measurement scope beside the numbers so a detached summary
    // cannot easily be mistaken for total page-start or decoder-only timing.
    measures: report.measures,
    candidate: report.variants.candidate.commit,
    baseline: report.variants.baseline.commit,
    build: report.build,
    scenarios: Object.fromEntries(
      report.scenarios.map((scenarioId) => [
        scenarioId,
        Object.fromEntries(
          ["publicReadyMs", ...responsivenessMetrics]
            .map((metric) => [
              metric,
              summarizeMetric(report.runs, scenarioId, metric),
            ])
            .filter(([, summary]) => summary !== undefined),
        ),
      ]),
    ),
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const input =
    process.argv[2] ?? "Build/Performance/Decompression/confirmatory.json";
  const report = JSON.parse(await readFile(input, "utf8"));
  console.log(JSON.stringify(summarizeConfirmatory(report), null, 2));
}
