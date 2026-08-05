#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import draco3d from "draco3d";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const fixtureDirectory = path.join(
  repositoryRoot,
  "Specs/Data/Performance/Decompression/draco",
);
const manifestPath = path.join(fixtureDirectory, "manifest.json");

const GENERATOR_NAME = "Cesium Draco benchmark fixture generator";
const GENERATOR_VERSION = "1.1.0";
const GENERATOR_SCHEMA_VERSION = 2;
const MANIFEST_SCHEMA_VERSION = 1;
const ENCODER_PACKAGE_NAME = "draco3d";
const encoderPackageVersion = require("draco3d/package.json").version;
const ENCODER_INTEGRITY =
  "sha512-m6WCKt/erDXcw+70IJXnG7M3awwQPAsZvJGX5zY7beBqpELw6RDGkYVU0W43AFxye4pDZ5i2Lbyc/NNGqwjUVQ==";

const ENCODER_SPEED = 5;
const DECODER_SPEED = 5;
const MESH_ENCODING_METHOD = "MESH_SEQUENTIAL_ENCODING";
const POINT_CLOUD_ENCODING_METHOD = "POINT_CLOUD_SEQUENTIAL_ENCODING";
const POINT_CLOUD_ENCODING_METHOD_VALUE = 0;
const POINT_CLOUD_DEDUPLICATE_VALUES = false;

const MESH_ATTRIBUTE_PROFILES = {
  unquantized: [
    {
      name: "POSITION",
      type: "POSITION",
      dataType: "FLOAT32",
      components: 3,
      normalized: false,
    },
    {
      name: "NORMAL",
      type: "NORMAL",
      dataType: "FLOAT32",
      components: 3,
      normalized: false,
    },
    {
      name: "TEX_COORD",
      type: "TEX_COORD",
      dataType: "FLOAT32",
      components: 2,
      normalized: false,
    },
    {
      name: "COLOR",
      type: "COLOR",
      dataType: "UINT8",
      components: 4,
      normalized: true,
    },
    {
      name: "FEATURE_ID",
      type: "GENERIC",
      dataType: "INT16",
      components: 2,
      normalized: false,
    },
  ],
  quantized: [
    {
      name: "POSITION",
      type: "POSITION",
      dataType: "FLOAT32",
      components: 3,
      normalized: false,
    },
    {
      name: "NORMAL",
      type: "NORMAL",
      dataType: "FLOAT32",
      components: 3,
      normalized: false,
    },
    {
      name: "TEX_COORD",
      type: "TEX_COORD",
      dataType: "FLOAT32",
      components: 2,
      normalized: false,
    },
    {
      name: "COLOR",
      type: "COLOR",
      dataType: "UINT8",
      components: 4,
      normalized: true,
    },
    {
      name: "FEATURE_ID",
      type: "GENERIC",
      dataType: "UINT16",
      components: 1,
      normalized: false,
    },
  ],
};

const POINT_CLOUD_ATTRIBUTE_PROFILES = {
  unquantized: [
    {
      name: "POSITION",
      type: "POSITION",
      dataType: "FLOAT32",
      components: 3,
      normalized: false,
    },
    {
      name: "NORMAL",
      type: "NORMAL",
      dataType: "FLOAT32",
      components: 3,
      normalized: false,
    },
    {
      name: "COLOR",
      type: "COLOR",
      dataType: "UINT8",
      components: 4,
      normalized: true,
    },
    {
      name: "INTENSITY",
      type: "GENERIC",
      dataType: "UINT16",
      components: 1,
      normalized: false,
    },
    {
      name: "CLASSIFICATION",
      type: "GENERIC",
      dataType: "INT8",
      components: 1,
      normalized: false,
    },
  ],
  quantized: [
    {
      name: "POSITION",
      type: "POSITION",
      dataType: "FLOAT32",
      components: 3,
      normalized: false,
    },
    {
      name: "NORMAL",
      type: "NORMAL",
      dataType: "FLOAT32",
      components: 3,
      normalized: false,
    },
    {
      name: "COLOR",
      type: "COLOR",
      dataType: "UINT8",
      components: 4,
      normalized: true,
    },
    {
      name: "INTENSITY",
      type: "GENERIC",
      dataType: "UINT16",
      components: 1,
      normalized: false,
    },
    {
      name: "CLASSIFICATION",
      type: "GENERIC",
      dataType: "INT8",
      components: 1,
      normalized: false,
    },
  ],
};

