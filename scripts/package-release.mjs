import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

// Every public package releases together at one shared version, in dependency order
// (dependencies publish before the packages that require them).
export const releasePackages = [
  "packages/sdk",
  "packages/cli",
  "packages/contrib-search-compat",
  "packages/contrib-algolia-server",
  "packages/contrib-astro",
];

export function verifyPackageIntegrity(tarball, registryRecord) {
  const expected = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (registryRecord.dist?.integrity !== expected) throw new Error("Published package integrity does not match the verified tarball");
  return expected;
}

export function nextVersion(current, bump) {
  if (!/^\d+\.\d+\.\d+$/.test(current)) throw new Error("Expected a stable semver version");
  const [major, minor, patch] = current.split(".").map(Number);
  const version = { patch: `${major}.${minor}.${patch + 1}`, minor: `${major}.${minor + 1}.0`, major: `${major + 1}.0.0` }[bump] ?? bump;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Use patch, minor, major, or a stable semver version");
  const parts = version.split(".").map(Number);
  const previous = [major, minor, patch];
  const changed = parts.findIndex((part, index) => part !== previous[index]);
  if (changed < 0 || parts[changed] < previous[changed]) throw new Error("Release version must increase");
  return version;
}

export function checkRelease(root, tag) {
  const manifests = releasePackages.map((directory) => JSON.parse(readFileSync(new URL(`${directory}/package.json`, root), "utf8")));
  const version = manifests[0].version;
  if (manifests.some((manifest) => manifest.version !== version)) throw new Error("All release package versions must match");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a stable semver version");
  if (tag && tag !== `v${version}`) throw new Error(`Expected tag v${version}, received ${tag}`);
  for (const manifest of manifests) {
    if (manifest.private || manifest.publishConfig?.access !== "public") throw new Error(`${manifest.name} must be configured for public publishing`);
  }
  return { manifests, version };
}

function main() {
  const root = new URL("../", import.meta.url);
  const [command, argument] = process.argv.slice(2);
  if (command === "list") {
    console.log(releasePackages.join("\n"));
    return;
  }
  if (command === "integrity") {
    verifyPackageIntegrity(readFileSync(argument), JSON.parse(readFileSync(process.argv[4], "utf8")));
    console.log("Published package integrity matches the verified tarball.");
    return;
  }
  const { manifests, version } = checkRelease(root, command === "check" ? argument : undefined);
  if (command === "prepare") {
    const updated = nextVersion(version, argument ?? "patch");
    manifests.forEach((manifest, index) => {
      manifest.version = updated;
      writeFileSync(new URL(`${releasePackages[index]}/package.json`, root), `${JSON.stringify(manifest, null, 2)}\n`);
    });
    console.log(`Prepared v${updated}. Review and commit the versions, merge to main, then run pnpm release:tag.`);
  } else if (command === "tag") {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    if (git("branch", "--show-current") !== "main") throw new Error("Tag releases from main after merging the release PR");
    if (git("status", "--porcelain")) throw new Error("Commit all changes before tagging");
    git("fetch", "origin", "main");
    if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) throw new Error("Local main must match origin/main");
    git("tag", "-a", `v${version}`, "-m", `Release npm packages v${version}`);
    console.log(`Created v${version}. Run git push origin v${version} to publish through CI.`);
  } else if (command === "check") {
    console.log(`Release v${version}: ${manifests.map((manifest) => manifest.name).join(", ")}`);
  } else {
    throw new Error("Usage: package-release.mjs prepare [patch|minor|major|version] | check [tag] | tag | list | integrity <tarball> <registry-json>");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
