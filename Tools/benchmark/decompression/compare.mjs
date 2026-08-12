#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";

// Compares two benchmark.json reports (from benchmark.spec.js) scenario by
// scenario, using the median duration of each cold/warm sample set.
const {
  values: { threshold },
  positionals: [baselinePath, candidatePath],
} = parseArgs({
  options: { threshold: { type: "string", default: "5" } },
  allowPositionals: true,
});

if (!baselinePath || !candidatePath) {
  console.error("Usage: node compare.mjs <baseline.json> <candidate.json> [--threshold percent]");
  process.exit(1);
}

const thresholdPercent = Number(threshold);

async function readReport(file) {
  const document = JSON.parse(await readFile(file, "utf8"));
  return new Map(
    document.results.map((result) => [`${result.scenarioId}|${result.state}`, result]),
  );
}

const [baseline, candidate] = await Promise.all([
  readReport(baselinePath),
  readReport(candidatePath),
]);

const rows = [];
let hasRegression = false;
for (const [key, baselineResult] of baseline) {
  const candidateResult = candidate.get(key);
  if (!candidateResult) {
    continue;
  }
  const deltaPercent =
    ((candidateResult.medianMs - baselineResult.medianMs) / baselineResult.medianMs) * 100;
  const isRegression = deltaPercent > thresholdPercent;
  hasRegression ||= isRegression;
  rows.push({
    scenario: baselineResult.scenarioId,
    state: baselineResult.state,
    baselineMedianMs: baselineResult.medianMs.toFixed(1),
    candidateMedianMs: candidateResult.medianMs.toFixed(1),
    deltaPercent: deltaPercent.toFixed(1),
    status: isRegression ? "REGRESSION" : "ok",
  });
}

console.table(rows);
process.exitCode = hasRegression ? 1 : 0;
