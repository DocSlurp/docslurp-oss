import { describe, expect, it } from "vitest";
import { readPdfStructure } from "./pdf-structure.js";

describe("PDF structure parser dependency contract", () => {
  it.each([
    ["empty", new Uint8Array()],
    ["truncated PDF", new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n")],
    ["large invalid input", new Uint8Array(1024 * 1024).fill(65)],
  ])("rejects %s without returning partial structure", async (_name, bytes) => {
    const original = bytes.slice();
    await expect(readPdfStructure(bytes)).rejects.toThrow();
    expect(bytes).toEqual(original);
  });
});
