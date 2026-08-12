import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultBaselineRef,
  defaultCandidateRef,
  hashFiles,
  pairedOrders,
  parseConfirmatoryArguments,
} from "./utils.mjs";
import { safeFile } from "./server.mjs";

test("defaults the baseline to the PR merge base, not fork main", () => {
  assert.equal(defaultCandidateRef, "7e620929194becfe04c5ad019c030159cfe0aa34");
  assert.equal(defaultBaselineRef, "6d5d8b1f0725b6f831b336463f4b11c98023427b");
  const options = parseConfirmatoryArguments(["--candidate=/c", "--baseline=/b"]);
  assert.equal(options.baselineRef, "6d5d8b1f0725b6f831b336463f4b11c98023427b");
});

test("rebuilds both variants unless --skip-build is passed", () => {
  assert.equal(
    parseConfirmatoryArguments(["--candidate=/c", "--baseline=/b"]).skipBuild,
    false,
  );
  assert.equal(
    parseConfirmatoryArguments(["--candidate=/c", "--baseline=/b", "--skip-build"]).skipBuild,
    true,
  );
});

test("parses explicit variant refs without confusing them for paths", () => {
  const options = parseConfirmatoryArguments([
    "--candidate=/candidate",
    "--baseline",
    "/baseline",
    "--candidate-ref",
    "candidate-ref",
    "--baseline-ref=baseline-ref",
    "--port",
    "8100",
  ]);
  assert.equal(options.candidate, "/candidate");
  assert.equal(options.baseline, "/baseline");
  assert.equal(options.candidateRef, "candidate-ref");
  assert.equal(options.baselineRef, "baseline-ref");
  assert.equal(options.port, 8100);
});

test("interleaves twelve counterbalanced paired blocks so order is not confounded with time", () => {
  const orders = pairedOrders();
  assert.equal(orders.length, 12);
  assert.equal(orders.filter(({ order }) => order[0] === "candidate").length, 6);
  assert.equal(orders.filter(({ order }) => order[0] === "baseline").length, 6);
  assert.deepEqual(
    orders.map(({ order }) => order[0]),
    Array.from({ length: 12 }, (_, block) =>
      block % 2 === 0 ? "candidate" : "baseline",
    ),
  );
  for (const { block, order } of orders) {
    assert.equal(order.length, 2);
    assert.notEqual(order[0], order[1]);
    assert.equal(typeof block, "number");
  }
  for (const half of [orders.slice(0, 6), orders.slice(6)]) {
    assert.equal(half.filter(({ order }) => order[0] === "candidate").length, 3);
    assert.equal(half.filter(({ order }) => order[0] === "baseline").length, 3);
  }
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
