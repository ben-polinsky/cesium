# Decoder worker benchmarks

The primary benchmark is the **14-asset public-API sweep**. It measures
Cesium's public loading APIs across Draco, KTX2, Meshopt, SPZ, KMZ, and Google
Earth Enterprise content.

| Benchmark                       | Coverage                                                                                   | Command                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 14-asset sweep                  | 10 cold and 30 warm `publicReady` samples per variant for all fixtures in `scenarios.json` | `npm run benchmark-decompression:full`                                         |
| Exact-base fixture confirmation | 12 counterbalanced cold pairs for two Meshopt fixtures and the SPZ tower                   | `npm run benchmark-decompression:fixtures -- --candidate PATH --baseline PATH` |
| Re:Earth production route       | Fresh-context Meshopt 3D Tiles route with readiness and responsiveness observations        | `npm run benchmark-decompression:reearth -- --candidate PATH --baseline PATH`  |

## 14-asset sweep

`full-sweep/scenarios.json` is the complete, readable fixture manifest: each
row records the public API, content files, compression type, and provenance. It
includes:

- three Draco glTF models;
- two Draco point clouds;
- KTX2, Meshopt cube, and Meshopt unit-square models;
- four SPZ 3D Tiles fixtures;
- KMZ and GEE metadata.

`full-sweep/run.mjs` is the complete runner: it creates a new Chromium process
for every cold sample, prepares one shared context for warm samples, and writes
the raw measurements. `full-sweep/browser.js` contains the timed public Cesium
loading operations. `full-sweep/summarize.mjs` compares two reports by median.

```sh
# Run once from the baseline worktree.
npm run benchmark-decompression:full -- \
  --output /tmp/baseline-full-sweep.json

# Run once from the candidate worktree.
npm run benchmark-decompression:full -- \
  --output /tmp/candidate-full-sweep.json

# Compare the two reports.
npm run benchmark-decompression:full:compare -- \
  /tmp/baseline-full-sweep.json /tmp/candidate-full-sweep.json
```

Cold samples use a fresh browser context. Warm samples reuse the prepared
benchmark page after a cold run. The timer starts immediately before Cesium's
public loader call and stops at public readiness.

The retained full sweep uses baseline `eab72bb` and candidate `7e62092`.
The exact-base fixture confirmation below separately compares the PR base
`6d5d8b1` with `7e62092`.

## Exact-base fixture confirmation

`confirmatory/run.mjs` rebuilds both clean worktrees, alternates
candidate-first and baseline-first order across 12 pairs, and uses a fresh
browser context for every sample. `summarize.mjs` derives paired results from
the raw report.

```sh
npm run benchmark-decompression:fixtures -- \
  --candidate ../cesium-candidate \
  --baseline ../cesium-baseline
npm run benchmark-decompression:fixtures:summary -- \
  Build/Performance/Decompression/confirmatory.json
```

## Re:Earth production route

`production-route/run.mjs` applies the same clean-worktree and paired-order
rules to a fixed Re:Earth Buildings route. It is a route measurement, not a
full traversal of the tileset.

```sh
npm run benchmark-decompression:reearth -- \
  --candidate ../cesium-candidate \
  --baseline ../cesium-baseline
```

## Checks

```sh
npm run benchmark-decompression:test
```

The repository retains the sweep runner and fixtures, the exact-base
confirmation, and the production-route runner. Raw captures, generators, and
exploratory preload and ion experiments remain on
`bdp/issue-13617-performance-benchmarks-archive`.
