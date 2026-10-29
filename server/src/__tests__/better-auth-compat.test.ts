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

  it("knows every native call that hashes a password", () => {
    // Reviewed against the release: each is either a new password (checked by
    // BREACHED_PASSWORD_PATHS) or a timing-equalising hash during verification.
    // admin, username and phone-number are not registered here.
    const reviewed: Record<string, number> = {
      "api/routes/sign-up.mjs": 2, // new password; duplicate-address timing hash on the same path
      "api/routes/password.mjs": 1, // /reset-password (disabled)
      "api/routes/update-user.mjs": 2, // /change-password, /set-password
      "api/routes/sign-in.mjs": 2, // timing only
      "utils/password.mjs": 1, // checkPassword timing only
      "plugins/email-otp/routes.mjs": 1, // /email-otp/reset-password
      "plugins/admin/routes.mjs": 2,
      "plugins/username/index.mjs": 1,
      "plugins/phone-number/routes.mjs": 1,
    };
    const dist = join(serverRoot, "node_modules/better-auth/dist");
    const found: Record<string, number> = {};
    for (const file of readdirSync(dist, { recursive: true }) as string[]) {
      if (!file.endsWith(".mjs")) continue;
      const calls = readFileSync(join(dist, file), "utf8").match(/password\.hash\(/g)?.length ?? 0;
      if (calls) found[file.split("\\").join("/")] = calls;
    }
    expect(found).toEqual(reviewed);
    const passkeyDist = join(serverRoot, "node_modules/@better-auth/passkey/dist");
    const passkeyCalls = (readdirSync(passkeyDist, { recursive: true }) as string[]).filter((file) => file.endsWith(".mjs") && /password\.hash\(/.test(readFileSync(join(passkeyDist, file), "utf8")));
    expect(passkeyCalls).toEqual([]);
  });

  it("refuses any other release", () => {
    expect(() => assertReviewedBetterAuth("test seam", REVIEWED_BETTER_AUTH_VERSION)).not.toThrow();
    expect(() => assertReviewedBetterAuth("test seam", "1.8.0")).toThrow(/test seam: Better Auth 1\.8\.0 has not been reviewed/);
    expect(() => assertReviewedBetterAuth("test seam", undefined)).toThrow(/\(unknown\)/);
  });
});
