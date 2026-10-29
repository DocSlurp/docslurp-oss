import { spawnSync } from "node:child_process";
import { mkdtemp, open, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedStream, executeDopplerVm, SHARDS_UNSUPPORTED_MESSAGE, MAX_PDF_BYTES, VM_TIMEOUT_MS, VM_CLEANUP_TIMEOUT_MS, dopplerVmUsage } from "./doppler-vm.js";
import type { ModalSdk } from "./index.js";

function stream(bytes: string) {
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(bytes)); c.close(); } });
}
function diagnostics(outputBytes = 6) { return JSON.stringify({ protocol: "doppler-vm@2", engine: "doppler", outputBytes, conversion: { pages: 1 } }); }
function harness(fail = false) {
  const terminate = vi.fn(async () => {});
  const exec = vi.fn(async () => ({ stdout: stream("result"), stderr: stream(diagnostics()), wait: async (): Promise<number> => fail ? 1 : 0 }));
  const writeBytes = vi.fn(async () => {});
  const copyFromLocal = vi.fn(async (_source: string, _destination: string) => {});
  const makeDirectory = vi.fn(async () => {});
  const vm = { sandboxId: "sb-test", terminate, exec, filesystem: { makeDirectory, writeBytes, copyFromLocal } };
  const create = vi.fn(async (..._args: unknown[]) => vm);
  const fromName = vi.fn(async () => "app");
  const reconnect = vi.fn();
  const fromRegistry = vi.fn();
  const fromId = vi.fn(async () => ({ imageId: "im-imported" }));
  const close = vi.fn();
  const registrySecret = { id: "registry-only" };
  const secretFromName = vi.fn(async () => registrySecret);
  const sdk = { ModalClient: class { secrets = { fromName: secretFromName }; apps = { fromName }; images = { fromRegistry, fromId }; sandboxes = { create }; close = close; }, Sandbox: class { terminate = terminate; constructor(...args: unknown[]) { reconnect(...args); } } } as unknown as ModalSdk;
  return { sdk, create, exec, terminate, copyFromLocal, writeBytes, close, fromName, makeDirectory, vm, reconnect, fromId, fromRegistry, registrySecret, secretFromName };
}
const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function job() {
  const dir = await mkdtemp(path.join(tmpdir(), "vm-contract-")); dirs.push(dir);
  const input = path.join(dir, "input.png"); const output = path.join(dir, "output.webp");
  await writeFile(input, "hostile bytes");
  vi.stubEnv("DOCSLURP_DOPPLER_VM_IMAGE", `registry/parser@sha256:${"a".repeat(64)}`);
  return { operation: "doppler-markdown" as const, input, output };
}
describe("dedicated document VM contract (offline)", () => {
  it("records Doppler VM allocation cost separately from worker-host compute", () => {
    const usage = dopplerVmUsage("image", 60);
    expect(usage.costCents).toBeCloseTo(0.27654);
    expect(usage.metadata).toMatchObject({ costRollup: "authoritative", physicalCores: 0.5, physicalCoreLimit: 1, costSource: "estimate" });
  });
  it("routes Doppler to its own immutable image and fixed guest entry point", async () => {
    const j = await job(); const h = harness();
    const image = `private/doppler@sha256:${"b".repeat(64)}`;
    vi.stubEnv("DOCSLURP_DOPPLER_VM_IMAGE", image);
    await executeDopplerVm({ ...j, operation: "doppler-markdown" }, undefined, async () => h.sdk);
    expect(h.create.mock.calls[0]?.[2]).toMatchObject({ runtime: "vm", blockNetwork: true, secrets: [], env: {}, includeOidcIdentityToken: false });
    expect(JSON.stringify(h.exec.mock.calls[0])).toContain("/opt/docslurp/doppler-vm.py");
    expect(JSON.stringify(h.exec.mock.calls)).not.toContain(j.input);
    expect(h.terminate).toHaveBeenCalledOnce();
  });
  it("pins VM runtime, disables identity/network, stages one file and destroys on success", async () => {
    const j = await job(); const h = harness();
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "must-never-travel");
    await executeDopplerVm(j, undefined, async () => h.sdk);
    expect(h.create.mock.calls[0]?.[2]).toEqual({ runtime: "vm", cpu: 0.5, cpuLimit: 1, memoryMiB: 1024, memoryLimitMiB: 1024, timeoutMs: VM_TIMEOUT_MS, blockNetwork: true, includeOidcIdentityToken: false, env: {}, secrets: [], volumes: {}, cloudBucketMounts: {} });
    expect(h.writeBytes).toHaveBeenCalledExactlyOnceWith(Buffer.from("hostile bytes"), "/job/input");
    expect(JSON.stringify(h.exec.mock.calls)).not.toContain("must-never-travel");
    expect(h.terminate).toHaveBeenCalled(); expect(h.close).toHaveBeenCalled();
    expect(await readFile(j.output, "utf8")).toBe("result");
    expect(h.exec).toHaveBeenCalledOnce();
    expect(h.makeDirectory).not.toHaveBeenCalled();
  });
  it("destroys on parser failure without downloading output", async () => {
    const j = await job(); const h = harness(true);
    await expect(executeDopplerVm(j, undefined, async () => h.sdk)).rejects.toThrow("parser failed");
    expect(h.terminate).toHaveBeenCalled(); expect(h.exec).toHaveBeenCalledTimes(1);
  });
  it("refuses mutable images and pre-aborted jobs without opening a VM", async () => {
    const j = await job(); const h = harness(); vi.stubEnv("DOCSLURP_DOPPLER_VM_IMAGE", "registry/parser:latest");
    await expect(executeDopplerVm(j, undefined, async () => h.sdk)).rejects.toThrow("digest-pinned");
    await expect(executeDopplerVm(j, AbortSignal.abort(), async () => h.sdk)).rejects.toThrow("aborted");
    expect(h.create).not.toHaveBeenCalled();
  });
  it("caps streams during consumption", async () => {
    await expect(boundedStream(stream("12345"), 4)).rejects.toThrow("byte limit");
    expect((await boundedStream(stream("1234"), 4)).length).toBe(4);
    expect(MAX_PDF_BYTES).toBe(500 * 1024 * 1024);
  });
  it("uses a fresh VM and fixed remote paths for each job", async () => {
    const a = await job(); const b = await job(); const h = harness();
    await executeDopplerVm(a, undefined, async () => h.sdk); await executeDopplerVm(b, undefined, async () => h.sdk);
    expect(h.create).toHaveBeenCalledTimes(2); expect(h.terminate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.exec.mock.calls)).not.toContain(path.dirname(a.input));
  });
  it("refuses oversized files before any SDK or VM call", async () => {
    const j = await job(); const h = harness();
    const handle = await open(j.input, "w"); await handle.truncate(MAX_PDF_BYTES + 1); await handle.close();
    await expect(executeDopplerVm(j, undefined, async () => h.sdk)).rejects.toThrow("oversized");
    expect(h.create).not.toHaveBeenCalled();
  });
  it("destroys a running VM on cancellation with no output commit", async () => {
    const j = await job(); const h = harness(); const controller = new AbortController();
    let started!: () => void; const running = new Promise<void>(resolve => { started = resolve; });
    h.exec.mockImplementation(async () => { started(); await new Promise(() => {}); return undefined as never; });
    const pending = executeDopplerVm(j, controller.signal, async () => h.sdk);
    await running; controller.abort();
    await expect(pending).rejects.toThrow("aborted"); expect(h.terminate).toHaveBeenCalled();
    await expect(readFile(j.output)).rejects.toThrow();
  });
  it("destroys a VM when logs exceed their incremental cap", async () => {
    const j = await job(); const h = harness();
    h.exec.mockImplementation(async () => ({ stdout: stream("result"), stderr: stream("x".repeat(16385)), wait: async () => 0 }));
    await expect(executeDopplerVm(j, undefined, async () => h.sdk)).rejects.toThrow("byte limit");
    expect(h.terminate).toHaveBeenCalled(); expect(h.exec).toHaveBeenCalledTimes(1);
  });
  it("does not trust an SDK error merely because its text uses the internal prefix", async () => {
    const j = await job(); const h = harness();
    h.create.mockRejectedValue(new Error("Document VM auth failed secret-token"));
    await expect(executeDopplerVm(j, undefined, async () => h.sdk)).rejects.toThrow(/^Document VM execution failed$/);
  });
  it("does not expose control authentication errors or fall back locally", async () => {
    const j = await job(); const h = harness();
    h.create.mockRejectedValue(new Error("revoked secret-token"));
    await expect(executeDopplerVm(j, undefined, async () => h.sdk)).rejects.toThrow("Document VM execution failed");
    expect(h.exec).not.toHaveBeenCalled(); expect(h.close).toHaveBeenCalled();
  });

  it("destroys a running VM at the absolute deadline without committing output", async () => {
    const j = await job(); const h = harness();
    vi.useFakeTimers();
    let started!: () => void; const running = new Promise<void>(resolve => { started = resolve; });
    h.exec.mockImplementation(async () => { started(); await new Promise(() => {}); return undefined as never; });
    const pending = executeDopplerVm(j, undefined, async () => h.sdk);
    const rejected = expect(pending).rejects.toThrow("deadline exceeded");
    await running; await vi.advanceTimersByTimeAsync(VM_TIMEOUT_MS + 1); await rejected;
    expect(h.terminate).toHaveBeenCalled();
    await expect(readFile(j.output)).rejects.toThrow();
  });

  it.each(["abort", "deadline"])("bounds hung lookup on %s and never creates after lookup resolves late", async (mode) => {
    const j = await job(); const h = harness(); const controller = new AbortController();
    vi.useFakeTimers();
    let started!: () => void, resolveLookup!: (value: string) => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    h.fromName.mockImplementation(() => { started(); return new Promise(resolve => { resolveLookup = resolve; }); });
    const pending = executeDopplerVm(j, controller.signal, async () => h.sdk);
    const rejected = expect(pending).rejects.toThrow(mode === "abort" ? "aborted" : "deadline exceeded");
    await running;
    if (mode === "abort") controller.abort(); else await vi.advanceTimersByTimeAsync(VM_TIMEOUT_MS);
    await rejected; expect(h.close).toHaveBeenCalledOnce(); expect(h.create).not.toHaveBeenCalled();
    resolveLookup("late app"); await vi.advanceTimersByTimeAsync(0);
    expect(h.create).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
  });
  it.each(["abort", "deadline"])("bounds hung create on %s and terminates a late VM without staging", async (mode) => {
    const j = await job(); const h = harness(); const controller = new AbortController();
    vi.useFakeTimers();
    let started!: () => void, resolveCreate!: (value: typeof h.vm) => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    h.create.mockImplementation(() => { started(); return new Promise(resolve => { resolveCreate = resolve; }); });
    const pending = executeDopplerVm(j, controller.signal, async () => h.sdk);
    const rejected = expect(pending).rejects.toThrow(mode === "abort" ? "aborted" : "deadline exceeded");
    await running;
    if (mode === "abort") controller.abort(); else await vi.advanceTimersByTimeAsync(VM_TIMEOUT_MS);
    await rejected; expect(h.close).toHaveBeenCalledOnce();
    resolveCreate(h.vm); await vi.advanceTimersByTimeAsync(0);
    expect(h.reconnect).toHaveBeenCalledOnce(); expect(h.terminate).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledTimes(2);
    expect(h.makeDirectory).not.toHaveBeenCalled(); expect(h.writeBytes).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
  });
  it("bounds hung termination and closes its control client", async () => {
    const j = await job(); const h = harness(); vi.useFakeTimers();
    let started!: () => void; const running = new Promise<void>(resolve => { started = resolve; });
    h.terminate.mockImplementation(() => { started(); return new Promise(() => {}); });
    const pending = executeDopplerVm(j, undefined, async () => h.sdk);
    const rejected = expect(pending).rejects.toMatchObject({ message: expect.stringContaining("cleanup deadline"),
      usage: { costCents: dopplerVmUsage("image", VM_TIMEOUT_MS / 1000).costCents, metadata: { allocationUnconfirmed: true } } });
    await running; await vi.advanceTimersByTimeAsync(VM_CLEANUP_TIMEOUT_MS); await rejected;
    expect(h.close).toHaveBeenCalledOnce(); expect(h.terminate).toHaveBeenCalledOnce();
    await expect(readFile(j.output)).rejects.toThrow();
  });
  it("does not continue staging when an in-flight write resolves after abort", async () => {
    const j = await job(); const h = harness(); const controller = new AbortController();
    let started!: () => void, resolveWrite!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    h.writeBytes.mockImplementation(() => { started(); return new Promise(resolve => { resolveWrite = resolve; }); });
    const pending = executeDopplerVm(j, controller.signal, async () => h.sdk);
    await running; controller.abort(); await expect(pending).rejects.toThrow("aborted");
    resolveWrite(); await Promise.resolve(); await Promise.resolve();
    expect(h.exec).not.toHaveBeenCalled(); expect(h.terminate).toHaveBeenCalledOnce();
  });
  it("consumes a late creation rejection after cancellation", async () => {
    const j = await job(); const h = harness(); const controller = new AbortController();
    let started!: () => void, rejectCreate!: (reason: Error) => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    h.create.mockImplementation(() => { started(); return new Promise((_, reject) => { rejectCreate = reject; }); });
    const pending = executeDopplerVm(j, controller.signal, async () => h.sdk);
    await running; controller.abort(); await expect(pending).rejects.toThrow("aborted");
    rejectCreate(new Error("late SDK rejection")); await new Promise(resolve => setImmediate(resolve));
    expect(h.exec).not.toHaveBeenCalled();
  });

  it("refuses a FIFO without blocking input staging or starting a VM", async () => {
    const j = await job(); const h = harness(); await rm(j.input);
    expect(spawnSync("mkfifo", [j.input]).status).toBe(0);
    await expect(executeDopplerVm(j, undefined, async () => h.sdk)).rejects.toThrow("invalid or oversized");
    expect(h.create).not.toHaveBeenCalled();
  });
  it("retains conservative cost exposure when creation acknowledgement is lost", async () => {
    const j = await job(); const h = harness(); const controller = new AbortController();
    let started!: () => void; const running = new Promise<void>(r => { started = r; });
    h.create.mockImplementation(() => { started(); return new Promise(() => {}); });
    const pending = executeDopplerVm(j, controller.signal, async () => h.sdk).catch(e => e);
    await running; controller.abort(); const error = await pending;
    expect(error.usage).toMatchObject({ costCents: dopplerVmUsage("image", VM_TIMEOUT_MS / 1000).costCents, metadata: { allocationUnconfirmed: true } });
  });
  it("does not expose parser-controlled diagnostics", async () => {
    const j = await job(); const h = harness();
    h.exec.mockImplementation(async () => ({stdout:stream(""),stderr:stream("credential-bearing-url"),wait:async()=>2}));
    await expect(executeDopplerVm(j, undefined, async () => h.sdk)).rejects.toThrow(/^Document VM parser failed \(2\)$/);
  });

  it("preserves a valid empty one-page extraction for downstream OCR triage", async () => {
    const j = await job(); const h = harness();
    h.exec.mockImplementation(async () => ({stdout:stream(""),stderr:stream(diagnostics(0)),wait:async()=>0}));
    await executeDopplerVm(j, undefined, async () => h.sdk);
    expect(await readFile(j.output,"utf8")).toBe("");
  });

  it.each([
    "", "not-json", JSON.stringify({ engine: "doppler", outputBytes: 6, conversion: { pages: 1 } }),
    JSON.stringify({ protocol: "wrong", engine: "doppler", outputBytes: 6, conversion: { pages: 1 } }),
    JSON.stringify({ protocol: "doppler-vm@2", engine: "doppler", outputBytes: 5, conversion: { pages: 1 } }),
    JSON.stringify({ protocol: "doppler-vm@2", engine: "doppler", outputBytes: 6, conversion: { pages: 0 } }),
    JSON.stringify({ protocol: "doppler-vm@2", engine: "doppler", outputBytes: 6, conversion: { pages: 1.5 } }),
  ])("refuses an invalid successful guest envelope without publishing: %s", async envelope => {
    const j = await job(); const h = harness();
    h.exec.mockImplementation(async () => ({ stdout: stream("result"), stderr: stream(envelope), wait: async () => 0 }));
    await expect(executeDopplerVm(j, undefined, async () => h.sdk)).rejects.toThrow();
    await expect(readFile(j.output)).rejects.toThrow(); expect(h.terminate).toHaveBeenCalledOnce();
  });
  it("uses registry credentials only for image import", async () => {
    const j = await job(); const h = harness(); vi.stubEnv("DOCSLURP_DOPPLER_REGISTRY_SECRET", "registry-readonly");
    await executeDopplerVm(j, undefined, async () => h.sdk);
    expect(h.secretFromName).toHaveBeenCalledExactlyOnceWith("registry-readonly");
    expect(h.fromRegistry).toHaveBeenCalledWith(process.env.DOCSLURP_DOPPLER_VM_IMAGE, h.registrySecret);
    expect(h.create.mock.calls[0]?.[2]).toMatchObject({ secrets: [], env: {} });
  });
  it("refuses revoked or wrong-scope registry credentials without creating a VM", async () => {
    const j = await job(); const h = harness(); vi.stubEnv("DOCSLURP_DOPPLER_REGISTRY_SECRET", "revoked");
    h.secretFromName.mockRejectedValue(new Error("permission denied private-credential"));
    await expect(executeDopplerVm(j, undefined, async () => h.sdk)).rejects.toThrow(/^Document VM execution failed$/);
    expect(h.create).not.toHaveBeenCalled();
  });

});


