import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFixturePath, thirdPartyFixtureDir } from "./fixture-paths.js";

describe("resolveFixturePath", () => {
  it("prefers the tracked fixture, falls back to the fetched cache, and returns undefined when absent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fx-"));
    const manifestDir = path.join(root, "manifest");
    mkdirSync(manifestDir);
    writeFileSync(path.join(manifestDir, "tracked.pdf"), "x");
    const cache = thirdPartyFixtureDir(root, {});
    mkdirSync(path.join(cache, "sub"), { recursive: true });
    writeFileSync(path.join(cache, "sub", "fetched.pdf"), "x");

    expect(resolveFixturePath(manifestDir, "tracked.pdf", root, {})).toBe(path.join(manifestDir, "tracked.pdf"));
    expect(resolveFixturePath(manifestDir, "sub/fetched.pdf", root, {})).toBe(path.join(cache, "sub", "fetched.pdf"));
    expect(resolveFixturePath(manifestDir, "missing.pdf", root, {})).toBeUndefined();
  });

  it("honours DOCSLURP_CACHE_DIR", () => {
    expect(thirdPartyFixtureDir("/repo", { DOCSLURP_CACHE_DIR: "/c" })).toBe(path.join("/c", "fixtures", "pdf"));
  });
});
