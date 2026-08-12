import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";

// One origin serves three explicit roots:
//   /harness/*   benchmark code
//   /candidate/* candidate worktree
//   /baseline/*  baseline worktree
// Using one server implementation and origin keeps transport behavior,
// caching policy, and URL structure symmetric between variants.
const contentTypes = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

export function safeFile(root, requestPath) {
  const decoded = decodeURIComponent(requestPath).replace(/^\/+/, "");
  const result = path.resolve(root, decoded);

  // The server intentionally exposes whole worktrees, so containment at the
  // selected mount root is the security boundary.
  if (result !== root && !result.startsWith(`${root}${path.sep}`)) {
    throw new Error("path traversal");
  }
  return result;
}

export function createServer({ harness, candidate, baseline, port }) {
  const roots = {
    harness: path.resolve(harness),
    candidate: path.resolve(candidate),
    baseline: path.resolve(baseline),
  };

  return http
    .createServer(async (request, response) => {
      try {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const [, mount, ...parts] = url.pathname.split("/");
        if (!roots[mount] || !["GET", "HEAD"].includes(request.method)) {
          response.writeHead(404);
          response.end();
          return;
        }

        const file = safeFile(roots[mount], parts.join("/") || "index.html");
        const details = await stat(file);
        if (!details.isFile()) throw new Error("not a file");

        response.writeHead(200, {
          // Every sample receives a fresh page/context, and no-store prevents the
          // harness itself from introducing asymmetric HTTP cache reuse.
          "Cache-Control": "no-store",
          "Content-Length": details.size,
          "Content-Type":
            contentTypes[path.extname(file)] || "application/octet-stream",
        });
        if (request.method === "HEAD") response.end();
        else createReadStream(file).pipe(response);
      } catch (error) {
        response.writeHead(error.message === "path traversal" ? 403 : 404);
        response.end();
      }
    })
    .listen(port, "127.0.0.1");
}
