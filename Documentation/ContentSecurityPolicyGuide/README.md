# Content Security Policy Guide

[Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy)
(CSP) lets an application restrict what code the browser will run. This guide covers what
CesiumJS needs in order to work under a policy, and how to keep that policy as narrow as
possible.

Everything here is about how you serve your application. CesiumJS does not set any policy
itself.

## What CesiumJS requires

Two things drive most of the configuration:

**Web Workers.** CesiumJS decodes terrain, Draco geometry, KTX2 textures, glTF buffers,
and other content in Web Workers. Your policy needs to allow them, and it needs to allow
them from wherever `CESIUM_BASE_URL` points.

**WebAssembly.** Several of those decoders are WebAssembly modules. Compiling WebAssembly
requires either `'wasm-unsafe-eval'` or `'unsafe-eval'`. As of CesiumJS 1.144, all
WebAssembly compilation happens inside workers, so this permission does not have to be
granted to your page — see [Scoping WebAssembly to workers](#scoping-webassembly-to-workers).

## A starting policy

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  worker-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  connect-src 'self';
```

You will need to widen `connect-src` and `img-src` to cover the servers your imagery,
terrain, and tileset data actually come from — for example `https://api.cesium.com` and
`https://assets.ion.cesium.com` if you use Cesium ion. Those hosts are specific to your
application, so there is no universal value.

`style-src 'unsafe-inline'` is needed if you use the CesiumJS widgets, which apply inline
styles. It is not needed for `@cesium/engine` on its own.

This policy contains no `'unsafe-eval'`. See the exceptions below for the cases that still
need it.

## Scoping WebAssembly to workers

CSP distinguishes two eval-related tokens, and the difference matters:

| Token                | Permits                                        |
| -------------------- | ---------------------------------------------- |
| `'wasm-unsafe-eval'` | WebAssembly compilation and instantiation only |
| `'unsafe-eval'`      | `eval`, `new Function`, **and** WebAssembly    |

`'unsafe-eval'` is a much broader grant. If you only need WebAssembly, prefer
`'wasm-unsafe-eval'`.

Better still, you can avoid granting either one to your page. A policy is delivered
per-response, and a worker script served with its own `Content-Security-Policy` header runs
under that policy instead of the document's. So you can forbid WebAssembly in the document
and permit it only where CesiumJS actually uses it:

```http
# your application document
Content-Security-Policy: default-src 'self'; script-src 'self'; worker-src 'self'

# responses for files under Workers/
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'
```

### Setting the worker header

Match the request path for the CesiumJS worker directory and add the header to those
responses only.

Express:

```javascript
app.use("/cesium/Workers", (req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'",
  );
  next();
});
```

nginx:

```nginx
location /cesium/Workers/ {
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'";
}
```

Note that `default-src 'self'` in the worker policy also governs the worker's own network
requests, which it uses to load `.wasm` files. If you narrow that directive, make sure
`connect-src` still permits the worker to reach `CESIUM_BASE_URL`.

### This requires same-origin workers

Per-response worker policies only work if the worker is a real same-origin script.

When `CESIUM_BASE_URL` is cross-origin, CesiumJS cannot construct a worker from that URL
directly, so it wraps it in a small `blob:` worker instead. A `blob:` worker **inherits the
policy of the document that created it**. A header on the original worker response cannot
give it a separate policy, so the document itself would then need the WebAssembly
permission — which defeats the arrangement.

To keep WebAssembly out of your document, serve your application and the CesiumJS assets
from the same scheme, host, and port. If you must load CesiumJS cross-origin, you will need
`worker-src 'self' blob:` and `script-src 'wasm-unsafe-eval'` on the document.

## Electron and custom protocols

Serve the renderer and the CesiumJS assets from the same custom-protocol origin rather than
`file:`, then attach the worker policy to that protocol's responses.

```text
app://renderer/index.html
app://renderer/cesium/Workers/decodeDraco.js
```

Watch out for a subtlety: `app://renderer/` and `app://cesium/` are **different origins**
despite sharing a scheme, and will trigger the `blob:` worker fallback described above.

When adding response headers, target the specific protocol and path rather than every
response your application handles.

## Known exceptions

Some paths still require `'unsafe-eval'`.

**Widgets.** `@cesium/widgets` includes Knockout, which compiles binding expressions with
`new Function`. Any build that includes the widgets — including the combined `Cesium.js` —
therefore needs `'unsafe-eval'` in `script-src`. `@cesium/engine` on its own does not.

**SPZ-compressed Gaussian splats.** The `@spz-loader/core` dependency is generated by
Emscripten's `embind` in a configuration that emits `new Function`, so the `decodeSpz`
worker requires `'unsafe-eval'` on its response until an upstream build without it is
published — see [drumath2237/spz-loader#91](https://github.com/drumath2237/spz-loader/issues/91).
Applications that do not load SPZ content are unaffected, since the decoder is only
loaded when such content appears.

If you need SPZ under an otherwise strict policy, grant the exception to that one worker
response rather than to the document:

```http
# response for Workers/decodeSpz.js only
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval'
```

**KMZ.** `@zip.js/zip.js` includes a WebAssembly inflate path that can run outside a
worker if the browser lacks `CompressionStream` or if compression streams are disabled. It
is not used in normal operation on current browsers.

## Verifying your policy

Browsers report violations to the console, and to a `securitypolicyviolation` event you can
listen for:

```javascript
document.addEventListener("securitypolicyviolation", (event) => {
  console.warn(event.violatedDirective, event.blockedURI);
});
```

Test with content that exercises the decoders you actually use — a Draco-compressed
tileset, KTX2 textures, terrain — since each one loads its worker lazily and a policy
problem will not appear until that content is loaded.
