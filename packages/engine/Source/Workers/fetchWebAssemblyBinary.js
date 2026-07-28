import Uri from "urijs";
import defined from "../Core/defined.js";
import Resource from "../Core/Resource.js";
import TrustedServers from "../Core/TrustedServers.js";

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
 * Fetches the WebAssembly binary described by a {@link TaskProcessor#initWebAssemblyModule}
 * configuration, from inside the worker that will compile it.
 *
 * The bytes are deliberately not requested on the main thread. Keeping both the
 * request and the compilation in the worker means the document never needs to
 * handle WebAssembly, so applications can scope <code>wasm-unsafe-eval</code> to
 * worker responses.
 *
 * The supplied configuration is mutated: <code>wasmBinary</code> is assigned onto it
 * and the same object is returned, so it can be passed straight to an Emscripten
 * module factory.
 *
 * @function fetchWebAssemblyBinary
 *
 * @param {object} webAssemblyConfig The configuration posted by <code>TaskProcessor</code>.
 * @param {string} [webAssemblyConfig.wasmBinaryFile] The absolute url of the web assembly binary.
 * @param {ArrayBuffer} [webAssemblyConfig.wasmBinary] Binary contents, if they were already provided.
 * @param {boolean} [webAssemblyConfig.withCredentials=false] Whether the binary's host was
 *        registered with {@link TrustedServers} on the document, in which case the request
 *        is made with credentials.
 * @returns {Promise<object>} A promise that resolves to the configuration with <code>wasmBinary</code> populated.
 *
 * @private
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

export default fetchWebAssemblyBinary;
