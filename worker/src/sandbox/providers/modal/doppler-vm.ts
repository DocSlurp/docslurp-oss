import { constants, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, writeFile, rm } from "node:fs/promises";
import type { ModalSdk } from "./index.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOPPLER_MAX_PDF_BYTES } from "@docslurp/shared";
import { resolveModalImage } from "./index.js";
import { SandboxRunError } from "../../types.js";
import type { UsageEvent } from "../../../models.js";

// Only failures constructed here may carry diagnostic text across the SDK boundary.
class DopplerVmFailure extends Error {}

/** `range` asks the guest for one parallel shard; it must start on the guest's 32-page chunk grid. */
export type DopplerVmJob = {
  operation: "doppler-markdown"; input: string; output: string;
  range?: { first: number; last: number; final: boolean };
  /** Per-shard output cap, at most MAX_OUTPUT_BYTES: parallel shards share one host's memory. */
  outputLimit?: number;
  /** The host's page count: a shard whose guest counts differently fails at once, not at the final shard. */
  expectedDocumentPages?: number;
};

export const PAGE_COUNT_MISMATCH_MESSAGE = "Document VM page count disagrees with the host";

/** The image's guest protocol as declared by the deploy beside its digest (0 when unset or invalid). */
export function declaredGuestProtocol(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.DOCSLURP_DOPPLER_VM_PROTOCOL?.trim() ?? "";
  return /^[2-4]$/.test(value) ? Number(value) : 0;
}

/** Protocol 4 guests confine themselves with no_new_privs, Landlock (ABI >= 4) and seccomp, and report it. */
export function validHardening(hardening: unknown): boolean {
  const h = hardening as { noNewPrivs?: unknown; landlockAbi?: unknown; seccompDenied?: unknown } | null;
  return h?.noNewPrivs === true && Number.isSafeInteger(h.landlockAbi) && (h.landlockAbi as number) >= 4 &&
    Number.isSafeInteger(h.seccompDenied) && (h.seccompDenied as number) > 0;
}

/** Thrown when a ranged job reaches a guest that predates shards; callers stop sharding on it. */
export const SHARDS_UNSUPPORTED_MESSAGE = "Document VM image does not support page-range shards";
export const MAX_PDF_BYTES = DOPPLER_MAX_PDF_BYTES;
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const INPUT_BUFFER_BYTES = 8 * 1024 * 1024;
export const MAX_LOG_BYTES = 16 * 1024;
export const VM_TIMEOUT_MS = 180_000;
export const VM_CLEANUP_TIMEOUT_MS = 5_000;
export const GUEST_CHUNK_PAGES = 32;

/** Host-side shape check; the guest re-validates against its own page count. */
export function validShardRange(range: DopplerVmJob["range"]): boolean {
  if (!range) return true;
  const { first, last, final } = range;
  return Number.isSafeInteger(first) && Number.isSafeInteger(last) && typeof final === "boolean" &&
    first >= 1 && last >= first && (first - 1) % GUEST_CHUNK_PAGES === 0 && (final || last % GUEST_CHUNK_PAGES === 0);
}

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

/**
 * The guest's diagnostic envelope must match its output. A shard must come from a range-aware guest
 * (`doppler-vm@3`) that echoes the requested range: an older image ignores the request and converts the
 * whole document, which would duplicate pages after the merge. Whole-document jobs accept either protocol
 * so a worker can roll out ahead of its image.
 */
export function validEnvelope(
  diagnostics: { protocol?: unknown; engine?: unknown; outputBytes?: unknown; hardening?: unknown; conversion?: Record<string, unknown> },
  output: Buffer,
  range: DopplerVmJob["range"],
  declared = declaredGuestProtocol(),
): boolean {
  // An image declared hardened must prove it on every result: an older or unconfined guest fails closed.
  if (declared >= 4 && (diagnostics.protocol !== "doppler-vm@4" || !validHardening(diagnostics.hardening))) return false;
  if (diagnostics.protocol === "doppler-vm@4" && !validHardening(diagnostics.hardening)) return false;
  const conversion = diagnostics.conversion ?? {};
  const pages = conversion.pages;
  if (diagnostics.engine !== "doppler" || diagnostics.outputBytes !== output.length || !Number.isSafeInteger(pages) || (pages as number) < 1) return false;
  // Every page owns one slot; slots are separated by form feeds.
  let separators = 0;
  for (const byte of output) if (byte === 0x0c) separators++;
  if (diagnostics.protocol === "doppler-vm@2") return !range;
  if (diagnostics.protocol !== "doppler-vm@3" && diagnostics.protocol !== "doppler-vm@4") return false;
  const documentPages = conversion.documentPages;
  if (separators !== (pages as number) - 1 || !Number.isSafeInteger(documentPages)) return false;
  const first = range?.first ?? 1;
  const last = range?.last ?? documentPages;
  if (conversion.first !== first || conversion.last !== last || pages !== (last as number) - first + 1) return false;
  if (!range) return true;
  return range.final ? documentPages === range.last : (documentPages as number) > range.last;
}

