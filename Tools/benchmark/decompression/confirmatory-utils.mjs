import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

// The candidate is the PR head and the baseline is the commit the PR is
// actually based on. Using fork-main instead of the merge base would fold
// unrelated model/rendering changes into the measured delta.
export const defaultCandidateRef =
  "7e620929194becfe04c5ad019c030159cfe0aa34";
export const defaultBaselineRef =
  "6d5d8b1f0725b6f831b336463f4b11c98023427b";
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
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
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
    else if (argument === "--candidate" || argument.startsWith("--candidate=")) {
      options.candidate = value(argumentsList, index, "--candidate");
      if (argument === "--candidate") index++;
    } else if (argument === "--baseline" || argument.startsWith("--baseline=")) {
      options.baseline = value(argumentsList, index, "--baseline");
      if (argument === "--baseline") index++;
    } else if (argument === "--candidate-ref" || argument.startsWith("--candidate-ref=")) {
      options.candidateRef = value(argumentsList, index, "--candidate-ref");
      if (argument === "--candidate-ref") index++;
    } else if (argument === "--baseline-ref" || argument.startsWith("--baseline-ref=")) {
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
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
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
      block % 2 === 0
        ? ["candidate", "baseline"]
        : ["baseline", "candidate"],
  }));
}

function git(root, argumentsList) {
  return execFileSync("git", ["-C", root, ...argumentsList], { encoding: "utf8" }).trim();
}

export const requiredArtifacts = Object.freeze([
  "packages/engine/Build/Minified/index.js",
]);

// `gulp build --minify --workspace @cesium/engine` regenerates every artifact
// the confirmatory page serves: Build/Minified/index.js, Build/Workers, and
// Build/ThirdParty/Workers.
export const releaseBuild = Object.freeze({
  command: "npx",
  args: Object.freeze([
    "gulp",
    "build",
    "--minify",
    "--workspace",
    "@cesium/engine",
  ]),
  display: "npx gulp build --minify --workspace @cesium/engine",
  removedBeforeBuild: Object.freeze(["packages/engine/Build"]),
});

// The Build directory is gitignored, so a clean worktree does not prove the
// build output came from the current HEAD. Remove it and rebuild.
export async function buildVariant(root) {
  const resolved = path.resolve(root);
  for (const relative of releaseBuild.removedBeforeBuild) {
    await rm(path.join(resolved, relative), { force: true, recursive: true });
  }
  execFileSync(releaseBuild.command, [...releaseBuild.args], {
    cwd: resolved,
    stdio: "inherit",
  });
  return {
    command: releaseBuild.display,
    removedBeforeBuild: [...releaseBuild.removedBeforeBuild],
    freshlyBuilt: true,
  };
}

export async function requireArtifacts(root, files = requiredArtifacts) {
  const resolved = path.resolve(root);
  await Promise.all(
    files.map(async (file) => {
      try {
        await access(path.join(resolved, file));
      } catch {
        throw new Error(`${resolved} is missing built artifact ${file}`);
      }
    }),
  );
}

// Checks worktree identity only. Built artifacts are verified separately, after
// the rebuild, because the rebuild deletes them first.
export async function verifyVariant(root, expectedRef) {
  const resolved = path.resolve(root);
  if (git(resolved, ["status", "--porcelain"]).length !== 0) {
    throw new Error(`${resolved} is dirty; confirmatory runs require dirty:false`);
  }
  const commit = git(resolved, ["rev-parse", "HEAD"]);
  const expectedCommit = git(resolved, ["rev-parse", expectedRef]);
  if (commit !== expectedCommit) {
    throw new Error(`${resolved} is at ${commit}, not expected ${expectedRef} (${expectedCommit})`);
  }
  return { root: resolved, commit, expectedRef, dirty: false };
}

export async function hashFiles(root, files) {
  return Promise.all(
    files.map(async (file) => {
      const absolute = path.join(root, file);
      try {
        const bytes = await readFile(absolute);
        return {
          path: file,
          present: true,
          sizeBytes: (await stat(absolute)).size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      } catch (error) {
        if (error.code === "ENOENT") return { path: file, present: false };
        throw error;
      }
    }),
  );
}

export async function workerArtifactFiles(root, workerFiles) {
  const discovered = new Set(workerFiles);
  const pending = [...workerFiles];
  while (pending.length > 0) {
    const file = pending.pop();
    let source;
    try {
      source = await readFile(path.join(root, file), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const match of source.matchAll(/from["'](\.\/[^"']+)["']/g)) {
      const imported = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (!discovered.has(imported)) {
        discovered.add(imported);
        pending.push(imported);
      }
    }
  }
  return [...discovered].sort();
}
