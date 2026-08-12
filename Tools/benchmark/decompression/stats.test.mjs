import assert from "node:assert/strict";
import test from "node:test";

import { quantile, summarize } from "./stats.mjs";

test("quantile interpolates between the two nearest samples", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([10], 0.95), 10);
});

test("summarize reports min/median/mean/p95/max", () => {
  const result = summarize([100, 200, 300, 400, 500]);
  assert.equal(result.sampleCount, 5);
  assert.equal(result.minMs, 100);
  assert.equal(result.medianMs, 300);
  assert.equal(result.meanMs, 300);
  assert.equal(result.maxMs, 500);
});
