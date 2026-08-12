# 14-asset decompression sweep

This is the unchanged runner that produced the 14-asset cold/warm matrix.
The executable files match
`bdp/issue-13617-performance-benchmarks-archive` byte-for-byte.

## Review order

1. `scenarios.json` — the 14 assets, public APIs, runtime files, and provenance.
2. `run.mjs` — command-line options and Playwright invocation.
3. `benchmark.spec.js` — sample lifecycle: 10 cold samples and 30 warm samples.
4. `browserRunner.js` — the public Cesium loading call and readiness condition.
5. `benchmark-utils.mjs` — validation, report metadata, sample ordering, and summaries.
6. `compare.mjs` — baseline/candidate report comparison.
7. `benchmark-utils.test.mjs` — the runner's focused checks.

## Run

```sh
npm run benchmark-decompression:full
npm run benchmark-decompression:full:compare -- \
  baseline.json candidate.json
npm run benchmark-decompression:full:test
```

Cold samples use a fresh Chromium process and ephemeral profile. Warm samples
load each asset once through the same public API, then retain that browser
context for the measured samples. The timer starts at the public loader call
and ends when that API's readiness condition is met.

## Re:Earth route

`production-route/` is the separate Re:Earth route test. It does not change
the 14-asset sweep.

The archive branch retains raw captures, generators, and unrelated exploratory
experiments; they are deliberately not part of this review surface.