const FIXTURE_CONFIGS = [
  {
    id: "mesh-small-unquantized",
    geometry: "mesh",
    shape: "heightfield-grid",
    gridSize: 32,
    scale: 1,
    phase: 0.125,
    attributeProfile: "unquantized",
    quantization: {},
    dequantizeInShader: false,
    attributesToSkipTransform: [],
  },
  {
    id: "mesh-medium-quantized",
    geometry: "mesh",
    shape: "heightfield-grid",
    gridSize: 96,
    scale: 100,
    phase: 0.375,
    attributeProfile: "quantized",
    quantization: {
      POSITION: 14,
      NORMAL: 10,
      TEX_COORD: 12,
    },
    dequantizeInShader: true,
    attributesToSkipTransform: ["POSITION", "NORMAL", "TEX_COORD"],
  },
  {
    id: "mesh-large-quantized",
    geometry: "mesh",
    shape: "heightfield-grid",
    gridSize: 192,
    scale: 10000,
    phase: 0.625,
    attributeProfile: "quantized",
    quantization: {
      POSITION: 16,
      NORMAL: 10,
      TEX_COORD: 14,
    },
    dequantizeInShader: true,
    attributesToSkipTransform: ["POSITION", "NORMAL", "TEX_COORD"],
  },
  {
    id: "point-small-unquantized",
    geometry: "point-cloud",
    shape: "heightfield-grid",
    gridSize: 64,
    scale: 10,
    phase: 0.25,
    attributeProfile: "unquantized",
    quantization: {},
    dequantizeInShader: false,
    attributesToSkipTransform: [],
  },
  {
    id: "point-medium-quantized",
    geometry: "point-cloud",
    shape: "heightfield-grid",
    gridSize: 256,
    scale: 1000,
    phase: 0.5,
    attributeProfile: "quantized",
    quantization: {
      POSITION: 14,
      NORMAL: 8,
    },
    dequantizeInShader: true,
    attributesToSkipTransform: ["POSITION", "NORMAL"],
  },
  {
    id: "point-large-quantized",
    geometry: "point-cloud",
    shape: "heightfield-grid",
    gridSize: 512,
    scale: 100000,
    phase: 0.75,
    attributeProfile: "quantized",
    quantization: {
      POSITION: 16,
      NORMAL: 8,
    },
    dequantizeInShader: true,
    attributesToSkipTransform: ["POSITION", "NORMAL"],
  },
];

