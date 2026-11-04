import {
  effectiveGraphEntityTypes,
  graphDepthProfiles,
  type GraphConfig,
  type PrivacyMode,
  type TextGenerationConfig,
  type TextGenerationProfile,
} from "@docslurp/shared";

import { isRouteLevelProviderFailure, operationErrorAttributes, operationErrorSummary } from "@docslurp/shared/observability";
import { generateOpenRouterText, type TextGenerationUsage } from "../lib/ai.js";
import { buildTrustedDocumentTaskPrompt } from "../lib/trusted-llm-task.js";
import { atomize, normalizeNfc } from "../lib/unicode-text.js";

const MAX_KNOWN_ENTITY_HINTS = 40;
const CO_MENTION_CONFIDENCE = 0.45;
/** Ceiling for the larger-budget retry of a window whose answer was cut off. */
const MAX_EXPANDED_OUTPUT_TOKENS = 6_400;

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
  /** Record each completed provider call before parsing, fallback, or cancellation can discard usage. */
  onUsage?: (usage: TextGenerationUsage, details: { window: number; finishReason: string }) => void;
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
  /** The model was asked and no window succeeded; the heuristic graph stands in until a retry or rebuild. */
  llmFailed: boolean;
  windows: number;
  /** Characters of chunk text in windows the model answered (parsed or not): what it read, so what the price follows. Zero for a heuristic graph. */
  charsAttempted: number;
  /** Characters of chunk text in windows that parsed into the graph, out of `charsTotal` in the document. */
  charsRead: number;
  charsTotal: number;
  /** The depth's windows covered only part of the document. */
  truncated: boolean;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

type ExtractedEntity = { name: string; type: string; confidence: number; aliases?: string[] };
type ExtractedRelationship = { subject: string; predicate: string; object: string; confidence: number };
type DocumentGraphExtraction = { entities: ExtractedEntity[]; relationships: ExtractedRelationship[] };

