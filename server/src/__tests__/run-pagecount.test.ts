import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

const s3 = vi.hoisted(() => ({ bytes: new Uint8Array() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    middlewareStack = { add: vi.fn(), addRelativeTo: vi.fn() }; send = async () => ({ Body: { transformToByteArray: async () => s3.bytes } }); },
  GetObjectCommand: class { constructor(readonly input: unknown) {} },
}));

import { estimateNonPdfPageCount, parsePdfInfoPageCount, resolveSourceMetadata, UnreadableSourceError } from "../services/source-metadata.js";

describe("parsePdfInfoPageCount", () => {
  it("extracts the page count from pdfinfo output", () => {
    expect(
      parsePdfInfoPageCount(`Title: sample.pdf
Pages:          14
Encrypted:      no`)
    ).toBe(14);
  });

  it("returns null when pdfinfo output has no page count", () => {
    expect(parsePdfInfoPageCount("Title: sample.pdf")).toBeNull();
  });
});

describe("estimateNonPdfPageCount", () => {
  it("uses line and character heuristics for text formats", () => {
    const text = Array.from({ length: 180 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(estimateNonPdfPageCount("text/plain", Buffer.from(text))).toBe(3);
  });

  it("defaults binary formats to a single page", () => {
    expect(estimateNonPdfPageCount("application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from([1, 2, 3]))).toBe(1);
  });
});

describe("resolveSourceMetadata with unreadable PDFs", () => {
  const hasPdfInfo = spawnSync("pdfinfo", ["-v"]).error === undefined;
  const file = { mimeType: "application/pdf", sourceKey: "sources/x.pdf", filename: "report.pdf" };

  it.skipIf(!hasPdfInfo).each([
    ["empty", new Uint8Array()],
    ["not a pdf", new TextEncoder().encode("plain text pretending to be a pdf")],
    ["truncated header", new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog")],
  ])("reports a %s file as a client error naming the file", async (_label, bytes) => {
    s3.bytes = bytes;
    const error = await resolveSourceMetadata(file).catch((caught) => caught);
    expect(error).toBeInstanceOf(UnreadableSourceError);
    expect(error).toMatchObject({ statusCode: 422, code: "unreadable_source" });
    expect(error.message).toContain("report.pdf");
  });
});
