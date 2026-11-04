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

describe("estimateNonPdfPageCount decoding", () => {
  it("counts a UTF-16LE CSV by its characters, not its bytes", () => {
    const rows = Array.from({ length: 100 }, (_, index) => `row${index},value${index}`).join("\r\n");
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rows, "utf16le")]);
    expect(estimateNonPdfPageCount("text/csv", utf16, "utf-16le")).toBe(estimateNonPdfPageCount("text/csv", Buffer.from(rows)));
  });

  it("counts East Asian text at its information density, and HTML without its markup", () => {
    const cjk = "日本語".repeat(500); // 1,500 characters ≈ 4,500 weighted → 2 pages
    expect(estimateNonPdfPageCount("text/plain", Buffer.from(cjk))).toBe(2);
    const markup = `<html><head><style>${"a{color:red}".repeat(2000)}</style><script>${"var x=1;".repeat(2000)}</script></head><body><p>Short page.</p></body></html>`;
    expect(estimateNonPdfPageCount("text/html", Buffer.from(markup))).toBe(1);
    expect(estimateNonPdfPageCount("text/plain", Buffer.from(markup))).toBeGreaterThan(1);
  });
});

describe("resolveSourceMetadata file facts", () => {
  const csv = "name,total\nacme,10\nbeta,20\n";

  it("stores a CSV declared application/vnd.ms-excel as text/csv with a warning, and counts it as text", async () => {
    s3.bytes = new TextEncoder().encode(csv);
    const metadata = await resolveSourceMetadata({ mimeType: "application/vnd.ms-excel", sourceKey: "k", filename: "data.csv" });
    expect(metadata.fileFacts).toMatchObject({ mimeType: "text/csv", mismatch: "same-family", declaredMimeType: "application/vnd.ms-excel" });
    expect(metadata.pageCount).toBe(1);
  });

  it("refuses plain text declared as a PDF, per file, before any parser sees it", async () => {
    s3.bytes = new TextEncoder().encode("this is just words\nnot a pdf\n");
    const error = await resolveSourceMetadata({ mimeType: "application/pdf", sourceKey: "k", filename: "fake.pdf" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(UnreadableSourceError);
    expect(error.message).toContain("fake.pdf");
    expect(error.message).toContain("not the declared application/pdf");
  });

  it("refuses a hostile ZIP declared as a DOCX", async () => {
    s3.bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(64).fill(7)]);
    const error = await resolveSourceMetadata({ mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sourceKey: "k", filename: "x.docx" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(UnreadableSourceError);
  });
});
