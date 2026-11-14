import { describe, expect, it } from "vitest";

import {
  adjacentSimilarities,
  buildSummaryTree,
  checkSummaryTreeCoverage,
  cutBySimilarity,
  hashSummaryTreeNodes,
  leafHash,
  leafHashesByChunkIndex,
  nodeHash,
  planSummaryReuse,
  selectSummaryTreeLeaves,
  summaryTreeChunksFromEmbeddingChunks,
  SummaryTreeBuilder,
  type StoredSummary,
  type SummaryReuseSource,
  type SummaryTree,
  type SummaryTreeChunk,
  type SummaryTreeHashContext,
  type SummaryTreeLeaf,
  type SummaryTreeLimits,
} from "./index.js";

const DIMENSIONS = 24;
const LIMITS: Partial<SummaryTreeLimits> = { minLeavesPerGroup: 4, maxLeavesPerGroup: 16, minFanIn: 3, maxFanIn: 10, minDocumentLeaves: 8 };
const CONTEXT: SummaryTreeHashContext = {
  modelId: "example/text-model",
  textGeneration: { profile: "provider-default", reasoningEffort: "none", maxOutputTokens: 546 },
  lengthTargetWords: 150,
};

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Paragraph { text: string; headingPath: string[]; topic: number; page: number }

/** A topic is a direction; paragraphs on one topic sit close together, so topic changes are the similarity minima. */
function vectorFor(paragraph: Paragraph): number[] {
  const next = random(leafSeed(paragraph.text));
  const vector = Array.from({ length: DIMENSIONS }, () => (next() - 0.5) * 0.2);
  vector[paragraph.topic % DIMENSIONS]! += 1;
  vector[(paragraph.topic * 7 + 3) % DIMENSIONS]! += 0.5;
  return vector;
}

function leafSeed(text: string): number {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) seed = Math.imul(seed ^ text.charCodeAt(i), 16777619);
  return seed >>> 0;
}

function section(headingPath: string[], count: number, topic: number, label = headingPath.join("/") || "body"): Paragraph[] {
  return Array.from({ length: count }, (_, i) => ({ text: `${label} paragraph ${i} about topic ${topic}`, headingPath, topic, page: 1 + Math.floor(i / 3) }));
}

interface Built { tree: SummaryTree; hashes: string[]; leaves: SummaryTreeLeaf[]; groupsByLeafHashes: string[] }

function build(paragraphs: Paragraph[], options?: { limits?: Partial<SummaryTreeLimits>; context?: SummaryTreeHashContext; firstChunkIndex?: number; pageOffset?: number }): Built {
  const first = options?.firstChunkIndex ?? 0;
  const leaves: SummaryTreeLeaf[] = paragraphs.map((paragraph, i) => ({
    chunkIndex: first + i * 2, rawText: paragraph.text, headingPath: paragraph.headingPath,
    pageStart: paragraph.page + (options?.pageOffset ?? 0), pageEnd: paragraph.page + (options?.pageOffset ?? 0),
  }));
  const vectors = paragraphs.map(vectorFor);
  const builder = new SummaryTreeBuilder(leaves, adjacentSimilarities(vectors.length, (i) => vectors[i]!), options?.limits ?? LIMITS);
  const position = new Map(leaves.map((leaf, i) => [leaf.chunkIndex, i]));
  // A node's "summary vector" here is the mean of the leaf vectors under it.
  const nodeVector = (index: number) => {
    const node = builder.nodes[index]!;
    const sum = new Array<number>(DIMENSIONS).fill(0);
    for (let i = position.get(node.chunkStart)!; i <= position.get(node.chunkEnd)!; i++) vectors[i]!.forEach((value, d) => { sum[d]! += value; });
    return sum;
  };
  while (!builder.done) builder.advance(nodeVector);
  const tree = builder.tree();
  const leafHashes = leafHashesByChunkIndex(leaves);
  const hashes = hashSummaryTreeNodes({ nodes: tree.nodes, leafHashByChunkIndex: leafHashes, context: options?.context ?? CONTEXT });
  const groupsByLeafHashes = tree.nodes.filter((node) => node.childKind === "leaf").map((node) => node.children.map((child) => leafHashes.get(child)!).join(","));
  return { tree, hashes, leaves, groupsByLeafHashes };
}

