// Basic descriptive stats for a set of millisecond samples. No confidence
// intervals or bootstrapping - a colleague reading this benchmark should be
// able to see exactly what a "p95" or "median" means without cross-referencing
// a stats textbook.

export function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper
    ? sorted[lower]
    : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function summarize(samplesMs) {
  const mean = samplesMs.reduce((sum, ms) => sum + ms, 0) / samplesMs.length;
  return {
    sampleCount: samplesMs.length,
    minMs: Math.min(...samplesMs),
    medianMs: quantile(samplesMs, 0.5),
    meanMs: mean,
    p95Ms: quantile(samplesMs, 0.95),
    maxMs: Math.max(...samplesMs),
  };
}
