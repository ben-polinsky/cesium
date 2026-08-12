import assert from "node:assert/strict";
import test from "node:test";
import { median, summarize } from "./summarize.mjs";

test("calculates odd and even medians", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 4, 2, 3]), 2.5);
});

test("keeps cold and warm measurements separate", () => {
  const [row] = summarize({
    scenarios: [{ id: "asset", sizeBytes: 4 }],
    runs: [
      { scenarioId: "asset", state: "cold", publicReadyMs: 30 },
      { scenarioId: "asset", state: "cold", publicReadyMs: 10 },
      { scenarioId: "asset", state: "warm", publicReadyMs: 8 },
      { scenarioId: "asset", state: "warm", publicReadyMs: 4 },
    ],
  });
  assert.equal(row.coldMedianMs, 20);
  assert.equal(row.warmMedianMs, 6);
});