it("streams a PDF above the old 64 MiB limit from a private bounded snapshot", async () => {
  const j = await job(); const h = harness();
  const source = await open(j.input, "w"); await source.truncate(65 * 1024 * 1024); await source.close();
  let copiedPath = "";
  h.copyFromLocal.mockImplementation(async (file, destination) => {
    copiedPath = file;
    expect(file).not.toBe(j.input); expect(destination).toBe("/job/input");
    const input = await open(file, "r"); expect((await input.stat()).size).toBe(65 * 1024 * 1024); await input.close();
  });
  await executeDopplerVm(j, undefined, async () => h.sdk);
  expect(h.copyFromLocal).toHaveBeenCalledOnce(); expect(h.writeBytes).not.toHaveBeenCalled();
  await expect(open(copiedPath, "r")).rejects.toThrow();
  expect(await readFile(j.output, "utf8")).toBe("result");
});

it("reserves full lifetime when early cancellation cannot confirm teardown", async () => {
  const j = await job(); const h = harness(); const controller = new AbortController(); vi.useFakeTimers();
  let ready!: () => void; const running = new Promise<void>(resolve => { ready = resolve; });
  let cleanup!: () => void; const cleaning = new Promise<void>(resolve => { cleanup = resolve; });
  h.exec.mockImplementation(async () => { ready(); return new Promise(() => {}); });
  h.terminate.mockImplementation(async () => { cleanup(); return new Promise(() => {}); });
  const pending = executeDopplerVm(j, controller.signal, async () => h.sdk).catch(error => error);
  await running; controller.abort(); await cleaning;
  await vi.advanceTimersByTimeAsync(VM_CLEANUP_TIMEOUT_MS);
  const error = await pending;
  expect(error.usage).toMatchObject({ costCents: dopplerVmUsage("image", VM_TIMEOUT_MS / 1000).costCents,
    metadata: { allocationUnconfirmed: true } });
  await expect(readFile(j.output)).rejects.toThrow();
});


