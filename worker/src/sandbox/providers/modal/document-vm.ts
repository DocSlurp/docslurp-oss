import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ModalSdk } from "./index.js";
import { buildModalUsageEvent, resolveModalImage } from "./index.js";
import { SandboxRunError } from "../../types.js";

export type DocumentVmJob = {
  operation: "encode-webp" | "decode-webp";
  input: string;
  output: string;
  effort?: number;
};
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_LOG_BYTES = 16 * 1024;
export const VM_TIMEOUT_MS = 60_000;

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
const IMAGE_PROGRAM = `
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
  if (job.effort !== undefined && (!Number.isInteger(job.effort) || job.effort < 0 || job.effort > 9)) throw new Error("Invalid WebP effort");
  const image = resolveModalImage(process.env.DOCSLURP_DOCUMENT_VM_IMAGE ?? "", process.env.DOCSLURP_DOCUMENT_VM_IMAGE_DIGEST);
  if (!/^[^@]+@sha256:[0-9a-f]{64}$/.test(image)) throw new SandboxRunError("Document VM requires a verified digest-pinned DOCSLURP_DOCUMENT_VM_IMAGE with offline parser assets");
  const input = await open(job.input, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const info = await input.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error("Invalid or oversized VM input");
    // An extra byte detects growth without an unbounded readFile allocation.
    bytes = Buffer.alloc(Math.min(info.size + 1, MAX_IMAGE_BYTES + 1));
    const { bytesRead } = await input.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_IMAGE_BYTES || bytesRead !== info.size) throw new Error("VM input changed or exceeded limit");
    bytes = bytes.subarray(0, bytesRead);
  } finally { await input.close(); }
  const sdk = await loadSdk();
  const client = new sdk.ModalClient({ tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET });
  let vm: Awaited<ReturnType<typeof client.sandboxes.create>> | undefined;
  let terminating: Promise<void> | undefined;
  const destroy = () => terminating ??= (async () => { await vm?.terminate(); })();
  let cancelled = false;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  aborted.catch(() => {});
  const onAbort = () => { cancelled = true; rejectAbort(new Error("Document VM aborted")); void destroy().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  const started = Date.now();
  const timer = setTimeout(() => { cancelled = true; rejectAbort(new Error("Document VM deadline exceeded")); void destroy().catch(() => {}); }, VM_TIMEOUT_MS);
  try {
    const app = await client.apps.fromName("docslurp-document-vm", { createIfMissing: true });
    // Do not race creation: a late creation must still be terminated in finally.
    vm = await client.sandboxes.create(app, client.images.fromRegistry(image), {
      runtime: "vm", cpu: 2, cpuLimit: 2, memoryMiB: 1024, memoryLimitMiB: 1024,
      timeoutMs: VM_TIMEOUT_MS, blockNetwork: true, includeOidcIdentityToken: false,
      env: {}, secrets: [], volumes: {}, cloudBucketMounts: {},
    });
    if (signal?.aborted || Date.now() - started >= VM_TIMEOUT_MS) throw new Error("Document VM cancelled during creation");
    const work = (async () => {
      await vm!.filesystem.makeDirectory("/job");
      await vm!.filesystem.writeBytes(bytes, "/job/input");
      const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/job", TMPDIR: "/job", PYTHONNOUSERSITE: "1", CUDA_VISIBLE_DEVICES: "", HF_HUB_OFFLINE: "1" };
      const child = await vm!.exec(["/usr/bin/env", "-i", ...Object.entries(env).map(([k,v]) => `${k}=${v}`), "python3", "-I", "-c", IMAGE_PROGRAM, job.operation, String(job.effort ?? 1)], { timeoutMs: 55_000, mode: "binary" });
      const [stdout, stderr, code] = await Promise.all([boundedStream(child.stdout, MAX_LOG_BYTES), boundedStream(child.stderr, MAX_LOG_BYTES), child.wait()]);
      if (code !== 0) throw new Error(`Document VM parser failed (${code}): ${stderr.toString("utf8").slice(0, 1000)}`);
      // Transfer exactly one declared output via a bounded stream, never a recursive tree.
      const transfer = await vm!.exec(["python3", "-I", "-c", READ_OUTPUT], { timeoutMs: 5_000, mode: "binary" });
      const [output, , transferCode] = await Promise.all([boundedStream(transfer.stdout, MAX_IMAGE_BYTES), boundedStream(transfer.stderr, MAX_LOG_BYTES), transfer.wait()]);
      if (transferCode !== 0 || output.length === 0) throw new Error("Document VM output transfer failed");
      if (cancelled) throw new Error("Document VM cancelled before output commit");
      await writeFile(job.output, output);
      return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode: 0,
        usage: buildModalUsageEvent({ tokenId: "", tokenSecret: "", app: "docslurp-document-vm", image, cpu: 2, memoryMb: 1024, sessionTimeoutSeconds: 60 }, randomUUID(), (Date.now() - started) / 1000) };
    })();
    return await Promise.race([work, aborted]);
  } catch (error) {
    // Raw SDK errors can contain control credentials. Keep them out of logs.
    const message = error instanceof Error && error.message.startsWith("Document VM") ? error.message : "Document VM execution failed";
    throw new SandboxRunError(message);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    try {
      // Creation may have completed after an earlier abort; always terminate the returned VM.
      if (terminating) await terminating;
      await vm?.terminate();
    } catch { throw new SandboxRunError("Document VM termination failed"); } finally { client.close(); }
  }
}
