import { describe, expect, it } from "vitest";

import { documentExportFolderNames, documentExportRequestSchema, rfc5987Encode, safeExportName } from "./document-export.js";

describe("document export names", () => {
  it("dedupes folders ignoring case, never reuses a name, and reserves README", () => {
    expect(documentExportFolderNames(["a.pdf", "a.docx", "a (2).pdf", "A.txt"])).toEqual(["a", "a (2)", "a (2) (2)", "A (3)"]);
    expect(documentExportFolderNames(["README.pdf", "readme.md.docx"])).toEqual(["README (2)", "readme.md (2)"]);
  });

  it("makes names that unzip anywhere", () => {
    expect(safeExportName("../../etc/passwd")).toBe("etc-passwd");
    expect(safeExportName("  ...  ")).toBe("document");
    expect(safeExportName("trail...   ")).toBe("trail");
    expect(safeExportName("CON")).toBe("CON_");
    expect(safeExportName("nul.txt", "x", { keepExtension: true })).toBe("nul_.txt");
    const long = safeExportName(`${"x".repeat(100)}.pdf`, "x", { keepExtension: true });
    expect(long).toHaveLength(60);
    expect(long.endsWith(".pdf")).toBe(true);
    // Shortened by code point, so an emoji is never split.
    expect(Array.from(safeExportName("😀".repeat(70)))).toHaveLength(60);
  });

  it("encodes filename* per RFC 5987", () => {
    expect(rfc5987Encode("it's (a)*.zip")).toBe("it%27s%20%28a%29%2A.zip");
  });

  it("takes a document, a workspace, or neither (the default workspace), never both", () => {
    expect(documentExportRequestSchema.safeParse({}).success).toBe(true);
    expect(documentExportRequestSchema.parse({ workspaceId: "default" }).content).toBe("markdown");
    expect(documentExportRequestSchema.safeParse({ documentId: "a", workspaceId: "b" }).success).toBe(false);
  });
});