/** Only co-mentions are symmetric; explicit model triples retain subject/object direction. */
export function graphEdgeEndpoints<T extends string>(source: T, target: T, normalizedPredicate: string): [T, T] {
  // Existing normalization removes underscores from the reserved co_mentions predicate.
  const symmetric = normalizedPredicate === "comentions" || normalizedPredicate === "co_mentions";
  return symmetric && source > target ? [target, source] : [source, target];
}

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
  const plan = planExtractionWindows(
    args.chunks.map((chunk) => chunk.text),
    profile.windowChars,
    profile.windows,
  );
  const windows = plan.windows;
  let charsRead = 0;
  // Windows the model answered, parsed or not (its tokens were spent reading them); provider errors read nothing.
  const attempted = new Set<number>();

  let extraction: DocumentGraphExtraction | null = null;
  let windowsRead = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const llmAttempted = Boolean(context.useLlm && context.apiKey && windows.length);
  // Set when a route-level refusal skipped the remaining windows.
  let stoppedEarly = false;

  if (llmAttempted) {
    let llmGraph: DocumentGraphExtraction = { entities: [], relationships: [] };
    let succeeded = false;
    windowLoop: for (const [index, window] of windows.entries()) {
      const request = (maxOutputTokens: number) => extractWindowWithLlm({
        context,
        apiKey: context.apiKey!,
        filename: args.filename,
        text: window,
        part: windows.length > 1 ? { index: index + 1, total: windows.length } : undefined,
        entityTypes,
        knownEntities: llmGraph.entities
          .slice(0, MAX_KNOWN_ENTITY_HINTS)
          .map((entity) => `${entity.name} (${entity.type})`),
        maxOutputTokens,
      });
      // Reasoning starts at the model's floor; a cut-off answer retries with double the budget, up to the ceiling.
      let maxOutputTokens = profile.maxOutputTokens;
      for (;;) {
        let result: Awaited<ReturnType<typeof extractWindowWithLlm>>;
        try {
          result = await request(maxOutputTokens);
        } catch (error) {
          if (context.signal?.aborted) throw error;
          // Status and type only: provider error bodies may contain document content.
          // generateOpenRouterText's observation sends the full telemetry to SigNoz.
          const failure = operationErrorAttributes(error);
          console.warn(`[graph-extract] model=${context.model} window=${index + 1}/${windows.length} outcome=provider-error ${operationErrorSummary(failure)}`);
          // The SDK already retried 429s and 5xx. A route-level refusal (an
          // unservable model or route, auth, credit) fails every later window too.
          if (isRouteLevelProviderFailure(failure)) { stoppedEarly = index < windows.length - 1; break windowLoop; }
          break;
        }
        inputTokens += result.usage.inputTokens;
        outputTokens += result.usage.outputTokens;
        attempted.add(index);
        // Outside either catch: a recorder failure must fail the stage, not silently lose billing.
        context.onUsage?.(result.usage, { window: index + 1, finishReason: result.finishReason });
        if (!context.onUsage) console.log(`[ai-usage] graphrag-extract model=${context.model} input_tokens=${result.usage.inputTokens} output_tokens=${result.usage.outputTokens}`);
        try {
          const graph = parseGraphExtraction(result.text, allowedTypes);
          windowsRead += 1;
          charsRead += window.length;
          llmGraph = {
            entities: mergeEntities(llmGraph.entities, graph.entities.filter((entity) => entity.confidence >= profile.minConfidence)),
            relationships: mergeRelationships(llmGraph.relationships, graph.relationships.filter((relationship) => relationship.confidence >= profile.minConfidence)),
          };
          succeeded = true;
          break;
        } catch (error) {
          if (context.signal?.aborted) throw error;
          const expand = result.finishReason === "length" && maxOutputTokens < MAX_EXPANDED_OUTPUT_TOKENS;
          console.warn(`[graph-extract] model=${context.model} window=${index + 1}/${windows.length} outcome=invalid-json finishReason=${result.finishReason} outputTokens=${result.usage.outputTokens}${expand ? " retry=expanded" : ""}`);
          if (!expand) break;
          maxOutputTokens = Math.min(MAX_EXPANDED_OUTPUT_TOKENS, maxOutputTokens * 2);
        }
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
    // A graph cut short (credit ran out mid-document) stays stale, so it is extracted again later.
    llmFailed: llmAttempted && (source === "heuristic" || stoppedEarly),
    windows: windowsRead,
    charsAttempted: source === "llm" ? [...attempted].reduce((sum, index) => sum + (windows[index]?.length ?? 0), 0) : 0,
    charsRead: source === "llm" ? charsRead : 0,
    charsTotal: plan.charsTotal,
    truncated: plan.truncated || (llmAttempted && charsRead < plan.charsTotal),
    inputTokens,
    outputTokens,
    durationMs: Date.now() - started,
  };
}

export function assembleDocumentGraph(args: {
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
    const normalizedPredicate = normalizePredicate(predicate);
    const [left, right] = graphEdgeEndpoints(sourceKey, targetKey, normalizedPredicate);
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
    const chunkText = foldCase(chunk.text);
    const documentEntitiesInChunk = args.extraction.entities.filter((entity) =>
      [entity.name, ...(entity.aliases ?? [])].some((name) => mentionsName(chunkText, name)),
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
  knownEntities: string[];
  maxOutputTokens: number;
}): ReturnType<typeof generateOpenRouterText> {
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

  return await generateOpenRouterText({
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
}

/**
 * Splits chunk texts into prompt-sized windows on chunk boundaries. When the
 * document needs more windows than the depth allows, keeps an even spread.
 */
export function buildExtractionWindows(texts: string[], windowChars: number, maxWindows: number): string[] {
  return planExtractionWindows(texts, windowChars, maxWindows).windows;
}

/** The windows to read, plus how much of the document's text they cover. */
export function planExtractionWindows(
  texts: string[],
  windowChars: number,
  maxWindows: number,
): { windows: string[]; charsTotal: number; truncated: boolean } {
  const windows: string[] = [];
  let current = "";
  for (const text of texts) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    // Split oversized chunks rather than silently discarding their tail; cut at
    // sentence, word or grapheme boundaries, never inside a surrogate pair.
    for (const piece of atomize(trimmed, { maxChars: windowChars })) {
      const part = piece.trim();
      if (!part) continue;
      if (current && current.length + part.length + 2 > windowChars) {
        windows.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${part}` : part;
    }
  }
  if (current) windows.push(current);
  const charsTotal = windows.reduce((sum, window) => sum + window.length, 0);
  if (windows.length <= maxWindows) return { windows, charsTotal, truncated: false };
  if (maxWindows <= 1) return { windows: windows.slice(0, 1), charsTotal, truncated: true };
  const step = (windows.length - 1) / (maxWindows - 1);
  return {
    windows: Array.from({ length: maxWindows }, (_, index) => windows[Math.round(index * step)] ?? ""),
    charsTotal,
    truncated: true,
  };
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

const LETTER_OR_NUMBER = "\\p{L}\\p{N}\\p{M}";
const NOT_AFTER_WORD = `(?<![${LETTER_OR_NUMBER}])`;
const NOT_BEFORE_WORD = `(?![${LETTER_OR_NUMBER}])`;
const CAPITALIZED = "\\p{Lu}\\p{Ll}+";
const ORGANIZATION_SUFFIX =
  "Inc|LLC|Ltd|Corporation|Corp|Company|University|Agency|Committee|Department|GmbH|AG|SA|BV|NV|Oy|AB|Pty|Universität|Université|Università|Universidad";
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*";

/**
 * Candidate entities when no model read the document: multi-word capitalized
 * phrases, acronyms, organizations by legal-form suffix, and dates. A single
 * capitalized word is not an entity (every sentence starts with one), and a
 * phrase's first word is dropped when only the sentence start capitalized it.
 * Scripts without capitals (Han, kana, Arabic) yield nothing here; the model
 * extraction handles them.
 */
export function extractEntitiesFromText(text: string, allowedTypes: ReadonlySet<string>): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();
  const pushEntity = (name: string, type: string, confidence: number) => {
    const cleaned = name.trim().replace(/[.,;:]+$/g, "");
    if (Array.from(cleaned).length < (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(cleaned) ? 2 : 3)) return;
    const constrained = constrainEntityType(type, allowedTypes);
    const key = graphNodeKey(normalizeName(cleaned), constrained);
    if (seen.has(key)) return;
    seen.add(key);
    entities.push({ name: cleaned, type: constrained, confidence });
  };

  for (const match of text.matchAll(new RegExp(`${NOT_AFTER_WORD}(${CAPITALIZED}(?:[ \\t]+${CAPITALIZED}){1,3})${NOT_BEFORE_WORD}`, "gu"))) {
    let phrase = match[1]!;
    const before = text.slice(0, match.index).trimEnd();
    const startsSentence = before === "" || /[.!?:\n\f]$/.test(before) || /(^|\n)\s*(?:[-*>#]+\s*|\d+[.)]\s*)$/.test(text.slice(0, match.index));
    if (startsSentence) phrase = phrase.replace(new RegExp(`^${CAPITALIZED}[ \\t]+`, "u"), "");
    if (phrase.includes(" ") || phrase.includes("\t")) pushEntity(phrase, "concept", 0.55);
  }
  for (const match of text.matchAll(new RegExp(`${NOT_AFTER_WORD}(\\p{Lu}{2,6}(?:[ \\t]+\\p{Lu}{2,6})*)${NOT_BEFORE_WORD}`, "gu"))) {
    pushEntity(match[1]!, "organization", 0.65);
  }
  for (const match of text.matchAll(
    new RegExp(`${NOT_AFTER_WORD}((?:19|20)\\d{2}-\\d{2}-\\d{2}|(?:19|20)\\d{2}|${MONTH}\\s+\\d{1,2},\\s+(?:19|20)\\d{2}|\\d{1,2}\\s+${MONTH}\\s+(?:19|20)\\d{2})${NOT_BEFORE_WORD}`, "gu"),
  )) {
    pushEntity(match[1]!, "date", 0.8);
  }
  for (const match of text.matchAll(
    new RegExp(`${NOT_AFTER_WORD}(${CAPITALIZED}(?:[ \\t]+${CAPITALIZED}){0,2}[ \\t]+(?:${ORGANIZATION_SUFFIX}))${NOT_BEFORE_WORD}`, "gu"),
  )) {
    pushEntity(match[1]!, "organization", 0.8);
  }
  for (const match of text.matchAll(/(?:株式会社|有限会社)\p{Script=Han}{1,12}|\p{Script=Han}{1,12}(?:株式会社|有限会社)/gu)) {
    pushEntity(match[0], "organization", 0.8);
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

/** NFC plus lower case: the form names are compared in. */
function foldCase(value: string): string {
  return normalizeNfc(value).toLowerCase();
}

/**
 * Identity key of an entity name: NFC, lower case, letters and numbers of any
 * script. The symbols that tell names apart stay (`+`, `#`, `&`, and a `.`
 * inside a name), so C, C++ and C# are three entities and `.NET` is not
 * `NET`; punctuation around a name does not count. Underscores and quotes are
 * dropped, whitespace collapses.
 */
export function normalizeName(value: string): string {
  return foldCase(value)
    .replace(/['’`_]/g, "")
    .replace(/[^\p{L}\p{N}\p{M}\s+#&.\-]/gu, " ")
    .replace(/(?<![\p{L}\p{N}\p{M}+#&.\-])[+#&.\-]+|[.\-]+(?![\p{L}\p{N}\p{M}])|(?<![\p{L}\p{N}\p{M}+#])[+#]+/gu, (run, offset: number, whole: string) =>
      // Keep a leading dot of a name like .NET; drop other loose punctuation.
      run === "." && /[\p{L}\p{N}]/u.test(whole[offset + 1] ?? "") ? run : " ")
    .replace(/\s+/g, " ")
    .trim();
}

const IDEOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const NAME_CHAR = /[\p{L}\p{N}\p{M}_]/u;

/**
 * Whether a folded chunk text mentions a name as a whole token. Substring
 * search found "ai" in "said" and "C" in "C++". A name edge needs a boundary
 * unless it is ideographic, which is written without spaces and can only be
 * matched where it appears.
 */
export function mentionsName(foldedText: string, name: string): boolean {
  const needle = foldCase(name).trim();
  if (!needle) return false;
  const first = Array.from(needle)[0]!;
  const last = Array.from(needle).at(-1)!;
  let from = 0;
  for (;;) {
    const at = foldedText.indexOf(needle, from);
    if (at < 0) return false;
    from = at + 1;
    const end = at + needle.length;
    if (!IDEOGRAPHIC.test(first) && at > 0) {
      const previous = Array.from(foldedText.slice(Math.max(0, at - 2), at)).at(-1)!;
      // A dot inside a longer name (node.js) or a symbol prefix (.net, @user) is part of that other token.
      const insideDotted = previous === "." && /[\p{L}\p{N}]/u.test(foldedText[at - 2] ?? "");
      if (NAME_CHAR.test(previous) || insideDotted) continue;
    }
    if (!IDEOGRAPHIC.test(last) && end < foldedText.length) {
      const next = foldedText[end]!;
      const afterNext = foldedText[end + 1] ?? "";
      const extendsName = NAME_CHAR.test(String.fromCodePoint(foldedText.codePointAt(end)!))
        || ((next === "+" || next === "#") && !/[+#]$/.test(needle))
        || (next === "." && /[\p{L}\p{N}]/u.test(afterNext));
      if (extendsName) continue;
    }
    return true;
  }
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
