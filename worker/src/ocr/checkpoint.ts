import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OcrInfrastructureError } from "./mode.js";
import type { ArtifactStore } from "../tools/storage.js";
import { sha256Bytes, sha256File } from "../sandbox/source-integrity.js";
import type { OcrReadOutcome } from "./engine.js";

export type OcrCheckpointStorage = Pick<ArtifactStore, "getBytes" | "putBytes" | "deleteKeys">;
// A large PDF is read in many batches. Hash its private staged file once while its identity is unchanged.
const sources = new WeakMap<object, Map<string, { identity: string; hash: Promise<string> }>>();
async function sourceHash(state: object, source: string): Promise<string> {
  const info = await stat(source, { bigint: true });
  const identity = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
  let cache = sources.get(state);
  if (!cache) sources.set(state, cache = new Map());
  const old = cache.get(source);
  if (old?.identity === identity) return old.hash;
  const hash = sha256File(source);
  cache.set(source, { identity, hash });
  while (cache.size > 32) cache.delete(cache.keys().next().value!);
  return hash;
}
const MAX_BYTES = 256 * 1024 * 1024;
const pending = new WeakMap<object, Map<string, { storage: OcrCheckpointStorage; keys: Set<string> }>>();

/** Delete only after the document-stage publication and usage checkpoint committed. */
export async function cleanOcrCheckpoint(state: object, documentId: string, stage: string): Promise<void> {
  const entries = pending.get(state);
  const id = `${documentId}:${stage}`;
  const entry = entries?.get(id);
  if (!entry) return;
  await entry.storage.deleteKeys([...entry.keys]);
  entries!.delete(id);
}

export async function baseOcrCheckpoint(args: {
  storage: OcrCheckpointStorage; state: object; scope: string[]; documentId: string; stage: string;
  source: string; settings: unknown; signal?: AbortSignal;
}): Promise<{ load(): Promise<OcrReadOutcome | null>; save(outcome: OcrReadOutcome): Promise<void> }> {
  args.signal?.throwIfAborted();
  if (args.scope.some(value => !value || !/^[a-zA-Z0-9_-]+$/.test(value))) throw new Error("OCR checkpoint requires explicit tenant scope");
  const binding = JSON.stringify({ version: 1, scope: args.scope, document: args.documentId, stage: args.stage,
    source: await sourceHash(args.state, args.source), settings: args.settings });
  const key = `${args.scope.join("/")}/ocr-retry/${sha256Bytes(Buffer.from(binding))}.json`;
  let entries = pending.get(args.state);
  if (!entries) pending.set(args.state, entries = new Map());
  const id = `${args.documentId}:${args.stage}`;
  let entry = entries.get(id);
  if (!entry) entries.set(id, entry = { storage: args.storage, keys: new Set() });
  entry.keys.add(key);
  return {
    async load() {
      args.signal?.throwIfAborted();
      let bytes: Buffer;
      try { bytes = await args.storage.getBytes(key, { maxBytes: MAX_BYTES }); }
      catch (error) {
        const cause = (error as { cause?: { name?: string } }).cause ?? error;
        if (["NoSuchKey", "NotFound"].includes((cause as Error).name)) return null;
        throw new OcrInfrastructureError("OCR checkpoint lookup failed", { cause: error });
      }
      if (bytes.length > MAX_BYTES) throw new Error("OCR checkpoint exceeds bounded size");
      const envelope = JSON.parse(bytes.toString("utf8"));
      if (envelope.binding !== binding || typeof envelope.payload !== "string" || sha256Bytes(Buffer.from(envelope.payload)) !== envelope.digest) throw new Error("OCR checkpoint integrity failure");
      const saved = JSON.parse(envelope.payload);
      if (saved.mode !== "vm" || typeof saved.engine !== "string" || !saved.language || typeof saved.language.setting !== "string" || !Array.isArray(saved.pages) || saved.pages.length > 64 || !Array.isArray(saved.blobs) || saved.blobs.length > 192 || !Array.isArray(saved.unreadPages) || saved.unreadPages.some((n: unknown) => !Number.isSafeInteger(n) || Number(n) < 1) || typeof saved.truncatedFrames !== "boolean") throw new Error("Invalid OCR checkpoint");
      const dir = await mkdtemp(path.join(tmpdir(), "docslurp-ocr-retry-"));
      try {
        for (const page of saved.pages) {
          if (!Number.isInteger(page.pageNumber) || page.pageNumber < 1 || typeof page.text !== "string" || typeof page.recogniser !== "string") throw new Error("Invalid OCR checkpoint page");
          for (const field of ["image", "escalation", "rendition"]) {
            if (!page[field]) continue;
            const index = page[field].imagePath;
            if (!Number.isInteger(index) || index < 0 || index >= saved.blobs.length || typeof saved.blobs[index] !== "string") throw new Error("Invalid OCR checkpoint frame");
            const file = path.join(dir, `${index}.bin`);
            await writeFile(file, Buffer.from(saved.blobs[index], "base64"), { mode: 0o600 });
            page[field].imagePath = file;
          }
        }
        args.signal?.throwIfAborted();
        return { ...saved, dispose: () => rm(dir, { recursive: true, force: true }) } as OcrReadOutcome;
      } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
    },
    async save(outcome) {
      args.signal?.throwIfAborted();
      const blobs: string[] = [];
      const pages = [];
      for (const original of outcome.pages) {
        const page: Record<string, unknown> = { ...original };
        for (const field of ["image", "escalation", "rendition"] as const) {
          const frame = original[field];
          if (frame) {
            const index = blobs.push((await readFile(frame.imagePath)).toString("base64")) - 1;
            page[field] = { ...frame, imagePath: index };
          }
        }
        pages.push(page);
      }
      const payload = JSON.stringify({ ...outcome, pages, blobs });
      const bytes = Buffer.from(JSON.stringify({ binding, payload, digest: sha256Bytes(Buffer.from(payload)) }));
      if (bytes.length > MAX_BYTES) throw new Error("OCR checkpoint exceeds bounded size");
      args.signal?.throwIfAborted();
      try { await args.storage.putBytes(key, bytes, "application/json"); }
      catch (error) { throw new OcrInfrastructureError("OCR checkpoint write failed", { cause: error }); }
    },
  };
}
