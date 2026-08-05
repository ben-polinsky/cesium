#!/usr/bin/env node
// @ts-check

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MeshoptEncoder } from "meshoptimizer/encoder";

const GENERATOR_VERSION = "1.0.1";
const GENERATOR_SCHEMA_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const ENCODE_VERSION = 0;
const ENCODE_LEVEL = 2;
const ENCODER_PACKAGE_VERSION = "1.2.0";
const ENCODER_INTEGRITY =
  "sha512-davRZeIJbxJrE24cwQle7ZDsxjdk/OphNOV83oX+efQinyoHY9Jcyz3MHbaoG0qySZajldGztNZ1RN/T19PZsg==";
const ENCODER_PROVENANCE = `meshoptimizer ${ENCODER_PACKAGE_VERSION} is recorded as provenance; generation and verification hard-fail on an installed-version mismatch, and benchmarks never invoke this generator.`;
const execFileAsync = promisify(execFile);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "../../..");
const FIXTURE_DIRECTORY = join(
  REPOSITORY_ROOT,
  "Specs",
  "Data",
  "Performance",
  "Decompression",
  "meshopt",
);
const MANIFEST_PATH = join(FIXTURE_DIRECTORY, "manifest.json");
const ENCODER_PACKAGE_MANIFEST_PATH = join(
  REPOSITORY_ROOT,
  "node_modules",
  "meshoptimizer",
  "package.json",
);

const OCTAHEDRAL_INPUTS = [
  [1, 0, 0, 0],
  [-1, 0, 0, 1],
  [0, 1, 0, -1],
  [0, -1, 0, 0],
  [0, 0, 1, 1],
  [0, 0, -1, -1],
  [0.70710677, 0.70710677, 0, 0.5],
  [-0.70710677, 0.70710677, 0, -0.5],
  [0.70710677, 0, 0.70710677, 0.25],
  [0, -0.70710677, 0.70710677, -0.25],
];

const QUATERNION_INPUTS = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
  [0.70710677, 0.70710677, 0, 0],
  [0.70710677, 0, 0.70710677, 0],
  [0.70710677, 0, 0, 0.70710677],
  [0.5, 0.5, 0.5, 0.5],
];

const EXPONENTIAL_INPUTS = [
  [1, -2, 4, -8],
  [0.5, -4, 8, -16],
  [16, -0.25, 2, -32],
  [32, -1, 0.125, -0.0625],
  [3, -6, 12, -24],
  [0.75, -1.5, 6, -12],
];

