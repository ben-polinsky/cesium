#!/usr/bin/env node
import { readFile } from "node:fs/promises";

export function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function summarize(report) {
  return report.scenarios.map((scenario) => {
    const values = (state) =>
      report.runs
        .filter((run) => run.scenarioId === scenario.id && run.state === state)
        .map((run) => run.publicReadyMs);
    return {
      ...scenario,
      coldMedianMs: median(values("cold")),
      warmMedianMs: median(values("warm")),
    };
  });
}

if (process.argv[1]?.endsWith("summarize.mjs")) {
  const [baselinePath, candidatePath] = process.argv.slice(2);
  if (!baselinePath || !candidatePath) {
    throw new Error("Usage: summarize.mjs BASELINE.json CANDIDATE.json");
  }
  const [baseline, candidate] = await Promise.all(
    [baselinePath, candidatePath].map(async (file) =>
      JSON.parse(await readFile(file, "utf8")),
    ),
  );
  const baselineRows = new Map(summarize(baseline).map((row) => [row.id, row]));
  const rows = summarize(candidate).map((row) => {
    const before = baselineRows.get(row.id);
    if (!before) throw new Error(`Baseline is missing ${row.id}`);
    return {
      asset: row.id,
      sizeBytes: row.sizeBytes,
      coldBaselineMs: before.coldMedianMs,
      coldCandidateMs: row.coldMedianMs,
      warmBaselineMs: before.warmMedianMs,
      warmCandidateMs: row.warmMedianMs,
    };
  });
  console.log(JSON.stringify(rows, null, 2));
}
