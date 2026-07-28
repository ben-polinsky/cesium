# basis_transcoder build

`basis_transcoder.js` is built from
[basis_universal](https://github.com/BinomialLLC/basis_universal) `v1_15_update2`
with Emscripten 2.0.17, plus one flag that upstream does not currently set:

```text
-s DYNAMIC_EXECUTION=0
```

Without it, Emscripten's `embind` generates its argument-marshaling invokers by
code-generating JavaScript at runtime and compiling it with `new Function`. That
requires a Content-Security-Policy containing `'unsafe-eval'`, which defeats the
purpose of confining WebAssembly to workers: `'wasm-unsafe-eval'` permits
WebAssembly compilation but not `new Function`. With the flag, `embind` emits its
closure-based invoker fallback instead — the same marshaling, without runtime code
generation.

The flag affects only the generated JavaScript. Building with and without it emits an
identical `.wasm`, so `../basis_transcoder.wasm` is **not** part of this change and must
be left as-is — replacing it would be an unrelated substitution of the compiled module.

Upstream has been asked to set this flag by default. See
https://github.com/CesiumGS/cesium/issues/13617.

## Relationship to upstream

These files have never been upstream's published artifact. basis_universal checks a
prebuilt `webgl/transcoder/build/basis_transcoder.js` into its own repository, and the
copy vendored here has always differed from it — the vendored JavaScript was 62,288
bytes against upstream's 62,337, with a different `.wasm` as well. The files were
evidently built from source when KTX2 support was added in 2021.

What the previously vendored JavaScript *did* match, byte for byte, is a from-source
build at `v1_15_update2` under Emscripten 2.0.17 with upstream's link flags unmodified.
That is how the version and toolchain were identified.

So this change does not introduce a divergence from upstream; it changes the build
configuration of an artifact already built here, by one flag.

Note that a from-source rebuild does *not* reproduce the vendored `.wasm` — it differs by
38 bytes, so Cesium's copy came from a slightly different source revision than the tag.
That is another reason to leave the compiled module alone.

## Reproducing

The pinned toolchain matters. Adjacent Emscripten patch releases do not reproduce the
same output — 2.0.16 differs by one statement in `_emscripten_resize_heap`. Verify any
toolchain change by first building *without* `DYNAMIC_EXECUTION=0` and confirming the
result matches the byte count above before trusting a patched build.

```sh
git clone --branch v1_15_update2 --depth 1 \
  https://github.com/BinomialLLC/basis_universal.git
cd basis_universal/webgl/transcoder
mkdir -p build && cd build

docker run --rm -v "$PWD/../../..":/src -w /src/webgl/transcoder/build \
  emscripten/emsdk:2.0.17 bash -c \
  'emcmake cmake -DCMAKE_EXE_LINKER_FLAGS="-s DYNAMIC_EXECUTION=0" .. && make -j2'
```

Then copy `basis_transcoder.js` here. Do not copy the `.wasm`; see above.

Verify the result contains no runtime code generation:

```sh
grep -c 'new Function(' basis_transcoder.js   # expect 0
```
