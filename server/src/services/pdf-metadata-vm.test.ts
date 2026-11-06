import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pdfInfoInVm } from "./pdf-metadata-vm.js";
const image = "ghcr.io/docslurp/parser@sha256:" + "a".repeat(64);
const usage = vi.fn(async (_seconds: number) => {});
function stream(text: string) { return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(text)); c.close(); } }); }
function fake(options: { exit?: number; stdout?: string; stderr?: string; create?: () => Promise<unknown> } = {}) {
  const creates: unknown[] = []; const inputs: Uint8Array[] = []; const terminated: string[] = []; const closed: number[] = [];
  let id = 0;
  const vm = () => ({ sandboxId: String(++id), terminate: async function () { terminated.push(this.sandboxId); }, filesystem: { makeDirectory: async () => {}, writeBytes: async (bytes: Uint8Array) => { inputs.push(bytes); } }, exec: async () => ({ stdout: stream(options.stdout ?? "Pages: 14"), stderr: stream(options.stderr ?? ""), wait: async () => options.exit ?? 0 }) });
  const sdk = { ModalClient: class {
    apps = { fromName: async () => ({}) }; images = { fromRegistry: (ref: string) => ref };
    sandboxes = { create: async (_app: unknown, _image: unknown, settings: unknown) => { creates.push(settings); return options.create ? options.create() : vm(); } };
    close() { closed.push(1); }
  }, Sandbox: class { constructor(_client: unknown, readonly sandboxId: string) {} async terminate() { terminated.push(this.sandboxId); } } } as unknown as typeof import("modal");
  return { sdk, creates, inputs, terminated, closed, vm };
}
beforeEach(() => { vi.stubEnv("MODAL_TOKEN_ID", "control-token"); vi.stubEnv("MODAL_TOKEN_SECRET", "control-secret"); vi.stubEnv("DOCSLURP_METADATA_VM_IMAGE", image); usage.mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("PDF metadata VM boundary", () => {
  it("uses a dedicated secret-free networkless VM and persists usage", async () => {
    const f = fake();
    expect(await pdfInfoInVm(Buffer.from("PDF bytes"), usage, async () => f.sdk)).toBe("Pages: 14");
    expect(f.creates[0]).toMatchObject({ runtime: "vm", blockNetwork: true, includeOidcIdentityToken: false, secrets: [], env: {}, volumes: {}, cloudBucketMounts: {} });
    expect(f.inputs).toEqual([Buffer.from("PDF bytes")]); expect(f.terminated).toEqual(["1"]); expect(f.closed).toHaveLength(1); expect(usage).toHaveBeenCalledOnce();
  });
  it("does not interpret invalid guest PDFs as an infrastructure fallback", async () => {
    const f = fake({ exit: 1, stderr: "invalid PDF" });
    await expect(pdfInfoInVm(Buffer.from("malformed"), usage, async () => f.sdk)).rejects.toMatchObject({ exitCode: 1 });
    expect(f.terminated).toHaveLength(1); expect(usage).toHaveBeenCalledOnce();
  });
  it("rejects missing credentials and mutable images before allocating a VM", async () => {
    const load = vi.fn(); vi.stubEnv("MODAL_TOKEN_SECRET", "");
    await expect(pdfInfoInVm(Buffer.alloc(1), usage, load)).rejects.toThrow(/credentials/);
    vi.stubEnv("MODAL_TOKEN_SECRET", "secret"); vi.stubEnv("DOCSLURP_METADATA_VM_IMAGE", "image:latest");
    await expect(pdfInfoInVm(Buffer.alloc(1), usage, load)).rejects.toThrow(/digest/);
    expect(load).not.toHaveBeenCalled();
  });
  it("sanitizes revoked-credential errors without a local fallback", async () => {
    const f = fake({ create: async () => { throw new Error("revoked control-secret"); } });
    await expect(pdfInfoInVm(Buffer.alloc(1), usage, async () => f.sdk)).rejects.toThrow("PDF metadata VM failed; refusing local parsing");
    expect(f.inputs).toHaveLength(0); expect(f.closed).toHaveLength(1);
  });
  it("bounds guest output and terminates on overflow", async () => {
    const f = fake({ stdout: "x".repeat(128 * 1024 + 1) });
    await expect(pdfInfoInVm(Buffer.alloc(1), usage, async () => f.sdk)).rejects.toThrow(/limit/);
    expect(f.terminated).toHaveLength(1);
  });
  it("separates concurrent tenant input into fresh VMs", async () => {
    const f = fake(); await Promise.all([pdfInfoInVm(Buffer.from("A"), usage, async () => f.sdk), pdfInfoInVm(Buffer.from("B"), usage, async () => f.sdk)]);
    expect(f.creates).toHaveLength(2); expect(new Set(f.terminated).size).toBe(2); expect(f.inputs.map((b) => Buffer.from(b).toString()).sort()).toEqual(["A", "B"]);
  });
  it("closes a timed-out client promptly and terminates a late-created VM", async () => {
    vi.useFakeTimers(); let resolve!: (value: unknown) => void;
    const f = fake({ create: () => new Promise((r) => { resolve = r; }) });
    const pending = pdfInfoInVm(Buffer.from("A"), usage, async () => f.sdk).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toBeInstanceOf(Error); expect(f.closed).toHaveLength(1);
    resolve(f.vm()); await vi.advanceTimersByTimeAsync(1);
    expect(f.terminated).toEqual(["1"]); expect(f.closed).toHaveLength(2); expect(f.inputs).toHaveLength(0);
  });
});