function createHeightfield(gridSize, scale, phase, geometry) {
  const pointsPerSide = gridSize + 1;
  const numPoints = pointsPerSide * pointsPerSide;
  const positions = new Float32Array(numPoints * 3);
  const normals = new Float32Array(numPoints * 3);
  const texCoords = new Float32Array(numPoints * 2);
  const colors = new Uint8Array(numPoints * 4);
  const featureIds = new Int16Array(numPoints * 2);
  const intensities = new Uint16Array(numPoints);
  const classifications = new Int8Array(numPoints);

  for (let row = 0; row < pointsPerSide; ++row) {
    for (let column = 0; column < pointsPerSide; ++column) {
      const pointIndex = row * pointsPerSide + column;
      const u = column / gridSize;
      const v = row / gridSize;
      const angleU = 2.0 * Math.PI * (u + phase);
      const angleV = 2.0 * Math.PI * (v - phase);
      const wave = Math.sin(angleU) * Math.cos(angleV);
      const amplitude = 0.08;
      const z = amplitude * wave * scale;
      const dzdu =
        amplitude * 2.0 * Math.PI * Math.cos(angleU) * Math.cos(angleV);
      const dzdv =
        -amplitude * 2.0 * Math.PI * Math.sin(angleU) * Math.sin(angleV);
      const normalX = -dzdu;
      const normalY = -dzdv;
      const normalLength = Math.sqrt(
        normalX * normalX + normalY * normalY + 1.0,
      );
      const positionOffset = pointIndex * 3;
      const normalOffset = pointIndex * 3;
      const texCoordOffset = pointIndex * 2;
      const colorOffset = pointIndex * 4;
      const featureOffset = pointIndex * 2;

      positions[positionOffset] = (u - 0.5) * scale;
      positions[positionOffset + 1] = (v - 0.5) * scale;
      positions[positionOffset + 2] = z;

      normals[normalOffset] = normalX / normalLength;
      normals[normalOffset + 1] = normalY / normalLength;
      normals[normalOffset + 2] = 1.0 / normalLength;

      texCoords[texCoordOffset] = u;
      texCoords[texCoordOffset + 1] = v;

      colors[colorOffset] = (column * 255) / gridSize;
      colors[colorOffset + 1] = (row * 255) / gridSize;
      colors[colorOffset + 2] =
        ((column * 17 + row * 31 + Math.round(phase * 100)) & 0xff);
      colors[colorOffset + 3] = 255;

      featureIds[featureOffset] = column % 257;
      featureIds[featureOffset + 1] = row % 251;
      intensities[pointIndex] =
        (column * 257 + row * 263 + Math.round(phase * 1000)) & 0xffff;
      classifications[pointIndex] =
        ((column + row + Math.round(phase * 10)) % 7) - 3;
    }
  }

  const result = {
    numPoints,
    positions,
    normals,
    texCoords,
    colors,
    featureIds,
    intensities,
    classifications,
  };

  if (geometry === "mesh") {
    const numFaces = gridSize * gridSize * 2;
    const indices = new Int32Array(numFaces * 3);
    let faceOffset = 0;
    for (let row = 0; row < gridSize; ++row) {
      for (let column = 0; column < gridSize; ++column) {
        const lowerLeft = row * pointsPerSide + column;
        const lowerRight = lowerLeft + 1;
        const upperLeft = lowerLeft + pointsPerSide;
        const upperRight = upperLeft + 1;

        indices[faceOffset++] = lowerLeft;
        indices[faceOffset++] = lowerRight;
        indices[faceOffset++] = upperLeft;
        indices[faceOffset++] = upperLeft;
        indices[faceOffset++] = lowerRight;
        indices[faceOffset++] = upperRight;
      }
    }
    result.indices = indices;
    result.numFaces = numFaces;
  }

  return result;
}

function getAttributeData(attribute, data) {
  switch (attribute.name) {
    case "POSITION":
      return data.positions;
    case "NORMAL":
      return data.normals;
    case "TEX_COORD":
      return data.texCoords;
    case "COLOR":
      return data.colors;
    case "FEATURE_ID":
      return data.featureIds;
    case "INTENSITY":
      return data.intensities;
    case "CLASSIFICATION":
      return data.classifications;
    default:
      throw new Error(`Unknown Draco fixture attribute: ${attribute.name}`);
  }
}

function addAttribute(module, builder, geometry, attribute, data) {
  const values = getAttributeData(attribute, data);
  const methods = {
    FLOAT32: "AddFloatAttribute",
    INT8: "AddInt8Attribute",
    UINT8: "AddUInt8Attribute",
    INT16: "AddInt16Attribute",
    UINT16: "AddUInt16Attribute",
    INT32: "AddInt32Attribute",
    UINT32: "AddUInt32Attribute",
  };
  const method = methods[attribute.dataType];
  if (typeof builder[method] !== "function") {
    throw new Error(`Draco encoder does not provide ${method}().`);
  }

  const attributeId = builder[method](
    geometry,
    module[attribute.type],
    data.numPoints,
    attribute.components,
    values,
  );
  if (attributeId < 0) {
    throw new Error(`Failed to add ${attribute.name} attribute.`);
  }
  if (attribute.normalized && !builder.SetNormalizedFlagForAttribute(
    geometry,
    attributeId,
    true,
  )) {
    throw new Error(`Failed to normalize ${attribute.name} attribute.`);
  }
  return attributeId;
}

function getAttributeProfile(config, geometry) {
  const profiles =
    geometry === "mesh"
      ? MESH_ATTRIBUTE_PROFILES
      : POINT_CLOUD_ATTRIBUTE_PROFILES;
  return profiles[config.attributeProfile];
}

function configureEncoder(module, encoder, config) {
  encoder.SetSpeedOptions(ENCODER_SPEED, DECODER_SPEED);
  if (config.geometry === "mesh") {
    encoder.SetEncodingMethod(module[MESH_ENCODING_METHOD]);
  } else {
    // The JS binding does not expose the point-cloud enum name. Its
    // sequential encoding value is shared with MESH_SEQUENTIAL_ENCODING.
    encoder.SetEncodingMethod(POINT_CLOUD_ENCODING_METHOD_VALUE);
  }
  for (const [attributeType, quantizationBits] of Object.entries(
    config.quantization,
  )) {
    encoder.SetAttributeQuantization(
      module[attributeType],
      quantizationBits,
    );
  }
}

