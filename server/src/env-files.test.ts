import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspaceEnvFiles } from "./env-files.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "catalog-env-"));
  roots.push(root);
  const core = join(root, "core");
  mkdirSync(join(core, "server", "scripts"), { recursive: true });
  for (const dir of [root, core]) writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(root, ".env"), "BASE=base\nSHARED=local\nEXPLICIT=local\nEMPTY=local\n");
  writeFileSync(join(root, ".env.production"), "PROD=production\nSHARED=production\nEXPLICIT=production\nEMPTY=production\n");
  return { root, url: pathToFileURL(join(core, "server/scripts/cli.ts")).href };
}
describe("catalog environment files", () => {
  it("layers production over baseline at the outer root while preserving shell values", () => {
    const { url } = fixture();
    const env = { EXPLICIT: "shell", EMPTY: "" };
    loadWorkspaceEnvFiles(url, true, env);
    expect(env).toEqual({ BASE: "base", SHARED: "production", PROD: "production", EXPLICIT: "shell", EMPTY: "" });
  });
  it("does not load production settings for local runs", () => {
    const { url } = fixture();
    const env = {};
    loadWorkspaceEnvFiles(url, false, env);
    expect(env).toEqual({ BASE: "base", SHARED: "local", EXPLICIT: "local", EMPTY: "local" });
  });
  it("fails before loading settings when the requested production overlay is missing", () => {
    const { root, url } = fixture();
    rmSync(join(root, ".env.production"));
    const env = {};
    expect(() => loadWorkspaceEnvFiles(url, true, env)).toThrow("Production environment file not found");
    expect(env).toEqual({});
  });
});