function guestProtocol(stderr: Buffer): unknown {
  try { return (JSON.parse(stderr.toString("utf8")) as { protocol?: unknown }).protocol; } catch { return undefined; }
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
  if (!validShardRange(job.range)) throw new SandboxRunError("Document VM invalid shard range");
  const outputLimit = Math.min(MAX_OUTPUT_BYTES, job.outputLimit ?? MAX_OUTPUT_BYTES);
  if (!(outputLimit > 0)) throw new SandboxRunError("Document VM invalid output limit");
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
  let inputDirectory: string | undefined;
  let succeeded = false;
  let allocationUsage: UsageEvent | undefined;
  let primaryMessage: string | undefined;
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
    const stagedInput = await control(async () => {
      const input = await open(job.input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let snapshot: Awaited<ReturnType<typeof open>> | undefined;
      try {
        checkActive();
        const info = await input.stat();
        if (!info.isFile() || info.size > MAX_PDF_BYTES) throw new DopplerVmFailure("Document VM invalid or oversized input");
        const inMemory = info.size <= INPUT_BUFFER_BYTES;
        const buffer = Buffer.alloc(inMemory ? info.size + 1 : 1024 * 1024);
        let snapshotPath: string | undefined;
        if (!inMemory) {
          inputDirectory = await mkdtemp(join(tmpdir(), "doppler-input-"));
          checkActive();
          snapshotPath = join(inputDirectory, "input");
          snapshot = await open(snapshotPath, "wx", 0o600);
        }
        let total = 0;
        for (;;) {
          checkActive();
          const { bytesRead } = await input.read(buffer, inMemory ? total : 0, Math.min(buffer.length - (inMemory ? total : 0), info.size - total + 1), total);
          checkActive();
          if (!bytesRead) break;
          total += bytesRead;
          if (total > info.size) throw new DopplerVmFailure("VM input changed or exceeded limit");
          if (snapshot) {
            let written = 0;
            while (written < bytesRead) {
              const result = await snapshot.write(buffer, written, bytesRead - written);
              checkActive();
              if (!result.bytesWritten) throw new DopplerVmFailure("VM input staging failed");
              written += result.bytesWritten;
            }
          }
        }
        const after = await input.stat();
        if (total !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
          throw new DopplerVmFailure("VM input changed or exceeded limit");
        }
        return snapshotPath ? { path: snapshotPath } : { bytes: buffer.subarray(0, total) };
      } finally {
        await snapshot?.close();
        await input.close();
        if (cancelled && inputDirectory) await rm(inputDirectory, { recursive: true, force: true });
      }
    });
    sdk = await control(loadSdk);
    checkActive();
    client = new sdk.ModalClient({ tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET });
    const app = await control(() => client!.apps.fromName("docslurp-doppler-vm", { createIfMissing: true }));
    const importedId = process.env.DOCSLURP_DOPPLER_MODAL_IMAGE_ID;
    if (importedId && !/^im-[A-Za-z0-9]+$/.test(importedId)) throw new DopplerVmFailure("Invalid imported document VM image ID");
    const registrySecret = !importedId && process.env.DOCSLURP_DOPPLER_REGISTRY_SECRET
      ? await control(() => client!.secrets.fromName(process.env.DOCSLURP_DOPPLER_REGISTRY_SECRET!))
      : undefined;
    const vmImage = importedId
      ? await control(() => client!.images.fromId(importedId))
      : client.images.fromRegistry(image, registrySecret);
    creationRequested = true;
    vm = await control(() => client!.sandboxes.create(app, vmImage, {
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
      await control(() => stagedInput.path
        ? vm!.filesystem.copyFromLocal(stagedInput.path, "/job/input")
        : vm!.filesystem.writeBytes(stagedInput.bytes!, "/job/input"));
      if (job.range) {
        const { first, last, final } = job.range;
        await control(() => vm!.filesystem.writeBytes(Buffer.from(JSON.stringify({ first, last, final })), "/job/shard.json"));
      }
      const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/job", TMPDIR: "/job", PYTHONNOUSERSITE: "1", CUDA_VISIBLE_DEVICES: "", HF_HUB_OFFLINE: "1" };
      const parserArgs = ["python3", "-I", "/opt/docslurp/doppler-vm.py"];
      const child = await control(() => vm!.exec(["/usr/bin/env", "-i", ...Object.entries(env).map(([k,v]) => `${k}=${v}`), ...parserArgs], { timeoutMs: 155_000, mode: "binary" }));
      const [out, err, exit] = await control(() => Promise.allSettled([boundedStream(child.stdout, outputLimit), boundedStream(child.stderr, MAX_LOG_BYTES), child.wait()]));
      // The guest writes its envelope before streaming Markdown, so an old guest that ignored the range is
      // recognised even when its whole-document output overran this shard's cap.
      if (job.range && err.status === "fulfilled" && guestProtocol(err.value) === "doppler-vm@2") throw new DopplerVmFailure(SHARDS_UNSUPPORTED_MESSAGE);
      if (out.status === "rejected") throw out.reason;
      if (err.status === "rejected") throw err.reason;
      if (exit.status === "rejected") throw exit.reason;
      const [output, stderr, code] = [out.value, err.value, exit.value];
      if (code !== 0) throw new DopplerVmFailure(`Document VM parser failed (${code})`);
      // The fixed guest streams Markdown only after successful bounded extraction.
      // Its small diagnostic envelope distinguishes a valid empty page from a broken guest.
      const diagnostics = JSON.parse(stderr.toString("utf8"));
      if (job.range && diagnostics.protocol === "doppler-vm@2") throw new DopplerVmFailure(SHARDS_UNSUPPORTED_MESSAGE);
      if (job.expectedDocumentPages !== undefined && diagnostics.conversion?.documentPages !== job.expectedDocumentPages) {
        throw new DopplerVmFailure(PAGE_COUNT_MISMATCH_MESSAGE);
      }
      if (!validEnvelope(diagnostics, output, job.range)) throw new DopplerVmFailure("Document VM invalid result envelope");
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
    primaryMessage = message;
    const exposure = vm ? usage() : creationRequested ? dopplerVmUsage(image, VM_TIMEOUT_MS / 1000) : undefined;
    if (exposure && !vm) exposure.metadata = { ...exposure.metadata, allocationUnconfirmed: true,
      estimateReason: "Creation acknowledgement missing; conservatively reserve full configured VM lifetime" };
    allocationUsage = exposure;
    throw new SandboxRunError(message, exposure);
  } finally {
    finished = true;
    try {
      try { if (vm) await terminate(vm); }
      catch {
        const exposure = dopplerVmUsage(image, Math.max(VM_TIMEOUT_MS / 1000, (Date.now() - started) / 1000));
        exposure.metadata = { ...exposure.metadata, allocationUnconfirmed: true,
          estimateReason: "VM termination unconfirmed; reserve full configured lifetime" };
        // Keep an old-image refusal recognisable: callers stop sharding on it.
        throw new SandboxRunError(primaryMessage === SHARDS_UNSUPPORTED_MESSAGE ? SHARDS_UNSUPPORTED_MESSAGE
          : "Document VM termination failed or exceeded cleanup deadline", exposure);
      }
      if (vm && allocationUsage) Object.assign(allocationUsage, usage());
      if (succeeded && stagedOutput) {
        if (cancelled || signal?.aborted || Date.now() - started >= VM_TIMEOUT_MS) {
          throw new SandboxRunError("Document VM cancelled before output commit", usage());
        }
        // No await between final cancellation check and atomic publication.
        try { renameSync(stagedOutput, job.output); }
        catch { throw new SandboxRunError("Document VM output publication failed", usage()); }
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      clientClosed = true;
      // Cleanup never replaces the result or a usage-bearing error.
      try { client?.close(); } catch { /* control client already unusable */ }
      if (stagedOutput) await rm(stagedOutput, { force: true }).catch(() => {});
      if (inputDirectory) await rm(inputDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}
