# Diagnostic codec fixtures

The generated Draco and meshopt files in this directory are controlled
microbenchmark inputs for decoder diagnostics only. They are not the
regression corpus and must not be used for product-performance claims.

The primary decompression regression benchmark is
[`Tools/benchmark/decompression`](../../../../Tools/benchmark/decompression/README.md).
It loads committed production-like assets through Cesium's public APIs.

## Diagnostic fixture contract

The remainder of this document describes the diagnostic fixture contract. It
is intentionally separate from the public loading benchmark.

- [`fixture-manifest.schema.json`](fixture-manifest.schema.json) defines the
  required per-codec manifest.
- [`benchmark-result-identity.schema.json`](benchmark-result-identity.schema.json)
  defines the environment identity attached to every result by the local
  benchmark runner.

## Dependency and provenance policy

The engine's production dependency ranges remain intentionally broad:

```json
{
  "draco3d": "^1.5.1",
  "meshoptimizer": "^1.0.1"
}
```

These ranges describe runtime compatibility; they are not fixture-generation
locks. The manifest records the exact encoder package version and npm
`dist.integrity` that produced the committed bytes:

| package         | manifest-recorded version | npm integrity                                                                                     |
| --------------- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `draco3d`       | `1.5.7`                   | `sha512-m6WCKt/erDXcw+70IJXnG7M3awwQPAsZvJGX5zY7beBqpELw6RDGkYVU0W43AFxye4pDZ5i2Lbyc/NNGqwjUVQ==` |
| `meshoptimizer` | `1.2.0`                   | `sha512-davRZeIJbxJrE24cwQle7ZDsxjdk/OphNOV83oX+efQinyoHY9Jcyz3MHbaoG0qySZajldGztNZ1RN/T19PZsg==` |

There is no tracked root npm, pnpm, or Yarn lockfile; ignored lock data under
`node_modules` is not a reproducibility artifact. Do not change production
dependency ranges just to regenerate a fixture. If an encoder is upgraded,
regenerate every affected fixture and update its manifest's exact package
version and npm integrity together.

Before generating or verifying, resolve the encoder package that the generator
will actually import and compare its installed package name and exact version
with the manifest's `encoder.package` and `encoder.version`. A mismatch is a
hard failure, before any fixture is written or verified. The failure must name
both versions and tell the user to use an environment containing the manifest's
recorded encoder version; do not silently regenerate with the installed range
resolution. `npm ls` is useful for inspecting the resolution:

```bash
npm ls draco3d meshoptimizer --workspace @cesium/engine --depth=0
```

The same version check applies to an explicit generator `--verify` operation.
Benchmark execution is a consumer only: it reads committed binaries and
manifests, never invokes a generator, never regenerates a missing fixture, and
fails clearly if fixture verification or encoder provenance checks fail.

Generators must import the encoder from the installed package resolution. Do
not copy a decoder module or wasm file into a fixture directory. Decoder
artifacts belong to the normal package/build output; a benchmark must
hash the exact module and wasm bytes that it loads.

## Directory and manifest layout

Use one directory per codec, with a `manifest.json` alongside that codec's
committed binary outputs:

```text
Decompression/
  fixture-manifest.schema.json
  benchmark-result-identity.schema.json
  draco/
    manifest.json
    <fixture binaries>
  meshopt/
    manifest.json
    <fixture binaries>
```

Every manifest must validate against `fixture-manifest.schema.json` and set
`"$schema": "../fixture-manifest.schema.json"`. Fixture paths are forward-slash
paths relative to the manifest; source and generator paths are
repository-relative. Keep a binary and its manifest in the same change.

### Manifest-level fields

The schema requires:

- `schemaVersion`: `1` for this contract.
- `codec`: `draco` or `meshopt`.
- `encoder`: the exact npm package name, exact semver, and the package's
  registry `dist.integrity` value. The manifest field must not contain a
  range such as `^1.2.0`; this does not change `packages/engine/package.json`.
- `generator`: a name, exact generator version, generator schema version, and
  every generator source file with its repository path, byte size, and
  lowercase SHA-256.
- `runtime`: exact Node version and package-manager name/version. Record
  `os` and `arch` when they can affect generated output.
- `fixtures`: the complete list of generated outputs in the manifest.

The generator version and generator schema version are independent of the
shared manifest schema version. Increment the generator schema version when
the meaning or serialization of generator inputs changes.

### Per-fixture fields

Every fixture entry must contain:

- `id`: a stable, unique identifier. Do not derive identity from a display
  label or array position.
- `path`: the committed compressed binary path.
- `compressed`: the binary's exact `sizeBytes` and lowercase SHA-256.
- `inputs`: every input that affects generation:
  - `sourceFiles` with repository path, byte size, and SHA-256 for committed
    source files;
  - `inline` for synthetic or script-defined input data, when applicable;
  - `options` containing every data-affecting encoder and generator option,
    including values that otherwise come from defaults; and
  - `inputSha256`, the SHA-256 of the UTF-8 RFC 8785 (JCS) serialization of
    the input descriptor (`sourceFiles`, `inline`, and `options`).
- `expectedDecoded`: the exact decoded byte `sizeBytes` and SHA-256, a
  `format` describing the canonical byte serialization, and a non-empty
  `summary` of the expected result. The summary should include the
  codec-relevant counts and layout, such as vertex/index counts, attribute
  names and types, index type, and any tolerances used for numeric checks.

Put codec-specific details such as filter modes, layout, seeds, and decoder
API names in the fixture's `metadata` or in `inputs.options`; do not add
unrecognized top-level fields to the manifest.

When a decoded result consists of multiple buffers, document the deterministic
concatenation order in `format` and `summary` before hashing it. The expected
decoded hash is not a timing result; it is a correctness and fixture-identity
check.

For meshopt filter fixtures, the expected decoded hash is the output of
Cesium's production `decodeMeshopt` worker. Unfiltered fixtures use the
deterministic source-byte reference.

Draco quantized fixtures mark their source-input reference in
`expectedDecoded.summary.referenceKind`; the benchmark validates the
production worker's decoded geometry and quantization metadata structurally
because quantization changes the canonical decoded representation.

## Benchmark result identity

Before comparing timings, the runner must attach an object that validates
against
`benchmark-result-identity.schema.json` and includes:

- the fixture `id`, path, and compressed SHA-256;
- the exact browser revision (not only a marketing version);
- `navigator.hardwareConcurrency`;
- every decoder module and wasm artifact actually loaded, with its resolved
  path/URL and SHA-256 of the loaded bytes;
- the worker queue depth; and
- `cold` or `warm` state, with the runner defining how caches and workers are
  prepared for each state.

The decoder hashes must describe the bytes used by the run, not an untracked
copy made during fixture generation. Keep benchmark measurements separate from
this identity object so that the same identity can label multiple samples.

The primary regression runner is in
[`Tools/benchmark/decompression`](../../../../Tools/benchmark/decompression/README.md).
It uses Playwright and the repository server to load committed production-like
assets through Cesium's public loading APIs. It does not consume these
generated fixtures, call decoder workers directly, construct glTF inputs, or
make worker-internal timing claims.

These generated fixtures remain useful for narrow decoder diagnostics. Keep
their manifests and provenance synchronized when they change, but do not use
their timings as before/after product regression measurements.

No new test framework is required by this contract. Use a JSON Schema
Draft 2020-12 validator when validating manifests, and use ordinary SHA-256
tools to verify committed files before review.
