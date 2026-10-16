import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { findWorkspaceRoot } from "./env.js";

describe("findWorkspaceRoot", () => {
  it("returns the outermost workspace when this repo is a core/ submodule", () => {
    const outer = mkdtempSync(join(tmpdir(), "ws-"));
    const core = join(outer, "core");
    const start = join(core, "server", "src");
    mkdirSync(start, { recursive: true });
    writeFileSync(join(outer, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(core, "pnpm-workspace.yaml"), "packages: []\n");
    expect(findWorkspaceRoot(start)).toBe(outer);
  });

  it("returns the only workspace in the standalone layout", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const start = join(root, "server", "src");
    mkdirSync(start, { recursive: true });
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    expect(findWorkspaceRoot(start)).toBe(root);
  });

  it("falls back to the start directory with no workspace", () => {
    const start = mkdtempSync(join(tmpdir(), "ws-"));
    expect(findWorkspaceRoot(start)).toBe(start);
  });
});