const leafGroups = (tree: SummaryTree) => tree.nodes.filter((node) => node.childKind === "leaf");

function ancestors(tree: SummaryTree, node: number): number[] {
  const chain: number[] = [];
  for (let current = tree.nodes[node]!.parent; current !== null; current = tree.nodes[current]!.parent) chain.push(current);
  return chain;
}

function headedDocument(): Paragraph[] {
  return [
    ...section(["Report"], 3, 1),
    ...section(["Report", "Revenue"], 9, 2),
    ...section(["Report", "Revenue", "By region"], 6, 3),
    ...section(["Report", "Hiring"], 12, 4),
    ...section(["Report", "Outlook"], 2, 5),
    ...section(["Appendix"], 7, 6),
  ];
}

function headinglessDocument(blocks = 20, blockSize = 10): Paragraph[] {
  return Array.from({ length: blocks }, (_, block) => section([], blockSize, block, `block-${block}`)).flat();
}

describe("leaf selection and skip rules", () => {
  const chunk = (index: number, extra: Partial<SummaryTreeChunk> = {}): SummaryTreeChunk => ({ index, rawText: `text ${index}`, headingPath: ["A"], pageNumbers: [index + 1], ...extra });
  const prose = (count: number, from = 0) => Array.from({ length: count }, (_, i) => chunk(from + i));

  it("keeps base prose chunks and drops overlap, row, cell and table chunks", () => {
    const chunks = [
      ...prose(10),
      chunk(10, { overlapIndex: 1 }),
      chunk(11, { tableGranularity: "table", evidenceType: "table" }),
      chunk(12, { tableGranularity: "row" }),
      chunk(13, { tableGranularity: "cell" }),
      chunk(14, { overlapIndex: 0 }),
    ];
    const selection = selectSummaryTreeLeaves({ normalizedFormat: "pdf" }, chunks, { minDocumentLeaves: 8 });
    expect(selection.skipReason).toBeNull();
    expect(selection.leaves.map((leaf) => leaf.chunkIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 14]);
    expect(selection.excluded).toEqual({ "overlap-chunk": 1, "table-detail-chunk": 2, "table-chunk": 1 });
    expect(selection.stats).toMatchObject({ chunks: 15, candidateLeaves: 12, proseLeaves: 11, tableLeaves: 1 });
    expect(selection.leaves[3]).toMatchObject({ pageStart: 4, pageEnd: 4, headingPath: ["A"] });
  });

  it("skips spreadsheets, structured data and media by format, with a reason", () => {
    const chunks = prose(40);
    const reason = (document: { normalizedFormat?: string; mimeType?: string }) => selectSummaryTreeLeaves(document, chunks).skipReason;
    expect(reason({ normalizedFormat: "office-excel" })).toBe("spreadsheet-format");
    expect(reason({ normalizedFormat: "structured-csv" })).toBe("structured-data-format");
    expect(reason({ normalizedFormat: "structured-json" })).toBe("structured-data-format");
    expect(reason({ normalizedFormat: "audio" })).toBe("audio-video");
    expect(reason({ normalizedFormat: "video" })).toBe("audio-video");
    expect(reason({ normalizedFormat: "unknown", mimeType: "video/mp4" })).toBe("audio-video");
    expect(reason({ normalizedFormat: "pdf" })).toBeNull();
    expect(selectSummaryTreeLeaves({ normalizedFormat: "office-excel" }, chunks).leaves).toEqual([]);
  });

  it("skips table-heavy and short documents", () => {
    const tables = (count: number, from: number) => Array.from({ length: count }, (_, i) => chunk(from + i, { tableGranularity: "table" }));
    const heavy = selectSummaryTreeLeaves({ normalizedFormat: "pdf" }, [...prose(30), ...tables(31, 30)]);
    expect(heavy.skipReason).toBe("table-heavy");
    expect(heavy.stats.tableLeafShare).toBeGreaterThan(0.5);
    // Exactly half is not "more than half".
    expect(selectSummaryTreeLeaves({ normalizedFormat: "pdf" }, [...prose(30), ...tables(30, 30)]).skipReason).toBeNull();
    expect(selectSummaryTreeLeaves({ normalizedFormat: "pdf" }, prose(23)).skipReason).toBe("below-long-document-floor");
    expect(selectSummaryTreeLeaves({ normalizedFormat: "pdf" }, prose(24)).skipReason).toBeNull();
    expect(selectSummaryTreeLeaves({ normalizedFormat: "pdf" }, []).skipReason).toBe("no-leaves");
  });

  it("rejects chunks out of order and embedding chunks without raw text", () => {
    expect(() => selectSummaryTreeLeaves({}, [chunk(1), chunk(0)])).toThrow(/increasing index order/);
    expect(() => summaryTreeChunksFromEmbeddingChunks([{ index: 0, metadata: {} }])).toThrow(/rawText/);
    const [converted] = summaryTreeChunksFromEmbeddingChunks([{ index: 4, headingPath: ["A"], pageNumbers: [2], metadata: { rawText: "raw", overlapIndex: 1 } }]);
    expect(converted).toMatchObject({ index: 4, rawText: "raw", overlapIndex: 1 });
  });
});

