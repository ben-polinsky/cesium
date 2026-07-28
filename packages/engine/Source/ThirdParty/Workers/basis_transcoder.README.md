# basis_transcoder build

`basis_transcoder.js` and `../basis_transcoder.wasm` are built from
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

Upstream has been asked to set this flag so this build can go back to matching a
published release. See https://github.com/CesiumGS/cesium/issues/13617.

## Reproducing

The pinned toolchain matters: Emscripten 2.0.17 with the unmodified upstream link
flags reproduces the previously vendored `basis_transcoder.js` byte for byte, which
is how this version was identified. Adjacent Emscripten patch releases do not — 2.0.16
differs by one statement in `_emscripten_resize_heap`.

```sh
git clone --branch v1_15_update2 --depth 1 \
  https://github.com/BinomialLLC/basis_universal.git
cd basis_universal/webgl/transcoder
mkdir -p build && cd build

docker run --rm -v "$PWD/../../..":/src -w /src/webgl/transcoder/build \
  emscripten/emsdk:2.0.17 bash -c \
  'emcmake cmake -DCMAKE_EXE_LINKER_FLAGS="-s DYNAMIC_EXECUTION=0" .. && make -j2'
```

Then copy `basis_transcoder.js` here and `basis_transcoder.wasm` to
`packages/engine/Source/ThirdParty/`.

Verify the result contains no runtime code generation:

```sh
grep -c 'new Function(' basis_transcoder.js   # expect 0
```