function copyEncodedBuffer(module, encodedData, encodedLength) {
  if (encodedLength <= 0) {
    throw new Error("Draco encoder returned an empty buffer.");
  }
  const bytes = new Uint8Array(encodedLength);
  for (let i = 0; i < encodedLength; ++i) {
    bytes[i] = encodedData.GetValue(i);
  }
  module.destroy(encodedData);
  return bytes;
}

function encodeFixture(module, config) {
  const data = createHeightfield(
    config.gridSize,
    config.scale,
    config.phase,
    config.geometry,
  );
  const attributes = getAttributeProfile(config, config.geometry);
  const builder =
    config.geometry === "mesh"
      ? new module.MeshBuilder()
      : new module.PointCloudBuilder();
  const geometry =
    config.geometry === "mesh" ? new module.Mesh() : new module.PointCloud();

  try {
    if (config.geometry === "mesh") {
      if (
        !builder.AddFacesToMesh(
          geometry,
          data.numFaces,
          data.indices,
        )
      ) {
        throw new Error("Failed to add mesh faces.");
      }
    }

    for (const attribute of attributes) {
      addAttribute(module, builder, geometry, attribute, data);
    }

    const encoder = new module.Encoder();
    const encodedData = new module.DracoInt8Array();
    try {
      configureEncoder(module, encoder, config);
      const encodedLength =
        config.geometry === "mesh"
          ? encoder.EncodeMeshToDracoBuffer(geometry, encodedData)
          : encoder.EncodePointCloudToDracoBuffer(
              geometry,
              POINT_CLOUD_DEDUPLICATE_VALUES,
              encodedData,
            );
      const bytes = copyEncodedBuffer(module, encodedData, encodedLength);
      module.destroy(encoder);
      return {
        bytes,
        data,
      };
    } catch (error) {
      module.destroy(encodedData);
      module.destroy(encoder);
      throw error;
    }
  } finally {
    module.destroy(geometry);
    module.destroy(builder);
  }
}

