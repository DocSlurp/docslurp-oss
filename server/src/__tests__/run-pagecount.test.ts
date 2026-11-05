import { describe, expect, it, vi } from "vitest";

// Any child process the API path started would show here (pdfinfo used to run on every PDF upload).
const spawned = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const record = (name: string) => (...args: unknown[]) => { spawned.push(`${name}:${String(args[0])}`); throw new Error(`child process ${name} in the API path`); };
  return { ...actual, spawn: record("spawn"), spawnSync: record("spawnSync"), execFile: record("execFile"), execFileSync: record("execFileSync"), exec: record("exec") };
});

const s3 = vi.hoisted(() => ({ bytes: new Uint8Array() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    middlewareStack = { add: vi.fn(), addRelativeTo: vi.fn() }; send = async () => ({ Body: { transformToByteArray: async () => s3.bytes } }); },
  GetObjectCommand: class { constructor(readonly input: unknown) {} },
}));

import { ASSUMED_BYTES_PER_PAGE, intakePageCountSource } from "@docslurp/shared";
import { estimateNonPdfPageCount, resolveSourceMetadata, UnreadableSourceError } from "../services/source-metadata.js";

describe("estimateNonPdfPageCount", () => {
  it("uses line and character heuristics for text formats", () => {
    const text = Array.from({ length: 180 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(estimateNonPdfPageCount("text/plain", Buffer.from(text))).toBe(3);
  });

  it("defaults binary formats to a single page", () => {
    expect(estimateNonPdfPageCount("application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from([1, 2, 3]))).toBe(1);
  });
});

describe("a PDF upload in the API: never parsed, only estimated", () => {
  const file = { mimeType: "application/pdf", sourceKey: "sources/x.pdf", filename: "report.pdf" };

  it("starts no child process and loads no native module, and labels the size-based count an estimate", async () => {
    // A 40-page-sized PDF whose body would make any parser work: the API reads only its size and header.
    s3.bytes = new Uint8Array(Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(40 * ASSUMED_BYTES_PER_PAGE - 9, 0x20)]));
    spawned.length = 0;
    const dlopen = vi.spyOn(process, "dlopen");
    try {
      const metadata = await resolveSourceMetadata(file);
      expect(metadata.pageCount).toBe(40);
      expect(metadata.fileFacts.mimeType).toBe("application/pdf");
      expect(intakePageCountSource({ name: "report.pdf", type: metadata.fileFacts.mimeType })).toBe("assumed");
      expect(spawned).toEqual([]);
      expect(dlopen).not.toHaveBeenCalled();
    } finally {
      dlopen.mockRestore();
    }
  });

  it("accepts a truncated or broken PDF at intake (the worker measures and fails it in its boundary)", async () => {
    s3.bytes = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog");
    await expect(resolveSourceMetadata(file)).resolves.toMatchObject({ pageCount: 1 });
    expect(spawned).toEqual([]);
  });

  it("still refuses a file whose bytes contradict its declared PDF type, from the header alone", async () => {
    s3.bytes = new TextEncoder().encode("plain text pretending to be a pdf");
    const error = await resolveSourceMetadata(file).catch((caught) => caught);
    expect(error).toBeInstanceOf(UnreadableSourceError);
    expect(spawned).toEqual([]);
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

  it("does not open a ZIP declared as a DOCX: the worker's quarantine inspects it, the API keeps the declaration provisional", async () => {
    s3.bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(64).fill(7)]);
    const metadata = await resolveSourceMetadata({ mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sourceKey: "k", filename: "x.docx" });
    expect(metadata.fileFacts).toMatchObject({ container: "zip", mismatch: "none", inspection: "header" });
  });

  it("refuses a ZIP declared as a PDF, which the magic bytes alone contradict", async () => {
    s3.bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(64).fill(7)]);
    const error = await resolveSourceMetadata({ mimeType: "application/pdf", sourceKey: "k", filename: "x.pdf" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(UnreadableSourceError);
  });

  it("counts a very large text file from a bounded sample", async () => {
    const line = `${"word ".repeat(40)}\n`;
    const bytes = Buffer.from(line.repeat(Math.ceil(30_000_000 / line.length)));
    const started = performance.now();
    const pages = estimateNonPdfPageCount("text/plain", bytes);
    expect(performance.now() - started).toBeLessThan(500);
    expect(pages).toBeGreaterThan(8_000);
  });
});
