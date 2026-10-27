import { constants, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, writeFile, rm } from "node:fs/promises";
import type { ModalSdk } from "./index.js";
import { resolveModalImage } from "./index.js";
import { SandboxRunError } from "../../types.js";
import type { UsageEvent } from "../../../models.js";

// Only failures constructed here may carry diagnostic text across the SDK boundary.
class DopplerVmFailure extends Error {}

export type DopplerVmJob = { operation: "doppler-markdown"; input: string; output: string; };
export const MAX_PDF_BYTES = 64 * 1024 * 1024;
export const MAX_LOG_BYTES = 16 * 1024;
export const VM_TIMEOUT_MS = 60_000;
export const VM_CLEANUP_TIMEOUT_MS = 5_000;

/** Sandbox list prices verified 2026-10-27 at https://modal.com/pricing.
 * This is an allocation estimate, not a provider invoice. CPU is physical cores.
 */
export function dopplerVmUsage(image: string, seconds: number): UsageEvent {
  const duration = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const costCents = duration * (0.00003942 + 0.00000667) * 100;
  return { provider: "modal", model: "doppler-document-vm", metric: "sandbox_compute",
    amount: costCents, unit: "cent", costCents,
    metadata: { image, sandboxProvider: "modal", costRole: "provider", costSource: "estimate",
      costRollup: "authoritative", billable: false, physicalCores: 0.5, physicalCoreLimit: 1, memoryGiB: 1,
      estimateBasis: "configured CPU ceiling; actual burst usage is not yet metered",
      costFloorCents: duration * (0.5 * 0.00003942 + 0.00000667) * 100,
      wallSeconds: duration, rateObservedAt: "2026-10-27", rateSource: "https://modal.com/pricing",
      excludes: ["image import", "storage", "egress", "regional multipliers"],
    } };
}