it("uses a preimported image ID without giving production a registry credential", async () => {
  const j = await job(); const h = harness(); vi.stubEnv("DOCSLURP_DOPPLER_MODAL_IMAGE_ID", "im-imported");
  vi.stubEnv("DOCSLURP_DOPPLER_REGISTRY_SECRET", "must-not-use");
  await executeDopplerVm(j, undefined, async () => h.sdk);
  expect(h.fromId).toHaveBeenCalledExactlyOnceWith("im-imported");
  expect(h.fromRegistry).not.toHaveBeenCalled(); expect(h.secretFromName).not.toHaveBeenCalled();
});

it("does not fall back to registry when imported image resolution fails", async () => {
  const j = await job(); const h = harness(); vi.stubEnv("DOCSLURP_DOPPLER_MODAL_IMAGE_ID", "im-missing");
  h.fromId.mockRejectedValue(new Error("private-provider-detail"));
  await expect(executeDopplerVm(j, undefined, async () => h.sdk)).rejects.toThrow(/^Document VM execution failed$/);
  expect(h.fromRegistry).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
});

/** A mocked VM finishes within a millisecond; report a second of runtime so its cost is measurable. */
function elapsedClock() {
  const realNow = Date.now.bind(Date);
  const start = realNow();
  let reads = 0;
  return vi.spyOn(Date, "now").mockImplementation(() => (reads++ === 0 ? start : realNow() + 1_000));
}

