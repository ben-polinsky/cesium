#!/usr/bin/env node

import { MeshoptEncoder } from "meshoptimizer/encoder";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const outputDirectory = path.join(
  repositoryRoot,
  "Specs",
  "Data",
  "Performance",
  "Decompression",
  "meshopt-task-shapes",
);
const encoderVersion = "1.2.0";
const encoderIntegrity =
  "sha512-davRZeIJbxJrE24cwQle7ZDsxjdk/OphNOV83oX+efQinyoHY9Jcyz3MHbaoG0qySZajldGztNZ1RN/T19PZsg==";
const totalCompressedBytes = 9540;
const primitiveCount = 200;

const workloads = [
  {
    id: "meshopt-task-shape-1-view",
    label: "1 compressed buffer view",
    uniqueCompressedViews: 1,
    specGroups: [
      {
        recipe: "triangle",
        count: 378,
        byteStride: 56,
        expectedCompressedBytes: 9540,
        instances: 1,
      },
    ],
  },
  {
    id: "meshopt-task-shape-10-view",
    label: "10 compressed buffer views",
    uniqueCompressedViews: 10,
    specGroups: [
      {
        recipe: "ramp",
        count: 32,
        byteStride: 80,
        expectedCompressedBytes: 800,
        instances: 4,
      },
      {
        recipe: "grid",
        count: 24,
        byteStride: 80,
        expectedCompressedBytes: 875,
        instances: 1,
      },
      {
        recipe: "ramp",
        count: 128,
        byteStride: 12,
        expectedCompressedBytes: 1093,
        instances: 5,
      },
    ],
  },
  {
    id: "meshopt-task-shape-60-view",
    label: "60 compressed buffer views",
    uniqueCompressedViews: 60,
    specGroups: [
      {
        recipe: "grid",
        count: 17,
        byteStride: 20,
        expectedCompressedBytes: 159,
        instances: 60,
      },
    ],
  },
  {
    id: "meshopt-task-shape-200-view",
    label: "200 compressed buffer views",
    uniqueCompressedViews: 200,
    specGroups: [
      {
        recipe: "repeat",
        count: 7,
        byteStride: 12,
        expectedCompressedBytes: 45,
        instances: 65,
      },
      {
        recipe: "repeat",
        count: 7,
        byteStride: 16,
        expectedCompressedBytes: 49,
        instances: 135,
      },
    ],
  },
];

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function recipePosition(recipe, index) {
  if (recipe === "repeat") {
    return [0, 0, 0];
  }
  if (recipe === "triangle") {
    return [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ][index % 3];
  }
  if (recipe === "grid") {
    return [index % 8, Math.floor(index / 8) % 8, Math.floor(index / 64) % 8];
  }
  if (recipe === "ramp") {
    return [index * 0.1, index * 0.2, index * 0.3];
  }
  throw new Error(`Unsupported recipe ${recipe}`);
}

function createSourceBytes(spec) {
  const source = new ArrayBuffer(spec.count * spec.byteStride);
  const view = new DataView(source);
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];

  for (let index = 0; index < spec.count; ++index) {
    const offset = index * spec.byteStride;
    const [x, y, z] = recipePosition(spec.recipe, index);
    view.setFloat32(offset, x, true);
    view.setFloat32(offset + 4, y, true);
    view.setFloat32(offset + 8, z, true);
    min = [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)];
    max = [Math.max(max[0], x), Math.max(max[1], y), Math.max(max[2], z)];

    for (let byteOffset = 12; byteOffset + 4 <= spec.byteStride; byteOffset += 4) {
      let value;
      if (spec.recipe === "repeat") {
        value = 0;
      } else if (spec.recipe === "triangle") {
        value = index % 3;
      } else if (spec.recipe === "grid") {
        value = (index + byteOffset) % 17;
      } else {
        value = index + byteOffset;
      }
      view.setFloat32(offset + byteOffset, value, true);
    }
  }

  return {
    bytes: Buffer.from(source),
    min,
    max,
  };
}

function createGltf(workload, views, totalDecodedBytes) {
  let compressedOffset = 0;
  let fallbackOffset = 0;
  const bufferViews = [];
  const accessors = [];
  const binaryChunks = [];

  for (let index = 0; index < views.length; ++index) {
    const view = views[index];
    bufferViews.push({
      buffer: 1,
      byteOffset: fallbackOffset,
      byteLength: view.decodedBytes,
      byteStride: view.byteStride,
      target: 34962,
      extensions: {
        KHR_meshopt_compression: {
          buffer: 0,
          byteOffset: compressedOffset,
          byteLength: view.compressedBytes,
          byteStride: view.byteStride,
          count: view.count,
          mode: "ATTRIBUTES",
          filter: "NONE",
        },
      },
    });
    accessors.push({
      bufferView: index,
      byteOffset: 0,
      componentType: 5126,
      count: view.count,
      type: "VEC3",
      min: view.min,
      max: view.max,
    });
    compressedOffset += view.compressedBytes;
    fallbackOffset += view.decodedBytes;
    binaryChunks.push(view.compressed);
  }

  const indexByteOffset = compressedOffset % 2 === 0 ? compressedOffset : compressedOffset + 1;
  if (indexByteOffset !== compressedOffset) {
    binaryChunks.push(Buffer.from([0]));
  }
  const indexBufferViewIndex = bufferViews.length;
  const indexAccessorIndex = accessors.length;
  const indexBytes = Buffer.from([0, 0, 1, 0, 2, 0]);
  binaryChunks.push(indexBytes);
  bufferViews.push({
    buffer: 0,
    byteOffset: indexByteOffset,
    byteLength: indexBytes.length,
    target: 34963,
  });
  accessors.push({
    bufferView: indexBufferViewIndex,
    byteOffset: 0,
    componentType: 5123,
    count: 3,
    type: "SCALAR",
    min: [0],
    max: [2],
  });

  const primitives = [];
  for (let index = 0; index < primitiveCount; ++index) {
    primitives.push({
      attributes: { POSITION: index % views.length },
      indices: indexAccessorIndex,
      material: 0,
    });
  }

  return {
    gltf: {
      asset: { version: "2.0" },
      extensionsUsed: ["KHR_meshopt_compression"],
      extensionsRequired: ["KHR_meshopt_compression"],
      buffers: [
        {
          uri: `${workload.id}.bin`,
          byteLength: indexByteOffset + indexBytes.length,
        },
        {
          byteLength: totalDecodedBytes,
          extensions: { KHR_meshopt_compression: { fallback: true } },
        },
      ],
      bufferViews,
      accessors,
      materials: [
        { pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } },
      ],
      meshes: [{ primitives }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    },
    binary: Buffer.concat(binaryChunks),
  };
}

