#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const reportPath =
  process.env.REARTH_REPORT ??
  "Build/Performance/Decompression/reearth-dense-40.json";
const outputPath =
  process.env.REARTH_INVENTORY ??
  "Build/Performance/Decompression/reearth-dense-40-inventory.json";
const concurrency = Number(process.env.REARTH_INVENTORY_CONCURRENCY ?? 8);

const report = JSON.parse(await readFile(reportPath, "utf8"));
const run = report.runs.find((item) => item.ok && item.variant === "candidate");
if (!run) throw new Error(`No successful candidate run in ${reportPath}`);

const files = run.content.responses.filter(
  (item) => item.status === 200 && item.contentType === "model/gltf-binary",
);
const textDecoder = new TextDecoder();

function parseGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (textDecoder.decode(bytes.subarray(0, 4)) !== "glTF") {
    throw new Error("invalid GLB magic");
  }
  if (view.getUint32(4, true) !== 2) {
    throw new Error(`unsupported GLB version ${view.getUint32(4, true)}`);
  }
  let offset = 12;
  const jsonLength = view.getUint32(offset, true);
  const jsonType = view.getUint32(offset + 4, true);
  if (jsonType !== 0x4e4f534a) throw new Error("GLB JSON chunk is missing");
  const json = JSON.parse(
    textDecoder.decode(bytes.subarray(offset + 8, offset + 8 + jsonLength)),
  );
  return json;
}

function objectSize(value) {
  return value && typeof value === "object" ? Object.keys(value).length : 0;
}

function inventoryFile(file, json, sha256) {
  const bufferViews = json.bufferViews ?? [];
  const compressedBufferViewSizes = [];
  let estimatedDecodedBytes = 0;
  for (const bufferView of bufferViews) {
    const meshopt = bufferView.extensions?.EXT_meshopt_compression;
    if (meshopt) {
      compressedBufferViewSizes.push(meshopt.byteLength);
      estimatedDecodedBytes += meshopt.count * meshopt.byteStride;
    } else {
      estimatedDecodedBytes += bufferView.byteLength;
    }
  }
  const primitiveCount = (json.meshes ?? []).reduce(
    (sum, mesh) => sum + (mesh.primitives?.length ?? 0),
    0,
  );
  const metadataPropertyCount = (json.extensions?.EXT_structural_metadata
    ?.schema?.classes
    ? Object.values(json.extensions.EXT_structural_metadata.schema.classes)
    : []
  ).reduce((sum, schemaClass) => sum + objectSize(schemaClass.properties), 0);
  const extensionsUsed = json.extensionsUsed ?? [];
  const compressedBytes = file.contentLength;
  return {
    url: file.url,
    compressedBytes,
    estimatedDecodedBytes,
    sha256,
    extensionsUsed,
    meshoptBufferViewCount: compressedBufferViewSizes.length,
    compressedBufferViewCount: compressedBufferViewSizes.length,
    totalCompressedBufferViewBytes: compressedBufferViewSizes.reduce(
      (sum, size) => sum + size,
      0,
    ),
    medianCompressedBufferViewBytes:
      compressedBufferViewSizes.length === 0
        ? 0
        : [...compressedBufferViewSizes].sort((a, b) => a - b)[
            Math.floor((compressedBufferViewSizes.length - 1) / 2)
          ],
    largestCompressedBufferViewBytes: Math.max(
      0,
      ...compressedBufferViewSizes,
    ),
    bufferViewCount: bufferViews.length,
    meshCount: json.meshes?.length ?? 0,
    primitiveCount,
    materialCount: json.materials?.length ?? 0,
    textureCount: json.textures?.length ?? 0,
    ktx2TextureCount: extensionsUsed.includes("KHR_texture_basisu")
      ? json.textures?.length ?? 0
      : 0,
    metadataPropertyCount,
  };
}

async function fetchInventory(file) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(file.url, {
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const body = new Uint8Array(await response.arrayBuffer());
      const hash = createHash("sha256").update(body).digest("hex");
      return inventoryFile(file, parseGlb(body), hash);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

const results = [];
let nextIndex = 0;
async function worker() {
  while (true) {
    const index = nextIndex++;
    if (index >= files.length) return;
    const file = files[index];
    try {
      results[index] = await fetchInventory(file);
    } catch (error) {
      results[index] = {
        url: file.url,
        compressedBytes: file.contentLength,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if ((index + 1) % 100 === 0 || index + 1 === files.length) {
      console.log(`Inventoried ${index + 1}/${files.length}`);
    }
  }
}
await Promise.all(
  Array.from({ length: Math.min(concurrency, files.length) }, () => worker()),
);

const successful = results.filter((item) => !item.error);
const sum = (key) =>
  successful.reduce((total, item) => total + (item[key] ?? 0), 0);
const allCompressedViewSizes = successful.flatMap((item) => {
  const count = item.compressedBufferViewCount;
  return count === 0
    ? []
    : [item.totalCompressedBufferViewBytes / count];
});
const aggregate = {
  contentCount: successful.length,
  failedContentCount: results.length - successful.length,
  uniqueCompressedBytes: sum("compressedBytes"),
  estimatedDecodedBytes: sum("estimatedDecodedBytes"),
  bufferViewCount: sum("bufferViewCount"),
  meshoptBufferViewCount: sum("meshoptBufferViewCount"),
  compressedBufferViewCount: sum("compressedBufferViewCount"),
  totalCompressedBufferViewBytes: sum("totalCompressedBufferViewBytes"),
  meshCount: sum("meshCount"),
  primitiveCount: sum("primitiveCount"),
  materialCount: sum("materialCount"),
  textureCount: sum("textureCount"),
  ktx2TextureCount: sum("ktx2TextureCount"),
  metadataPropertyCount: sum("metadataPropertyCount"),
  medianPerFileAverageCompressedBufferViewBytes:
    allCompressedViewSizes.length === 0
      ? 0
      : [...allCompressedViewSizes].sort((a, b) => a - b)[
          Math.floor((allCompressedViewSizes.length - 1) / 2)
        ],
};

const inventory = {
  kind: "reearth-production-meshopt-route-inventory",
  generatedAt: new Date().toISOString(),
  sourceReport: reportPath,
  route: report.route,
  aggregate,
  files: results,
};
await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      outputPath,
      contentCount: aggregate.contentCount,
      uniqueCompressedBytes: aggregate.uniqueCompressedBytes,
      estimatedDecodedBytes: aggregate.estimatedDecodedBytes,
      failedContentCount: aggregate.failedContentCount,
    },
    null,
    2,
  ),
);