function toLittleEndianBytes(typedArray) {
  if (typedArray instanceof Uint8Array || typedArray instanceof Int8Array) {
    return Buffer.from(
      typedArray.buffer,
      typedArray.byteOffset,
      typedArray.byteLength,
    );
  }

  const bytes = Buffer.alloc(typedArray.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let setter;
  if (typedArray instanceof Uint16Array) {
    setter = "setUint16";
  } else if (typedArray instanceof Int16Array) {
    setter = "setInt16";
  } else if (typedArray instanceof Uint32Array) {
    setter = "setUint32";
  } else if (typedArray instanceof Int32Array) {
    setter = "setInt32";
  } else if (typedArray instanceof Float32Array) {
    setter = "setFloat32";
  } else {
    throw new Error(`Unsupported typed array: ${typedArray.constructor.name}.`);
  }

  for (let i = 0; i < typedArray.length; ++i) {
    view[setter](i * typedArray.BYTES_PER_ELEMENT, typedArray[i], true);
  }
  return bytes;
}

const COMPONENT_DATATYPES = {
  FLOAT32: "FLOAT",
  INT8: "BYTE",
  UINT8: "UNSIGNED_BYTE",
  INT16: "SHORT",
  UINT16: "UNSIGNED_SHORT",
  INT32: "INT",
  UINT32: "UNSIGNED_INT",
};

function createSourceAttributeSummary(config, attribute, data) {
  const values = getAttributeData(attribute, data);
  const quantizationBits = config.quantization[attribute.type] ?? null;
  return {
    sourceDataType: attribute.dataType,
    typedArray: values.constructor.name,
    componentDatatype: COMPONENT_DATATYPES[attribute.dataType],
    componentsPerAttribute: attribute.components,
    count: data.numPoints,
    arrayLength: values.length,
    normalized: attribute.normalized,
    byteStride: values.BYTES_PER_ELEMENT * attribute.components,
    requestedQuantizationBits: quantizationBits,
    requestedTransform:
      quantizationBits === null
        ? null
        : attribute.name === "NORMAL"
          ? "octahedral"
          : "uniform",
  };
}

function createSourceReference(config, data) {
  const attributes = getAttributeProfile(config, config.geometry);
  const attributeOrder = attributes.map((attribute) => attribute.name);
  const serializationOrder =
    config.geometry === "mesh"
      ? ["indices", ...attributeOrder]
      : attributeOrder;
  const parts = [];

  if (config.geometry === "mesh") {
    parts.push(toLittleEndianBytes(data.indices));
  }
  for (const attribute of attributes) {
    parts.push(
      toLittleEndianBytes(getAttributeData(attribute, data)),
    );
  }

  const summary = {
    geometryType:
      config.geometry === "mesh" ? "TRIANGULAR_MESH" : "POINT_CLOUD",
    numPoints: data.numPoints,
    attributes: Object.fromEntries(
      attributes.map((attribute) => [
        attribute.name,
        createSourceAttributeSummary(config, attribute, data),
      ]),
    ),
    serialization: {
      order: serializationOrder,
      index:
        config.geometry === "mesh"
          ? {
              sourceDataType: "INT32",
              typedArray: data.indices.constructor.name,
              componentDatatype: "INT",
              count: data.indices.length,
              byteLength: data.indices.byteLength,
            }
          : null,
    },
    referenceKind: "deterministic-source-input",
    validation: {
      expectedData: "deterministic source geometry and attribute inputs",
      generator: "does not decode Draco payloads",
      authoritative:
        "future Cesium TaskProcessor/DracoLoader benchmark harness",
      quantizedAttributes:
        "require codec-specific production-decoder comparison or tolerance checks",
    },
  };
  if (config.geometry === "mesh") {
    summary.numFaces = data.numFaces;
  }

  return {
    summary,
    bytes: Buffer.concat(parts),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function getGenerationParameters(config) {
  return {
    geometry: config.geometry,
    shape: config.shape,
    gridSize: config.gridSize,
    scale: config.scale,
    phase: config.phase,
    attributeProfile: config.attributeProfile,
    quantization: config.quantization,
    encoding: {
      encodingSpeed: ENCODER_SPEED,
      decodingSpeed: DECODER_SPEED,
      meshEncodingMethod:
        config.geometry === "mesh" ? MESH_ENCODING_METHOD : null,
      pointCloudEncodingMethod:
        config.geometry === "point-cloud" ? POINT_CLOUD_ENCODING_METHOD : null,
      pointCloudEncodingMethodValue:
        config.geometry === "point-cloud"
          ? POINT_CLOUD_ENCODING_METHOD_VALUE
          : null,
      pointCloudDeduplicateValues:
        config.geometry === "point-cloud"
          ? POINT_CLOUD_DEDUPLICATE_VALUES
          : null,
    },
  };
}

function createAttributeLayoutMetadata(config) {
  return getAttributeProfile(config, config.geometry).map((attribute) => ({
    name: attribute.name,
    type: attribute.type,
    dataType: attribute.dataType,
    components: attribute.components,
    normalized: attribute.normalized,
  }));
}

function createEncoderMetadata(config, packageVersion) {
  return {
    package: ENCODER_PACKAGE_NAME,
    packageVersion,
    api:
      config.geometry === "mesh"
        ? "Encoder.EncodeMeshToDracoBuffer"
        : "Encoder.EncodePointCloudToDracoBuffer",
    encodingSpeed: ENCODER_SPEED,
    decodingSpeed: DECODER_SPEED,
    encodingMethod:
      config.geometry === "mesh"
        ? MESH_ENCODING_METHOD
        : POINT_CLOUD_ENCODING_METHOD,
    encodingMethodValue:
      config.geometry === "point-cloud"
        ? POINT_CLOUD_ENCODING_METHOD_VALUE
        : null,
    pointCloudDeduplicateValues:
      config.geometry === "point-cloud"
        ? POINT_CLOUD_DEDUPLICATE_VALUES
        : null,
    quantization: config.quantization,
  };
}

function createRuntimeDecodeMetadata(config) {
  return {
    api:
      config.geometry === "mesh"
        ? "Decoder.DecodeBufferToMesh"
        : "Decoder.DecodeBufferToPointCloud",
    worker: "packages/engine/Source/Workers/decodeDraco.js",
    geometryType:
      config.geometry === "mesh" ? "TRIANGULAR_MESH" : "POINT_CLOUD",
    dequantizeInShader: config.dequantizeInShader,
    attributesToSkipTransform: config.attributesToSkipTransform,
    validationAuthority:
      "future Cesium TaskProcessor/DracoLoader benchmark harness",
  };
}

function createInputDescriptor(config, packageVersion) {
  const descriptor = {
    sourceFiles: [],
    inline: {
      recipeVersion: 1,
      source: {
        recipe: "procedural-heightfield",
        geometry: config.geometry,
        shape: config.shape,
        gridSize: config.gridSize,
        scale: config.scale,
        phase: config.phase,
        attributeProfile: config.attributeProfile,
      },
    },
    options: {
      generation: getGenerationParameters(config),
      attributes: createAttributeLayoutMetadata(config),
      encoder: createEncoderMetadata(config, packageVersion),
      runtimeDecode: createRuntimeDecodeMetadata(config),
    },
  };

  return {
    ...descriptor,
    inputSha256: sha256(
      Buffer.from(canonicalJson(descriptor), "utf8"),
    ),
  };
}

function createExpectedDecodedMetadata(sourceReference) {
  const { summary, bytes } = sourceReference;
  const serializationOrder = summary.serialization.order;
  const format =
    `little-endian raw source-input typed-array bytes concatenated in ${serializationOrder.join(" -> ")} order; this is a deterministic reference derived without decoding the Draco payload`;

  return {
    sizeBytes: bytes.byteLength,
    sha256: sha256(bytes),
    format,
    summary,
  };
}

function createGeneratorSourceFile(sourceBytes) {
  return {
    path: path
      .relative(repositoryRoot, scriptPath)
      .replaceAll("\\", "/"),
    sizeBytes: sourceBytes.byteLength,
    sha256: sha256(sourceBytes),
  };
}

async function readRuntimeMetadata() {
  const { stdout } = await execFileAsync("npm", ["--version"]);
  const npmVersion = stdout.trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(npmVersion)) {
    throw new Error(`Unable to determine npm version: ${npmVersion}`);
  }

  return {
    nodeVersion: process.version,
    packageManager: `npm@${npmVersion}`,
    os: process.platform,
    arch: process.arch,
  };
}

function createManifest(
  fixtures,
  generatorSourceFile,
  runtime,
) {
  return {
    $schema: "../fixture-manifest.schema.json",
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    codec: "draco",
    encoder: {
      package: ENCODER_PACKAGE_NAME,
      version: encoderPackageVersion,
      integrity: ENCODER_INTEGRITY,
    },
    generator: {
      name: GENERATOR_NAME,
      version: GENERATOR_VERSION,
      schemaVersion: GENERATOR_SCHEMA_VERSION,
      sourceFiles: [generatorSourceFile],
    },
    runtime,
    fixtures,
  };
}

function createFixtureManifestEntry(
  config,
  encoded,
  sourceReference,
  packageVersion,
) {
  const compressed = {
    sizeBytes: encoded.bytes.byteLength,
    sha256: sha256(encoded.bytes),
  };

  return {
    id: config.id,
    path: `${config.id}.drc`,
    compressed,
    inputs: createInputDescriptor(config, packageVersion),
    expectedDecoded: createExpectedDecodedMetadata(sourceReference),
    metadata: {
      tier: config.id.split("-")[1],
      geometry: config.geometry,
      shape: config.shape,
      gridSize: config.gridSize,
      scale: config.scale,
      phase: config.phase,
      attributeProfile: config.attributeProfile,
      attributes: createAttributeLayoutMetadata(config),
      generation: getGenerationParameters(config),
      encoder: createEncoderMetadata(config, packageVersion),
      runtimeDecode: createRuntimeDecodeMetadata(config),
      validation: {
        sourceReference:
          "expectedDecoded is derived from deterministic generator inputs",
        decodeAuthority:
          "only future Cesium TaskProcessor/DracoLoader execution is authoritative",
      },
    },
  };
}

function assertManifestMatchesConfig(
  manifest,
  generatorSourceFile,
  packageVersion,
) {
  assert.equal(manifest.$schema, "../fixture-manifest.schema.json");
  assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.equal(manifest.codec, "draco");
  assert.deepEqual(manifest.encoder, {
    package: ENCODER_PACKAGE_NAME,
    version: packageVersion,
    integrity: ENCODER_INTEGRITY,
  });
  assert.equal(manifest.generator.name, GENERATOR_NAME);
  assert.equal(manifest.generator.version, GENERATOR_VERSION);
  assert.equal(
    manifest.generator.schemaVersion,
    GENERATOR_SCHEMA_VERSION,
  );
  assert.deepEqual(manifest.generator.sourceFiles, [generatorSourceFile]);
  assert.equal(typeof manifest.runtime?.nodeVersion, "string");
  assert.equal(typeof manifest.runtime?.packageManager, "string");
  assert.equal(typeof manifest.runtime?.os, "string");
  assert.equal(typeof manifest.runtime?.arch, "string");
  assert.equal(manifest.fixtures.length, FIXTURE_CONFIGS.length);
  assert.equal(manifest.encoder.package, ENCODER_PACKAGE_NAME);
  assert.deepEqual(
    manifest.fixtures.map((fixture) => fixture.id),
    FIXTURE_CONFIGS.map((config) => config.id),
  );
}

async function generate() {
  const generatorSourceFile = createGeneratorSourceFile(
    await readFile(scriptPath),
  );
  const runtime = await readRuntimeMetadata();
  const encoderModule = await draco3d.createEncoderModule({});
  const generatedFixtures = [];

  for (const config of FIXTURE_CONFIGS) {
    const encoded = encodeFixture(encoderModule, config);
    const sourceReference = createSourceReference(config, encoded.data);
    generatedFixtures.push({
      config,
      encoded,
      manifest: createFixtureManifestEntry(
        config,
        encoded,
        sourceReference,
        encoderPackageVersion,
      ),
    });
  }

  await mkdir(fixtureDirectory, { recursive: true });
  for (const fixture of generatedFixtures) {
    await writeFile(
      path.join(fixtureDirectory, fixture.manifest.path),
      fixture.encoded.bytes,
    );
  }
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      createManifest(
        generatedFixtures.map((fixture) => fixture.manifest),
        generatorSourceFile,
        runtime,
      ),
      null,
      2,
    )}\n`,
  );

  for (const fixture of generatedFixtures) {
    console.log(
      `${fixture.manifest.id}: ${fixture.manifest.compressed.sizeBytes} bytes`,
    );
  }
}

async function verify() {
  const generatorSourceFile = createGeneratorSourceFile(
    await readFile(scriptPath),
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertManifestMatchesConfig(
    manifest,
    generatorSourceFile,
    encoderPackageVersion,
  );

  const encoderModule = await draco3d.createEncoderModule({});

  for (const config of FIXTURE_CONFIGS) {
    const expected = manifest.fixtures.find(
      (fixture) => fixture.id === config.id,
    );

    const encoded = encodeFixture(encoderModule, config);
    const sourceReference = createSourceReference(config, encoded.data);
    const generatedEntry = createFixtureManifestEntry(
      config,
      encoded,
      sourceReference,
      encoderPackageVersion,
    );
    for (const key of [
      "id",
      "path",
      "compressed",
      "inputs",
      "expectedDecoded",
      "metadata",
    ]) {
      assert.deepEqual(
        expected[key],
        generatedEntry[key],
        `${config.id}: manifest metadata differs from the generator.`,
      );
    }

    const committedBytes = await readFile(
      path.join(fixtureDirectory, expected.path),
    );
    assert.equal(
      committedBytes.byteLength,
      expected.compressed.sizeBytes,
      `${config.id}: committed byte size differs from manifest.`,
    );
    assert.equal(
      sha256(committedBytes),
      expected.compressed.sha256,
      `${config.id}: committed SHA-256 differs from manifest.`,
    );
    assert.equal(
      Buffer.compare(committedBytes, Buffer.from(encoded.bytes)),
      0,
      `${config.id}: regenerated bytes differ from committed fixture.`,
    );
    console.log(
      `${config.id}: verified ${expected.compressed.sizeBytes} bytes (${expected.compressed.sha256})`,
    );
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === "--generate") {
    await generate();
  } else if (mode === "--verify") {
    await verify();
  } else if (mode === "--help" || mode === "-h") {
    console.log(
      "Usage: node Tools/benchmark/draco/generate-fixtures.mjs --generate|--verify",
    );
    console.log(
      "--verify checks deterministic encoder bytes and source metadata; it does not decode Draco.",
    );
    console.log(
      "Decode correctness is authoritative only in a future Cesium TaskProcessor/DracoLoader harness.",
    );
  } else {
    console.error(
      "Usage: node Tools/benchmark/draco/generate-fixtures.mjs --generate|--verify",
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
