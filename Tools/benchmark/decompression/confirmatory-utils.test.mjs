import assert from "node:assert/strict";
import test from "node:test";

import {
  hashFiles,
  pairedOrders,
  parseConfirmatoryArguments,
} from "./confirmatory-utils.mjs";
import { safeFile } from "./confirmatory-server.mjs";

test("parses explicit variant refs without confusing them for paths", () => {
  const options = parseConfirmatoryArguments([
    "--candidate=/candidate",
    "--baseline", "/baseline",
    "--candidate-ref", "candidate-ref",
    "--baseline-ref=baseline-ref",
    "--port", "8100",
  ]);
  assert.equal(options.candidate, "/candidate");
  assert.equal(options.baseline, "/baseline");
  assert.equal(options.candidateRef, "candidate-ref");
  assert.equal(options.baselineRef, "baseline-ref");
  assert.equal(options.port, 8100);
});

test("provides exactly twelve counterbalanced paired blocks", () => {
  const orders = pairedOrders();
  assert.equal(orders.length, 12);
  assert.equal(orders.filter(({ order }) => order[0] === "candidate").length, 6);
  assert.equal(orders.filter(({ order }) => order[0] === "baseline").length, 6);
});

test("rejects path traversal from mounted roots", () => {
  assert.throws(() => safeFile("/safe/root", "../outside"), /path traversal/);
});

test("records absent optional variant artifacts", async () => {
  const [artifact] = await hashFiles(process.cwd(), [
    "Tools/benchmark/decompression/no-such-artifact.js",
  ]);
  assert.deepEqual(artifact, {
    path: "Tools/benchmark/decompression/no-such-artifact.js",
    present: false,
  });
});
