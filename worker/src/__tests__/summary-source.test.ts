import { describe, expect, it, vi } from "vitest";
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
    expect(storage.getByteRange).toHaveBeenCalledTimes(16);
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

  it("honors cancellation before starting storage work", async () => {
    const storage = { bucket: "b", objectSize: vi.fn(), getByteRange: vi.fn() };
    await expect(readSummarySource(storage, document, "s3://b/doc.md", AbortSignal.abort(new Error("cancelled"))))
      .rejects.toThrow("cancelled");
    expect(storage.objectSize).not.toHaveBeenCalled();
  });
});
