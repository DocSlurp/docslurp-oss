/*
 * DOCSLURP_OCR_MODE=local end to end: the real docslurp_ocr.py CLI, the pinned models and the real parser sandbox
 * (bubblewrap). Skips cleanly unless the OCR venv (DOCSLURP_OCR_TEST_PYTHON), the models (DOCSLURP_OCR_TEST_MODELS) and
 * a working bubblewrap are present; `scripts/install-ocr-runtime.sh` sets up the first two.
 */
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import bubblewrap from "../../sandbox/providers/bubblewrap/index.js";
import { interpreterRoots } from "../../sandbox/paths.js";
import { probePidNamespace } from "../../sandbox/teardown.js";
import type { SandboxSession } from "../../sandbox/types.js";
import { CommandRunner } from "../../tools/runner.js";
import { readWithOcr } from "../engine.js";

// Point these at an OCR venv and model dir (scripts/install-ocr-runtime.sh); the test skips without them.
const python = process.env.DOCSLURP_OCR_TEST_PYTHON?.trim() || "/opt/docslurp/ocr-venv/bin/python3";
const models = process.env.DOCSLURP_OCR_TEST_MODELS?.trim() || "/opt/docslurp/ocr-models";
const linux = process.platform === "linux";
const bwrapAvailable = linux && spawnSync("bwrap", ["--version"]).status === 0;
const pidNamespace = linux && probePidNamespace().ok;
const filterArch = ["x64", "arm64"].includes(process.arch);
const runtimeReady = existsSync(python) && existsSync(path.join(models, "PP-OCRv6_rec_small.onnx"))
  && spawnSync(python, ["-I", "-c", "import rapidocr, onnxruntime"]).status === 0;
const enabled = bwrapAvailable && pidNamespace && filterArch && runtimeReady;

const dirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function renderText(file: string, text: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="260"><rect width="100%" height="100%" fill="white"/>` +
    `<text x="60" y="160" font-family="DejaVu Sans, Arial, sans-serif" font-size="96" fill="black">${text}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function sandboxedRunner(activityId: string): Promise<{ runner: CommandRunner; session: SandboxSession; spawned: string[][] }> {
  const root = scratch("docslurp-ocr-sandbox-");
  const config = { scratchRoot: path.join(root, "sandbox"), writablePaths: [] };
  vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ROOT", config.scratchRoot);
  const session = await bubblewrap.openSession(config, { activityId });
  const spawned: string[][] = [];
  const spawn = session.spawn!.bind(session);
  session.spawn = (command) => {
    spawned.push([command.binary, ...command.args]);
    return spawn(command);
  };
  return { runner: new CommandRunner({ openSession: async () => session }), session, spawned };
}

function localEnv(modelDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DOCSLURP_OCR_MODE: "local",
    DOCSLURP_SERVICE_PROFILE: "self-hosted",
    DOCSLURP_OCR_PYTHON: python,
    DOCSLURP_OCR_MODEL_DIR: modelDir,
  };
}

describe.skipIf(!enabled)("local OCR through the real CLI under bubblewrap", () => {
  let listener: Server;
  let port = 0;
  beforeAll(async () => {
    // A host listener the sandbox must not reach (its own network namespace has no route to the host's loopback).
    listener = createServer((socket) => socket.end("reached"));
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    port = (listener.address() as { port: number }).port;
    return () => new Promise<void>((resolve) => listener.close(() => resolve()));
  });

  it("reads the text of a rendered PNG, inside the sandbox", async () => {
    const work = scratch("docslurp-ocr-local-");
    const source = path.join(work, "memo.png");
    await renderText(source, "INVOICE 4200");
    const { runner, session, spawned } = await sandboxedRunner("ocr-local");
    const local = vi.spyOn(runner, "localOcrRead");
    const outcome = await readWithOcr(runner, { source, kind: "image", escalation: false, languageSetting: "eng", env: localEnv(models) });
    try {
      expect(outcome.mode).toBe("local");
      expect(outcome.engine).toBe("local-sandbox");
      expect(outcome.pages).toHaveLength(1);
      expect(outcome.pages[0]!.text.toUpperCase().replace(/\s+/g, " ")).toContain("INVOICE");
      expect(outcome.pages[0]!.text).toContain("4200");
      expect(outcome.cpuMs).toBeGreaterThan(0);
      expect(outcome.peakRssKb).toBeGreaterThan(0);
    } finally {
      await outcome.dispose();
    }
    expect(local).toHaveBeenCalledTimes(1);
    // The command ran through the bubblewrap session (its launcher unshares the network), not on the bare host.
    expect(session.providerId).toBe("bubblewrap");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]![0]).toBe(python);
    expect(spawned[0]!.join(" ")).toContain("docslurp_ocr.py");
    expect(spawned[0]).toEqual(expect.arrayContaining(["--models", models, "--kind", "image"]));
  }, 180_000);

  it("gives sandboxed commands no network: the host's loopback listener is unreachable from inside", async () => {
    // Positive control on the host (asynchronously: the listener lives on this event loop).
    const host = await promisify(execFile)(python, ["-I", "-c", `import socket; s=socket.create_connection(("127.0.0.1", ${port}), 2); print(s.recv(16).decode())`], { encoding: "utf8" });
    expect(host.stdout.trim()).toBe("reached");
    const { runner } = await sandboxedRunner("ocr-net");
    const probe = `import socket\ntry:\n  socket.create_connection(("127.0.0.1", ${port}), 2)\n  print("reached")\nexcept OSError as e:\n  print("refused", e.errno)`;
    const result = await runner.run({ binary: python, args: ["-I", "-c", probe], available: true, bundleRoots: [path.dirname(path.dirname(python)), ...interpreterRoots(python)] });
    expect(result.stdout.trim()).toMatch(/^refused/);
  }, 60_000);

  it("fails closed when a pinned model is missing, and downloads nothing", async () => {
    const work = scratch("docslurp-ocr-missing-");
    const partial = path.join(work, "models");
    mkdirSync(partial);
    for (const name of readdirSync(models)) if (name !== "PP-OCRv6_rec_small.onnx") copyFileSync(path.join(models, name), path.join(partial, name));
    const before = readdirSync(partial).sort();
    const source = path.join(work, "memo.png");
    await renderText(source, "INVOICE 4200");
    const { runner } = await sandboxedRunner("ocr-missing");
    await expect(readWithOcr(runner, { source, kind: "image", escalation: false, languageSetting: "eng", env: localEnv(partial) })).rejects.toThrow(/model/i);
    expect(readdirSync(partial).sort()).toEqual(before);
    expect(existsSync(path.join(partial, "PP-OCRv6_rec_small.onnx"))).toBe(false);
  }, 180_000);
});

