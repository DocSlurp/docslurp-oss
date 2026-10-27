import { spawnSync } from "node:child_process";
import { mkdtemp, open, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedStream, executeDocumentVm, MAX_IMAGE_BYTES, IMAGE_PROGRAM } from "./document-vm.js";
import type { ModalSdk } from "./index.js";

function stream(bytes: string) {
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(bytes)); c.close(); } });
}
function harness(fail = false) {
  const terminate = vi.fn(async () => {});
  const exec = vi.fn(async () => ({ stdout: stream("result"), stderr: stream(""), wait: async () => fail ? 1 : 0 }));
  const writeBytes = vi.fn(async () => {});
  const create = vi.fn(async (..._args: unknown[]) => ({ terminate, exec, filesystem: { makeDirectory: vi.fn(), writeBytes } }));
  const fromRegistry = vi.fn();
  const close = vi.fn();
  const sdk = { ModalClient: class { apps = { fromName: vi.fn() }; images = { fromRegistry }; sandboxes = { create }; close = close; } } as unknown as ModalSdk;
  return { sdk, create, exec, terminate, writeBytes, close };
}
const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function job() {
  const dir = await mkdtemp(path.join(tmpdir(), "vm-contract-")); dirs.push(dir);
  const input = path.join(dir, "input.png"); const output = path.join(dir, "output.webp");
  await writeFile(input, "hostile bytes");
  vi.stubEnv("DOCSLURP_DOCUMENT_VM_IMAGE", `registry/parser@sha256:${"a".repeat(64)}`);
  return { operation: "encode-webp" as const, input, output, effort: 1 };
}
describe("dedicated document VM contract (offline)", () => {
  it("pins VM runtime, disables identity/network, stages one file and destroys on success", async () => {
    const j = await job(); const h = harness();
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "must-never-travel");
    await executeDocumentVm(j, undefined, async () => h.sdk);
    expect(h.create.mock.calls[0]?.[2]).toEqual({ runtime: "vm", cpu: 2, cpuLimit: 2, memoryMiB: 1024, memoryLimitMiB: 1024, timeoutMs: 60000, blockNetwork: true, includeOidcIdentityToken: false, env: {}, secrets: [], volumes: {}, cloudBucketMounts: {} });
    expect(h.writeBytes).toHaveBeenCalledExactlyOnceWith(Buffer.from("hostile bytes"), "/job/input");
    expect(JSON.stringify(h.exec.mock.calls)).not.toContain("must-never-travel");
    expect(h.terminate).toHaveBeenCalled(); expect(h.close).toHaveBeenCalled();
    expect(await readFile(j.output, "utf8")).toBe("result");
  });
  it("destroys on parser failure without downloading output", async () => {
    const j = await job(); const h = harness(true);
    await expect(executeDocumentVm(j, undefined, async () => h.sdk)).rejects.toThrow("parser failed");
    expect(h.terminate).toHaveBeenCalled(); expect(h.exec).toHaveBeenCalledTimes(1);
  });
  it("refuses mutable images and pre-aborted jobs without opening a VM", async () => {
    const j = await job(); const h = harness(); vi.stubEnv("DOCSLURP_DOCUMENT_VM_IMAGE", "registry/parser:latest");
    await expect(executeDocumentVm(j, undefined, async () => h.sdk)).rejects.toThrow("digest-pinned");
    await expect(executeDocumentVm(j, AbortSignal.abort(), async () => h.sdk)).rejects.toThrow("aborted");
    expect(h.create).not.toHaveBeenCalled();
  });
  it("caps streams during consumption", async () => {
    await expect(boundedStream(stream("12345"), 4)).rejects.toThrow("byte limit");
    expect((await boundedStream(stream("1234"), 4)).length).toBe(4);
    expect(MAX_IMAGE_BYTES).toBe(67108864);
  });
  it("uses a fresh VM and fixed remote paths for each job", async () => {
    const a = await job(); const b = await job(); const h = harness();
    await executeDocumentVm(a, undefined, async () => h.sdk); await executeDocumentVm(b, undefined, async () => h.sdk);
    expect(h.create).toHaveBeenCalledTimes(2); expect(h.terminate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.exec.mock.calls)).not.toContain(path.dirname(a.input));
  });
  it.each([{ w: 4097, h: 2, frames: 1 }, { w: 4000, h: 4001, frames: 1 }, { w: 10, h: 10, frames: 2 }])("guest validation refuses oversized or animated rasters %j before codecs", ({ w, h, frames }) => {
    // Execute the guest validation with a fake image object, never a host image decoder.
    const stub = `import sys, types\nclass Fake:\n    size=(${w},${h})\n    n_frames=${frames}\n    def __enter__(self): return self\n    def __exit__(self,*args): pass\n    def load(self): raise RuntimeError('codec must not run')\nsys.modules['PIL']=types.SimpleNamespace(Image=types.SimpleNamespace(open=lambda p: Fake()))\nsys.argv=['guest','decode-webp','1']\n`;
    const result = spawnSync("python3", ["-I", "-c", stub + IMAGE_PROGRAM], { encoding: "utf8", timeout: 5000 });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain("unsupported image dimensions or animation");
    expect(result.stderr).not.toContain("codec must not run");
  });
  it("refuses oversized files before any SDK or VM call", async () => {
    const j = await job(); const h = harness();
    const handle = await open(j.input, "w"); await handle.truncate(MAX_IMAGE_BYTES + 1); await handle.close();
    await expect(executeDocumentVm(j, undefined, async () => h.sdk)).rejects.toThrow("oversized");
    expect(h.create).not.toHaveBeenCalled();
  });
  it("destroys a running VM on cancellation with no output commit", async () => {
    const j = await job(); const h = harness(); const controller = new AbortController();
    let started!: () => void; const running = new Promise<void>(resolve => { started = resolve; });
    h.exec.mockImplementation(async () => { started(); await new Promise(() => {}); return undefined as never; });
    const pending = executeDocumentVm(j, controller.signal, async () => h.sdk);
    await running; controller.abort();
    await expect(pending).rejects.toThrow("aborted"); expect(h.terminate).toHaveBeenCalled();
    await expect(readFile(j.output)).rejects.toThrow();
  });
  it("destroys a VM when logs exceed their incremental cap", async () => {
    const j = await job(); const h = harness();
    h.exec.mockImplementation(async () => ({ stdout: stream("x".repeat(16385)), stderr: stream(""), wait: async () => 0 }));
    await expect(executeDocumentVm(j, undefined, async () => h.sdk)).rejects.toThrow("execution failed");
    expect(h.terminate).toHaveBeenCalled(); expect(h.exec).toHaveBeenCalledTimes(1);
  });
  it("does not expose control authentication errors or fall back locally", async () => {
    const j = await job(); const h = harness();
    h.create.mockRejectedValue(new Error("revoked secret-token"));
    await expect(executeDocumentVm(j, undefined, async () => h.sdk)).rejects.toThrow("Document VM execution failed");
    expect(h.exec).not.toHaveBeenCalled(); expect(h.close).toHaveBeenCalled();
  });

  it("destroys a running VM at the absolute deadline without committing output", async () => {
    const j = await job(); const h = harness();
    vi.useFakeTimers();
    let started!: () => void; const running = new Promise<void>(resolve => { started = resolve; });
    h.exec.mockImplementation(async () => { started(); await new Promise(() => {}); return undefined as never; });
    const pending = executeDocumentVm(j, undefined, async () => h.sdk);
    const rejected = expect(pending).rejects.toThrow("deadline exceeded");
    await running; await vi.advanceTimersByTimeAsync(60_001); await rejected;
    expect(h.terminate).toHaveBeenCalled();
    await expect(readFile(j.output)).rejects.toThrow();
  });

});