const FIXTURES = [
  {
    id: "attributes-small-none",
    filename: "attributes-small-none.bin",
    tier: "small",
    mode: "ATTRIBUTES",
    filter: "NONE",
    count: 256,
    byteStride: 16,
    target: 34962,
    source: {
      recipe: "raw-uint32-interleaved",
      seed: 0x13579bdf,
      components: 4,
      componentType: "UNSIGNED_INT",
    },
  },
  {
    id: "attributes-medium-none",
    filename: "attributes-medium-none.bin",
    tier: "medium",
    mode: "ATTRIBUTES",
    filter: "NONE",
    count: 4096,
    byteStride: 16,
    target: 34962,
    source: {
      recipe: "raw-uint32-interleaved",
      seed: 0x2468ace0,
      components: 4,
      componentType: "UNSIGNED_INT",
    },
  },
  {
    id: "attributes-medium-octahedral",
    filename: "attributes-medium-octahedral.bin",
    tier: "medium",
    mode: "ATTRIBUTES",
    filter: "OCTAHEDRAL",
    count: 4096,
    byteStride: 8,
    target: 34962,
    source: {
      recipe: "octahedral-vectors",
      seed: 0x10203040,
      components: 4,
      componentType: "SHORT",
      normalized: true,
      filterBits: 8,
    },
  },
  {
    id: "attributes-medium-quaternion",
    filename: "attributes-medium-quaternion.bin",
    tier: "medium",
    mode: "ATTRIBUTES",
    filter: "QUATERNION",
    count: 4096,
    byteStride: 8,
    target: 34962,
    source: {
      recipe: "unit-quaternions",
      seed: 0x55667788,
      components: 4,
      componentType: "SHORT",
      normalized: true,
      filterBits: 12,
    },
  },
  {
    id: "attributes-large-none",
    filename: "attributes-large-none.bin",
    tier: "large",
    mode: "ATTRIBUTES",
    filter: "NONE",
    count: 32768,
    byteStride: 16,
    target: 34962,
    source: {
      recipe: "raw-uint32-interleaved",
      seed: 0x89abcdef,
      components: 4,
      componentType: "UNSIGNED_INT",
    },
  },
  {
    id: "attributes-large-exponential",
    filename: "attributes-large-exponential.bin",
    tier: "large",
    mode: "ATTRIBUTES",
    filter: "EXPONENTIAL",
    count: 32768,
    byteStride: 16,
    target: 34962,
    source: {
      recipe: "exponential-vectors",
      seed: 0x31415926,
      components: 4,
      componentType: "FLOAT",
      filterBits: 15,
      filterMode: "SharedVector",
    },
  },
  {
    id: "triangles-small-u16",
    filename: "triangles-small-u16.bin",
    tier: "small",
    mode: "TRIANGLES",
    filter: "NONE",
    count: 768,
    byteStride: 2,
    target: 34963,
    source: {
      recipe: "triangle-indexes",
      seed: 0x0badcafe,
      componentType: "UNSIGNED_SHORT",
      components: 1,
      vertexCount: 4096,
    },
  },
  {
    id: "triangles-medium-u16",
    filename: "triangles-medium-u16.bin",
    tier: "medium",
    mode: "TRIANGLES",
    filter: "NONE",
    count: 12288,
    byteStride: 2,
    target: 34963,
    source: {
      recipe: "triangle-indexes",
      seed: 0x1badb002,
      componentType: "UNSIGNED_SHORT",
      components: 1,
      vertexCount: 32768,
    },
  },
  {
    id: "triangles-large-u32",
    filename: "triangles-large-u32.bin",
    tier: "large",
    mode: "TRIANGLES",
    filter: "NONE",
    count: 49152,
    byteStride: 4,
    target: 34963,
    source: {
      recipe: "triangle-indexes",
      seed: 0x5eed1234,
      componentType: "UNSIGNED_INT",
      components: 1,
      vertexCount: 131072,
    },
  },
  {
    id: "indices-small-u16",
    filename: "indices-small-u16.bin",
    tier: "small",
    mode: "INDICES",
    filter: "NONE",
    count: 1024,
    byteStride: 2,
    target: 34963,
    source: {
      recipe: "index-sequence",
      seed: 0x12344321,
      componentType: "UNSIGNED_SHORT",
      components: 1,
      vertexCount: 4096,
    },
  },
  {
    id: "indices-medium-u16",
    filename: "indices-medium-u16.bin",
    tier: "medium",
    mode: "INDICES",
    filter: "NONE",
    count: 16384,
    byteStride: 2,
    target: 34963,
    source: {
      recipe: "index-sequence",
      seed: 0x45677654,
      componentType: "UNSIGNED_SHORT",
      components: 1,
      vertexCount: 32768,
    },
  },
  {
    id: "indices-large-u32",
    filename: "indices-large-u32.bin",
    tier: "large",
    mode: "INDICES",
    filter: "NONE",
    count: 65536,
    byteStride: 4,
    target: 34963,
    source: {
      recipe: "index-sequence",
      seed: 0x7899abcd,
      componentType: "UNSIGNED_INT",
      components: 1,
      vertexCount: 262144,
    },
  },
];

