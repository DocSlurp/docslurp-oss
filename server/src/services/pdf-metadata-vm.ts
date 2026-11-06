/** A fresh, networkless VM counts each PDF; no storage or application keys enter the guest. */
import type { ModalClient, Sandbox } from "modal";

const MAX_INPUT = 500 * 1024 * 1024;
const DEADLINE_MS = 60_000;
const MAX_LOG_BYTES = 128 * 1024;
export class PdfMetadataVmError extends Error {
  constructor(message: string, readonly exitCode?: number | null) { super(message); }
}

async function bounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_LOG_BYTES) throw new PdfMetadataVmError("PDF metadata VM output exceeded limit");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function pdfInfoInVm(bytes: Uint8Array, recordUsage: (seconds: number) => Promise<void>, loadSdk: () => Promise<typeof import("modal")> = () => import("modal")): Promise<string> {
  if (bytes.length > MAX_INPUT) throw new PdfMetadataVmError("PDF metadata input exceeds 500 MiB");
  const image = process.env.DOCSLURP_METADATA_VM_IMAGE?.trim();
  if (!image || !/@sha256:[a-f0-9]{64}$/i.test(image)) throw new PdfMetadataVmError("DOCSLURP_METADATA_VM_IMAGE must name a digest-pinned parser image");
  if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) throw new PdfMetadataVmError("PDF metadata VM credentials are unavailable; refusing local parsing");
  const imageId = process.env.DOCSLURP_METADATA_VM_IMAGE_ID?.trim();
  if (imageId && !/^im-[A-Za-z0-9]+$/.test(imageId)) throw new PdfMetadataVmError("invalid DOCSLURP_METADATA_VM_IMAGE_ID");
  const sdk = await loadSdk();
  const client: ModalClient = new sdk.ModalClient({ tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET });
  const started = Date.now();
  let creationRequested = false;
  let vm: Sandbox | undefined;
  let finished = false;
  let clientClosed = false;
  let payload: Uint8Array | undefined = bytes;
  bytes = new Uint8Array();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = async (target: Sandbox) => {
    if (!clientClosed) { await target.terminate({ wait: true }); return; }
    const cleanupClient = new sdk.ModalClient({ tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET });
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([new sdk.Sandbox(cleanupClient, target.sandboxId).terminate({ wait: true }), new Promise<never>((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error("late VM cleanup deadline")), 5_000); })]);
    } finally { if (cleanupTimer) clearTimeout(cleanupTimer); cleanupClient.close(); }
  };
  const operation = (async () => {
    const app = await client.apps.fromName(process.env.DOCSLURP_MODAL_APP?.trim() || "docslurp-parsers", { createIfMissing: true });
    const registrySecret = process.env.DOCSLURP_MODAL_REGISTRY_SECRET?.trim();
    const pullSecret = registrySecret && !imageId ? await client.secrets.fromName(registrySecret) : undefined;
    const vmImage = imageId ? await client.images.fromId(imageId) : client.images.fromRegistry(image, pullSecret);
    creationRequested = true;
    vm = await client.sandboxes.create(app, vmImage, {
      runtime: "vm", cpu: 0.5, cpuLimit: 0.5, memoryMiB: 1024, memoryLimitMiB: 1024,
      timeoutMs: DEADLINE_MS, blockNetwork: true, includeOidcIdentityToken: false,
      env: {}, secrets: [], volumes: {}, cloudBucketMounts: {},
    });
    if (finished) { await cleanup(vm).catch(() => console.error("[parser-vm] late metadata VM cleanup failed")); throw new PdfMetadataVmError("PDF metadata VM deadline exceeded"); }
    await vm.filesystem.makeDirectory("/job");
    if (!payload) throw new PdfMetadataVmError("PDF metadata input released after deadline");
    await vm.filesystem.writeBytes(payload, "/job/input.pdf");
    const child = await vm.exec(["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C", "LC_ALL=C", "pdfinfo", "/job/input.pdf"], { mode: "binary", timeoutMs: 30_000 });
    const [stdout, stderr, exit] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.wait()]);
    if (exit !== 0) throw new PdfMetadataVmError((stderr || stdout).slice(0, 200), exit);
    return stdout;
  })();
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PdfMetadataVmError("PDF metadata VM deadline exceeded")), DEADLINE_MS);
    })]);
  } catch (error) {
    if (error instanceof PdfMetadataVmError) throw error;
    // SDK exceptions can contain credentials or provider details. Never forward them to API clients.
    throw new PdfMetadataVmError("PDF metadata VM failed; refusing local parsing");
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    if (vm) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([cleanup(vm), new Promise<never>((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error("VM cleanup timed out")), 5_000); })]);
      } catch { console.error("[parser-vm] metadata VM cleanup failed; provider lifetime limit remains enforced"); }
      finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
    }
    payload = undefined;
    clientClosed = true;
    client.close();
    void operation.catch(() => {});
    if (creationRequested) await recordUsage((Date.now() - started) / 1000);
  }
}