describe("grouping", () => {
  it("is deterministic", () => {
    const first = build(headinglessDocument());
    const second = build(headinglessDocument());
    expect(second.tree).toEqual(first.tree);
    expect(second.hashes).toEqual(first.hashes);
  });

  it("cuts at every heading change and never merges short sections", () => {
    const { tree } = build(headedDocument());
    expect(leafGroups(tree).map((node) => [node.headingPath.join("/"), node.leafCount])).toEqual([
      ["Report", 3], ["Report/Revenue", 9], ["Report/Revenue/By region", 6], ["Report/Hiring", 12], ["Report/Outlook", 2], ["Appendix", 7],
    ]);
    expect(checkSummaryTreeCoverage(tree)).toEqual([]);
  });

  it("groups upper levels by shared heading prefix, one level shallower at a time, up to one root", () => {
    const { tree } = build(headedDocument());
    const describeNode = (index: number): unknown => {
      const node = tree.nodes[index]!;
      return node.childKind === "leaf" ? node.headingPath.join("/") : { [node.headingPath.join("/") || "(root)"]: node.children.map(describeNode) };
    };
    expect(describeNode(tree.root!)).toEqual({
      "(root)": [
        { Report: ["Report", { "Report/Revenue": ["Report/Revenue", "Report/Revenue/By region"] }, "Report/Hiring", "Report/Outlook"] },
        "Appendix",
      ],
    });
    const root = tree.nodes[tree.root!]!;
    expect(root).toMatchObject({ level: 4, parent: null, chunkStart: 0, chunkEnd: 76, pageStart: 1, pageEnd: 4, leafCount: 39 });
    for (const node of tree.nodes) expect(node.children.length === 1 && node.childKind === "node").toBe(false);
  });

  it("cuts a heading-less long document at its lowest-similarity boundaries", () => {
    const { tree } = build(headinglessDocument(20, 10));
    // Topic blocks of 10 fit the 4..16 window, so the groups are exactly the blocks.
    expect(leafGroups(tree).map((node) => node.leafCount)).toEqual(new Array(20).fill(10));
    expect(leafGroups(tree).map((node) => node.chunkStart)).toEqual(Array.from({ length: 20 }, (_, block) => block * 20));
    expect(tree.root).toBe(tree.nodes.length - 1);
    expect(tree.nodes[tree.root!]!.headingPath).toEqual([]);
    expect(checkSummaryTreeCoverage(tree)).toEqual([]);
  });

  it("keeps every similarity-cut group within the minimum and maximum, counted in leaves", () => {
    const next = random(7);
    for (const count of [17, 31, 64, 257, 1000]) {
      const similarities = Float64Array.from({ length: count - 1 }, () => next());
      const starts = cutBySimilarity({ count, similarityAt: (gap) => similarities[gap]!, min: 4, max: 16 });
      const sizes = starts.map((start, i) => (starts[i + 1] ?? count) - start);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(count);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(4);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(16);
    }
    // The lowest similarity wins only where both sides keep the minimum: gap 1 is lower but leaves one side too small.
    const similarities = [0.9, 0.01, 0.9, 0.9, 0.9, 0.9, 0.2, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9];
    expect(cutBySimilarity({ count: 18, similarityAt: (gap) => similarities[gap]!, min: 4, max: 16 })).toEqual([0, 7]);
    // No absolute threshold: uniformly high similarities are still cut, at the relative minimum.
    const high = Array.from({ length: 17 }, (_, gap) => (gap === 9 ? 0.98 : 0.99));
    expect(cutBySimilarity({ count: 18, similarityAt: (gap) => high[gap]!, min: 4, max: 16 })).toEqual([0, 10]);
    expect(cutBySimilarity({ count: 16, similarityAt: () => 0, min: 4, max: 16 })).toEqual([0]);
  });

  it("respects fan-in limits and keeps coverage on a wide heading-less document", async () => {
    const paragraphs = headinglessDocument(150, 7);
    const { tree } = build(paragraphs);
    for (const node of tree.nodes) {
      if (node.childKind === "leaf") {
        expect(node.children.length).toBeGreaterThanOrEqual(4);
        expect(node.children.length).toBeLessThanOrEqual(16);
      } else {
        expect(node.children.length).toBeGreaterThanOrEqual(2);
        expect(node.children.length).toBeLessThanOrEqual(10);
      }
    }
    expect(checkSummaryTreeCoverage(tree)).toEqual([]);
    expect(tree.nodes[tree.root!]!.leafCount).toBe(paragraphs.length);
  });

  it("asks for summary vectors only when siblings exceed the fan-in maximum", async () => {
    const small = new SummaryTreeBuilder(build(headedDocument()).leaves, new Float64Array(38), LIMITS);
    expect(small.vectorsNeeded()).toEqual([]);
    const paragraphs = headinglessDocument(20, 10);
    const leaves = build(paragraphs).leaves;
    const wide = new SummaryTreeBuilder(leaves, adjacentSimilarities(leaves.length, (i) => vectorFor(paragraphs[i]!)), LIMITS);
    expect(wide.vectorsNeeded()).toHaveLength(20);
    expect(() => wide.advance()).toThrow(/needs a summary vector/);

    const levels: number[][] = [];
    const tree = await buildSummaryTree({
      leaves, leafSimilarities: adjacentSimilarities(leaves.length, (i) => vectorFor(paragraphs[i]!)), limits: LIMITS,
      onLevel: (created) => { levels.push(created); },
      vectorOf: (node) => [Math.sin(node), Math.cos(node * 3), 1],
    });
    expect(levels[0]).toHaveLength(20);
    expect(levels.flat()).toEqual(tree.nodes.map((_, index) => index));
    expect(checkSummaryTreeCoverage(tree)).toEqual([]);
  });

  it("handles empty and single-group documents", () => {
    expect(build([]).tree).toEqual({ nodes: [], root: null, leafChunkIndexes: [] });
    const single = build(section([], 5, 1)).tree;
    expect(single.nodes).toHaveLength(1);
    expect(single.root).toBe(0);
    expect(checkSummaryTreeCoverage(single)).toEqual([]);
  });
});

