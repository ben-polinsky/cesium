import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

function git(root, argumentsList) {
  return execFileSync("git", ["-C", root, ...argumentsList], {
    encoding: "utf8",
  }).trim();
}

export const requiredArtifacts = Object.freeze([
  "packages/engine/Build/Minified/index.js",
]);

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

export async function verifyVariant(root, expectedRef) {
  const resolved = path.resolve(root);
  if (git(resolved, ["status", "--porcelain"]).length !== 0) {
    throw new Error(`${resolved} is dirty; benchmark runs require dirty:false`);
  }
  const commit = git(resolved, ["rev-parse", "HEAD"]);
  const expectedCommit = git(resolved, ["rev-parse", expectedRef]);
  if (commit !== expectedCommit) {
    throw new Error(
      `${resolved} is at ${commit}, not expected ${expectedRef} (${expectedCommit})`,
    );
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
      const imported = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), match[1]),
      );
      if (!discovered.has(imported)) {
        discovered.add(imported);
        pending.push(imported);
      }
    }
  }
  return [...discovered].sort();
}
