# Public decompression/loading benchmark

This benchmark measures Cesium's normal public loading APIs in Chromium. It
does not call `TaskProcessor`, decoder workers, internal loaders, or construct
glTF objects. The scenario manifest points at committed Cesium test assets, and
the browser fetches them from the repository server.

## Run

Build the browser bundle, then run both cache/process states:

```sh
npm run build
npm run benchmark-decompression
```

The default plan collects 30 warm samples and 10 cold samples for every
scenario. Use a fixed seed when comparing two checkouts:

```sh
npm run benchmark-decompression -- \
  --state cold,warm \
  --cold-iterations 10 \
  --warm-iterations 30 \
  --seed 12345 \
  --output Build/Performance/Decompression/main.json
```

Select a smaller diagnostic run with
`--scenario draco-model-cesium-man,meshopt-model-unit-square`.
The public-readiness timeout defaults to 120000 ms and can be shortened for
investigation with `--ready-timeout-ms 5000`.

To compare servers or builds with paired cold samples, use `paired-cold` and
repeat `--variant id=url` for each comparison:

```sh
npm run benchmark-decompression -- \
  --state paired-cold \
  --variant candidate=http://localhost:8081 \
  --cold-iterations 10 \
  --seed 12345 \
  --output Build/Performance/Decompression/paired.json
```

The normal Playwright `baseURL` is the `primary` variant. Each scenario pair
uses one Chromium process, but every variant gets a fresh context and page.
Variant order is randomized for every pair. Using the primary URL again as a
variant is supported for null calibration. Variants are rejected for every
other state, and `paired-cold` requires at least one variant.

The opt-in experiment states separate first-use setup and cache effects:

```sh
npm run benchmark-decompression -- \
  --scenario meshopt-model-unit-square \
  --state cold,worker-probe-preloaded,asset-cache-warmed,prewarmed \
  --iterations 1 \
  --seed 12345 \
  --output Build/Performance/Decompression/prewarm-smoke.json
```

`worker-probe-preloaded` constructs the existing shared codec worker and waits
for Cesium's transferable-ArrayBuffer probe. It does not post a decoder task,
decode a fixture, initialize a generic worker pool, or claim that worker module
evaluation is complete. `worker-wasm-preloaded` additionally waits for the
existing codec WASM initialization promise, and is supported only for Draco and
KTX2 because meshopt and SPZ do not currently expose a separate no-decode
readiness hook. `asset-cache-warmed` fetches the scenario's explicit runtime
asset URLs into the browser HTTP cache without touching Cesium's ResourceCache
or decoder state. `prewarmed` retains its existing full public-fixture behavior.

Run the same command on the candidate checkout and compare the durable raw
samples:

```sh
npm run benchmark-decompression:compare -- \
  Build/Performance/Decompression/main.json \
  Build/Performance/Decompression/candidate.json \
  --threshold 5 \
  --output Build/Performance/Decompression/compare.json
```

The comparison reports median and p95 changes per scenario, state, and
readiness milestone. It exits with status 1 when a median regression exceeds
the selected threshold.

## What is measured

Each sample starts immediately before the public API call and ends at a public
readiness milestone:

| Scenario                                   | Public API                              | Readiness                                          |
| ------------------------------------------ | --------------------------------------- | -------------------------------------------------- |
| Draco, meshopt, and KTX2 glTF              | `Model.fromGltfAsync`                   | `Model.ready`                                      |
| Draco point clouds and SPZ Gaussian splats | `Cesium3DTileset.fromUrl`               | `tileset.tilesLoaded`                              |
| KMZ                                        | `KmlDataSource.load`                    | Loaded data source rendered through `CesiumWidget` |
| Google Earth Enterprise                    | `GoogleEarthEnterpriseMetadata.fromUrl` | Decoded metadata packet                            |

Resource Timing entries are retained separately so transport and public
loading time are visible. Decoder, worker, WASM, and bundle responses are
hashed from the exact build loaded by the browser. No transport or calibration
time is subtracted, and the runner does not claim worker-internal timing.