async function main() {
  const packageJson = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "node_modules", "meshoptimizer", "package.json"),
      "utf8",
    ),
  );
  assert(
    packageJson.version === encoderVersion,
    `meshoptimizer ${packageJson.version} is installed; this corpus requires ${encoderVersion}`,
  );

  await MeshoptEncoder.ready;
  await mkdir(outputDirectory, { recursive: true });

  const generatorPath = path.relative(
    repositoryRoot,
    fileURLToPath(import.meta.url),
  );
  const generatorBytes = await readFile(fileURLToPath(import.meta.url));
  const fixtures = [];

  for (const workload of workloads) {
    const views = [];
    const decodedChunks = [];
    let compressedBytes = 0;
    let decodedBytes = 0;

    for (const group of workload.specGroups) {
      for (let index = 0; index < group.instances; ++index) {
        const source = createSourceBytes(group);
        const compressed = Buffer.from(
          MeshoptEncoder.encodeGltfBuffer(
            source.bytes,
            group.count,
            group.byteStride,
            "ATTRIBUTES",
          ),
        );
        assert(
          compressed.length === group.expectedCompressedBytes,
          `${workload.id} expected ${group.expectedCompressedBytes} bytes, got ${compressed.length}`,
        );
        views.push({
          recipe: group.recipe,
          count: group.count,
          byteStride: group.byteStride,
          compressedBytes: compressed.length,
          decodedBytes: source.bytes.length,
          min: source.min,
          max: source.max,
          compressed,
        });
        decodedChunks.push(source.bytes);
        compressedBytes += compressed.length;
        decodedBytes += source.bytes.length;
      }
    }

    assert(
      views.length === workload.uniqueCompressedViews,
      `${workload.id} generated ${views.length} views`,
    );
    assert(
      compressedBytes === totalCompressedBytes,
      `${workload.id} generated ${compressedBytes} compressed bytes`,
    );

    const { gltf, binary } = createGltf(workload, views, decodedBytes);
    const gltfPath = path.join(outputDirectory, `${workload.id}.gltf`);
    const binaryPath = path.join(outputDirectory, `${workload.id}.bin`);
    await writeFile(gltfPath, `${JSON.stringify(gltf, null, 2)}\n`, "utf8");
    await writeFile(binaryPath, binary);

    const construction = {
      compressedBytes,
      decodedAttributeBytes: decodedBytes,
      uniqueCompressedViews: views.length,
      primitiveCount,
      primitiveToUniqueViewMapping: "primitiveIndex % uniqueCompressedViews",
      specGroups: workload.specGroups,
      decodedAttributeSha256: hashBytes(Buffer.concat(decodedChunks)),
    };
    fixtures.push({
      id: workload.id,
      label: workload.label,
      gltf: path.relative(repositoryRoot, gltfPath).replaceAll(path.sep, "/"),
      gltfSha256: hashBytes(await readFile(gltfPath)),
      binary: path.relative(repositoryRoot, binaryPath).replaceAll(path.sep, "/"),
      binarySha256: hashBytes(binary),
      binarySizeBytes: binary.length,
      construction,
      constructionSha256: hashBytes(Buffer.from(canonicalize(construction))),
    });
  }

  const manifest = {
    schemaVersion: 1,
    purpose:
      "Matched Meshopt task-shape corpus for public Model.fromGltfAsync measurements.",
    encoder: {
      package: "meshoptimizer",
      version: encoderVersion,
      integrity: encoderIntegrity,
    },
    generator: {
      path: generatorPath,
      sha256: hashBytes(generatorBytes),
      version: "1.0.0",
    },
    runtime: {
      nodeVersion: process.version,
      os: os.platform(),
      arch: os.arch(),
      packageManager: "npm",
    },
    study: {
      compressedBytesTarget: totalCompressedBytes,
      decodedBytesRange: [19840, 21168],
      viewCounts: [1, 10, 60, 200],
      primitiveCount,
      compression: "KHR_meshopt_compression ATTRIBUTES/NONE",
    },
    fixtures,
  };
  await writeFile(
    path.join(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(`Wrote ${outputDirectory}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  process.exitCode = 1;
});
