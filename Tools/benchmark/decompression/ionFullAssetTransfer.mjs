#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Ion from "../../../packages/engine/Source/Core/Ion.js";

const repositoryRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../..",
);
const defaultAssetId = 4547222;
const defaultConcurrency = 6;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseArgs(argv) {
  const options = {
    assetId: defaultAssetId,
    concurrency: defaultConcurrency,
    output: path.join(
      "/Users/benpolinsky/.copilot/session-state/27128a2d-3741-420e-9184-b996f03451ab/files",
      "ion-4547222-full-transfer.json",
    ),
  };

  function valueFor(argument, index) {
    const equalsIndex = argument.indexOf("=");
    if (equalsIndex !== -1) {
      return argument.slice(equalsIndex + 1);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    return value;
  }

  for (let index = 0; index < argv.length; ++index) {
    const argument = argv[index];
    if (argument.startsWith("--asset-id")) {
      options.assetId = Number(valueFor(argument, index));
    } else if (argument.startsWith("--concurrency")) {
      options.concurrency = Number(valueFor(argument, index));
    } else if (argument.startsWith("--output")) {
      options.output = valueFor(argument, index);
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
    if (!argument.includes("=")) {
      ++index;
    }
  }

  assert(Number.isSafeInteger(options.assetId) && options.assetId > 0);
  assert(
    Number.isSafeInteger(options.concurrency) &&
      options.concurrency > 0 &&
      options.concurrency <= 32,
    "--concurrency must be an integer between 1 and 32",
  );
  return options;
}

function stripAccessToken(url) {
  const result = new URL(url);
  result.searchParams.delete("access_token");
  return result.href;
}

function signedUrl(url, accessToken) {
  const result = new URL(url);
  result.searchParams.set("access_token", accessToken);
  return result.href;
}

function extensionOf(url) {
  return (
    new URL(url).pathname.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase() ??
    "(none)"
  );
}

async function fetchBytes(url, accessToken) {
  let lastError;
  for (let attempt = 0; attempt < 5; ++attempt) {
    try {
      const response = await fetch(signedUrl(url, accessToken));
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!response.ok) {
        throw new Error(
          `${response.status} ${response.statusText}: ${bytes.toString("utf8", 0, 200)}`,
        );
      }
      return { response, bytes };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fetchJson(url, accessToken) {
  const { bytes, response } = await fetchBytes(url, accessToken);
  return {
    value: JSON.parse(bytes.toString("utf8")),
    bytes,
    response,
  };
}

function contentUrls(tile, baseUrl) {
  const urls = [];
  if (tile.content?.uri || tile.content?.url) {
    urls.push(new URL(tile.content.uri ?? tile.content.url, baseUrl).href);
  }
  if (Array.isArray(tile.contents)) {
    for (const content of tile.contents) {
      urls.push(new URL(content.uri ?? content.url, baseUrl).href);
    }
  }
  return urls;
}

async function enumerateAsset(endpoint, accessToken) {
  const pendingTilesets = [endpoint];
  const visitedTilesets = new Set();
  const content = new Set();
  const tilesets = [];
  let tileNodeCount = 0;

  while (pendingTilesets.length > 0) {
    const url = pendingTilesets.shift();
    if (visitedTilesets.has(url)) {
      continue;
    }
    visitedTilesets.add(url);
    const { value, bytes, response } = await fetchJson(url, accessToken);
    tilesets.push({
      url: stripAccessToken(url),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
      contentType: response.headers.get("content-type"),
      assetVersion: value.asset?.version ?? null,
    });

    function walk(tile) {
      tileNodeCount += 1;
      for (const childUrl of contentUrls(tile, url)) {
        if (/[{}]/.test(decodeURIComponent(childUrl))) {
          continue;
        }
        if (extensionOf(childUrl) === "json") {
          pendingTilesets.push(childUrl);
        } else {
          content.add(childUrl);
        }
      }
      for (const child of tile.children ?? []) {
        walk(child);
      }
    }
    walk(value.root);
  }

  return {
    tilesets,
    tileNodeCount,
    contentUrls: [...content].sort(),
  };
}

function parseGltfExtensions(bytes) {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF") {
    return [];
  }
  const jsonLength = bytes.readUInt32LE(12);
  const jsonType = bytes.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a || 20 + jsonLength > bytes.length) {
    return [];
  }
  try {
    const json = JSON.parse(
      bytes.toString("utf8", 20, 20 + jsonLength).trim(),
    );
    return [
      ...(json.extensionsUsed ?? []),
      ...(json.extensionsRequired ?? []),
      ...Object.keys(json.meshes?.[0]?.primitives?.[0]?.extensions ?? {}),
    ].sort();
  } catch {
    return [];
  }
}

async function downloadContent(url, accessToken) {
  const response = await fetch(signedUrl(url, accessToken));
  if (!response.ok || response.body === null) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const hash = createHash("sha256");
  const prefixChunks = [];
  let prefixLength = 0;
  let sizeBytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    hash.update(buffer);
    sizeBytes += buffer.length;
    if (prefixLength < 65536) {
      const prefix = buffer.subarray(0, 65536 - prefixLength);
      prefixChunks.push(prefix);
      prefixLength += prefix.length;
    }
  }
  const prefix = Buffer.concat(prefixChunks);
  return {
    url: stripAccessToken(url),
    extension: extensionOf(url),
    sizeBytes,
    sha256: hash.digest("hex"),
    etag: response.headers.get("etag"),
    contentType: response.headers.get("content-type"),
    gltfExtensions: parseGltfExtensions(prefix),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiHeaders = {
    Authorization: `Bearer ${Ion.defaultAccessToken}`,
  };
  const asset = await (
    await fetch(`https://api.cesium.com/v1/assets/${options.assetId}`, {
      headers: apiHeaders,
    })
  ).json();
  const endpointInfo = await (
    await fetch(
      `https://api.cesium.com/v1/assets/${options.assetId}/endpoint`,
      { headers: apiHeaders },
    )
  ).json();
  const inventory = await enumerateAsset(
    endpointInfo.url,
    endpointInfo.accessToken,
  );

  const results = [];
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= inventory.contentUrls.length) {
        return;
      }
      const url = inventory.contentUrls[index];
      let result;
      let error;
      for (let attempt = 0; attempt < 5; ++attempt) {
        try {
          result = await downloadContent(url, endpointInfo.accessToken);
          break;
        } catch (caught) {
          error = caught;
          await new Promise((resolve) =>
            setTimeout(resolve, 250 * (attempt + 1)),
          );
        }
      }
      if (result === undefined) {
        throw new Error(`${url}: ${error?.message ?? "download failed"}`);
      }
      results[index] = result;
      if ((index + 1) % 50 === 0 || index + 1 === inventory.contentUrls.length) {
        console.error(
          `Downloaded ${index + 1}/${inventory.contentUrls.length} content tiles`,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: options.concurrency }, () => worker()),
  );

  const byExtension = {};
  const gltfExtensions = new Set();
  for (const result of results) {
    const group = byExtension[result.extension] ?? {
      count: 0,
      totalBytes: 0,
      minBytes: Number.POSITIVE_INFINITY,
      maxBytes: 0,
    };
    group.count += 1;
    group.totalBytes += result.sizeBytes;
    group.minBytes = Math.min(group.minBytes, result.sizeBytes);
    group.maxBytes = Math.max(group.maxBytes, result.sizeBytes);
    byExtension[result.extension] = group;
    for (const extension of result.gltfExtensions) {
      gltfExtensions.add(extension);
    }
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    assetId: options.assetId,
    asset: {
      name: asset.name,
      bytesReportedByIon: asset.bytes,
      status: asset.status,
    },
    endpoint: {
      url: stripAccessToken(endpointInfo.url),
      version: new URL(endpointInfo.url).searchParams.get("v"),
    },
    inventory: {
      tilesetManifestCount: inventory.tilesets.length,
      tileNodeCount: inventory.tileNodeCount,
      contentTileCount: inventory.contentUrls.length,
      tilesets: inventory.tilesets,
      contentByExtension: byExtension,
      observedGltfExtensions: [...gltfExtensions].sort(),
      downloadedContentBytes: results.reduce(
        (sum, result) => sum + result.sizeBytes,
        0,
      ),
      contentSha256: createHash("sha256")
        .update(
          results
            .map((result) => `${result.url}\0${result.sizeBytes}\0${result.sha256}\n`)
            .join(""),
        )
        .digest("hex"),
    },
    content: results,
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${options.output}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  process.exitCode = 1;
});
