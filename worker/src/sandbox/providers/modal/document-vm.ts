import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ModalSdk } from "./index.js";
import { buildModalUsageEvent, resolveModalImage } from "./index.js";
import { SandboxRunError } from "../../types.js";

export interface LayoutVmRequest {
  model: "heron" | "heron-custom" | "ppv3" | "pp-small" | "pp-small-onnx";
  device: "cpu"; modelId: string; revision: string; artifactSha256: string; inferenceProfileSha256: string;
}
export type DocumentVmJob = {
  operation: "encode-webp" | "decode-webp" | "layout";
  layout?: LayoutVmRequest;
  input: string;
  output: string;
  effort?: number;
};
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_LOG_BYTES = 16 * 1024;
export const VM_TIMEOUT_MS = 60_000;
export const VM_CLEANUP_TIMEOUT_MS = 5_000;

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
      if (size > limit) throw new Error("VM transfer exceeded byte limit");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

// This program and Pillow are image assets, not host imports. Image.open/load/convert and
// frame/dimension checks all execute behind the VM kernel before codecs receive pixels.
export const IMAGE_PROGRAM = `
import os, sys, subprocess, resource
resource.setrlimit(resource.RLIMIT_FSIZE, (67108864, 67108864))
resource.setrlimit(resource.RLIMIT_CPU, (50, 50))
from PIL import Image
Image.MAX_IMAGE_PIXELS = 16000000
op, effort = sys.argv[1:]
with Image.open('/job/input') as image:
    w,h = image.size
    if w < 1 or h < 1 or w > 4096 or h > 4096 or w*h > 16000000 or getattr(image,'n_frames',1) != 1:
        raise ValueError('unsupported image dimensions or animation')
    image.load()
    if op == 'encode-webp':
        if image.format != 'PNG': raise ValueError('expected PNG')
        subprocess.run(['cwebp','-quiet','-lossless','-exact','-z',effort,'-metadata','none','-o','/job/output','/job/input'], check=True, timeout=50)
    elif op == 'decode-webp':
        if image.format != 'WEBP': raise ValueError('expected WebP')
        image.save('/job/output', format='PNG')
    else: raise ValueError('unsupported operation')
`;
const READ_OUTPUT = `
import os, stat, sys
fd = os.open('/job/output', os.O_RDONLY | os.O_NOFOLLOW)
s = os.fstat(fd)
if not stat.S_ISREG(s.st_mode) or s.st_size > 67108864: raise ValueError('invalid output')
remaining = 67108865
while remaining:
    chunk = os.read(fd, min(65536,remaining))
    if not chunk: break
    sys.stdout.buffer.write(chunk)
    remaining -= len(chunk)
`;

