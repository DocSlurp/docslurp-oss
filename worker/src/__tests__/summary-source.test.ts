import { describe, expect, it, vi } from "vitest";
import { buildSummaryEvidence } from "../stages/summary-evidence.js";
import { readSummarySource, SUMMARY_SOURCE_MAX_BYTES } from "../stages/summary-source.js";

const document = { sourceKey: "source.pdf", mimeType: "application/pdf" };

describe("bounded summary source reads", () => {
  it("reads a one- or two-page text artifact completely in one request", async () => {
    const text = Buffer.from("# Short document\n" + "Details. ".repeat(200));
    const storage = { bucket: "b", objectSize: vi.fn(async () => text.length),
      getByteRange: vi.fn(async () => text) };
    const result = await readSummarySource(storage, document, "s3://b/doc.md");
    expect(result).toEqual({ text: text.toString(), sourceBytes: text.length, readBytes: text.length, sampled: false });
    expect(storage.getByteRange).toHaveBeenCalledOnce();
  });

  it("samples a terabyte artifact without allocating or reading the entire object", async () => {
    const size = 1_000_000_000_000;
    const storage = { bucket: "b", objectSize: vi.fn(async () => size),
      getByteRange: vi.fn(async (_key: string, start: number, end: number) => Buffer.alloc(end - start + 1, "x")) };
    const result = await readSummarySource(storage, document, "s3://b/huge.md");
    expect(result?.sampled).toBe(true);
    expect(result?.sourceBytes).toBe(size);
    expect(result?.readBytes).toBe(SUMMARY_SOURCE_MAX_BYTES);
    expect(storage.getByteRange).toHaveBeenCalledTimes(4);
    expect(storage.getByteRange.mock.calls[0]?.[1]).toBe(0);
    expect(storage.getByteRange.mock.calls.at(-1)?.[2]).toBe(size - 1);
  });

  it("never reparses raw PDFs or reads oversized manifests", async () => {
    const storage = { bucket: "b", objectSize: vi.fn(async () => 100_000), getByteRange: vi.fn() };
    expect(await readSummarySource(storage, document, undefined)).toBeNull();
    expect(await readSummarySource(storage, document, "s3://b/huge.json")).toBeNull();
    expect(storage.getByteRange).not.toHaveBeenCalled();
  });

  it("resolves a bounded manifest and rejects cross-bucket references", async () => {
    const manifest = Buffer.from(JSON.stringify({ textArtifactUri: "s3://b/text.md" }));
    const storage = { bucket: "b", objectSize: vi.fn(async (key: string) => key.endsWith("json") ? manifest.length : 4),
      getByteRange: vi.fn(async (key: string) => key.endsWith("json") ? manifest : Buffer.from("text")) };
    expect((await readSummarySource(storage, document, "s3://b/manifest.json"))?.text).toBe("text");
    storage.getByteRange.mockResolvedValue(Buffer.from(JSON.stringify({ textArtifactUri: "s3://other/private.md" })));
    expect(await readSummarySource(storage, document, "s3://b/manifest.json")).toBeNull();
  });

  it("reads only the bounded sidecar and rejects stale document/source bindings", async () => {
    const artifact = buildSummaryEvidence({ text: "page one\fpage two", pageCount: 2,
      documentId: "doc", sourceUri: "s3://b/doc.md" });
    const data = Buffer.from(JSON.stringify(artifact));
    const storage = { bucket: "b", objectSize: vi.fn(async () => data.length), getByteRange: vi.fn(async () => data) };
    const result = await readSummarySource(storage, { ...document, id: "doc" }, "s3://b/doc.md", undefined, "s3://b/evidence.json");
    expect(result?.coverage?.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(storage.objectSize).toHaveBeenCalledExactlyOnceWith("evidence.json", undefined);
    expect(result?.readBytes).toBe(data.length);
    await expect(readSummarySource(storage, { ...document, id: "other" }, "s3://b/doc.md", undefined, "s3://b/evidence.json")).rejects.toThrow("does not match");
    storage.objectSize.mockResolvedValue(20_000);
    await expect(readSummarySource(storage, { ...document, id: "doc" }, "s3://b/doc.md", undefined, "s3://b/evidence.json")).rejects.toThrow("exceeds");
  });

  it("summarizes the current markdown when a later stage replaced it after the evidence was cut", async () => {
    const evidence = Buffer.from(JSON.stringify(buildSummaryEvidence({ text: "stale extraction text", pageCount: 1,
      documentId: "doc", sourceUri: "s3://b/extracted.md" })));
    const current = Buffer.from("reconciled markdown text");
    const storage = { bucket: "b",
      objectSize: vi.fn(async (key: string) => key === "evidence.json" ? evidence.length : current.length),
      getByteRange: vi.fn(async (key: string) => key === "evidence.json" ? evidence : current) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await readSummarySource(storage, { ...document, id: "doc" }, "s3://b/reconciled.md", undefined, "s3://b/evidence.json");
    expect(result).toMatchObject({ text: "reconciled markdown text", sampled: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stale_summary_evidence document=doc"));
    warn.mockRestore();
  });

  it("falls back to the markdown when the evidence object was deleted", async () => {
    const current = Buffer.from("redacted markdown");
    const storage = { bucket: "b", objectSize: vi.fn(async (key: string) => key === "evidence.json" ? null : current.length),
      getByteRange: vi.fn(async () => current) };
    expect((await readSummarySource(storage, { ...document, id: "doc" }, "s3://b/doc.md", undefined, "s3://b/evidence.json"))?.text)
      .toBe("redacted markdown");
  });

  it("honors cancellation before starting storage work", async () => {
    const storage = { bucket: "b", objectSize: vi.fn(), getByteRange: vi.fn() };
    await expect(readSummarySource(storage, document, "s3://b/doc.md", AbortSignal.abort(new Error("cancelled"))))
      .rejects.toThrow("cancelled");
    expect(storage.objectSize).not.toHaveBeenCalled();
  });
});
