# Decompression worker benchmarks

This directory contains the performance evidence for moving decoder work from
the main thread to workers. It intentionally keeps three complementary,
runnable benchmark lanes. They answer different questions and must not be
treated as interchangeable.

| Lane           | Scope                                                                 | Primary measurement                                                        | Command                                                                            |
| -------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Full sweep     | 14 local public-API fixtures: Draco, KTX2, Meshopt, SPZ, KMZ, and GEE | Cold and warm `publicReady` latency                                        | `npm run benchmark-decompression:full`                                             |
| Confirmatory   | Exact candidate/base comparison: two Meshopt fixtures and SPZ tower   | Cold first-use readiness and SPZ frame continuity                          | `npm run benchmark-decompression:confirmatory -- --candidate PATH --baseline PATH` |
| Re:Earth route | Production Meshopt 3D Tiles route                                     | Fresh-context route readiness, frame gaps, long tasks, and request content | `npm run benchmark-decompression:reearth -- --candidate PATH --baseline PATH`      |

## Choosing a lane

Use the **full sweep** to inspect behavior across the broad local fixture
matrix, including its 10 cold and 30 warm samples per variant. The fixture
definition and source provenance are in `scenarios.json`.

Use the **confirmatory** lane when attributing an outcome to this PR. It
requires clean worktrees at the supplied candidate and baseline commits,
rebuilds both minified engine distributions, and alternates candidate-first
and baseline-first order across 12 isolated browser-context pairs.

Use the **Re:Earth route** to exercise a production-scale Meshopt stream.
It uses the same exact-reference worktree checks and alternating pair order as
the confirmatory lane. It is a route measurement, not a full traversal of the
entire tileset.

Every report records the compared commit identities. Do not combine values from
reports that use different references.

## Run

Install this repository's dependencies, then create clean worktrees for the
commits being compared:

```sh
git worktree add ../cesium-candidate <candidate-ref>
git worktree add ../cesium-baseline <baseline-ref>
```

Run the full fixture matrix from one checkout:

```sh
npm run benchmark-decompression:full -- \
  --output Build/Performance/Decompression/full-sweep.json
npm run benchmark-decompression:full:compare -- \
  Build/Performance/Decompression/full-sweep.json
```

Run the exact-base fixture confirmation:

```sh
npm run benchmark-decompression:confirmatory -- \
  --candidate ../cesium-candidate \
  --baseline ../cesium-baseline
npm run benchmark-decompression:confirmatory:summary -- \
  Build/Performance/Decompression/confirmatory.json
```

Run the Re:Earth route:

```sh
npm run benchmark-decompression:reearth -- \
  --candidate ../cesium-candidate \
  --baseline ../cesium-baseline
```

`--skip-build` is for harness debugging only. A result that did not rebuild
both worktrees records that fact and should not be used as performance
evidence.

## Code map

### Full sweep

| File                  | Responsibility                                                           |
| --------------------- | ------------------------------------------------------------------------ |
| `scenarios.json`      | 14 fixture definitions, runtime files, and provenance                    |
| `run.mjs`             | Parses options and invokes Playwright                                    |
| `benchmark.spec.js`   | Controls cold/warm samples, browser isolation, and raw result collection |
| `browserRunner.js`    | Performs the timed public Cesium loading operations                      |
| `benchmark-utils.mjs` | Scenario validation, identity capture, sample ordering, and summaries    |
| `compare.mjs`         | Produces comparisons from retained raw results                           |

### Confirmatory

| File                         | Responsibility                                                            |
| ---------------------------- | ------------------------------------------------------------------------- |
| `confirmatory/run.mjs`       | Verifies worktrees, rebuilds both variants, and runs paired samples       |
| `confirmatory/browser.js`    | Defines the neutral browser-side public loading and responsiveness timing |
| `confirmatory/server.mjs`    | Serves the harness and both worktrees through symmetric no-cache mounts   |
| `confirmatory/utils.mjs`     | Defines the exact refs, fixtures, ordering, build checks, and hashes      |
| `confirmatory/summarize.mjs` | Derives paired results from raw observations                              |

### Re:Earth

| File                          | Responsibility                                                          |
| ----------------------------- | ----------------------------------------------------------------------- |
| `large-reearth/run.mjs`       | Configurable paired route runner and request accounting                 |
| `large-reearth/browser.js`    | Route loading, readiness, frame-gap, long-task, and memory observations |
| `large-reearth/inventory.mjs` | Content inventory collection                                            |
| `large-reearth/server.mjs`    | Symmetric harness/worktree server                                       |

## Fixtures and evidence

The full-sweep fixtures and provenance remain in:

```text
Specs/Data/Performance/Decompression/
Specs/Data/Models/glTF-2.0/SPZ/
```

Retained raw evidence and its scope notes are in `evidence/`. Large-corpus
metadata is in `large-asset-corpus.json` and `large-data-summary.md`.

## Checks

Run the focused unit checks:

```sh
npm run benchmark-decompression:test
```

These checks cover fixture parsing and full-sweep summaries, plus
confirmatory option parsing, order balancing, paired calculations, and server
path containment. They do not collect performance measurements.