describe("node hashes and reuse", () => {
  function changedNodes(before: Built, after: Built): number[] {
    const known = new Set(before.hashes);
    return after.hashes.flatMap((hash, index) => (known.has(hash) ? [] : [index]));
  }

  it("changes only the edited group and its ancestors when a paragraph is inserted under a heading", () => {
    const before = build(headedDocument());
    const edited = headedDocument();
    const at = edited.findIndex((paragraph) => paragraph.headingPath.join("/") === "Report/Hiring") + 5;
    edited.splice(at, 0, { text: "A new paragraph about the Lisbon office opening", headingPath: ["Report", "Hiring"], topic: 4, page: 2 });
    const after = build(edited);

    const group = after.tree.nodes.findIndex((node) => node.childKind === "leaf" && node.headingPath.join("/") === "Report/Hiring");
    expect(changedNodes(before, after).sort((a, b) => a - b)).toEqual([group, ...ancestors(after.tree, group)].sort((a, b) => a - b));
    // Boundaries elsewhere are the same groups of the same leaves, though every later chunk index moved.
    const unchanged = after.groupsByLeafHashes.filter((_, index) => leafGroups(after.tree)[index]!.headingPath.join("/") !== "Report/Hiring");
    expect(unchanged).toEqual(before.groupsByLeafHashes.filter((_, index) => leafGroups(before.tree)[index]!.headingPath.join("/") !== "Report/Hiring"));
    expect(leafGroups(after.tree)[5]!.chunkStart).toBe(leafGroups(before.tree)[5]!.chunkStart + 2);
  });

  it("changes only the edited group and its ancestors when a paragraph is inserted in a heading-less document", () => {
    const before = build(headinglessDocument(20, 10));
    const edited = headinglessDocument(20, 10);
    edited.splice(74, 0, { text: "An inserted paragraph on the block-7 topic", headingPath: [], topic: 7, page: 3 });
    const after = build(edited);

    expect(leafGroups(after.tree).map((node) => node.leafCount)).toEqual([...new Array(7).fill(10), 11, ...new Array(12).fill(10)]);
    const changed = changedNodes(before, after);
    const group = changed.filter((index) => after.tree.nodes[index]!.childKind === "leaf");
    expect(group).toEqual([7]);
    expect(changed.sort((a, b) => a - b)).toEqual([7, ...ancestors(after.tree, 7)].sort((a, b) => a - b));
    expect(after.groupsByLeafHashes.filter((_, index) => index !== 7)).toEqual(before.groupsByLeafHashes.filter((_, index) => index !== 7));

    const stored = new Map<string, StoredSummary>(before.hashes.map((hash) => [hash, { title: "t", text: `summary ${hash}` }]));
    const source: SummaryReuseSource = { entries: stored, eligibility: { sameOrgProjectAndCanonicalChain: true, sourceNotPurged: true, sourceNotPiiBlockedOrRedacted: true } };
    const plan = planSummaryReuse({ nodeHashes: after.hashes, source });
    expect(plan.stats).toEqual({ nodes: after.hashes.length, reused: after.hashes.length - changed.length, modelCalls: changed.length, sourceAccepted: true });
    expect(plan.generate.flatMap((entry) => entry.nodes).sort((a, b) => a - b)).toEqual(changed);
  });

  it("changes the renamed section, its subsections and their ancestors when a heading is renamed, and no boundary", () => {
    const before = build(headedDocument());
    const renamed = headedDocument().map((paragraph) => ({ ...paragraph, headingPath: paragraph.headingPath.map((segment) => (segment === "Revenue" ? "Income" : segment)) }));
    const after = build(renamed);

    expect(after.groupsByLeafHashes).toEqual(before.groupsByLeafHashes);
    expect(after.tree.nodes.map((node) => node.children)).toEqual(before.tree.nodes.map((node) => node.children));
    const changed = changedNodes(before, after);
    const touched = after.tree.nodes.flatMap((node, index) => (node.headingPath.includes("Income") ? [index, ...ancestors(after.tree, index)] : []));
    expect(changed.sort((a, b) => a - b)).toEqual([...new Set(touched)].sort((a, b) => a - b));
    const untouched = ["Report", "Report/Hiring", "Report/Outlook", "Appendix"];
    for (const path of untouched) {
      const index = after.tree.nodes.findIndex((node) => node.childKind === "leaf" && node.headingPath.join("/") === path);
      expect(after.hashes[index]).toBe(before.hashes[index]);
    }
  });

  it("excludes chunk ids, page numbers and position from node hashes", () => {
    const base = build(headedDocument());
    const moved = build(headedDocument(), { firstChunkIndex: 5000, pageOffset: 300 });
    expect(moved.tree.nodes[0]!.chunkStart).toBe(5000);
    expect(moved.tree.nodes[0]!.pageStart).toBe(301);
    expect(moved.hashes).toEqual(base.hashes);
    // The hash inputs have no field for a document id, filename or embedding model at all.
    expect(Object.keys(CONTEXT).sort()).toEqual(["lengthTargetWords", "modelId", "textGeneration"]);
  });

  it("changes every node hash with the prompt version, model, text settings, length target or key version", () => {
    const base = build(headedDocument()).hashes;
    const variants: SummaryTreeHashContext[] = [
      { ...CONTEXT, promptVersion: "summary-tree-prompt@2" },
      { ...CONTEXT, modelId: "example/other-model" },
      { ...CONTEXT, textGeneration: { ...CONTEXT.textGeneration, reasoningEffort: "low" } },
      { ...CONTEXT, lengthTargetWords: 200 },
      { ...CONTEXT, keyVersion: 2 },
    ];
    for (const context of variants) {
      const hashes = build(headedDocument(), { context }).hashes;
      expect(hashes.filter((hash, index) => hash === base[index])).toEqual([]);
    }
    const reordered = { ...CONTEXT, textGeneration: { maxOutputTokens: 546, reasoningEffort: "none", profile: "provider-default", unused: undefined } };
    expect(build(headedDocument(), { context: reordered }).hashes).toEqual(base);
  });

  it("hashes leaves over normalized raw text, and nodes over level, heading and child order", () => {
    expect(leafHash("Total  revenue\r\n rose.")).toBe(leafHash(" Total revenue rose. "));
    expect(leafHash("Total revenue rose.")).not.toBe(leafHash("Total revenue fell."));
    expect(leafHash("café")).toBe(leafHash("café"));
    const a = leafHash("a");
    const b = leafHash("b");
    const base = nodeHash({ context: CONTEXT, level: 1, headingPath: ["A", "B"], childHashes: [a, b] });
    expect(nodeHash({ context: CONTEXT, level: 1, headingPath: [" A ", "B"], childHashes: [a, b] })).toBe(base);
    expect(nodeHash({ context: CONTEXT, level: 1, headingPath: ["A", "B"], childHashes: [b, a] })).not.toBe(base);
    expect(nodeHash({ context: CONTEXT, level: 2, headingPath: ["A", "B"], childHashes: [a, b] })).not.toBe(base);
    expect(nodeHash({ context: CONTEXT, level: 1, headingPath: ["A/B"], childHashes: [a, b] })).not.toBe(base);
    expect(() => nodeHash({ context: CONTEXT, level: 1, headingPath: [], childHashes: [] })).toThrow();
  });

  it("refuses reuse from a source the caller has not vouched for, and calls the model once per distinct hash", () => {
    const hashes = [leafHash("one"), leafHash("two"), leafHash("two"), leafHash("three")];
    const entries = new Map<string, StoredSummary>([[hashes[0]!, { title: "One", text: "First." }], [hashes[3]!, { title: "Three", text: "  " }]]);
    const eligibility = { sameOrgProjectAndCanonicalChain: true, sourceNotPurged: true, sourceNotPiiBlockedOrRedacted: true } as const;

    const plan = planSummaryReuse({ nodeHashes: hashes, source: { entries, eligibility }, firstNode: 10 });
    expect(plan.reuse).toEqual([{ node: 10, hash: hashes[0], summary: { title: "One", text: "First." } }]);
    expect(plan.generate).toEqual([{ hash: hashes[1], nodes: [11, 12] }, { hash: hashes[3], nodes: [13] }]);

    for (const flag of ["sameOrgProjectAndCanonicalChain", "sourceNotPurged", "sourceNotPiiBlockedOrRedacted"] as const) {
      const unvouched = { entries, eligibility: { ...eligibility, [flag]: false } } as unknown as SummaryReuseSource;
      const refused = planSummaryReuse({ nodeHashes: hashes, source: unvouched });
      expect(refused.reuse).toEqual([]);
      expect(refused.stats).toMatchObject({ reused: 0, modelCalls: 3, sourceAccepted: false });
    }
    expect(planSummaryReuse({ nodeHashes: hashes, source: null }).stats.reused).toBe(0);
    expect(planSummaryReuse({ nodeHashes: hashes, source: { entries } as unknown as SummaryReuseSource }).stats.reused).toBe(0);
  });
});