Warm samples share a browser context. Each scenario is warmed once through the
same public API before measurements; HTTP, Cesium resource, worker, and WASM
state are retained. Cold samples use a new Chromium process and ephemeral
profile for every scenario sample; browser startup and OS cache reset are not
included. Cold and warm distributions are never combined.

`prewarmed` uses a fresh Chromium process and ephemeral profile for every
target sample, just like `cold`. Before the target timer starts, it loads a
small committed fixture through the normal public Cesium API and waits for the
same public readiness definition. The prewarm fixtures are the 2.7 KB Draco
unit-square GLB, 4.6 KB meshopt unit-square GLB (or the 10 KB meshopt cube
payload when the target is that unit-square asset), 2.6 KB SPZ SH unit-cube
tile, and the existing KTX2 Box fixture. This initializes the relevant decoder
worker using the normal loading path; it does not invoke decoder workers
directly or alter the target glTF.

This state is intentionally limited to the worker-backed `draco`, `meshopt`,
`ktx2`, and `spz` scenarios; select those scenarios explicitly when using it.

Prewarm deliberately retains every side effect of that public load, including
the decoder worker/WASM state and any shared HTTP or Cesium resource cache.
The KTX2 Box fixture is also the only current KTX2 benchmark asset, so that
prewarm additionally caches the target resource. Treat `prewarmed` as a
controlled first-use experiment, not as a decoder-only measurement or a
replacement for cold/warm comparisons. Each target's outside-the-timer
prewarm result is retained in its raw sample under `prewarm`.

The worker/probe, worker/WASM, asset-cache, and public-fixture states also use a
fresh process and profile for every target. Raw samples contain
`measurements.preloadTriggerToReadyMs` and
`measurements.targetPublicApiToReadyMs`, plus detailed `preload` and target
records. `preloadSummaries` reports the former separately from normal target
`summaries`. These are end-to-end state timings, not decoder-only timings.

The benchmark-only codec hooks reuse the actual shared Draco, meshopt, KTX2, or
SPZ `TaskProcessor`; they do not create a second processor that the target API
would ignore. Meshopt and SPZ can only represent worker/probe readiness today.
No supported no-decode message exists to prove their worker module or internal
WASM readiness, so the benchmark records that limitation instead of inventing
one.

When the benchmark bundle contains the opt-in TaskProcessor hook, raw samples
also contain `decoderLifecycle`. Its timestamps are relative to the unchanged
public timer start and include worker creation, task scheduling, worker message
entry (the earliest reliable proof that module evaluation completed), explicit
Draco/KTX2 WASM readiness, meshopt decoder readiness, worker decode start/end,
worker result receipt, and `publicReady` where those points exist. SPZ does not
currently expose a separate WASM-ready callback, so it records worker entry,
the `loadSpz` task interval, and result receipt but marks the unavailable
decoder-ready fields as `null`. All unavailable fields are listed explicitly;
they are never represented as zero. The hook is unset outside this benchmark
page and has no logging or per-task work in normal runtime.

Raw results also contain `executionSetups` and `setupSummaries`. These record
Node-side browser launch, page load, and benchmark-page initialization
separately from public API processing. Setup timings are informational and are
not included in `publicReady` or the regression threshold comparison.

## Frozen ion realism corpus

`ion-corpus.json` records the verified public ion realism lane without
vendoring its content. It pins each asset's endpoint version, ion-reported
asset size, tileset manifest hash, content-tile count, observed container and
glTF compression extensions, and representative content hashes. Treat it as a
snapshot and re-verify before using a changed ion endpoint version or content
hash in a comparison.

The included assets are SPZ `4547222` and `3667783`, Reality Tiler
Draco+KTX2 `2325107` and `2325106`, and legacy Draco controls `69380` and
`40866`. Asset `3923568` is recorded but excluded because sampled terrain
GLBs contain no Meshopt compression.

