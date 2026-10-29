import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertReviewedBetterAuth, REVIEWED_BETTER_AUTH_VERSION } from "../lib/auth-compat.js";

const serverRoot = join(import.meta.dirname, "../..");
const coreRoot = join(serverRoot, "..");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, string> | undefined>;
const isBetterAuth = (name: string) => name === "better-auth" || name.startsWith("@better-auth/");
// Separately versioned helpers the family depends on; not part of the release train.
const separatelyVersioned = new Set(["@better-auth/utils"]);

/**
 * The upgrade contract (docs/better-auth-upgrade-contract.md): the family moves
 * together, exactly pinned, and only after the seams have been re-reviewed.
 */
describe("Better Auth upgrade contract", () => {
  const manifests = ["package.json", "server/package.json", ...readdirSync(join(coreRoot, "packages")).map((name) => `packages/${name}/package.json`)]
    .flatMap((path) => { try { return [{ path, json: readJson(join(coreRoot, path)) }]; } catch { return []; } });

  it("pins every Better Auth package to the reviewed release", () => {
    const specs = manifests.flatMap(({ path, json }) => ["dependencies", "devDependencies", "peerDependencies"].flatMap((field) =>
      Object.entries(json[field] ?? {}).filter(([name]) => isBetterAuth(name) && !separatelyVersioned.has(name)).map(([name, spec]) => `${path} ${name}@${spec}`)));
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((spec) => !spec.endsWith(`@${REVIEWED_BETTER_AUTH_VERSION}`))).toEqual([]);
  });

  it("installs the reviewed release of every package the server declares", () => {
    const declared = Object.keys(readJson(join(serverRoot, "package.json")).dependencies ?? {}).filter((name) => isBetterAuth(name) && !separatelyVersioned.has(name));
    const installed = declared.map((name) => `${name}@${readJson(join(serverRoot, "node_modules", name, "package.json")).version}`);
    expect(installed).toEqual(declared.map((name) => `${name}@${REVIEWED_BETTER_AUTH_VERSION}`));
  });

  it("names the reviewed release and every guarded seam in the upgrade inventory", () => {
    const inventory = readFileSync(join(coreRoot, "docs/better-auth-upgrade-contract.md"), "utf8");
    expect(inventory).toContain(`\`${REVIEWED_BETTER_AUTH_VERSION}\``);
    const libDir = join(serverRoot, "src/lib");
    const guarded = readdirSync(libDir).filter((file) => file.endsWith(".ts") && file !== "auth-compat.ts"
      && readFileSync(join(libDir, file), "utf8").includes("assertReviewedBetterAuth("));
    expect(guarded.length).toBeGreaterThan(0);
    expect(guarded.filter((file) => !inventory.includes(`server/src/lib/${file}`))).toEqual([]);
  });

  it("refuses any other release", () => {
    expect(() => assertReviewedBetterAuth("test seam", REVIEWED_BETTER_AUTH_VERSION)).not.toThrow();
    expect(() => assertReviewedBetterAuth("test seam", "1.8.0")).toThrow(/test seam: Better Auth 1\.8\.0 has not been reviewed/);
    expect(() => assertReviewedBetterAuth("test seam", undefined)).toThrow(/\(unknown\)/);
  });
});