describe("coverage invariant", () => {
  const valid = () => structuredClone(build(headedDocument()).tree);

  it("passes a built tree", () => {
    expect(checkSummaryTreeCoverage(valid())).toEqual([]);
  });

  it("catches an orphan leaf and a leaf under two groups", () => {
    const orphan = valid();
    const dropped = orphan.nodes[1]!.children.pop()!;
    expect(checkSummaryTreeCoverage(orphan)).toEqual([{ kind: "leaf-without-group", chunkIndex: dropped }]);

    const doubled = valid();
    doubled.nodes[2]!.children.push(doubled.nodes[1]!.children[0]!);
    expect(checkSummaryTreeCoverage(doubled)).toEqual([{ kind: "leaf-in-multiple-groups", chunkIndex: doubled.nodes[1]!.children[0], nodes: [1, 2] }]);

    const unknown = valid();
    unknown.nodes[0]!.children.push(99_999);
    expect(checkSummaryTreeCoverage(unknown)).toEqual([{ kind: "unknown-leaf", chunkIndex: 99_999, node: 0 }]);
  });

  it("catches an orphan node and a node under two parents", () => {
    const orphan = valid();
    const parent = orphan.nodes.findIndex((node) => node.childKind === "node");
    const [removed] = orphan.nodes[parent]!.children.splice(0, 1);
    expect(checkSummaryTreeCoverage(orphan)).toEqual(expect.arrayContaining([{ kind: "node-without-parent", node: removed }]));

    const doubled = valid();
    const parents = doubled.nodes.flatMap((node, index) => (node.childKind === "node" ? [index] : []));
    const child = doubled.nodes[parents[0]!]!.children[0]!;
    doubled.nodes[parents.at(-1)!]!.children.push(child);
    expect(checkSummaryTreeCoverage(doubled)).toEqual([{ kind: "node-with-multiple-parents", node: child, parents: [parents[0], parents.at(-1)] }]);
  });

  it("catches a missing or wrong root, a stale parent pointer and a forward child reference", () => {
    const noRoot = valid();
    const root = noRoot.root!;
    noRoot.root = null;
    expect(checkSummaryTreeCoverage(noRoot)).toEqual([{ kind: "missing-root" }, { kind: "node-without-parent", node: root }]);

    const wrongRoot = valid();
    wrongRoot.root = 0;
    expect(checkSummaryTreeCoverage(wrongRoot).map((violation) => violation.kind)).toEqual(["root-mismatch", "node-without-parent"]);

    const stale = valid();
    stale.nodes[0]!.parent = null;
    expect(checkSummaryTreeCoverage(stale)).toEqual([{ kind: "parent-pointer-mismatch", node: 0, recorded: null, actual: build(headedDocument()).tree.nodes[0]!.parent }]);

    const forward = valid();
    const firstParent = forward.nodes.findIndex((node) => node.childKind === "node");
    forward.nodes[firstParent]!.children.push(forward.nodes.length - 1);
    expect(checkSummaryTreeCoverage(forward).map((violation) => violation.kind)).toContain("child-not-before-parent");
  });
});

