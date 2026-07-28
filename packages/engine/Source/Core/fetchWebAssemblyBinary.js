import Uri from "urijs";
import defined from "./defined.js";
import Resource from "./Resource.js";
import TrustedServers from "./TrustedServers.js";

/**
 * Registers the binary's host with this worker's {@link TrustedServers} so that
 * {@link Resource} sends credentials with the request.
 *
 * TrustedServers keeps its registry in module scope, which is per-realm. A worker
 * therefore starts with an empty registry no matter what the document registered,
 * so the decision is made on the document and replayed here.
 *
 * @param {string} url An absolute url.
 *
 * @private
 */
function trustBinaryHost(url) {
  const uri = new Uri(url);
  uri.normalize();

  const hostname = uri.hostname();
  if (hostname.length === 0) {
    return;
  }

  let port = parseInt(uri.port(), 10);
  if (isNaN(port)) {
    const scheme = uri.scheme();
    if (scheme === "http") {
      port = 80;
    } else if (scheme === "https") {
      port = 443;
    } else {
      return;
    }
  }

  TrustedServers.add(hostname, port);
}

/**
 * Loads the WebAssembly binary described by a {@link TaskProcessor#initWebAssemblyModule}
 * configuration, from inside the worker that will compile it.
 *
 * <code>TaskProcessor</code> posts the url of the binary rather than its bytes, so that the
 * document neither fetches nor compiles WebAssembly. Worker implementations call this to
 * obtain the bytes, and can pass the resolved configuration straight to an Emscripten
 * module factory.
 *
 * The configuration is mutated in place: <code>wasmBinary</code> is assigned onto the object
 * that was passed in, and that same object is returned. A configuration that already carries
 * <code>wasmBinary</code>, or that has no <code>wasmBinaryFile</code>, is returned untouched.
 *
 * @function fetchWebAssemblyBinary
 *
 * @param {WebAssemblyConfig} webAssemblyConfig The configuration posted by {@link TaskProcessor#initWebAssemblyModule}.
 * @returns {Promise<WebAssemblyConfig>} A promise that resolves to the configuration with <code>wasmBinary</code> populated.
 *
 * @example
 * import {
 *   createTaskProcessorWorker,
 *   fetchWebAssemblyBinary,
 * } from "@cesium/engine";
 *
 * let module;
 *
 * async function doWork(parameters) {
 *   const wasmConfig = parameters.webAssemblyConfig;
 *   if (Cesium.defined(wasmConfig)) {
 *     module = await createMyModule(await fetchWebAssemblyBinary(wasmConfig));
 *     return true;
 *   }
 *
 *   return module.compute(parameters);
 * }
 *
 * export default createTaskProcessorWorker(doWork);
 *
 * @see TaskProcessor#initWebAssemblyModule
 * @see createTaskProcessorWorker
 */
async function fetchWebAssemblyBinary(webAssemblyConfig) {
  if (
    !defined(webAssemblyConfig.wasmBinaryFile) ||
    defined(webAssemblyConfig.wasmBinary)
  ) {
    return webAssemblyConfig;
  }

  if (webAssemblyConfig.withCredentials === true) {
    trustBinaryHost(webAssemblyConfig.wasmBinaryFile);
  }

  webAssemblyConfig.wasmBinary = await Resource.fetchArrayBuffer({
    url: webAssemblyConfig.wasmBinaryFile,
  });

  return webAssemblyConfig;
}

/**
 * The WebAssembly configuration posted to a worker by
 * {@link TaskProcessor#initWebAssemblyModule}, as the first message that worker receives.
 *
 * @typedef {object} WebAssemblyConfig
 *
 * @property {string} [wasmBinaryFile] The absolute url of the WebAssembly binary. Undefined
 *           when the browser does not support WebAssembly and a fallback module is used instead.
 * @property {string} [modulePath] The absolute url of the fallback JavaScript module, present
 *           only when the browser does not support WebAssembly.
 * @property {boolean} [withCredentials=false] Whether the binary's host was registered with
 *           {@link TrustedServers}, in which case the request is made with credentials.
 * @property {ArrayBuffer} [wasmBinary] The binary contents. Populated by
 *           {@link fetchWebAssemblyBinary}; not present in the posted configuration.
 */

export default fetchWebAssemblyBinary;
