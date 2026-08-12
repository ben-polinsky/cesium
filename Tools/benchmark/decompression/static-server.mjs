#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

const mimeTypes = new Map([
  [".bin", "application/octet-stream"],
  [".css", "text/css; charset=utf-8"],
  [".drc", "application/octet-stream"],
  [".glb", "model/gltf-binary"],
  [".gltf", "model/gltf+json"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json; charset=utf-8"],
  [".ktx2", "image/ktx2"],
  [".kmz", "application/vnd.google-earth.kmz"],
  [".png", "image/png"],
  [".spz", "application/octet-stream"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

function fail(message) {
  throw new Error(`Benchmark static server error: ${message}`);
}

function optionValue(argumentsList, name) {
  const index = argumentsList.findIndex(
    (argument) => argument === name || argument.startsWith(`${name}=`),
  );
  if (index === -1) {
    return undefined;
  }
  const argument = argumentsList[index];
  const equalsIndex = argument.indexOf("=");
  if (equalsIndex !== -1) {
    return argument.slice(equalsIndex + 1);
  }
  const value = argumentsList[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`${name} requires a value`);
  }
  return value;
}

const rootArgument = optionValue(process.argv.slice(2), "--root");
const portArgument = optionValue(process.argv.slice(2), "--port");
const root = path.resolve(rootArgument ?? process.cwd());
const port = Number(portArgument ?? 8080);

if (!Number.isInteger(port) || port < 1 || port >= 65536) {
  fail(`invalid port ${portArgument}`);
}

const server = http.createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  let filePath;
  try {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    const relativePath = decodeURIComponent(requestUrl.pathname).replace(
      /^\/+/,
      "",
    );
    filePath = path.resolve(root, relativePath);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403);
      response.end();
      return;
    }

    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": fileStats.size,
      "Content-Type":
        mimeTypes.get(path.extname(filePath).toLowerCase()) ??
        "application/octet-stream",
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      createReadStream(filePath).pipe(response);
    }
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(500);
    response.end();
    console.error(`Unable to serve ${filePath ?? request.url}: ${error.message}`);
  }
});

server.listen(port, "localhost", () => {
  console.log(`Benchmark static server serving ${root} on port ${port}`);
});

function closeServer() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", closeServer);
process.once("SIGTERM", closeServer);
