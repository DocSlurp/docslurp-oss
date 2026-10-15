import {
  effectiveGraphEntityTypes,
  graphDepthProfiles,
  type GraphConfig,
  type PrivacyMode,
  type TextGenerationConfig,
  type TextGenerationProfile,
} from "@docslurp/shared";

import { generateOpenRouterText } from "../lib/ai.js";
import { buildTrustedDocumentTaskPrompt } from "../lib/trusted-llm-task.js";

const MAX_KNOWN_ENTITY_HINTS = 40;
const CO_MENTION_CONFIDENCE = 0.45;

export interface GraphChunk {
  id: string;
  text: string;
  pageNumber?: number | null;
}

export interface GraphExtractionContext {
  config: GraphConfig;
  /** Trusted scope: the workspace's domain brief, or its own definition. */
  scope: string;
  model: string;
  /** LLM extraction runs only with a key; otherwise heuristics only. */
  apiKey?: string;
  useLlm: boolean;
  /** Workspace privacy mode; the hosted LLM client refuses calls outside `standard`. */
  privacyMode: PrivacyMode;
  textGeneration?: TextGenerationConfig;
  deploymentProfile?: TextGenerationProfile;
  signal?: AbortSignal;
}

/** Workspace natural key of a node: `kg_nodes (normalized_name, entity_type)`. */
export type GraphNodeKey = string;

export interface GraphNodeDraft {
  key: GraphNodeKey;
  canonicalName: string;
  normalizedName: string;
  entityType: string;
  aliases: string[];
  confidence: number;
  mentionCount: number;
}

export interface GraphEdgeDraft {
  sourceKey: GraphNodeKey;
  targetKey: GraphNodeKey;
  predicate: string;
  normalizedPredicate: string;
  confidence: number;
  weight: number;
}

export interface GraphChunkEntityDraft {
  chunkId: string;
  nodeKey: GraphNodeKey;
  mentionCount: number;
  confidence: number;
  pageNumbers: number[];
}

