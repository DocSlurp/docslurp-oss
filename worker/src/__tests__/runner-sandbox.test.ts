import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  buildCommandEnv,
  buildSandboxCommand,
  isVectorBackendCommand,
  planDocumentToolInvocation,
  sanitizeDocumentToolFileArg,
  type CommandPlan,
} from "../tools/runner.js";

const samplePlan: CommandPlan = {
  binary: "pdftotext",
  args: ["sample.pdf", "-"],
  available: true,
};

const scriptsDir = "/repo/worker/scripts";
const limits = { timeoutMs: 60_000 };

function command(overrides: Partial<Parameters<typeof buildSandboxCommand>[0]> = {}) {
  return buildSandboxCommand({
    plan: samplePlan,
    venvBin: "/tmp/fake-venv/bin",
    scriptsDir,
    scratchRoot: "/tmp/docslurp-parser-sandbox",
    configuredWritablePaths: [],
    limits,
    env: { PATH: "/usr/bin" },
    ...overrides,
  });
}

describe("sandbox command construction", () => {
  it("rejects broad writable mounts", () => {
    expect(() => command({ configuredWritablePaths: ["/tmp"] })).toThrow("private DocSlurp temporary workspaces");
  });

  it("describes the command without launcher details", () => {
    const spec = command({ configuredWritablePaths: [path.join(tmpdir(), "docslurp-test")] });

    expect(spec.binary).toBe("pdftotext");
    expect(spec.args).toEqual(["sample.pdf", "-"]);
    expect(spec.limits).toEqual(limits);
    expect(spec.env.PATH).toBe("/tmp/fake-venv/bin:/usr/bin");
    expect(spec.env.DOCSLURP_PARSER_SANDBOX_MODE).toBeUndefined();
    expect(spec.writablePaths).toEqual([path.join(tmpdir(), "docslurp-test")]);
  });

  it("does not forward worker credentials", () => {
    const spec = command({
      env: {
        PATH: "/usr/bin",
        AWS_SECRET_ACCESS_KEY: "parser-should-not-receive-this",
        LANCEDB_URI: "s3://parser-should-not-receive-this",
        STORAGE_URI: "s3://key:secret@parser-should-not-receive-this",
      },
    });

    expect(spec.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(spec.env.LANCEDB_URI).toBeUndefined();
    expect(spec.env.STORAGE_URI).toBeUndefined();
  });

  it("grants parser output write access to DocSlurp temp workspaces", () => {
    const tempWorkspace = path.join(tmpdir(), "docslurp-source-test");
    const sourcePath = path.join(tempWorkspace, "sample.pdf");
    const spec = command({
      plan: {
        binary: "node",
        args: ["kreuzberg_extract.mjs", "--input", sourcePath, "--output", `${sourcePath}.kreuzberg.md`],
        available: true,
      },
    });

    expect(spec.writablePaths).toEqual([tempWorkspace]);
  });

  it("does not infer a writable checkout from scripts in a temporary worktree", () => {
    const project = path.join(tmpdir(), "docslurp-worktree-test");
    const spec = command({
      plan: { binary: "node", args: [path.join(project, "worker/scripts/parser.mjs")], available: true },
      scriptsDir: path.join(project, "worker/scripts"),
    });
    expect(spec.writablePaths).toEqual([]);
  });

  it("recognises vector writer commands by trusted entrypoint, never by input filename", () => {
    expect(isVectorBackendCommand([path.join(scriptsDir, "vector_backend_write.py"), "--input", "x"], scriptsDir)).toBe(true);
    expect(isVectorBackendCommand([path.join(scriptsDir, "orama_write.mjs")], scriptsDir)).toBe(true);
    expect(isVectorBackendCommand(["/tmp/docslurp-source/vector_backend_write.py"], scriptsDir)).toBe(false);
  });

  it("gives vector writer commands backend env that parsers never get", () => {
    const plan: CommandPlan = { binary: "python3", args: [path.join(scriptsDir, "vector_backend_write.py")], available: true };
    const sourceEnv = { PATH: "/usr/bin", LANCEDB_URI: "/tmp/lancedb", AWS_SECRET_ACCESS_KEY: "test-secret" };
    const writer = buildCommandEnv({ plan, venvBin: "/tmp/fake-venv/bin", isVectorBackend: true, env: sourceEnv });
    expect(writer.LANCEDB_URI).toBe("/tmp/lancedb");
    expect(writer.AWS_SECRET_ACCESS_KEY).toBe("test-secret");
    const parser = buildCommandEnv({ plan, venvBin: "/tmp/fake-venv/bin", isVectorBackend: false, env: sourceEnv });
    expect(parser.LANCEDB_URI).toBeUndefined();
    expect(parser.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

describe("document tool invocation planning", () => {
  it("separates parser options from leading-dash file names", () => {
    const planned = planDocumentToolInvocation({
      binary: "pdftotext",
      args: ["-layout", "-enc", "UTF-8", "-sample.pdf", "-"],
      fileArgIndexes: [3],
      supportsDoubleDash: true,
    });

    expect(planned).toEqual({
      binary: "pdftotext",
      args: ["-layout", "-enc", "UTF-8", "--", "./-sample.pdf", "-"],
    });
  });

  it("does not insert a delimiter before option values that are paths", () => {
    const planned = planDocumentToolInvocation({
      binary: "pdftoppm",
      args: ["-png", "-r", "150", "-input.pdf", "-out"],
      fileArgIndexes: [3, 4],
      supportsDoubleDash: false,
    });

    expect(planned.args).toEqual([
      "-png",
      "-r",
      "150",
      "./-input.pdf",
      "./-out",
    ]);
  });

  it("preserves stdout markers and absolute file paths", () => {
    expect(sanitizeDocumentToolFileArg("-")).toBe("-");
    expect(sanitizeDocumentToolFileArg("/tmp/-sample.pdf")).toBe(
      "/tmp/-sample.pdf",
    );
  });
});

describe("vendor bundle plans", () => {
  it("mounts the unpacked bundle read-only and puts its site-packages on PYTHONPATH", async () => {
    const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
    const { withVendorBundle } = await import("../tools/runner.js");
    const root = await mkdtemp(path.join(tmpdir(), "bundle-root-"));
    await mkdir(path.join(root, "site-packages"));
    try {
      const plan = withVendorBundle(
        { binary: path.join(root, "bin", "docling"), args: ["--to", "md"], available: true },
        { name: "docling", sha256: "a".repeat(64), root, binDir: path.join(root, "bin"), sitePackages: path.join(root, "site-packages"), env: { HF_HUB_OFFLINE: "1", HF_HOME: path.join(root, "models/hf") } },
      );
      const spec = buildSandboxCommand({ plan, venvBin: "/nonexistent/.venv/bin", scriptsDir: path.resolve(process.cwd(), "scripts"),
        scratchRoot: "/tmp/docslurp-parser-sandbox", configuredWritablePaths: [], limits, env: { PATH: "/usr/bin" } });
      expect(spec.env.PYTHONPATH).toBe(path.join(root, "site-packages"));
      expect(spec.env.HF_HOME).toBe(path.join(root, "models/hf"));
      expect(spec.env.HF_HUB_OFFLINE).toBe("1");
      expect(spec.readablePaths).toContain(root);
      // Applying the same bundle twice does not duplicate entries.
      expect(withVendorBundle(plan, { name: "docling", sha256: "a".repeat(64), root, binDir: "", sitePackages: path.join(root, "site-packages"), env: {} }).pythonPath).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("parser sandbox launcher with a custom temp root", () => {
  const launcher = path.resolve(process.cwd(), "scripts/parser-sandbox.sh");
  const hasBwrap = spawnSync("bwrap", ["--version"]).status === 0;

  function runLauncher(tmpRoot: string, writable: string, ...command: string[]) {
    return spawnSync("bash", [launcher, ...command], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, DOCSLURP_PARSER_SANDBOX_TMP_ROOT: tmpRoot, DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS: writable },
    });
  }

  it.skipIf(!hasBwrap || process.platform !== "linux")("mounts private workspaces under a non-/tmp temp root and still refuses broad paths", () => {
    const tmpRoot = mkdtempSync(path.join(process.env.HOME ?? process.cwd(), ".docslurp-sandbox-root-"));
    try {
      const workspace = path.join(tmpRoot, "docslurp-work");
      mkdirSync(workspace);
      writeFileSync(path.join(workspace, "in.txt"), "hello");

      const ok = runLauncher(tmpRoot, workspace, "cat", path.join(workspace, "in.txt"));
      expect(ok.stderr).toBe("");
      expect(ok.stdout).toBe("hello");

      expect(runLauncher(tmpRoot, tmpRoot, "true").status).toBe(70);
      expect(runLauncher(tmpRoot, `${workspace}/../../escape`, "true").status).toBe(70);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
