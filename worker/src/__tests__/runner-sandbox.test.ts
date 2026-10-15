import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  buildSpawnCommandSpec,
  planDocumentToolInvocation,
  resolveParserSandboxSettings,
  sanitizeDocumentToolFileArg,
  type CommandPlan,
} from "../tools/runner.js";

const samplePlan: CommandPlan = {
  binary: "pdftotext",
  args: ["sample.pdf", "-"],
  available: true,
};

describe("parser sandbox settings", () => {
  it("disables parser sandboxing by default for local macOS workers", () => {
    if (process.platform !== "darwin") {
      return;
    }

    const settings = resolveParserSandboxSettings({
      scriptsDir: path.resolve(process.cwd(), "scripts"),
      env: {},
    });

    expect(settings.enabled).toBe(false);
    expect(settings.launcherPath).toBeNull();
  });

  it("uses the bundled parser launcher when sandboxing is enabled", () => {
    const scriptsDir = path.resolve(process.cwd(), "scripts");
    const settings = resolveParserSandboxSettings({
      scriptsDir,
      env: {
        DOCSLURP_PARSER_SANDBOX_ENABLED: "true",
      },
    });

    expect(settings.enabled).toBe(true);
    expect(settings.launcherPath).toBe(
      path.join(scriptsDir, "parser-sandbox.sh"),
    );
    expect(settings.scratchRoot).toBe("/tmp/docslurp-parser-sandbox");
  });

  it("defaults parser sandbox mode to isolated", () => {
    const scriptsDir = path.resolve(process.cwd(), "scripts");
    const sandbox = resolveParserSandboxSettings({
      scriptsDir,
      env: {
        DOCSLURP_PARSER_SANDBOX_ENABLED: "true",
      },
    });

    expect(sandbox.mode).toBe("isolated");
    expect(sandbox.writablePaths).toEqual([]);
    expect(sandbox.launcherPath).toBe(
      path.join(scriptsDir, "parser-sandbox.sh"),
    );
  });

  it("forces isolation in production even when disabled in configuration", () => {
    const settings = resolveParserSandboxSettings({ scriptsDir: path.resolve(process.cwd(), "scripts"),
      env: { NODE_ENV: "production", DOCSLURP_PARSER_SANDBOX_ENABLED: "false", DOCSLURP_PARSER_SANDBOX_MODE: "inherit" } });
    expect(settings.enabled).toBe(true);
    expect(settings.mode).toBe("isolated");
  });

  it("rejects broad writable mounts", () => {
    expect(() => buildSpawnCommandSpec({ plan: samplePlan, venvBin: "/tmp/venv/bin",
      sandbox: { enabled: true, launcherPath: "/repo/worker/scripts/parser-sandbox.sh", mode: "isolated", scratchRoot: "/tmp/docslurp-parser-sandbox", writablePaths: ["/tmp"] }
    })).toThrow("private DocSlurp temporary workspaces");
  });

  it("never grants backend credentials based on an input filename", () => {
    const spec = buildSpawnCommandSpec({ plan: { binary: "pdftotext", args: ["/tmp/docslurp-source/vector_backend_write.py"], available: true }, venvBin: "/tmp/venv/bin",
      sandbox: { enabled: true, launcherPath: "/repo/worker/scripts/parser-sandbox.sh", mode: "isolated", scratchRoot: "/tmp/docslurp-parser-sandbox", writablePaths: [] },
      env: { AWS_SECRET_ACCESS_KEY: "secret" }
    });
    expect(spec.binary).toBe("/repo/worker/scripts/parser-sandbox.sh");
    expect(spec.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("falls back to direct execution when sandboxing is disabled", () => {
    const settings = resolveParserSandboxSettings({
      scriptsDir: "/tmp/does-not-matter",
      env: {
        DOCSLURP_PARSER_SANDBOX_ENABLED: "false",
      },
    });

    const spec = buildSpawnCommandSpec({
      plan: samplePlan,
      venvBin: "/tmp/fake-venv/bin",
      sandbox: settings,
      env: {
        PATH: "/usr/bin",
      },
    });

    expect(spec.binary).toBe("pdftotext");
    expect(spec.args).toEqual(["sample.pdf", "-"]);
  });

  it("routes parser commands through the launcher with security env", () => {
    const spec = buildSpawnCommandSpec({
      plan: samplePlan,
      venvBin: "/tmp/fake-venv/bin",
      sandbox: {
        enabled: true,
        launcherPath: "/repo/worker/scripts/parser-sandbox.sh",
        mode: "isolated",
        scratchRoot: "/tmp/docslurp-parser-sandbox",
        writablePaths: [path.join(tmpdir(), "docslurp-test")],
      },
      env: {
        PATH: "/usr/bin",
        AWS_SECRET_ACCESS_KEY: "parser-should-not-receive-this",
        LANCEDB_URI: "s3://parser-should-not-receive-this",
        STORAGE_URI: "s3://key:secret@parser-should-not-receive-this",
      },
    });

    expect(spec.binary).toBe("/repo/worker/scripts/parser-sandbox.sh");
    expect(spec.args).toEqual(["pdftotext", "sample.pdf", "-"]);
    expect(spec.env.DOCSLURP_PARSER_SANDBOX_MODE).toBe("isolated");
    expect(spec.env.DOCSLURP_PARSER_SANDBOX_ROOT).toBe(
      "/tmp/docslurp-parser-sandbox",
    );
    expect(spec.env.DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS).toBe(
      path.join(tmpdir(), "docslurp-test"),
    );
    expect(spec.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(spec.env.LANCEDB_URI).toBeUndefined();
    expect(spec.env.STORAGE_URI).toBeUndefined();
  });

  it("grants parser output write access to DocSlurp temp workspaces", () => {
    const tempWorkspace = path.join(tmpdir(), "docslurp-source-test");
    const sourcePath = path.join(tempWorkspace, "sample.pdf");
    const outputPath = `${sourcePath}.kreuzberg.md`;

    const spec = buildSpawnCommandSpec({
      plan: {
        binary: "node",
        args: [
          "kreuzberg_extract.mjs",
          "--input",
          sourcePath,
          "--output",
          outputPath,
        ],
        available: true,
      },
      venvBin: "/tmp/fake-venv/bin",
      sandbox: {
        enabled: true,
        launcherPath: "/repo/worker/scripts/parser-sandbox.sh",
        mode: "isolated",
        scratchRoot: "/tmp/docslurp-parser-sandbox",
        writablePaths: [],
      },
      env: {
        PATH: "/usr/bin",
      },
    });

    expect(spec.env.DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS).toBe(
      tempWorkspace,
    );
  });

  it("does not infer a writable checkout from scripts in a temporary worktree", () => {
    const project = path.join(tmpdir(), "docslurp-worktree-test");
    const spec = buildSpawnCommandSpec({
      plan: { binary: "node", args: [path.join(project, "worker/scripts/parser.mjs")], available: true },
      venvBin: "/tmp/fake-venv/bin",
      sandbox: { enabled: true, launcherPath: path.join(project, "worker/scripts/parser-sandbox.sh"), mode: "isolated", scratchRoot: "/tmp/docslurp-parser-sandbox", writablePaths: [] },
    });
    expect(spec.env.DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS).toBe("");
  });

  it("runs vector writer commands outside the parser sandbox with backend env", () => {
    const tempWorkspace = path.join(tmpdir(), "docslurp-vector-test");
    const inputPath = path.join(tempWorkspace, "input.json");
    const outputPath = path.join(tempWorkspace, "output.json");
    const lancedbPath = path.join(tmpdir(), "docslurp-lancedb-test");
    const chromaPath = path.join(tmpdir(), "docslurp-chroma-test");
    const oramaPath = path.join(tmpdir(), "docslurp-orama-test");

    const spec = buildSpawnCommandSpec({
      plan: {
        binary: "/tmp/fake-venv/bin/python3",
        args: [
          "/repo/worker/scripts/vector_backend_write.py",
          "--input",
          inputPath,
          "--output",
          outputPath,
          "--backend",
          "lancedb",
          "--collection",
          "documents",
        ],
        available: true,
      },
      venvBin: "/tmp/fake-venv/bin",
      sandbox: {
        enabled: true,
        launcherPath: "/repo/worker/scripts/parser-sandbox.sh",
        mode: "isolated",
        scratchRoot: "/tmp/docslurp-parser-sandbox",
        writablePaths: [],
      },
      env: {
        PATH: "/usr/bin",
        LANCEDB_URI: lancedbPath,
        CHROMA_PATH: chromaPath,
        ORAMA_PATH: oramaPath,
        STORAGE_URI: "s3://docslurp-files?endpoint=http://minio:9000&region=us-west-2",
        AWS_SECRET_ACCESS_KEY: "test-secret",
        AWS_ENDPOINT_URL_S3: "http://legacy-not-forwarded:9000",
      },
    });

    expect(spec.binary).toBe("/tmp/fake-venv/bin/python3");
    expect(spec.args).toEqual([
      "/repo/worker/scripts/vector_backend_write.py",
      "--input",
      inputPath,
      "--output",
      outputPath,
      "--backend",
      "lancedb",
      "--collection",
      "documents",
    ]);
    expect(spec.env.LANCEDB_URI).toBe(lancedbPath);
    expect(spec.env.CHROMA_PATH).toBe(chromaPath);
    expect(spec.env.ORAMA_PATH).toBe(oramaPath);
    expect(spec.env.STORAGE_URI).toBe("s3://docslurp-files?endpoint=http://minio:9000&region=us-west-2");
    expect(spec.env.AWS_ENDPOINT_URL_S3).toBeUndefined();
    expect(spec.env.AWS_SECRET_ACCESS_KEY).toBe("test-secret");
    expect(spec.env.DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS).toBeUndefined();
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
      binary: "mutool",
      args: ["draw", "-F", "txt", "-o", "-out.txt", "-input.pdf"],
      fileArgIndexes: [4, 5],
      supportsDoubleDash: false,
    });

    expect(planned.args).toEqual([
      "draw",
      "-F",
      "txt",
      "-o",
      "./-out.txt",
      "./-input.pdf",
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
      const scriptsDir = path.resolve(process.cwd(), "scripts");
      const sandbox = resolveParserSandboxSettings({ scriptsDir, env: { DOCSLURP_PARSER_SANDBOX_ENABLED: "true" } });
      const spec = buildSpawnCommandSpec({ plan, venvBin: "/nonexistent/.venv/bin", sandbox, env: { PATH: "/usr/bin" } });
      expect(spec.env.PYTHONPATH).toBe(path.join(root, "site-packages"));
      expect(spec.env.HF_HOME).toBe(path.join(root, "models/hf"));
      expect(spec.env.HF_HUB_OFFLINE).toBe("1");
      expect(spec.env.DOCSLURP_PARSER_SANDBOX_READABLE_PATHS?.split(",")).toContain(root);
      // Applying the same bundle twice does not duplicate entries.
      expect(withVendorBundle(plan, { name: "docling", sha256: "a".repeat(64), root, binDir: "", sitePackages: path.join(root, "site-packages"), env: {} }).pythonPath).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