/** Read incrementally: readText/readBytes allocate the complete hostile stream. */
export async function boundedStream(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new DopplerVmFailure("VM transfer exceeded byte limit");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/** A fresh CPU VM per job; credentials are used only by the host-side control client. */
export async function executeDopplerVm(
  job: DopplerVmJob,
  signal?: AbortSignal,
  loadSdk: () => Promise<ModalSdk> = () => import("modal"),
) {
  if (signal?.aborted) throw new SandboxRunError("Document VM aborted");
  const image = resolveModalImage(process.env.DOCSLURP_DOPPLER_VM_IMAGE ?? "", undefined);
  if (!/^[^@]+@sha256:[0-9a-f]{64}$/.test(image)) throw new SandboxRunError("Document VM requires a verified digest-pinned DOCSLURP_DOPPLER_VM_IMAGE with offline parser assets");
  // Every asynchronous control operation shares this absolute deadline, including SDK
  // loading, app lookup and creation. A losing promise always retains rejection handlers.
  const started = Date.now();
  const cpu = 0.5;
  const usage = () => dopplerVmUsage(image, (Date.now() - started) / 1000);
  let cancelled = false;
  let finished = false;
  let rejectStop!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  stopped.catch(() => {});
  const stop = (message: string) => { cancelled = true; rejectStop(new DopplerVmFailure(message)); };
  const onAbort = () => stop("Document VM aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("Document VM deadline exceeded"), VM_TIMEOUT_MS);
  function checkActive(): void {
    if (signal?.aborted) onAbort();
    if (!cancelled && Date.now() - started >= VM_TIMEOUT_MS) stop("Document VM deadline exceeded");
    if (cancelled || finished) throw new DopplerVmFailure(signal?.aborted ? "Document VM aborted" : "Document VM deadline exceeded");
  }
  async function control<T>(operation: () => Promise<T>): Promise<T> {
    checkActive();
    const pending = Promise.resolve().then(() => { checkActive(); return operation(); });
    const value = await Promise.race([pending, stopped]);
    checkActive();
    return value;
  }
  let sdk: ModalSdk | undefined;
  let client: InstanceType<ModalSdk["ModalClient"]> | undefined;
  let clientClosed = false;
  let vm: Awaited<ReturnType<InstanceType<ModalSdk["ModalClient"]>["sandboxes"]["create"]>> | undefined;
  let terminating: Promise<void> | undefined;
  let creationRequested = false;
  let stagedOutput: string | undefined;
  let succeeded = false;
  let allocationUsage: UsageEvent | undefined;
  function terminate(target: NonNullable<typeof vm>): Promise<void> {
    // The control client is closed promptly when creation hangs. If creation later
    // returns an ID, use a fresh control client solely to terminate that VM.
    terminating ??= (async () => {
      let cleanupClient: typeof client;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending = Promise.resolve().then(() => {
          if (!clientClosed) return target.terminate({ wait: true });
          cleanupClient = new sdk!.ModalClient({ tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET });
          return new sdk!.Sandbox(cleanupClient, target.sandboxId).terminate({ wait: true });
        });
        await Promise.race([pending, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new DopplerVmFailure("Document VM termination deadline exceeded")), VM_CLEANUP_TIMEOUT_MS);
        })]);
      } finally { clearTimeout(timeout); cleanupClient?.close(); }
    })();
    // Late cleanup has no awaiting caller; consume failures and emit a fixed, safe refusal.
    terminating.catch(() => {});
    return terminating;
  }
  try {
    const bytes = await control(async () => {

      const input = await open(job.input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const info = await input.stat();
        if (!info.isFile() || info.size > MAX_PDF_BYTES) throw new DopplerVmFailure("Document VM invalid or oversized input");
        // An extra byte detects growth without an unbounded readFile allocation.
        bytes = Buffer.alloc(Math.min(info.size + 1, MAX_PDF_BYTES + 1));
        const { bytesRead } = await input.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_PDF_BYTES || bytesRead !== info.size) throw new DopplerVmFailure("VM input changed or exceeded limit");
        bytes = bytes.subarray(0, bytesRead);
      } finally { await input.close(); }
      return bytes;
    });
    sdk = await control(loadSdk);
    checkActive();
    client = new sdk.ModalClient({ tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET });
    const app = await control(() => client!.apps.fromName("docslurp-doppler-vm", { createIfMissing: true }));
    const registrySecret = process.env.DOCSLURP_DOPPLER_REGISTRY_SECRET
      ? await control(() => client!.secrets.fromName(process.env.DOCSLURP_DOPPLER_REGISTRY_SECRET!))
      : undefined;
    creationRequested = true;
    vm = await control(() => client!.sandboxes.create(app, client!.images.fromRegistry(image, registrySecret), {
      runtime: "vm", cpu, cpuLimit: 1, memoryMiB: 1024, memoryLimitMiB: 1024,
      timeoutMs: VM_TIMEOUT_MS, blockNetwork: true, includeOidcIdentityToken: false,
      env: {}, secrets: [], volumes: {}, cloudBucketMounts: {},
    }).then((created) => {
      vm = created;
      if (cancelled || finished) void terminate(created).catch(() => {
        console.warn("[document-vm] late VM termination failed; provider lifetime limit remains enforced");
      });
      return created;
    }));
    const work = (async () => {
      await control(() => vm!.filesystem.writeBytes(bytes, "/job/input"));
      const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/job", TMPDIR: "/job", PYTHONNOUSERSITE: "1", CUDA_VISIBLE_DEVICES: "", HF_HUB_OFFLINE: "1" };
      const parserArgs = ["python3", "-I", "/opt/docslurp/doppler-vm.py"];
      const child = await control(() => vm!.exec(["/usr/bin/env", "-i", ...Object.entries(env).map(([k,v]) => `${k}=${v}`), ...parserArgs], { timeoutMs: 55_000, mode: "binary" }));
      const [output, stderr, code] = await control(() => Promise.all([boundedStream(child.stdout, MAX_PDF_BYTES), boundedStream(child.stderr, MAX_LOG_BYTES), child.wait()]));
      if (code !== 0) throw new DopplerVmFailure(`Document VM parser failed (${code})`);
      // The fixed guest streams Markdown only after successful bounded extraction.
      // Its small diagnostic envelope distinguishes a valid empty page from a broken guest.
      const diagnostics = JSON.parse(stderr.toString("utf8"));
      if (diagnostics.protocol !== "doppler-vm@1" || diagnostics.engine !== "doppler" || diagnostics.outputBytes !== output.length ||
          !Number.isSafeInteger(diagnostics.conversion?.pages) || diagnostics.conversion.pages < 1) {
        throw new DopplerVmFailure("Document VM invalid result envelope");
      }
      if (cancelled) throw new DopplerVmFailure("Document VM cancelled before output commit");
      stagedOutput = `${job.output}.${randomUUID()}.partial`;
      // Bounded local write is awaited so cancellation cannot race its cleanup.
      await writeFile(stagedOutput, output, { flag: "wx", mode: 0o600 });
      checkActive();
      succeeded = true;
      return { stdout: JSON.stringify(diagnostics), stderr: "", exitCode: 0,
        usage: (allocationUsage = usage()) };
    })();
    return await work;
  } catch (error) {
    // Raw SDK errors can contain control credentials. Keep them out of logs.
    const message = error instanceof DopplerVmFailure ? error.message : "Document VM execution failed";
    const exposure = vm ? usage() : creationRequested ? dopplerVmUsage(image, VM_TIMEOUT_MS / 1000) : undefined;
    if (exposure && !vm) exposure.metadata = { ...exposure.metadata, allocationUnconfirmed: true,
      estimateReason: "Creation acknowledgement missing; conservatively reserve full configured VM lifetime" };
    allocationUsage = exposure;
    throw new SandboxRunError(message, exposure);
  } finally {
    finished = true;
    try {
      try { if (vm) await terminate(vm); }
      catch { throw new SandboxRunError("Document VM termination failed or exceeded cleanup deadline", usage()); }
      if (vm && allocationUsage) Object.assign(allocationUsage, usage());
      if (succeeded && stagedOutput) {
        if (cancelled || signal?.aborted || Date.now() - started >= VM_TIMEOUT_MS) {
          throw new SandboxRunError("Document VM cancelled before output commit", usage());
        }
        // No await between final cancellation check and atomic publication.
        renameSync(stagedOutput, job.output);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      clientClosed = true; client?.close();
      if (stagedOutput) await rm(stagedOutput, { force: true });
    }
  }
}