describe("scale", () => {
  function leavesAtScale(count: number, headingPathAt: (i: number) => string[]): SummaryTreeLeaf[] {
    return Array.from({ length: count }, (_, i) => ({ chunkIndex: i * 2, rawText: `p${i}`, headingPath: headingPathAt(i), pageStart: 1 + Math.floor(i / 3), pageEnd: 1 + Math.floor(i / 3) }));
  }

  async function run(leaves: SummaryTreeLeaf[], similarityAt: (gap: number) => number) {
    const similarities = Float64Array.from({ length: leaves.length - 1 }, (_, gap) => similarityAt(gap));
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const next = random(11);
    const vectors = new Map<number, number[]>();
    const tree = await buildSummaryTree({
      leaves, leafSimilarities: similarities,
      onLevel: (created) => { for (const node of created) vectors.set(node, [next(), next(), next(), next()]); },
      vectorOf: (node) => vectors.get(node),
    });
    const hashes = hashSummaryTreeNodes({ nodes: tree.nodes, leafHashByChunkIndex: leafHashesByChunkIndex(leaves), context: CONTEXT });
    const violations = checkSummaryTreeCoverage(tree);
    return { tree, hashes, violations, ms: performance.now() - started, heapGrowthMb: (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024 };
  }

  // 60,000 leaves is about a 20,000-page document. The budgets are loose: they catch a quadratic scan, not jitter.
  const LEAVES = 60_000;
  const TIME_BUDGET_MS = 10_000;
  const HEAP_BUDGET_MB = 400;

  it("groups one heading-less 60,000-leaf section in bounded time and memory", async () => {
    const next = random(3);
    const result = await run(leavesAtScale(LEAVES, () => []), () => next());
    expect(result.violations).toEqual([]);
    expect(result.tree.nodes[result.tree.root!]!.leafCount).toBe(LEAVES);
    expect(result.tree.nodes.length).toBeLessThan(LEAVES / 2);
    expect(new Set(result.hashes).size).toBe(result.hashes.length);
    expect(result.ms).toBeLessThan(TIME_BUDGET_MS);
    expect(result.heapGrowthMb).toBeLessThan(HEAP_BUDGET_MB);
  });

  it("stays bounded when every cut peels the smallest allowed side", async () => {
    // Strictly rising similarities make each cut as lopsided as the minimum allows: the worst case for a scan per cut.
    const result = await run(leavesAtScale(LEAVES, () => []), (gap) => gap / LEAVES);
    expect(result.violations).toEqual([]);
    const sizes = result.tree.nodes.filter((node) => node.childKind === "leaf").map((node) => node.leafCount);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(4);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(16);
    expect(result.ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it("groups 60,000 leaves under 3,000 headings three levels deep", async () => {
    const next = random(5);
    const path = (i: number) => [`Part ${Math.floor(i / 6000)}`, `Chapter ${Math.floor(i / 400)}`, `Section ${Math.floor(i / 20)}`];
    const result = await run(leavesAtScale(LEAVES, path), () => next());
    expect(result.violations).toEqual([]);
    expect(result.tree.nodes[result.tree.root!]!.headingPath).toEqual([]);
    expect(result.tree.nodes.filter((node) => node.headingPath.length === 1 && node.level > 1 && node.children.length > 1).length).toBeGreaterThanOrEqual(10);
    expect(result.ms).toBeLessThan(TIME_BUDGET_MS);
    expect(result.heapGrowthMb).toBeLessThan(HEAP_BUDGET_MB);
  });
});
