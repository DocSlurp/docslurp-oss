import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CommandPlan } from "../tools/runner.js";
import { detectImageLayout, detectImageLayoutAtEndpoint, parseImageLayout } from "./image-layout.js";

const payload = () => ({ schemaVersion: 1, coordinateSpace: "normalized-source", model: { id: "detector", revision: "test" }, device: "cpu", image: { width: 20, height: 10 }, supportedLabels: ["figure"], regions: [{ label: "figure", rawLabel: "picture", confidence: 0.8, bbox: [0.1, 0.2, 0.9, 0.8] }] });

describe("image layout transport boundary", () => {
  it("preserves raw coarse classes without inventing unsupported distinctions", () => {
    const parsed = parseImageLayout(payload());
    expect(parsed.regions[0]).toEqual(payload().regions[0]);
    expect(parsed.supportedLabels).not.toContain("photo");
    expect(() => parseImageLayout({ ...payload(), regions: [{ ...payload().regions[0], label: "photo" }] })).toThrow("not declared supported");
  });
  it.each([[0.9, 0.2, 0.1, 0.8], [-0.1, 0, 1, 1], [0, 0, Infinity, 1], [0, 0, 1]])("rejects invalid source boxes %j", (...bbox) => {
    expect(() => parseImageLayout({ ...payload(), regions: [{ ...payload().regions[0], bbox }] })).toThrow();
  });
  it("preserves bounded detector and transform diagnostics", () => {
    const diagnostics = { detectorMetadata: { orientation: { revision: "pinned" } }, imageTransforms: [{ orientation: { correction_angle: 90 } }] };
    expect(parseImageLayout({ ...payload(), diagnostics }).diagnostics).toEqual(diagnostics);
    expect(() => parseImageLayout({ ...payload(), diagnostics: [] })).toThrow("object");
  });
  it("preserves declared geometric coverage and validates visual fingerprints", () => {
    const region = { ...payload().regions[0], imageCoverage: 0.48, coverageKind: "half-page", fingerprint: { algorithm: "dhash-64", value: "0123456789abcdef" } };
    expect(parseImageLayout({ ...payload(), regions: [region] }).regions[0]).toEqual(region);
    expect(() => parseImageLayout({ ...payload(), regions: [{ ...region, fingerprint: { algorithm: "dhash-64", value: "bad" } }] })).toThrow("fingerprint");
  });
  it("preserves optional model-native polygons and reading order, rejecting malformed metadata", () => {
    const region = { ...payload().regions[0], polygon: [[0.1, 0.2], [0.9, 0.2], [0.5, 0.8]], readingOrder: 0 };
    expect(parseImageLayout({ ...payload(), regions: [region] }).regions[0]).toEqual(region);
    for (const polygon of [[], [[0, 0], [1, 1]], [[0, 0], [1, 1], [NaN, 0]], [[0, 0], [1, 1], [2, 0]], [[0, 0], [1, 1], [0]]]) {
      expect(() => parseImageLayout({ ...payload(), regions: [{ ...region, polygon }] })).toThrow();
    }
    for (const readingOrder of [-1, 0.5, Infinity, "0"]) {
      expect(() => parseImageLayout({ ...payload(), regions: [{ ...region, readingOrder }] })).toThrow("reading order");
    }
  });
  it("rejects unknown coordinate spaces and nonfinite confidence", () => {
    expect(() => parseImageLayout({ ...payload(), coordinateSpace: "pixels" })).toThrow("coordinate space");
    expect(() => parseImageLayout({ ...payload(), regions: [{ ...payload().regions[0], confidence: NaN }] })).toThrow("finite");
  });
  it("stages opaque bytes for VM metadata and inference without host decoding", async () => {
    const input = Buffer.from("malformed or hostile source bytes");
    let output = "";
    const run = vi.fn(async (plan: CommandPlan) => {
      expect(plan.bundleEnv).toBeUndefined(); expect(plan.bundleRoots).toBeUndefined();
      expect(plan.documentVm?.operation).toBe("layout");
      expect(await readFile(plan.documentVm!.input)).toEqual(input);
      output = plan.documentVm!.output;
      await writeFile(output, JSON.stringify({ ...payload(), model: { id: "docling-project/docling-layout-heron", revision: "pinned", artifactSha256: "a".repeat(64) }, inferenceProfileSha256: "b".repeat(64), image: { width: 20, height: 10, sha256: createHash("sha256").update(input).digest("hex") } }));
      return { stdout: "", stderr: "" };
    });
    await detectImageLayout(input, { model: "heron", device: "cpu", revision: "pinned", artifactSha256: "a".repeat(64), inferenceProfileSha256: "b".repeat(64) }, { run });
    expect(run).toHaveBeenCalledOnce(); await expect(access(output)).rejects.toThrow();
  });
  it.each(["cuda", "cuda:0", "cpu:0"])("refuses unsupported device %s without dispatch", async (device) => {
    const run = vi.fn();
    await expect(detectImageLayout(Buffer.from("bytes"), { model: "heron", device: device as "cuda", revision: "pinned", artifactSha256: "a".repeat(64), inferenceProfileSha256: "b".repeat(64) }, { run })).rejects.toThrow("CPU-only");
    expect(run).not.toHaveBeenCalled();
  });
  it("refuses oversized input and malformed or excessive guest dimensions/regions", async () => {
    await expect(detectImageLayout(Buffer.alloc(25*1024*1024+1), {} as never, { run: vi.fn() })).rejects.toThrow("25 MiB");
    expect(() => parseImageLayout({ ...payload(), image: { width: 100000, height: 100000 } })).toThrow("dimensions");
    expect(() => parseImageLayout({ ...payload(), regions: Array(4097).fill(payload().regions[0]) })).toThrow("bounds");
  });
  it("refuses the legacy loopback backend without fetching", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    try {
      await expect(detectImageLayoutAtEndpoint(Buffer.from("bytes"), { endpoint: "http://127.0.0.1:8769/layout", expectedModelId: "x", expectedRevision: "pinned", device: "cpu" })).rejects.toThrow("not a VM boundary");
      expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