/** One document's contribution to the workspace graph. */
export interface DocumentGraph {
  nodes: GraphNodeDraft[];
  edges: GraphEdgeDraft[];
  chunkEntities: GraphChunkEntityDraft[];
  source: "llm" | "heuristic";
  windows: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

type ExtractedEntity = { name: string; type: string; confidence: number; aliases?: string[] };
type ExtractedRelationship = { subject: string; predicate: string; object: string; confidence: number };
type DocumentGraphExtraction = { entities: ExtractedEntity[]; relationships: ExtractedRelationship[] };

export function graphNodeKey(normalizedName: string, entityType: string): GraphNodeKey {
  return `${normalizedName}\u0000${entityType}`;
}

/**
 * Extracts one document's entities, relationships and chunk mentions. LLM
 * extraction reads the document in depth-sized windows (sampled across long
 * documents); without a key, or if every window fails, capitalized-phrase
 * heuristics stand in.
 */
export async function extractDocumentGraph(args: {
  filename: string;
  chunks: GraphChunk[];
  context: GraphExtractionContext;
}): Promise<DocumentGraph> {
  const started = Date.now();
  const { context } = args;
  const profile = graphDepthProfiles[context.config.depth];
  const entityTypes = effectiveGraphEntityTypes(context.config);
  const allowedTypes = new Set([...entityTypes, "concept"]);
  const windows = buildExtractionWindows(
    args.chunks.map((chunk) => chunk.text),
    profile.windowChars,
    profile.windows,
  );

  let extraction: DocumentGraphExtraction | null = null;
  let windowsRead = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  if (context.useLlm && context.apiKey && windows.length) {
    let llmGraph: DocumentGraphExtraction = { entities: [], relationships: [] };
    let succeeded = false;
    for (const [index, window] of windows.entries()) {
      try {
        const result = await extractWindowWithLlm({
          context,
          apiKey: context.apiKey,
          filename: args.filename,
          text: window,
          part: windows.length > 1 ? { index: index + 1, total: windows.length } : undefined,
          entityTypes,
          allowedTypes,
          knownEntities: llmGraph.entities
            .slice(0, MAX_KNOWN_ENTITY_HINTS)
            .map((entity) => `${entity.name} (${entity.type})`),
          maxOutputTokens: profile.maxOutputTokens,
        });
        windowsRead += 1;
        inputTokens += result.usage.inputTokens;
        outputTokens += result.usage.outputTokens;
        console.log(
          `[ai-usage] graphrag-extract model=${context.model} input_tokens=${result.usage.inputTokens} output_tokens=${result.usage.outputTokens}`,
        );
        llmGraph = {
          entities: mergeEntities(
            llmGraph.entities,
            result.graph.entities.filter((entity) => entity.confidence >= profile.minConfidence),
          ),
          relationships: mergeRelationships(
            llmGraph.relationships,
            result.graph.relationships.filter((relationship) => relationship.confidence >= profile.minConfidence),
          ),
        };
        succeeded = true;
      } catch (error) {
        if (context.signal?.aborted) throw error;
        // A failed window falls back to what other windows (or heuristics) found.
      }
    }
    if (succeeded) extraction = llmGraph;
  }

  const source = extraction ? "llm" : "heuristic";
  if (!extraction) {
    const entities = extractEntitiesFromText(windows.join("\n\n"), allowedTypes);
    extraction = { entities, relationships: buildCoMentionRelationships(entities) };
  }

  const graph = assembleDocumentGraph({
    chunks: args.chunks,
    extraction,
    allowedTypes,
    // Once the model has read the document, its domain-shaped entities
    // replace per-chunk capitalized-phrase heuristics instead of mixing in.
    chunkHeuristics: source === "heuristic",
  });
  return {
    ...graph,
    source,
    windows: windowsRead,
    inputTokens,
    outputTokens,
    durationMs: Date.now() - started,
  };
}

function assembleDocumentGraph(args: {
  chunks: GraphChunk[];
  extraction: DocumentGraphExtraction;
  allowedTypes: ReadonlySet<string>;
  chunkHeuristics: boolean;
}): Pick<DocumentGraph, "nodes" | "edges" | "chunkEntities"> {
  const nodes = new Map<GraphNodeKey, GraphNodeDraft & { confidenceTotal: number }>();
  const edges = new Map<string, GraphEdgeDraft & { confidenceTotal: number }>();
  const chunkEntities = new Map<string, GraphChunkEntityDraft & { confidenceTotal: number }>();

  const ensureNode = (entity: ExtractedEntity) => {
    const normalizedName = normalizeName(entity.name);
    if (!normalizedName) return null;
    const entityType = normalizeEntityType(entity.type);
    const key = graphNodeKey(normalizedName, entityType);
    let node = nodes.get(key);
    if (!node) {
      node = {
        key,
        canonicalName: entity.name.trim(),
        normalizedName,
        entityType,
        aliases: [],
        confidence: 0,
        confidenceTotal: 0,
        mentionCount: 0,
      };
      nodes.set(key, node);
    }
    node.mentionCount += 1;
    node.confidenceTotal += clamp(entity.confidence);
    if (entity.name.trim().length > node.canonicalName.length) node.canonicalName = entity.name.trim();
    for (const alias of entity.aliases ?? []) {
      if (alias.trim() && !node.aliases.includes(alias.trim())) node.aliases.push(alias.trim());
    }
    return node;
  };

  const addEdge = (sourceKey: GraphNodeKey, targetKey: GraphNodeKey, predicate: string, confidence: number) => {
    if (sourceKey === targetKey) return;
    const [left, right] = [sourceKey, targetKey].sort() as [GraphNodeKey, GraphNodeKey];
    const normalizedPredicate = normalizePredicate(predicate);
    const key = `${left}\u0001${right}\u0001${normalizedPredicate}`;
    let edge = edges.get(key);
    if (!edge) {
      edge = { sourceKey: left, targetKey: right, predicate, normalizedPredicate, confidence: 0, confidenceTotal: 0, weight: 0 };
      edges.set(key, edge);
    }
    edge.weight += 1;
    edge.confidenceTotal += clamp(confidence);
  };

  for (const entity of args.extraction.entities) ensureNode(entity);

  for (const chunk of args.chunks) {
    const chunkText = chunk.text.toLowerCase();
    const documentEntitiesInChunk = args.extraction.entities.filter((entity) =>
      [entity.name, ...(entity.aliases ?? [])].some((name) => chunkText.includes(name.toLowerCase())),
    );
    const chunkLevel = args.chunkHeuristics
      ? mergeEntities(extractEntitiesFromText(chunk.text, args.allowedTypes), documentEntitiesInChunk)
      : documentEntitiesInChunk;

    const chunkNodeKeys = new Set<GraphNodeKey>();
    for (const entity of chunkLevel) {
      const node = ensureNode(entity);
      if (!node) continue;
      chunkNodeKeys.add(node.key);
      const mentionKey = `${chunk.id}\u0000${node.key}`;
      const existing = chunkEntities.get(mentionKey);
      const pageNumber = typeof chunk.pageNumber === "number" && Number.isFinite(chunk.pageNumber) ? chunk.pageNumber : null;
      if (existing) {
        existing.mentionCount += 1;
        existing.confidenceTotal += clamp(entity.confidence);
        if (pageNumber !== null && !existing.pageNumbers.includes(pageNumber)) existing.pageNumbers.push(pageNumber);
        continue;
      }
      chunkEntities.set(mentionKey, {
        chunkId: chunk.id,
        nodeKey: node.key,
        mentionCount: 1,
        confidence: 0,
        confidenceTotal: clamp(entity.confidence),
        pageNumbers: pageNumber === null ? [] : [pageNumber],
      });
    }

    const keys = [...chunkNodeKeys];
    for (let left = 0; left < keys.length; left += 1) {
      for (let right = left + 1; right < keys.length; right += 1) {
        addEdge(keys[left]!, keys[right]!, "co_mentions", CO_MENTION_CONFIDENCE);
      }
    }
  }

  for (const relationship of args.extraction.relationships) {
    const source = findNode(nodes, relationship.subject);
    const target = findNode(nodes, relationship.object);
    if (source && target) addEdge(source.key, target.key, relationship.predicate, relationship.confidence);
  }

  return {
    nodes: [...nodes.values()].map(({ confidenceTotal, ...node }) => ({
      ...node,
      confidence: clamp(confidenceTotal / Math.max(1, node.mentionCount)),
    })),
    edges: [...edges.values()].map(({ confidenceTotal, ...edge }) => ({
      ...edge,
      confidence: clamp(confidenceTotal / Math.max(1, edge.weight)),
    })),
    chunkEntities: [...chunkEntities.values()].map(({ confidenceTotal, ...mention }) => ({
      ...mention,
      confidence: clamp(confidenceTotal / Math.max(1, mention.mentionCount)),
    })),
  };
}

async function extractWindowWithLlm(args: {
  context: GraphExtractionContext;
  apiKey: string;
  filename: string;
  text: string;
  part?: { index: number; total: number };
  entityTypes: string[];
  allowedTypes: ReadonlySet<string>;
  knownEntities: string[];
  maxOutputTokens: number;
}): Promise<{ graph: DocumentGraphExtraction; usage: { inputTokens: number; outputTokens: number } }> {
  const typeUnion = args.entityTypes.map((type) => JSON.stringify(type)).join("|");
  const trustedContext = [
    { label: "Filename", value: args.filename },
    { label: "Workspace domain and scope", value: args.context.scope },
  ];
  if (args.part) {
    trustedContext.push({
      label: "Document part",
      value: `Excerpt ${args.part.index} of ${args.part.total} from the same document.`,
    });
  }
  if (args.knownEntities.length) {
    trustedContext.push({
      label: "Entities already found in earlier excerpts (reuse these exact names when they recur)",
      value: args.knownEntities.join("; "),
    });
  }
  const task = buildTrustedDocumentTaskPrompt({
    instruction: [
      "Extract a compact knowledge graph from the document.",
      "Favor the subjects and relationships that matter for the workspace domain and scope; skip boilerplate, navigation, and incidental mentions.",
    ].join(" "),
    outputContract: [
      "Return strict JSON with keys `entities` and `relationships`.",
      `\`entities\` must be an array of objects: {"name": string, "type": ${typeUnion}|"concept", "confidence": number, "aliases": string[]}. Use "concept" only when no listed type fits.`,
      '`relationships` must be an array of objects: {"subject": string, "predicate": string, "object": string, "confidence": number}. Subjects and objects must be names from `entities`.',
      "Prefer canonical names, keep predicates short verb phrases, and only include relationships directly supported by the text.",
    ].join(" "),
    trustedContext,
    untrustedContent: args.text,
    untrustedContentLabel: "document text",
    maxContentChars: -1,
  });

  const result = await generateOpenRouterText({
    operation: "graph-extraction",
    apiKey: args.apiKey,
    privacyMode: args.context.privacyMode,
    system: task.system,
    prompt: task.prompt,
    model: args.context.model,
    maxOutputTokens: args.maxOutputTokens,
    textGeneration: args.context.textGeneration,
    deploymentProfile: args.context.deploymentProfile,
    signal: args.context.signal,
  });
  return { graph: parseGraphExtraction(result.text, args.allowedTypes), usage: result.usage };
}

/**
 * Splits chunk texts into prompt-sized windows on chunk boundaries. When the
 * document needs more windows than the depth allows, keeps an even spread.
 */
export function buildExtractionWindows(texts: string[], windowChars: number, maxWindows: number): string[] {
  const windows: string[] = [];
  let current = "";
  for (const text of texts) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    // Split oversized chunks rather than silently discarding their tail.
    for (let offset = 0; offset < trimmed.length; offset += windowChars) {
      const part = trimmed.slice(offset, offset + windowChars);
      if (current && current.length + part.length + 2 > windowChars) {
        windows.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${part}` : part;
    }
  }
  if (current) windows.push(current);
  if (windows.length <= maxWindows) return windows;
  if (maxWindows <= 1) return windows.slice(0, 1);
  const step = (windows.length - 1) / (maxWindows - 1);
  return Array.from({ length: maxWindows }, (_, index) => windows[Math.round(index * step)] ?? "");
}

export function parseGraphExtraction(text: string, allowedTypes: ReadonlySet<string>): DocumentGraphExtraction {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("graph extraction did not return JSON");
  const parsed = JSON.parse(match[0]) as Partial<DocumentGraphExtraction>;
  return {
    entities: Array.isArray(parsed.entities)
      ? parsed.entities.flatMap((entity) => sanitizeEntity(entity, allowedTypes))
      : [],
    relationships: Array.isArray(parsed.relationships)
      ? parsed.relationships.flatMap((relationship) => sanitizeRelationship(relationship))
      : [],
  };
}

function sanitizeEntity(value: unknown, allowedTypes: ReadonlySet<string>): ExtractedEntity[] {
  if (!value || typeof value !== "object") return [];
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== "string" || !candidate.name.trim()) return [];
  return [
    {
      name: candidate.name.trim(),
      type: constrainEntityType(candidate.type, allowedTypes),
      confidence: clamp(typeof candidate.confidence === "number" ? candidate.confidence : 0.6),
      aliases: Array.isArray(candidate.aliases)
        ? candidate.aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
        : [],
    },
  ];
}

function sanitizeRelationship(value: unknown): ExtractedRelationship[] {
  if (!value || typeof value !== "object") return [];
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.subject !== "string" ||
    typeof candidate.predicate !== "string" ||
    typeof candidate.object !== "string"
  ) {
    return [];
  }
  return [
    {
      subject: candidate.subject.trim(),
      predicate: candidate.predicate.trim(),
      object: candidate.object.trim(),
      confidence: clamp(typeof candidate.confidence === "number" ? candidate.confidence : 0.55),
    },
  ];
}

function mergeEntities(primary: ExtractedEntity[], secondary: ExtractedEntity[]): ExtractedEntity[] {
  const merged = new Map<string, ExtractedEntity>();
  for (const entity of [...primary, ...secondary]) {
    const key = graphNodeKey(normalizeName(entity.name), normalizeEntityType(entity.type));
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        name: entity.name,
        type: normalizeEntityType(entity.type),
        confidence: clamp(entity.confidence),
        aliases: [...(entity.aliases ?? [])],
      });
      continue;
    }
    existing.confidence = Math.max(existing.confidence, clamp(entity.confidence));
    existing.aliases = [...new Set([...(existing.aliases ?? []), ...(entity.aliases ?? [])])];
    if (entity.name.length > existing.name.length) existing.name = entity.name;
  }
  return [...merged.values()];
}

function mergeRelationships(
  primary: ExtractedRelationship[],
  secondary: ExtractedRelationship[],
): ExtractedRelationship[] {
  const merged = new Map<string, ExtractedRelationship>();
  for (const relationship of [...primary, ...secondary]) {
    const key = [
      normalizeName(relationship.subject),
      normalizePredicate(relationship.predicate),
      normalizeName(relationship.object),
    ].join(":");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...relationship, confidence: clamp(relationship.confidence) });
      continue;
    }
    existing.confidence = Math.max(existing.confidence, clamp(relationship.confidence));
  }
  return [...merged.values()];
}

function extractEntitiesFromText(text: string, allowedTypes: ReadonlySet<string>): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();
  const pushEntity = (name: string, type: string, confidence: number) => {
    const cleaned = name.trim().replace(/[.,;:]+$/g, "");
    if (cleaned.length < 3) return;
    const constrained = constrainEntityType(type, allowedTypes);
    const key = graphNodeKey(normalizeName(cleaned), constrained);
    if (seen.has(key)) return;
    seen.add(key);
    entities.push({ name: cleaned, type: constrained, confidence });
  };

  for (const match of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g)) {
    pushEntity(match[1]!, "concept", 0.55);
  }
  for (const match of text.matchAll(/\b([A-Z]{2,}(?:\s+[A-Z]{2,})*)\b/g)) {
    pushEntity(match[1]!, "organization", 0.65);
  }
  for (const match of text.matchAll(
    /\b((?:19|20)\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+(?:19|20)\d{2})\b/g,
  )) {
    pushEntity(match[1]!, "date", 0.8);
  }
  for (const match of text.matchAll(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+(?:Inc|LLC|Ltd|Corporation|Corp|Company|University|Agency|Committee|Department))\b/g,
  )) {
    pushEntity(match[1]!, "organization", 0.8);
  }
  return entities.slice(0, 64);
}

function buildCoMentionRelationships(entities: ExtractedEntity[]): ExtractedRelationship[] {
  const relationships: ExtractedRelationship[] = [];
  for (let index = 0; index + 1 < entities.length; index += 1) {
    const source = entities[index]!;
    const target = entities[index + 1]!;
    relationships.push({
      subject: source.name,
      predicate: "co_mentions",
      object: target.name,
      confidence: Math.min(source.confidence, target.confidence),
    });
  }
  return relationships;
}

function findNode<T extends GraphNodeDraft>(nodes: Map<GraphNodeKey, T>, name: string): T | null {
  const normalized = normalizeName(name);
  for (const node of nodes.values()) {
    if (node.normalizedName === normalized) return node;
    if (node.aliases.some((alias) => normalizeName(alias) === normalized)) return node;
  }
  return null;
}

export function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ");
}

function normalizePredicate(value: string): string {
  return normalizeName(value).replace(/\s+/g, "_") || "related_to";
}

/** Canonical spelling of an entity type; vocabulary checks happen at extraction. */
function normalizeEntityType(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return /^[a-z][a-z0-9_]{1,39}$/.test(normalized) ? normalized : "concept";
}

/** Maps a type outside the workspace vocabulary onto the `concept` catch-all. */
function constrainEntityType(value: unknown, allowedTypes: ReadonlySet<string>): string {
  const normalized = normalizeEntityType(value);
  return allowedTypes.has(normalized) ? normalized : "concept";
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
