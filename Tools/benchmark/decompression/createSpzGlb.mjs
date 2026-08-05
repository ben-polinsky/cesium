#!/usr/bin/env node

import fs from "node:fs";
import zlib from "node:zlib";

function getOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    throw new Error(`Missing required option: ${name}`);
  }
  return process.argv[index + 1];
}

function parseSpzHeader(data) {
  const payload =
    data[0] === 0x1f && data[1] === 0x8b ? zlib.gunzipSync(data) : data;

  if (payload.toString("ascii", 0, 4) !== "NGSP") {
    throw new Error("Input is not an SPZ payload");
  }

  const version = payload.readUInt32LE(4);
  if (version < 1 || version > 4) {
    throw new Error(`Unsupported SPZ version: ${version}`);
  }

  return {
    version,
    gaussianCount: payload.readUInt32LE(8),
    shDegree: payload[12],
  };
}

function createAccessors(gaussianCount, shDegree) {
  const accessors = [
    {
      componentType: 5126,
      count: gaussianCount,
      type: "VEC3",
      min: [-1, -1, -1],
      max: [1, 1, 1],
    },
    {
      componentType: 5121,
      normalized: true,
      count: gaussianCount,
      type: "VEC4",
    },
    {
      componentType: 5126,
      count: gaussianCount,
      type: "VEC3",
    },
    {
      componentType: 5126,
      count: gaussianCount,
      type: "VEC4",
    },
  ];

  const attributes = {
    POSITION: 0,
    COLOR_0: 1,
    "KHR_gaussian_splatting:SCALE": 2,
    "KHR_gaussian_splatting:ROTATION": 3,
  };

  for (let degree = 1; degree <= shDegree; ++degree) {
    const coefficientCount = degree * 2 + 1;
    for (let coefficient = 0; coefficient < coefficientCount; ++coefficient) {
      attributes[
        `KHR_gaussian_splatting:SH_DEGREE_${degree}_COEF_${coefficient}`
      ] = accessors.length;
      accessors.push({
        componentType: 5126,
        count: gaussianCount,
        type: "VEC3",
      });
    }
  }

  return { accessors, attributes };
}

function createGltf(spzByteLength, gaussianCount, shDegree) {
  const { accessors, attributes } = createAccessors(
    gaussianCount,
    shDegree,
  );

  return {
    extensionsUsed: [
      "KHR_gaussian_splatting",
      "KHR_gaussian_splatting_compression_spz_2",
      "KHR_materials_unlit",
    ],
    extensionsRequired: [
      "KHR_gaussian_splatting",
      "KHR_gaussian_splatting_compression_spz_2",
    ],
    asset: {
      version: "2.0",
      generator: "Cesium SPZ benchmark wrapper",
    },
    buffers: [{ byteLength: spzByteLength }],
    bufferViews: [{ buffer: 0, byteLength: spzByteLength }],
    accessors,
    materials: [{ extensions: { KHR_materials_unlit: {} } }],
    meshes: [
      {
        primitives: [
          {
            attributes,
            material: 0,
            mode: 0,
            extensions: {
              KHR_gaussian_splatting: {
                extensions: {
                  KHR_gaussian_splatting_compression_spz_2: {
                    bufferView: 0,
                  },
                },
              },
            },
          },
        ],
      },
    ],
    nodes: [{ mesh: 0 }],
    scene: 0,
    scenes: [{ nodes: [0] }],
  };
}

function padBuffer(buffer, byte) {
  const paddedLength = (buffer.length + 3) & ~3;
  if (paddedLength === buffer.length) {
    return buffer;
  }

  return Buffer.concat([buffer, Buffer.alloc(paddedLength - buffer.length, byte)]);
}

function createGlb(gltf, spzData) {
  const json = padBuffer(Buffer.from(JSON.stringify(gltf), "utf8"), 0x20);
  const bin = padBuffer(spzData, 0);
  const totalLength = 12 + 8 + json.length + 8 + bin.length;
  const result = Buffer.alloc(totalLength);

  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(totalLength, 8);

  let offset = 12;
  result.writeUInt32LE(json.length, offset);
  result.writeUInt32LE(0x4e4f534a, offset + 4);
  json.copy(result, offset + 8);
  offset += 8 + json.length;

  result.writeUInt32LE(bin.length, offset);
  result.writeUInt32LE(0x004e4942, offset + 4);
  bin.copy(result, offset + 8);

  return result;
}

const inputPath = getOption("--input");
const outputPath = getOption("--output");
const spzData = fs.readFileSync(inputPath);
const header = parseSpzHeader(spzData);
const gltf = createGltf(
  spzData.length,
  header.gaussianCount,
  header.shDegree,
);
const glb = createGlb(gltf, spzData);

fs.mkdirSync(outputPath.substring(0, outputPath.lastIndexOf("/")), {
  recursive: true,
});
fs.writeFileSync(outputPath, glb);

console.log(
  JSON.stringify(
    {
      inputPath,
      outputPath,
      inputBytes: spzData.length,
      outputBytes: glb.length,
      ...header,
    },
    null,
    2,
  ),
);
