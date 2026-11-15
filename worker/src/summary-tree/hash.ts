import { createHash } from "node:crypto";

import { SUMMARY_TREE_KEY_VERSION, SUMMARY_TREE_PROMPT_VERSION, SummaryTreeInputError } from "./limits.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** NFC, one space for any whitespace run, trimmed: layout-only differences do not change a hash. */
export function normalizeSummaryTreeText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function normalizeHeadingPath(headingPath: readonly string[] | null | undefined): string[] {
  return (headingPath ?? []).map(normalizeSummaryTreeText).filter((segment) => segment.length > 0);
}

/** Identity of a heading path for grouping. JSON keeps a separator inside a heading from colliding. */
export function headingPathKey(headingPath: readonly string[] | null | undefined): string {
  return JSON.stringify(normalizeHeadingPath(headingPath));
}

/**
 * Leaf hash: sha256 of the normalized raw chunk text. Raw text only: the embedded text and its reuse key
 * include the contextual preamble, which changes on any edit, and the document content hash is one per file.
 */
export function leafHash(rawText: string): string {
  return sha256(normalizeSummaryTreeText(rawText));
}

export type SummaryTreeSettingValue = string | number | boolean | null;

/**
 * Everything that decides what a summary says besides its children and heading. A node hash covers all of it,
 * so changing any field makes every node a miss. Nothing here identifies a document, a tenant or a location.
 */
export interface SummaryTreeHashContext {
  /** Defaults to SUMMARY_TREE_KEY_VERSION. */
  keyVersion?: number;
  /** Defaults to SUMMARY_TREE_PROMPT_VERSION. */
  promptVersion?: string;
  /** The model id the call resolves to, after aliases and routing. */
  modelId: string;
  /** Resolved text-generation settings (profile, reasoning effort, output budget, ...). Key order is irrelevant. */
  textGeneration: Readonly<Record<string, SummaryTreeSettingValue | undefined>>;
  lengthTargetWords: number;
}

function canonicalSettings(settings: SummaryTreeHashContext["textGeneration"]): Array<[string, SummaryTreeSettingValue]> {
  const entries: Array<[string, SummaryTreeSettingValue]> = [];
  for (const key of Object.keys(settings).sort()) {
    const value = settings[key];
    if (value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value)) throw new SummaryTreeInputError(`summary tree setting ${key} is not finite`);
    entries.push([key, value]);
  }
  return entries;
}

/** The context part of every node hash, computed once per tree. */
export function summaryTreeContextKey(context: SummaryTreeHashContext): string {
  if (!context.modelId.trim()) throw new SummaryTreeInputError("summary tree hash needs a resolved model id");
  if (!Number.isFinite(context.lengthTargetWords)) throw new SummaryTreeInputError("summary tree hash needs a length target");
  return sha256(JSON.stringify([
    "summary-tree-context",
    context.keyVersion ?? SUMMARY_TREE_KEY_VERSION,
    context.promptVersion ?? SUMMARY_TREE_PROMPT_VERSION,
    context.modelId.trim(),
    canonicalSettings(context.textGeneration),
    context.lengthTargetWords,
  ]));
}

/**
 * Node hash: context (tree key version, prompt version, model, text settings, length target), level,
 * normalized heading path and the ordered child hashes. Document, chunk and block ids, page numbers, the
 * filename and the embedding model are deliberately absent: the same section under the same settings hashes
 * the same wherever it sits. `context` may be a precomputed `summaryTreeContextKey`.
 */
export function nodeHash(args: {
  context: SummaryTreeHashContext | string;
  level: number;
  headingPath: readonly string[] | null | undefined;
  childHashes: readonly string[];
}): string {
  if (args.childHashes.length === 0) throw new SummaryTreeInputError("summary tree node hash needs at least one child");
  const contextKey = typeof args.context === "string" ? args.context : summaryTreeContextKey(args.context);
  return sha256(JSON.stringify(["summary-tree-node", contextKey, args.level, normalizeHeadingPath(args.headingPath), args.childHashes]));
}

/** The node fields hashing reads; `SummaryTreeNode` satisfies it. Children precede their parents in the array. */
export interface HashableSummaryTreeNode {
  level: number;
  headingPath: readonly string[];
  childKind: "leaf" | "node";
  /** Chunk indexes for `leaf` children, node indexes for `node` children. */
  children: readonly number[];
}

/**
 * Hashes for nodes `from..nodes.length-1`, appended to `known` (hashes of the earlier nodes), so a tree that
 * grows level by level is hashed incrementally. Returns the full array aligned with `nodes`.
 */
export function hashSummaryTreeNodes(args: {
  nodes: readonly HashableSummaryTreeNode[];
  leafHashByChunkIndex: ReadonlyMap<number, string>;
  context: SummaryTreeHashContext | string;
  known?: readonly string[];
}): string[] {
  const contextKey = typeof args.context === "string" ? args.context : summaryTreeContextKey(args.context);
  const hashes = [...(args.known ?? [])];
  if (hashes.length > args.nodes.length) throw new SummaryTreeInputError("more known summary tree hashes than nodes");
  for (let index = hashes.length; index < args.nodes.length; index++) {
    const node = args.nodes[index]!;
    const childHashes = node.children.map((child) => {
      const hash = node.childKind === "leaf" ? args.leafHashByChunkIndex.get(child) : child < index ? hashes[child] : undefined;
      if (!hash) throw new SummaryTreeInputError(`summary tree node ${index} has no hash for ${node.childKind} child ${child}`);
      return hash;
    });
    hashes.push(nodeHash({ context: contextKey, level: node.level, headingPath: node.headingPath, childHashes }));
  }
  return hashes;
}

export function leafHashesByChunkIndex(leaves: ReadonlyArray<{ chunkIndex: number; rawText: string }>): Map<number, string> {
  const hashes = new Map<number, string>();
  for (const leaf of leaves) hashes.set(leaf.chunkIndex, leafHash(leaf.rawText));
  return hashes;
}
