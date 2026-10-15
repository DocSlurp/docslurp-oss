import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  declaredPythonDistributions,
  ensurePythonDistributions,
  lazyPythonInstallEnabled,
  lockedPythonPins,
  normalizeDistribution,
  parseMissingPythonDependency,
} from "../tools/python-deps.js";

describe("lazy python dependencies", () => {
  it("finds the missing distribution in script output", () => {
    expect(parseMissingPythonDependency("python3 (1): missing dependency: pip install trafilatura (No module named 'trafilatura')")).toBe("trafilatura");
    expect(parseMissingPythonDependency("ModuleNotFoundError: No module named 'bs4'")).toBe("beautifulsoup4");
    expect(parseMissingPythonDependency("ModuleNotFoundError: No module named 'pptx.util'")).toBe("python-pptx");
    expect(parseMissingPythonDependency("ModuleNotFoundError: No module named 'PIL'")).toBe("pillow");
    expect(parseMissingPythonDependency("Segmentation fault")).toBeNull();
  });

  it("only allows distributions the worker declares, pinned from the lock", () => {
    const declared = declaredPythonDistributions();
    expect(declared.has("trafilatura")).toBe(true);
    expect(declared.has("pypandoc-binary")).toBe(true);
    expect(declared.has("left-pad")).toBe(false);
    // Bundle-only direct-URL wheels (spaCy models) never become PyPI-installable names.
    expect(declared.has("en-core-web-sm")).toBe(false);
    expect(declared.has("docling")).toBe(true);
    expect(lockedPythonPins().get("trafilatura")).toMatch(/^\d/);
    expect(normalizeDistribution("Python_PPTX")).toBe("python-pptx");
  });

  it("refuses undeclared packages and honors the off switch without installing", async () => {
    await expect(ensurePythonDistributions(["left-pad"], { venvBin: "/nonexistent/bin" })).resolves.toBe(false);
    await expect(ensurePythonDistributions(["trafilatura"], { venvBin: "/nonexistent/bin", env: { DOCSLURP_PYTHON_LAZY_INSTALL: "false" } })).resolves.toBe(false);
    expect(lazyPythonInstallEnabled({})).toBe(true);
    expect(lazyPythonInstallEnabled({ DOCSLURP_PYTHON_LAZY_INSTALL: "false" })).toBe(false);
  });
  it("keeps security constraints and the CPU index when exact-lock installation fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "docslurp-python-deps-"));
    try {
      const bin = path.join(root, "venv", "bin");
      const receipt = path.join(root, "calls.jsonl");
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, "python3"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(args) + "\\n");
process.exit(args.some(arg => arg.endsWith("requirements.lock.txt")) ? 1 : 0);
`, { mode: 0o755 });
      await expect(ensurePythonDistributions(["trafilatura"], { venvBin: bin })).resolves.toBe(true);
      const calls: string[][] = (await readFile(receipt, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(calls).toHaveLength(2);
      for (const args of calls) {
        const base = args.findIndex(arg => arg.endsWith("requirements-base.txt"));
        expect(base).toBeGreaterThan(0);
        expect(args[base - 1]).toBe("-c");
        expect(args).toContain("https://download.pytorch.org/whl/cpu");
      }
      expect(calls[0]!.some(arg => arg.endsWith("requirements.lock.txt"))).toBe(true);
      expect(calls[1]!.some(arg => arg.endsWith("requirements.lock.txt"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Production regression (lean worker, 2026-10-15): the image runs as a
  // non-root user, /app is root-owned and has no venv, so mkdir of the install
  // lock failed with EACCES. Every mkdir error was treated as "lock held",
  // stalling extract-markdown for the full 15-minute lock deadline.
  it.skipIf(process.getuid?.() === 0)("fails fast when the venv location is not writable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "docslurp-python-deps-ro-"));
    const readOnly = path.join(root, "app");
    try {
      await mkdir(readOnly);
      await chmod(readOnly, 0o555);
      const started = Date.now();
      await expect(ensurePythonDistributions(["trafilatura"], { venvBin: path.join(readOnly, ".venv", "bin") })).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await chmod(readOnly, 0o755).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops waiting for another process's install lock when the caller's signal aborts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "docslurp-python-deps-lock-"));
    try {
      const venv = path.join(root, "venv");
      // A fresh lock held by "another process".
      await mkdir(`${venv}.install-lock`, { recursive: true });
      const started = Date.now();
      await expect(
        ensurePythonDistributions(["trafilatura"], { venvBin: path.join(venv, "bin"), signal: AbortSignal.timeout(200) }),
      ).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      // Releasing the lock lets the background attempt finish and clean up.
      await rm(root, { recursive: true, force: true });
    }
  });
});
