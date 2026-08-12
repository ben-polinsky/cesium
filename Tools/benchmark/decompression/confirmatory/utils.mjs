export {
  buildVariant,
  hashFiles,
  releaseBuild,
  requireArtifacts,
  verifyVariant,
  workerArtifactFiles,
} from "../shared/worktree-utils.mjs";

// Shared experiment definition and reproducibility checks. This module contains
// no timing code; it establishes which commits, scenarios, builds, and ordering
// are valid before the browser is allowed to collect a sample.

// The candidate is the PR head and the baseline is the commit the PR is
// actually based on. Using fork-main instead of the merge base would fold
// unrelated model/rendering changes into the measured delta.
export const defaultCandidateRef = "7e620929194becfe04c5ad019c030159cfe0aa34";
export const defaultBaselineRef = "6d5d8b1f0725b6f831b336463f4b11c98023427b";

// These fixtures use Cesium's public loaders and are already committed test
// data. The two Meshopt models measure first-use readiness; the larger SPZ
// fixture also provides a long enough decode to observe frame continuity.
export const scenarios = Object.freeze([
  {
    id: "meshopt-model-unit-square",
    type: "model",
    url: "Specs/Data/Models/glTF-2.0/unitSquare/unitSquare11x11_meshopt.glb",
  },
  {
    id: "meshopt-model-meshopt-cube-test",
    type: "model",
    url: "Specs/Data/Models/glTF-2.0/MeshoptCubeTest/glTF-Meshopt/MeshoptCubeTest.gltf",
  },
  {
    id: "spz-tiles-tower",
    type: "tileset",
    url: "Specs/Data/Cesium3DTiles/GaussianSplats/tower/tileset.json",
  },
]);

function value(argumentsList, index, name) {
  const argument = argumentsList[index];
  if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
  const result = argumentsList[index + 1];
  if (!result || result.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return result;
}

export function parseConfirmatoryArguments(argumentsList) {
  const options = {
    candidate: undefined,
    baseline: undefined,
    candidateRef: defaultCandidateRef,
    baselineRef: defaultBaselineRef,
    output: "Build/Performance/Decompression/confirmatory.json",
    port: 8091,
    headed: false,
    skipBuild: false,
    help: false,
  };
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--headed") options.headed = true;
    else if (argument === "--skip-build") options.skipBuild = true;
    else if (
      argument === "--candidate" ||
      argument.startsWith("--candidate=")
    ) {
      options.candidate = value(argumentsList, index, "--candidate");
      if (argument === "--candidate") index++;
    } else if (
      argument === "--baseline" ||
      argument.startsWith("--baseline=")
    ) {
      options.baseline = value(argumentsList, index, "--baseline");
      if (argument === "--baseline") index++;
    } else if (
      argument === "--candidate-ref" ||
      argument.startsWith("--candidate-ref=")
    ) {
      options.candidateRef = value(argumentsList, index, "--candidate-ref");
      if (argument === "--candidate-ref") index++;
    } else if (
      argument === "--baseline-ref" ||
      argument.startsWith("--baseline-ref=")
    ) {
      options.baselineRef = value(argumentsList, index, "--baseline-ref");
      if (argument === "--baseline-ref") index++;
    } else if (argument === "--output" || argument.startsWith("--output=")) {
      options.output = value(argumentsList, index, "--output");
      if (argument === "--output") index++;
    } else if (argument === "--port" || argument.startsWith("--port=")) {
      options.port = Number(value(argumentsList, index, "--port"));
      if (argument === "--port") index++;
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.help && (!options.candidate || !options.baseline)) {
    throw new Error("--candidate and --baseline are required");
  }
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return options;
}

// Alternate AB/BA every block. Splitting the run into a candidate-first half
// and a baseline-first half balances the totals but confounds variant order
// with elapsed time, browser warming, and thermal drift.
export function pairedOrders() {
  return Array.from({ length: 12 }, (_, block) => ({
    block,
    order:
      block % 2 === 0 ? ["candidate", "baseline"] : ["baseline", "candidate"],
  }));
}