The matched Meshopt task-shape corpus is committed under
`Specs/Data/Performance/Decompression/meshopt-task-shapes/`. Run the
1/10/60/200 buffer-view study against those exact files with:

```sh
node Tools/benchmark/decompression/meshoptGranularityExperiment.mjs \
  --use-committed \
  --cold-iterations 10 \
  --warm-iterations 30 \
  --seed 12345
```

The 4547222 multi-tile SPZ concurrency experiment uses only the public
`Cesium3DTileset.fromIonAssetId` API and records close and far-to-close routes:

```sh
node Tools/benchmark/decompression/ionSpzConcurrencyExperiment.mjs \
  --iterations 3 \
  --routes close,far-to-close \
  --maximum-screen-space-error 8 \
  --close-range-factor 0.25
```

The production-sized SPZ preload experiment keeps worker/probe preload,
HTTP-cache warming, and full public-fixture prewarming separate:

```sh
node Tools/benchmark/decompression/ionSpzPreloadExperiment.mjs \
  --iterations 3 \
  --state cold,worker-probe-preloaded,asset-cache-warmed,prewarmed
```

These scripts are measurement tools only. They do not alter decoder
implementation, create a generic worker pool, or enable batching.

Paired runs identify every sample and setup with a pair ID, variant ID, and
variant order. Ordinary summaries remain separated by variant.
`pairedComparisonSummaries` contains raw per-pair millisecond deltas
(`comparison - primary`) plus mean, median, and p95 directed and absolute
deltas. It also includes deterministic 95% percentile-bootstrap intervals for
the paired mean and median deltas. A null calibration should be run before
comparing different builds; its intervals should be centered near zero.
`pairedResponsivenessSummaries` applies the same paired analysis to
main-thread long-task counts and duration plus p95/maximum animation-frame
gaps. Positive deltas mean the comparison incurred more blocking or a longer
frame gap. These are responsiveness signals, not a substitute for measured
input latency.

For a symmetric paired comparison, serve both worktrees with the same static
server implementation. The Playwright benchmark server uses
`Tools/benchmark/decompression/static-server.mjs`; start the comparison
worktree with the same script and pass its URL as a variant:

```sh
node Tools/benchmark/decompression/static-server.mjs \
  --root /path/to/other/worktree \
  --port 8115

npm run benchmark-decompression -- \
  --state paired-cold \
  --variant baseline=http://localhost:8115 \
  --cold-iterations 30 \
  --seed 12345 \
  --port 8116 \
  --output Build/Performance/Decompression/paired.json
```

If a scenario fails, its raw run records the error plus page errors, console
warnings/errors, failed requests, and HTTP error responses. Cold and
paired-cold runs continue collecting later samples after a failure so
intermittent failures can be counted. Any failed sample still marks the JSON
result as failed and makes the command exit nonzero.

The benchmark records the Cesium commit, browser executable and revision,
operating system, CPU model, logical CPU count, `hardwareConcurrency`, viewport,
device scale factor, asset hashes, loaded decoder artifact hashes, sample
order, and cache policy. Raw samples remain in the result JSON.

There is no committed, license-reviewed I3S corpus in this repository, so the
manifest intentionally does not use a live I3S service. The committed GEE
fixtures contain a metadata packet but no compatible terrain tile advertised by
that metadata, so the GEE scenario measures the public metadata/decryption
path only. Add versioned local I3S or GEE terrain datasets with provenance
before enabling those additional scenarios; do not substitute production URLs.

SPZ scenarios use one-tile 3D Tiles wrappers because that is Cesium's currently
supported public Gaussian-splat loading path. `Model.fromGltfAsync` reaches the
SPZ loader for these assets, but its model pipeline does not consume the
postprocessed SPZ typed-array attributes as render buffers, so it cannot reach
`Model.ready` without an internal workaround. The benchmark intentionally does
not use that workaround or report it as a supported public path.