/** A fresh CPU VM per job; credentials are used only by the host-side control client. */
export async function executeDocumentVm(
  job: DocumentVmJob,
  signal?: AbortSignal,
  loadSdk: () => Promise<ModalSdk> = () => import("modal"),
) {
  if (signal?.aborted) throw new SandboxRunError("Document VM aborted");
  if (job.operation === "layout" && (!job.layout || job.layout.device !== "cpu")) throw new SandboxRunError("Document VM layout requires CPU; CUDA is unsupported");
  if (job.effort !== undefined && (!Number.isInteger(job.effort) || job.effort < 0 || job.effort > 9)) throw new Error("Invalid WebP effort");
  const image = resolveModalImage(process.env.DOCSLURP_DOCUMENT_VM_IMAGE ?? "", process.env.DOCSLURP_DOCUMENT_VM_IMAGE_DIGEST);
  if (!/^[^@]+@sha256:[0-9a-f]{64}$/.test(image)) throw new SandboxRunError("Document VM requires a verified digest-pinned DOCSLURP_DOCUMENT_VM_IMAGE with offline parser assets");
  const inputLimit = job.operation === "layout" ? 25 * 1024 * 1024 : MAX_IMAGE_BYTES;
  const input = await open(job.input, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const info = await input.stat();
    if (!info.isFile() || info.size > inputLimit) throw new Error("Invalid or oversized VM input");
    // An extra byte detects growth without an unbounded readFile allocation.
    bytes = Buffer.alloc(Math.min(info.size + 1, inputLimit + 1));
    const { bytesRead } = await input.read(bytes, 0, bytes.length, 0);
    if (bytesRead > inputLimit || bytesRead !== info.size) throw new Error("VM input changed or exceeded limit");
    bytes = bytes.subarray(0, bytesRead);
  } finally { await input.close(); }
  // Every asynchronous control operation shares this absolute deadline, including SDK
  // loading, app lookup and creation. A losing promise always retains rejection handlers.
  const started = Date.now();
  let cancelled = false;
  let finished = false;
  let rejectStop!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  stopped.catch(() => {});
  const stop = (message: string) => { cancelled = true; rejectStop(new Error(message)); };
  const onAbort = () => stop("Document VM aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("Document VM deadline exceeded"), VM_TIMEOUT_MS);
  function checkActive(): void {
    if (signal?.aborted) onAbort();
    if (!cancelled && Date.now() - started >= VM_TIMEOUT_MS) stop("Document VM deadline exceeded");
    if (cancelled || finished) throw new Error(signal?.aborted ? "Document VM aborted" : "Document VM deadline exceeded");
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
  function terminate(target: NonNullable<typeof vm>): Promise<void> {
    // The control client is closed promptly when creation hangs. If creation later
    // returns an ID, use a fresh control client solely to terminate that VM.
    terminating ??= (async () => {
      let cleanupClient: typeof client;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending = Promise.resolve().then(() => {
          if (!clientClosed) return target.terminate();
          cleanupClient = new sdk!.ModalClient({ tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET });
          return new sdk!.Sandbox(cleanupClient, target.sandboxId).terminate();
        });
        await Promise.race([pending, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Document VM termination deadline exceeded")), VM_CLEANUP_TIMEOUT_MS);
        })]);
      } finally { clearTimeout(timeout); cleanupClient?.close(); }
    })();
    // Late cleanup has no awaiting caller; consume failures and emit a fixed, safe refusal.
    terminating.catch(() => {});
    return terminating;
  }
  try {
    sdk = await control(loadSdk);
    checkActive();
    client = new sdk.ModalClient({ tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET });
    const app = await control(() => client!.apps.fromName("docslurp-document-vm", { createIfMissing: true }));
    vm = await control(() => client!.sandboxes.create(app, client!.images.fromRegistry(image), {
      runtime: "vm", cpu: 2, cpuLimit: 2, memoryMiB: 1024, memoryLimitMiB: 1024,
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
      await control(() => vm!.filesystem.makeDirectory("/job"));
      await control(() => vm!.filesystem.writeBytes(bytes, "/job/input"));
      const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/job", TMPDIR: "/job", PYTHONNOUSERSITE: "1", CUDA_VISIBLE_DEVICES: "", HF_HUB_OFFLINE: "1" };
      const parserArgs = job.operation === "layout"
        ? ["python3", "-P", "/opt/docslurp/layout/runtime/vm_entry.py", JSON.stringify(job.layout)]
        : ["python3", "-I", "-c", IMAGE_PROGRAM, job.operation, String(job.effort ?? 1)];
      const child = await control(() => vm!.exec(["/usr/bin/env", "-i", ...Object.entries(env).map(([k,v]) => `${k}=${v}`), ...parserArgs], { timeoutMs: 55_000, mode: "binary" }));
      const [stdout, stderr, code] = await control(() => Promise.all([boundedStream(child.stdout, MAX_LOG_BYTES), boundedStream(child.stderr, MAX_LOG_BYTES), child.wait()]));
      if (code !== 0) throw new Error(`Document VM parser failed (${code}): ${stderr.toString("utf8").slice(0, 1000)}`);
      // Transfer exactly one declared output via a bounded stream, never a recursive tree.
      const transfer = await control(() => vm!.exec(["python3", "-I", "-c", READ_OUTPUT], { timeoutMs: 5_000, mode: "binary" }));
      const [output, , transferCode] = await control(() => Promise.all([boundedStream(transfer.stdout, job.operation === "layout" ? 10 * 1024 * 1024 : MAX_IMAGE_BYTES), boundedStream(transfer.stderr, MAX_LOG_BYTES), transfer.wait()]));
      if (transferCode !== 0 || output.length === 0) throw new Error("Document VM output transfer failed");
      if (cancelled) throw new Error("Document VM cancelled before output commit");
      await control(() => writeFile(job.output, output));
      return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode: 0,
        usage: buildModalUsageEvent({ tokenId: "", tokenSecret: "", app: "docslurp-document-vm", image, cpu: 2, memoryMb: 1024, sessionTimeoutSeconds: 60 }, randomUUID(), (Date.now() - started) / 1000) };
    })();
    return await work;
  } catch (error) {
    // Raw SDK errors can contain control credentials. Keep them out of logs.
    const message = error instanceof Error && error.message.startsWith("Document VM") ? error.message : "Document VM execution failed";
    throw new SandboxRunError(message, vm ? buildModalUsageEvent({ tokenId: "", tokenSecret: "", app: "docslurp-document-vm", image, cpu: 2, memoryMb: 1024, sessionTimeoutSeconds: 60 }, randomUUID(), (Date.now() - started) / 1000) : undefined);
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    try {
      if (vm) await terminate(vm);
    } catch { throw new SandboxRunError("Document VM termination failed or exceeded cleanup deadline"); }
    finally { clientClosed = true; client?.close(); }
  }
}
