import { createHash } from "node:crypto";

import { SummaryTreeInputError } from "./limits.js";
import type { StoredSummary } from "./reuse.js";

/*
 * Durable summary text for one document, keyed by node hash, under `<run root>/summary-tree/<documentId>/`.
 *
 *   parts/<id>.jsonl   one or more records, written once when a group (or a batch of groups) finishes
 *   summaries.jsonl    every record of the finished tree, written once at the end; the parts are then deleted
 *
 * Object storage has no append, so "append" is a new immutable part named after the hashes it holds: a retry
 * writes the same object again, two workers never overwrite each other, and a resumed build reads back exactly
 * the groups that were committed. Compaction keeps a finished document at one object instead of one per group.
 * Records hold text and its hash only: no document, chunk or tenant id and no page numbers.
 */

export const SUMMARY_TREE_ARTIFACT_VERSION = 1;

export interface SummaryTreeRecord extends StoredSummary {
  hash: string;
}

/** The storage calls the artifact needs. `getText` returns null for a missing object; `listKeys` returns every key or throws. */
export interface SummaryTreeArtifactIO {
  getText(key: string): Promise<string | null>;
  putText(key: string, text: string): Promise<void>;
  listKeys(prefix: string): Promise<string[]>;
  deleteKeys?(keys: string[]): Promise<void>;
}

export class SummaryTreeArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryTreeArtifactError";
  }
}

const HASH_RE = /^[0-9a-f]{64}$/;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** `<run root>/summary-tree/<documentId>`: inside the run root, so existing run and document deletes cover it. */
export function summaryTreeArtifactRoot(runRoot: string, documentId: string): string {
  if (!SAFE_SEGMENT_RE.test(documentId)) throw new SummaryTreeInputError("summary tree artifact needs a plain document id");
  const root = runRoot.replace(/\/+$/, "");
  if (!root) throw new SummaryTreeInputError("summary tree artifact needs a run root");
  return `${root}/summary-tree/${documentId}`;
}

export const summaryTreePackKey = (root: string) => `${root}/summaries.jsonl`;
export const summaryTreePartsPrefix = (root: string) => `${root}/parts/`;

function assertRecord(record: SummaryTreeRecord): void {
  if (!HASH_RE.test(record.hash)) throw new SummaryTreeArtifactError("summary tree record has a malformed hash");
  if (typeof record.title !== "string" || typeof record.text !== "string" || record.text.trim().length === 0) {
    throw new SummaryTreeArtifactError(`summary tree record ${record.hash} has no text`);
  }
}

export function serializeSummaryTreeRecords(records: readonly SummaryTreeRecord[]): string {
  return records.map((record) => {
    assertRecord(record);
    return `${JSON.stringify({ v: SUMMARY_TREE_ARTIFACT_VERSION, hash: record.hash, title: record.title, text: record.text })}\n`;
  }).join("");
}

/** Strict: an unreadable line, an unknown version or a malformed record fails the whole object. */
export function parseSummaryTreeRecords(text: string): SummaryTreeRecord[] {
  const records: SummaryTreeRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new SummaryTreeArtifactError("summary tree artifact has an unreadable line");
    }
    const raw = value as { v?: unknown; hash?: unknown; title?: unknown; text?: unknown } | null;
    if (!raw || raw.v !== SUMMARY_TREE_ARTIFACT_VERSION) throw new SummaryTreeArtifactError("summary tree artifact has an unsupported record version");
    const record = { hash: raw.hash as string, title: raw.title as string, text: raw.text as string };
    if (typeof record.hash !== "string") throw new SummaryTreeArtifactError("summary tree record has a malformed hash");
    assertRecord(record);
    records.push(record);
  }
  return records;
}

/**
 * Commits finished summaries as one immutable part and returns its key. Call it per group to resume per
 * group, or with the groups of one concurrent batch to write fewer objects.
 */
export async function appendSummaryTreeRecords(io: SummaryTreeArtifactIO, root: string, records: readonly SummaryTreeRecord[]): Promise<string | null> {
  if (records.length === 0) return null;
  const id = records.length === 1
    ? records[0]!.hash
    : createHash("sha256").update(records.map((record) => record.hash).join("\n"), "utf8").digest("hex");
  const key = `${summaryTreePartsPrefix(root)}${id}.jsonl`;
  await io.putText(key, serializeSummaryTreeRecords(records));
  return key;
}

async function mapLimited<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}

export interface SummaryTreeArtifactContents {
  entries: Map<string, StoredSummary>;
  /** True when the compacted file exists, i.e. the build that wrote it reached its end. */
  compacted: boolean;
  partKeys: string[];
}

/**
 * Everything committed under `root`: the compacted file and any parts (a build in progress, or one that was
 * interrupted). An empty result means nothing was committed. Use it to resume this document's build, and to
 * read a predecessor before handing its entries to the reuse planner.
 */
export async function readSummaryTreeArtifact(io: SummaryTreeArtifactIO, root: string, options?: { concurrency?: number }): Promise<SummaryTreeArtifactContents> {
  const entries = new Map<string, StoredSummary>();
  const add = (text: string) => {
    for (const record of parseSummaryTreeRecords(text)) entries.set(record.hash, { title: record.title, text: record.text });
  };
  const pack = await io.getText(summaryTreePackKey(root));
  if (pack !== null) add(pack);
  const partKeys = (await io.listKeys(summaryTreePartsPrefix(root))).filter((key) => key.endsWith(".jsonl")).sort();
  const parts = await mapLimited(partKeys, options?.concurrency ?? 16, (key) => io.getText(key));
  // A part deleted between the listing and the read was compacted by another worker; its records are in the pack next time.
  for (const part of parts) if (part !== null) add(part);
  return { entries, compacted: pack !== null, partKeys };
}

/**
 * Writes the finished tree's records as the single compacted file, then removes the parts it replaces.
 * `records` must be every node of the tree; the pack is the only copy once the parts are gone.
 */
export async function compactSummaryTreeArtifact(io: SummaryTreeArtifactIO, root: string, records: readonly SummaryTreeRecord[]): Promise<{ key: string; records: number; deletedParts: number }> {
  const unique = new Map<string, SummaryTreeRecord>();
  for (const record of records) unique.set(record.hash, record);
  const ordered = [...unique.values()].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const key = summaryTreePackKey(root);
  await io.putText(key, serializeSummaryTreeRecords(ordered));
  let deletedParts = 0;
  if (io.deleteKeys) {
    const partKeys = await io.listKeys(summaryTreePartsPrefix(root));
    if (partKeys.length > 0) await io.deleteKeys(partKeys);
    deletedParts = partKeys.length;
  }
  return { key, records: ordered.length, deletedParts };
}
