import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxCommand } from "../sandbox/types.js";
import { createArtifactProcessor } from "./index.js";
import { configure } from "./pdf-reference.js";

const vm = vi.hoisted(() => ({
  readConfig: vi.fn(),
  probe: vi.fn(),
  openSession: vi.fn(),
  run: vi.fn(),
  close: vi.fn(),
  drain: vi.fn(),
}));
vi.mock("../sandbox/providers/modal/index.js", () => ({
  createModalProvider: () => ({ id: "modal", ...vm }),
}));

const remote = { filesystem: true, network: "full", processes: true, location: "remote" };
const text = "<table><tr><td>Document text</td></tr></table>\n";

describe("the standalone PDF recipe", () => {
  let dir: string;
  let source: string;
  let env: NodeJS.ProcessEnv;
  const { signal } = new AbortController();

  beforeEach(async () => {
    vi.resetAllMocks();
    dir = await mkdtemp(path.join(tmpdir(), "pdf-recipe-test-"));
    source = path.join(dir, "source.pdf");
    await writeFile(source, "mock PDF");
    env = {
      NODE_ENV: "development",
      DOCSLURP_PARSER_SANDBOX: "modal",
      DOCSLURP_PROCESSOR_OUTPUT_DIR: path.join(dir, "output"),
      EXAMPLE_PROVIDER_SECRET: "host-only",
    };
    vm.probe.mockResolvedValue({ ok: true, isolation: remote });
    vm.openSession.mockResolvedValue({ providerId: "modal", isolation: remote, run: vm.run, close: vm.close });
    vm.run.mockImplementation(async (command: SandboxCommand) => ({
      exitCode: 0,
      stdout: command.binary === "pdfinfo" ? "Pages: 2\n" : text,
    }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps parsing in the VM and preserves text artifacts after closing the session", async () => {
    const { prepare, adapters } = await configure(env);
    const target = ["document/markdown", "page/chunks"];
    const { request, close } = await prepare(source, target, signal);
    const result = await createArtifactProcessor(adapters).execute({ ...request, target }, signal).finally(close);
    expect(vm.readConfig).toHaveBeenCalledWith(expect.objectContaining({ NODE_ENV: "production" }));
    expect(vm.run.mock.calls.map(([command]) => command.binary)).toEqual([
      "pdfinfo", "pdftotext", "pdftotext", "pandoc", "pandoc",
    ]);
    for (const [command] of vm.run.mock.calls) {
      expect(command.env).toEqual({ LANG: "C", LC_ALL: "C" });
      expect(command.inputPaths).toHaveLength(1);
      expect(path.dirname(command.inputPaths[0])).toBe(path.dirname(request.initial[0].uri));
      expect(command.writablePaths).toEqual([]);
    }
    expect(vm.close).toHaveBeenCalledOnce();
    expect(vm.drain).toHaveBeenCalledOnce();
    await expect(stat(request.initial[0].uri)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chunks = result.targets.filter(({ kind }) => kind === "page/chunks");
    expect(chunks).toHaveLength(2);
    expect(JSON.parse(await readFile(chunks[0].uri, "utf8"))).toEqual([text]);
    expect(await readFile(result.targets.find(({ kind }) => kind === "document/markdown")!.uri, "utf8")).toContain(text.trim());
  });

  it("refuses a session without full network isolation before sending the PDF", async () => {
    vm.openSession.mockResolvedValue({
      providerId: "modal", isolation: { ...remote, network: "none" }, run: vm.run, close: vm.close,
    });
    const { prepare } = await configure(env);
    await expect(prepare(source, ["page/markdown"], signal)).rejects.toThrow(/full network isolation/);
    expect(vm.run).not.toHaveBeenCalled();
    expect(vm.close).toHaveBeenCalledOnce();
  });

  it("refuses local parsing and oversized inputs before opening a session", async () => {
    await expect(configure({ ...env, DOCSLURP_PARSER_SANDBOX: "none" })).rejects.toThrow(/requires.*modal/);
    await truncate(source, 128 * 1024 * 1024 + 1);
    const { prepare } = await configure(env);
    await expect(prepare(source, ["page/markdown"], signal)).rejects.toThrow(/128 MiB/);
    expect(vm.probe).not.toHaveBeenCalled();
  });
});
