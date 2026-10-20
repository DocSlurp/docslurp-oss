import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createCommandScratch, landrunArgs, resolveExecutable } from "../providers/landlock/index.js";

describe("landrunArgs", () => {
  const args = landrunArgs({ binary: "pdfinfo", args: ["a.pdf"], env: {}, readablePaths: [], writablePaths: [] });
  const roGrant = args[args.indexOf("--ro") + 1] ?? "";

  it("grants the fontconfig cache read-only when it exists", () => {
    if (!existsSync("/var/cache/fontconfig")) return;
    expect(roGrant.split(",")).toContain("/var/cache/fontconfig");
    expect(args).not.toContain("--rw");
  });

  it("omits the fontconfig cache when it does not exist", () => {
    if (existsSync("/var/cache/fontconfig")) return;
    expect(args.join(" ")).not.toContain("/var/cache/fontconfig");
  });
});

describe("landrun grants", () => {
  it("refuses a grant path containing a comma instead of splitting it", () => {
    expect(() =>
      landrunArgs({ binary: "/usr/bin/true", args: [], env: {}, readablePaths: ["/tmp/a,b"], writablePaths: [] }),
    ).toThrow("landrun cannot grant a path containing a comma: /tmp/a,b");
  });
});

describe("landrun binary resolution", () => {
  it("resolves a bare name against PATH to an absolute executable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "landrun-path-"));
    try {
      const binary = path.join(dir, "landrun");
      writeFileSync(binary, "#!/bin/sh\n");
      chmodSync(binary, 0o755);
      expect(resolveExecutable("landrun", `/nonexistent${path.delimiter}${dir}`)).toBe(binary);
      expect(resolveExecutable("./relative/landrun", "")).toBe(path.resolve("relative/landrun"));
      expect(resolveExecutable("landrun", "/nonexistent")).toBe("landrun");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("landlock command scratch", () => {
  it("creates the launcher's private HOME, TMPDIR and XDG directories under the scratch root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "landlock-scratch-"));
    try {
      const scratch = createCommandScratch(path.join(root, "nested"));
      expect(Object.keys(scratch.env).sort()).toEqual(
        ["HOME", "TEMP", "TMP", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"],
      );
      for (const dir of [...Object.values(scratch.env), scratch.cwd]) {
        expect(dir.startsWith(`${scratch.dir}${path.sep}`)).toBe(true);
        expect(existsSync(dir)).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
