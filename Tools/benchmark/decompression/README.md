# Decoder worker benchmarks

These two benchmarks evaluate moving Meshopt and SPZ decoding from the main
thread to workers. Both compare the PR head
`7e620929194becfe04c5ad019c030159cfe0aa34` with its actual base
`6d5d8b1f0725b6f831b336463f4b11c98023427b`.

| Benchmark            | What it covers                                                                                                    | Command                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Fixture confirmation | Cold first-use readiness for two Meshopt models and an SPZ tower; SPZ frame continuity                            | `npm run benchmark-decompression:fixtures -- --candidate PATH --baseline PATH` |
| Production route     | Fresh-context Re:Earth Meshopt 3D Tiles route, including readiness, frame gaps, long tasks, and requested content | `npm run benchmark-decompression:reearth -- --candidate PATH --baseline PATH`  |

## Fixture confirmation

`confirmatory/run.mjs` rebuilds both clean worktrees, alternates candidate-first
and baseline-first order across 12 pairs, and uses a fresh browser context for
every sample. The shared browser page starts timing immediately before calling
Cesium's public loading API and stops at public readiness.

`confirmatory/browser.js` is the browser-side measurement. `utils.mjs` checks
worktree identity and build freshness. `summarize.mjs` derives paired results
from the raw report; it does not recompute numbers by hand.

```sh
npm run benchmark-decompression:fixtures -- \
  --candidate ../cesium-candidate \
  --baseline ../cesium-baseline
npm run benchmark-decompression:fixtures:summary -- \
  Build/Performance/Decompression/confirmatory.json
```

The fixture benchmark measures first compressed-asset use after the engine has
loaded. It is not a total page-startup measurement.

## Production route

`production-route/run.mjs` applies the same clean-worktree and paired-order
rules to a fixed Re:Earth Buildings route. `browser.js` loads the production
tileset through Cesium and records route readiness plus browser responsiveness.
Each run receives a fresh browser context.

```sh
npm run benchmark-decompression:reearth -- \
  --candidate ../cesium-candidate \
  --baseline ../cesium-baseline
```

This is a route test, not a full traversal of the entire Re:Earth tileset.

## Checks

```sh
npm run benchmark-decompression:test
```

The tests cover exact-reference defaults, clean build options, counterbalanced
order, path containment, and paired summary calculations.

## Deliberately excluded

This branch excludes exploratory preload, synthetic corpus, ion/SPZ diagnostic,
and raw-result artifacts. The complete investigation, including the older
14-asset cold/warm sweep, is preserved on
`bdp/issue-13617-performance-benchmarks-archive`. Its sweep used a different
baseline and is not PR-attribution evidence.
