import { describe, expect, it } from "vitest";

import { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import { buildAdaptiveRoutingDecisionSurface } from "../stages/classify-route.js";
import { PAGE_ROUTE_PLAN_SLOT } from "../routing/runtime.js";
import { freeVisualCandidateStats, quarantineChartPresence } from "./free-stats.js";

function store(objects: Record<string, unknown>) {
  return {
    bucket: "b",
    uri: (key: string) => `s3://b/${key}`,
    async getJson<T>(key: string): Promise<T> {
      if (!(key in objects)) throw new Error("missing");
      return structuredClone(objects[key]) as T;
    },
    async putJson() { throw new Error("free stats must not write"); },
    async putBytes() { throw new Error("free stats must not write"); },
    async deleteKeys() { /* unused */ },
  };
}

const document = { id: "doc", userId: "u", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", pageCount: 4 };

/** A real classifier surface with page 2 routed as a chart page. */
function classification() {
  const surface = buildAdaptiveRoutingDecisionSurface({
    documentId: "doc", filename: "deck.pptx", text: "Intro\fRevenue\fOutro", pageCount: 3,
    evidence: { source: "canonical-document", artifactUri: "s3://b/canonical.json" },
  }) as { status: string; pages: Array<{ pageNumber: number; route: string }> };
  expect(surface.status).toBe("ready");
  const out = { ...surface, pages: surface.pages.map((page) => ({ ...page, route: page.pageNumber === 2 ? "chart-or-figure" : "straightforward-text" })) };
  return out;
}

describe("free visual candidate stats", () => {
  it("reads Office chart presence from the quarantine inspection and ignores malformed counts", async () => {
    const ledger = DocumentArtifactLedger.create({});
    ledger.recordDocument("doc", "quarantine", "s3://b/q.json");
    expect(await quarantineChartPresence(store({ "q.json": { archive: { chartParts: 3 } } }), ledger, "doc")).toEqual({ officeChartParts: 3 });
    expect(await quarantineChartPresence(store({ "q.json": { archive: { chartParts: "3" } } }), ledger, "doc")).toEqual({});
    expect(await quarantineChartPresence(store({ "q.json": { archive: null } }), ledger, "doc")).toEqual({});
    expect(await quarantineChartPresence(store({}), DocumentArtifactLedger.create({}), "doc")).toEqual({});
  });

  it("counts legacy chart pages and quarantine chart parts without writing or calling anything", async () => {
    const ledger = DocumentArtifactLedger.create({});
    ledger.recordDocument("doc", "quarantine", "s3://b/q.json");
    ledger.recordDocument("doc", "classification", "s3://b/c.json");
    const objects = {
      "q.json": { archive: { chartParts: 2 } },
      "c.json": classification(),
    };
    const { stats, lowConfidence } = await freeVisualCandidateStats({ storage: store(objects) as never, ledger, document, run: { id: "run" } });
    // Two Office chart parts (free: counted in their deterministic bucket, so estimates never price them). The legacy
    // keyword page has no other signal: low confidence, counted apart and never priced.
    expect(stats).toEqual({ charts: 2, diagrams: 0, pagesWithUnexportedVisuals: [], exported: 0, bySource: { "office-chart-xml": 2 } });
    expect(lowConfidence).toBe(1);
  });

  it("counts a keyword page a Doppler figure confirms, and reads no slot the document lacks", async () => {
    const ledger = DocumentArtifactLedger.create({});
    ledger.recordDocument("doc", "doppler-figures", "s3://b/f.json");
    const reads: string[] = [];
    const base = store({
      "f.json": { figures: [{ id: "p2.g0", page: 2, bbox: [0, 0, 10, 10], kind: "picture", fate: "kept", format: "png", mediaType: "image/png", bytes: 10, sha256: "a".repeat(64), width: 10, height: 10, fileOf: "p2.g0", slot: "doppler-figure:p2.g0" }] },
    });
    const storage = { ...base, async getJson<T>(key: string): Promise<T> { reads.push(key); return await base.getJson<T>(key); } };
    const pdf = { ...document, mimeType: "application/pdf" };
    const { stats, lowConfidence } = await freeVisualCandidateStats({ storage: storage as never, ledger, document: pdf, run: { id: "run" }, classification: classification() });
    expect(stats).toMatchObject({ charts: 1, pagesWithUnexportedVisuals: [2], bySource: {} });
    expect(lowConfidence).toBe(0);
    // Classification came from the caller; no plan, media map or quarantine slot, so only the figure index is read.
    expect(reads).toEqual(["f.json"]);
  });

  it("returns empty stats when nothing is stored", async () => {
    const { stats } = await freeVisualCandidateStats({ storage: store({}) as never, ledger: DocumentArtifactLedger.create({}), document, run: { id: "run" } });
    expect(stats).toEqual({ charts: 0, diagrams: 0, pagesWithUnexportedVisuals: [], exported: 0, bySource: {} });
    expect(PAGE_ROUTE_PLAN_SLOT).toBe("page-route-plan");
  });
});