describe("shard jobs and publication receipts", () => {
  it("recognises an old guest that ignored the range even when its output overran the shard cap", async () => {
    const j = await job(); const h = harness();
    h.exec.mockImplementation(async () => ({ stdout: stream("whole document output"), stderr: stream(diagnostics(21)), wait: async () => 0 }));
    const clock = elapsedClock();
    const error = await executeDopplerVm({ ...j, range: { first: 1, last: 32, final: false }, outputLimit: 4 }, undefined, async () => h.sdk).catch((e) => e);
    clock.mockRestore();
    expect(error.message).toBe(SHARDS_UNSUPPORTED_MESSAGE);
    expect(error.usage?.costCents).toBeGreaterThan(0);
  });

  it("keeps the old-guest classification when termination is unconfirmed", async () => {
    const j = await job(); const h = harness();
    h.terminate.mockImplementation(async () => { throw new Error("provider down"); });
    const error = await executeDopplerVm({ ...j, range: { first: 1, last: 32, final: false } }, undefined, async () => h.sdk).catch((e) => e);
    expect(error.message).toBe(SHARDS_UNSUPPORTED_MESSAGE);
    expect(error.usage?.metadata?.allocationUnconfirmed).toBe(true);
  });

  it("returns the VM's cost when publishing its output fails", async () => {
    const j = await job(); const h = harness();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(j.output); // rename onto a directory fails after a successful run
    const clock = elapsedClock();
    const error = await executeDopplerVm(j, undefined, async () => h.sdk).catch((e) => e);
    clock.mockRestore();
    expect(error.message).toBe("Document VM output publication failed");
    expect(error.usage?.costCents).toBeGreaterThan(0);
  });

  it("does not let a failing control-client close replace the result", async () => {
    const j = await job(); const h = harness();
    h.close.mockImplementation(() => { throw new Error("close failed"); });
    await expect(executeDopplerVm(j, undefined, async () => h.sdk)).resolves.toMatchObject({ exitCode: 0 });
    expect(await readFile(j.output, "utf8")).toBe("result");
  });
});

