# 14-asset decompression benchmark

Loads each asset in `scenarios.json` through its public Cesium API in a real
Chromium browser and times how long it takes to reach that API's own "ready"
condition (e.g. `model.ready`, `tileset.tilesLoaded`). No internal Cesium
instrumentation - the clock starts at the public call and stops at the public
readiness check.

## Review order

1. `scenarios.json` — the 14 assets: id, category, compression, API, and URL.
2. `benchmark.html` + `browserRunner.js` — loads the asset via its public API
   and returns the elapsed time.
3. `benchmark.spec.js` — the Playwright test: for each scenario, runs 10 cold
   samples (fresh Chromium process + profile each time) and 30 warm samples
   (one shared browser context, warmed up once, then measured).
4. `stats.mjs` — min/median/mean/p95 over the samples. Nothing fancier.
5. `compare.mjs` — diffs the median duration of two reports.

## Run

```sh
npm run benchmark-decompression
npm run benchmark-decompression:compare -- baseline.json candidate.json
npm run benchmark-decompression:test
```

Useful flags for `benchmark-decompression`: `--scenario <id>` (repeatable),
`--cold-iterations N`, `--warm-iterations N`, `--output <path>`, `--headed`.
Run with `--help` for the full list.

## Re:Earth route

`reearth/` is a separate, unrelated test against the live Re:Earth production
tileset, comparing two built Cesium worktrees (baseline vs. candidate). It
does not affect the 14-asset sweep above.
