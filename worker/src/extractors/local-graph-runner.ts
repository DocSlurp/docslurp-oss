import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ExtractionArtifactRef } from "@docslurp/shared";
import { executeArtifactGraph } from "./artifact-graph.js";
import { availableLocalArtifactAdapters } from "./local-artifact-adapters.js";

export interface LocalPdfGraphInput {
  sourcePath: string;
  sourceDocumentId: string;
  sha256: string;
  pageCount: number;
  targetKinds: readonly string[];
  scratchDir: string;
  signal?: AbortSignal;
  maxPages?: number;
  maxOutputs?: number;
  maxSourceBytes?: number;
  maxArtifactBytes?: number;
}

export interface LocalPdfGraphOutput {
  artifacts: readonly ExtractionArtifactRef[];
  targets: readonly ExtractionArtifactRef[];
  steps: readonly string[];
}

async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

/** Public local extraction seam; scratch files remain owned by the caller. */
export async function runLocalPdfArtifactGraph(input: LocalPdfGraphInput): Promise<LocalPdfGraphOutput> {
  const maxPages = input.maxPages ?? 64;
  const maxOutputs = input.maxOutputs ?? 256;
  const maxSourceBytes = input.maxSourceBytes ?? 128 * 1024 * 1024;
  const maxArtifactBytes = input.maxArtifactBytes ?? 32 * 1024 * 1024;
  for (const [name, value] of Object.entries({ maxPages, maxOutputs, maxSourceBytes, maxArtifactBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  }
  if (!input.sourceDocumentId.trim()) throw new Error("sourceDocumentId is required");
  if (!Number.isSafeInteger(input.pageCount) || input.pageCount < 1 || input.pageCount > maxPages) throw new Error(`PDF pageCount must be between 1 and ${maxPages}`);
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error("PDF sha256 must be a 64-character hex digest");
  if (input.targetKinds.length === 0) throw new Error("At least one target kind is required");
  input.signal?.throwIfAborted();
  const sourcePath = path.resolve(input.sourcePath);
  const scratchDir = path.resolve(input.scratchDir);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.size > maxSourceBytes) throw new Error(`PDF source must be a file of at most ${maxSourceBytes} bytes`);
  const actualHash = await hashFile(sourcePath, input.signal);
  if (actualHash.toLowerCase() !== input.sha256.toLowerCase()) throw new Error("PDF source sha256 mismatch");
  await mkdir(scratchDir, { recursive: true });
  await access(scratchDir);
  const source: ExtractionArtifactRef = {
    id: `${input.sourceDocumentId}:source:${actualHash.slice(0, 16)}`,
    kind: "source/pdf",
    uri: sourcePath,
    mediaType: "application/pdf",
    sha256: actualHash,
    sourceDocumentId: input.sourceDocumentId,
    derivedFrom: [],
    placements: [],
    producer: { id: "source", optionsDigest: actualHash },
  };
  const adapters = await availableLocalArtifactAdapters({ outputDir: scratchDir, maxBytes: maxArtifactBytes });
  const result = await executeArtifactGraph({
    sourceDocumentId: input.sourceDocumentId,
    initial: [source],
    target: input.targetKinds,
    adapters,
    pageNumbers: Array.from({ length: input.pageCount }, (_, i) => i + 1),
    signal: input.signal,
    maxSteps: 12,
    maxStates: 4096,
    maxOutputs,
  });
  if (!result.ok) {
    const available = adapters.map((adapter) => adapter.id).join(", ") || "none";
    throw new Error(`Local PDF artifact graph ${result.reason}; missing: ${result.missing.join(", ") || "unknown"}. Available adapters: ${available}`);
  }
  return { artifacts: result.artifacts, targets: result.targets, steps: result.steps };
}
