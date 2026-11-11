import { describe, expect, it } from "vitest";

import type { DiagramSpec } from "@docslurp/shared";

import { extractDeterministicVisuals } from "../index.js";
import { GRAPHVIZ_DIGRAPH, MERMAID_FLOWCHART } from "./fixtures.js";

function diagram(text: string) {
  const r = extractDeterministicVisuals({ kind: "svg", text });
  expect(r.refusals).toEqual([]);
  expect(r.visuals).toHaveLength(1);
  expect(r.visuals[0]!.kind).toBe("diagram");
  return { v: r.visuals[0]!, spec: r.visuals[0]!.spec as DiagramSpec };
}

describe("svg diagrams", () => {
  it("reads a Mermaid flowchart: nodes, shapes, edges, labels and styles", () => {
    const { v, spec } = diagram(MERMAID_FLOWCHART);
    expect(v.generator).toBe("mermaid");
    expect(spec.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([
      ["Start", "Order in", "rounded"], ["Check", "Stock?", "diamond"], ["Ship_order", "Ship <fast>", "box"], ["Restock", "Restock", "box"],
    ]);
    expect(spec.edges).toEqual([
      { from: "Start", to: "Check", label: null, style: "solid", directed: true },
      { from: "Check", to: "Ship_order", label: "in stock", style: "solid", directed: true },
      { from: "Check", to: "Restock", label: null, style: "dashed", directed: false },
    ]);
    expect(spec.direction).toBe("TB");
    expect(v.confidence).toBeGreaterThan(0.9);
  });

  it("reads a Graphviz digraph with clusters, shapes and dashed edges", () => {
    const { v, spec } = diagram(GRAPHVIZ_DIGRAPH);
    expect(v.generator).toBe("graphviz");
    expect(spec.title).toBe("pipeline");
    expect(spec.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([["upload", "Upload", "rounded"], ["parse", "Parse & chunk", "box"], ["index", "Index?", "diamond"]]);
    expect(spec.nodes[0]!.group).toBe(spec.groups[0]!.id);
    expect(spec.groups[0]!.label).toBe("Ingest");
    expect(spec.edges).toEqual([
      { from: "upload", to: "parse", label: "bytes", style: "solid", directed: true },
      { from: "parse", to: "index", label: null, style: "dashed", directed: true },
    ]);
  });

  it("sanitises hostile node ids and keeps labels as data", () => {
    const svg = GRAPHVIZ_DIGRAPH.replaceAll("<title>upload</title>", "<title>a&quot;];click a call alert(1)%%</title>")
      .replace("<title>upload&#45;&gt;parse</title>", "<title>a&quot;];click a call alert(1)%%&#45;&gt;parse</title>");
    const { spec } = diagram(svg);
    const n = spec.nodes[0]!;
    expect(n.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(spec.edges[0]!.from).toBe(n.id);
  });

  it("skips diagrams when the option is off", () => {
    expect(extractDeterministicVisuals({ kind: "svg", text: MERMAID_FLOWCHART }, { diagrams: false }).visuals).toEqual([]);
  });
});