function bytes(view) {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function hash32(value) {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
}

function createRawAttributes(spec) {
  const source = new Uint8Array(spec.count * spec.byteStride);
  const view = new DataView(source.buffer);
  const seed = spec.source.seed;

  for (let index = 0; index < spec.count; ++index) {
    const offset = index * spec.byteStride;
    view.setUint32(
      offset,
      hash32(seed + Math.imul(index, 0x9e3779b9)),
      true,
    );
    view.setUint32(
      offset + 4,
      hash32(seed + Math.imul(index, 0x85ebca6b)),
      true,
    );
    view.setUint32(
      offset + 8,
      hash32(seed + Math.imul(index, 0xc2b2ae35)),
      true,
    );
    view.setUint32(
      offset + 12,
      hash32(seed + Math.imul(index, 0x27d4eb2f)),
      true,
    );
  }

  return source;
}

function createFilterInput(spec, inputs) {
  const source = new Float32Array(spec.count * 4);
  const seed = spec.source.seed;

  for (let index = 0; index < spec.count; ++index) {
    const input = inputs[hash32(seed + index) % inputs.length];
    source.set(input, index * 4);
  }

  return source;
}

function createFilteredAttributes(spec) {
  const bits = spec.source.filterBits;
  let source;

  if (spec.filter === "OCTAHEDRAL") {
    source = createFilterInput(spec, OCTAHEDRAL_INPUTS);
    return MeshoptEncoder.encodeFilterOct(
      source,
      spec.count,
      spec.byteStride,
      bits,
    );
  }

  if (spec.filter === "QUATERNION") {
    source = createFilterInput(spec, QUATERNION_INPUTS);
    return MeshoptEncoder.encodeFilterQuat(
      source,
      spec.count,
      spec.byteStride,
      bits,
    );
  }

  if (spec.filter === "EXPONENTIAL") {
    source = createFilterInput(spec, EXPONENTIAL_INPUTS);
    return MeshoptEncoder.encodeFilterExp(
      source,
      spec.count,
      spec.byteStride,
      bits,
      spec.source.filterMode,
    );
  }

  throw new Error(`Unsupported attribute filter: ${spec.filter}`);
}

function createIndexBytes(spec, values) {
  const source = new ArrayBuffer(spec.count * spec.byteStride);
  const view = new DataView(source);

  for (let index = 0; index < values.length; ++index) {
    if (spec.byteStride === 2) {
      view.setUint16(index * 2, values[index], true);
    } else {
      view.setUint32(index * 4, values[index], true);
    }
  }

  return new Uint8Array(source);
}

function createTriangleIndexes(spec) {
  const values = new Array(spec.count);
  const { seed, vertexCount } = spec.source;
  const triangleCount = spec.count / 3;
  const usableVertexCount = vertexCount - 32;

  for (let triangle = 0; triangle < triangleCount; ++triangle) {
    const base =
      hash32(seed + Math.imul(triangle, 0x9e3779b9)) % usableVertexCount;
    const first = base;
    const second = base + 1 + (hash32(seed + triangle * 3) % 7);
    const third = base + 8 + (hash32(seed + triangle * 5) % 23);

    values[triangle * 3] = first;
    values[triangle * 3 + 1] = second;
    values[triangle * 3 + 2] = third;
  }

  return createIndexBytes(spec, values);
}

function createIndexSequence(spec) {
  const values = new Array(spec.count);
  const { seed, vertexCount } = spec.source;

  for (let index = 0; index < spec.count; ++index) {
    const block = index >> 5;
    const local = index & 31;
    const jitter = hash32(seed + block) % 9;
    values[index] =
      (block * 97 + local * 3 + jitter + (index >> 9) * 11) % vertexCount;
  }

  return createIndexBytes(spec, values);
}

function createSource(spec) {
  if (spec.mode === "ATTRIBUTES") {
    return spec.filter === "NONE"
      ? createRawAttributes(spec)
      : createFilteredAttributes(spec);
  }

  if (spec.mode === "TRIANGLES") {
    return createTriangleIndexes(spec);
  }

  if (spec.mode === "INDICES") {
    return createIndexSequence(spec);
  }

  throw new Error(`Unsupported meshopt mode: ${spec.mode}`);
}

function createEncodedFixture(spec) {
  // The source bytes passed to encodeGltfBuffer are the deterministic expected
  // decoded bytes for this fixture. Decode correctness is authoritative only
  // when a future Cesium TaskProcessor/GltfBufferViewLoader harness exercises
  // the committed stream through production code.
  const source = createSource(spec);
  const encoded = MeshoptEncoder.encodeGltfBuffer(
    source,
    spec.count,
    spec.byteStride,
    spec.mode,
    ENCODE_VERSION,
  );

  return { encoded, source };
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; ++index) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function createEncoderMetadata(spec, encoderPackageVersion) {
  let filter;

  if (spec.filter === "OCTAHEDRAL" || spec.filter === "QUATERNION") {
    filter = {
      api:
        spec.filter === "OCTAHEDRAL"
          ? "MeshoptEncoder.encodeFilterOct"
          : "MeshoptEncoder.encodeFilterQuat",
      bits: spec.source.filterBits,
    };
  } else if (spec.filter === "EXPONENTIAL") {
    filter = {
      api: "MeshoptEncoder.encodeFilterExp",
      bits: spec.source.filterBits,
      mode: spec.source.filterMode,
    };
  } else {
    filter = null;
  }

  return {
    package: "meshoptimizer",
    packageVersion: encoderPackageVersion,
    api: "MeshoptEncoder.encodeGltfBuffer",
    mode: spec.mode,
    level: ENCODE_LEVEL,
    version: ENCODE_VERSION,
    filter,
  };
}

function createDecoderMetadata(spec) {
  return {
    worker: "packages/engine/Source/Workers/decodeMeshopt.js",
    mode: spec.mode,
    filter: spec.filter,
    count: spec.count,
    byteStride: spec.byteStride,
  };
}

function createLayoutMetadata(spec) {
  return {
    componentType: spec.source.componentType,
    components: spec.source.components,
    normalized: spec.source.normalized ?? false,
    endianness: "little",
  };
}

function getFilterInputTable(spec) {
  if (spec.filter === "OCTAHEDRAL") {
    return OCTAHEDRAL_INPUTS;
  }
  if (spec.filter === "QUATERNION") {
    return QUATERNION_INPUTS;
  }
  if (spec.filter === "EXPONENTIAL") {
    return EXPONENTIAL_INPUTS;
  }
  return undefined;
}

function createInputDescriptor(spec, encoderPackageVersion) {
  const inline = {
    recipeVersion: 1,
    source: spec.source,
  };
  const filterInputTable = getFilterInputTable(spec);
  if (filterInputTable !== undefined) {
    inline.filterInputTable = filterInputTable;
  }

  const sourceFiles = [];
  const options = {
    mode: spec.mode,
    filter: spec.filter,
    count: spec.count,
    byteStride: spec.byteStride,
    target: spec.target,
    encoder: createEncoderMetadata(spec, encoderPackageVersion),
    decoder: createDecoderMetadata(spec),
    layout: createLayoutMetadata(spec),
  };
  const descriptor = {
    sourceFiles,
    inline,
    options,
  };

  return {
    ...descriptor,
    inputSha256: sha256(Buffer.from(canonicalJson(descriptor), "utf8")),
  };
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

function createExpectedDecodedMetadata(spec, source) {
  const format =
    spec.mode === "ATTRIBUTES"
      ? `little-endian interleaved ${spec.count} records of ${spec.byteStride} bytes`
      : `little-endian ${spec.count} ${spec.source.componentType} indices`;

  // The meshopt filter transforms are part of the production decoder
  // contract. Their decoded bytes are recorded from Cesium's production
  // worker rather than from the encoder's pre-filter source buffer.
  const productionDecodedSha256 = {
    "attributes-medium-octahedral":
      "e4bf381506924ce8536ec8f8dbfebb58dea4a73704aeb2743d7eb2d4c33f5f54",
    "attributes-medium-quaternion":
      "b72a63fbcdad8fee01e99f93339192d0f6fa44ffd082c94bc62721fe9cc77a54",
    "attributes-large-exponential":
      "0a0076742c01b3bed6aa9936f5f03c9e2cb53010c440cf3ee0e6d91c4a17904f",
  }[spec.id];

  return {
    sizeBytes: source.byteLength,
    sha256: productionDecodedSha256 ?? sha256(source),
    format,
    summary: {
      mode: spec.mode,
      filter: spec.filter,
      count: spec.count,
      byteStride: spec.byteStride,
      target: spec.target,
      layout: createLayoutMetadata(spec),
      sourceRecipe: spec.source.recipe,
    },
  };
}

function createFixtureEntry(
  spec,
  encoded,
  source,
  encoderPackageVersion,
) {
  const compressed = {
    sizeBytes: encoded.byteLength,
    sha256: sha256(encoded),
  };

  return {
    id: spec.id,
    path: spec.filename,
    compressed,
    inputs: createInputDescriptor(spec, encoderPackageVersion),
    expectedDecoded: createExpectedDecodedMetadata(spec, source),
    metadata: {
      tier: spec.tier,
      mode: spec.mode,
      filter: spec.filter,
      count: spec.count,
      byteStride: spec.byteStride,
      target: spec.target,
      compressedByteSize: compressed.sizeBytes,
      decodedByteSize: source.byteLength,
      encoder: createEncoderMetadata(spec, encoderPackageVersion),
      decoder: createDecoderMetadata(spec),
      layout: createLayoutMetadata(spec),
      source: spec.source,
    },
  };
}

function createGeneratorSourceFile(sourceBytes) {
  return {
    path: relative(REPOSITORY_ROOT, SCRIPT_PATH).replaceAll("\\", "/"),
    sizeBytes: sourceBytes.byteLength,
    sha256: sha256(sourceBytes),
  };
}

async function readEncoderPackageVersion() {
  const packageJson = JSON.parse(
    await readFile(ENCODER_PACKAGE_MANIFEST_PATH, "utf8"),
  );
  if (typeof packageJson.version !== "string") {
    throw new Error(
      `Missing meshoptimizer version in ${ENCODER_PACKAGE_MANIFEST_PATH}`,
    );
  }
  if (packageJson.version !== ENCODER_PACKAGE_VERSION) {
    throw new Error(
      `Installed meshoptimizer ${packageJson.version} does not match required ${ENCODER_PACKAGE_VERSION}`,
    );
  }
  return packageJson.version;
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
  entries,
  encoderPackageVersion,
  generatorSourceFile,
  runtime,
) {
  return {
    $schema: "../fixture-manifest.schema.json",
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    codec: "meshopt",
    encoder: {
      package: "meshoptimizer",
      version: encoderPackageVersion,
      integrity: ENCODER_INTEGRITY,
    },
    generator: {
      name: "Cesium meshopt benchmark fixture generator",
      version: GENERATOR_VERSION,
      schemaVersion: GENERATOR_SCHEMA_VERSION,
      sourceFiles: [generatorSourceFile],
    },
    runtime,
    metadata: {
      encoderProvenance: ENCODER_PROVENANCE,
      expectedDecoded:
        "SHA-256 is derived from deterministic source bytes for unfiltered fixtures and from Cesium production-worker output for filtered fixtures.",
      validationAuthority:
        "Cesium production TaskProcessor/GltfBufferViewLoader benchmark harness.",
    },
    fixtures: entries,
  };
}

async function generateFixtures(
  encoderPackageVersion,
  generatorSourceFile,
  runtime,
) {
  const generated = [];
  for (const spec of FIXTURES) {
    const { encoded, source } = createEncodedFixture(spec);
    generated.push({
      spec,
      encoded,
      manifestEntry: createFixtureEntry(
        spec,
        encoded,
        source,
        encoderPackageVersion,
      ),
    });
  }

  await mkdir(FIXTURE_DIRECTORY, { recursive: true });
  for (const fixture of generated) {
    await writeFile(join(FIXTURE_DIRECTORY, fixture.spec.filename), fixture.encoded);
  }

  const manifest = createManifest(
    generated.map((fixture) => fixture.manifestEntry),
    encoderPackageVersion,
    generatorSourceFile,
    runtime,
  );
  await writeFile(
    MANIFEST_PATH,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return generated;
}

async function verifyFixtures(encoderPackageVersion, generatorSourceFile) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read committed meshopt manifest: ${error}`);
  }

  if (
    manifest.$schema !== "../fixture-manifest.schema.json" ||
    manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    manifest.codec !== "meshopt" ||
    manifest.encoder?.package !== "meshoptimizer" ||
    manifest.encoder?.version !== encoderPackageVersion ||
    manifest.encoder?.integrity !== ENCODER_INTEGRITY ||
    manifest.generator?.name !== "Cesium meshopt benchmark fixture generator" ||
    manifest.generator?.version !== GENERATOR_VERSION ||
    manifest.generator?.schemaVersion !== GENERATOR_SCHEMA_VERSION ||
    JSON.stringify(manifest.generator?.sourceFiles) !==
      JSON.stringify([generatorSourceFile]) ||
    typeof manifest.runtime?.nodeVersion !== "string" ||
    typeof manifest.runtime?.packageManager !== "string" ||
    manifest.metadata?.expectedDecoded !==
      "SHA-256 is derived from deterministic source bytes for unfiltered fixtures and from Cesium production-worker output for filtered fixtures." ||
    manifest.metadata?.encoderProvenance !== ENCODER_PROVENANCE ||
    manifest.metadata?.validationAuthority !==
      "Cesium production TaskProcessor/GltfBufferViewLoader benchmark harness."
  ) {
    throw new Error("Committed meshopt manifest provenance is out of date");
  }

  const entriesById = new Map(
    (manifest.fixtures ?? []).map((entry) => [entry.id, entry]),
  );
  if (entriesById.size !== FIXTURES.length) {
    throw new Error("Committed meshopt manifest has an unexpected fixture set");
  }

  for (const spec of FIXTURES) {
    const entry = entriesById.get(spec.id);
    if (!entry) {
      throw new Error(`Missing manifest entry for ${spec.id}`);
    }

    const { encoded, source } = createEncodedFixture(spec);
    const expectedEntry = createFixtureEntry(
      spec,
      encoded,
      source,
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
      if (JSON.stringify(entry[key]) !== JSON.stringify(expectedEntry[key])) {
        throw new Error(`Manifest metadata does not match ${spec.id}`);
      }
    }

    const committed = await readFile(join(FIXTURE_DIRECTORY, entry.path));
    if (
      sha256(committed) !== entry.compressed.sha256 ||
      !bytesEqual(committed, encoded)
    ) {
      throw new Error(`Committed bytes do not match manifest for ${spec.id}`);
    }
  }
}

function printUsage() {
  console.log(
    "Usage: node Tools/benchmark/meshopt/generateFixtures.mjs [--verify]",
  );
  console.log("Without --verify, regenerate the committed meshopt fixtures.");
  console.log("--verify checks generated bytes and committed SHA-256 values.");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    printUsage();
    return;
  }

  const unknownArguments = [...args].filter(
    (argument) => argument !== "--verify",
  );
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument: ${unknownArguments[0]}`);
  }

  if (!MeshoptEncoder.supported) {
    throw new Error("meshoptimizer WebAssembly is not supported");
  }

  await MeshoptEncoder.ready;
  const encoderPackageVersion = await readEncoderPackageVersion();
  const generatorSourceFile = createGeneratorSourceFile(
    await readFile(SCRIPT_PATH),
  );

  if (args.has("--verify")) {
    await verifyFixtures(encoderPackageVersion, generatorSourceFile);
    console.log(`Verified ${FIXTURES.length} meshopt fixtures.`);
  } else {
    const runtime = await readRuntimeMetadata();
    await generateFixtures(
      encoderPackageVersion,
      generatorSourceFile,
      runtime,
    );
    console.log(`Generated ${FIXTURES.length} meshopt fixtures.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
