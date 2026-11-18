import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { json: (value: unknown) => value, array: (value: unknown) => value }) }));

const { looksLikeUrlFilename, urlDerivedFilename } = await import("../services/remote-ingest.js");
const { opaqueCanonicalIdForUrl } = await import("../lib/canonical-id.js");
const { sanitizeReplayedUrlIntake } = await import("../services/project-intake-actions.js");

describe("URL-derived names", () => {
  it.each<[string, string]>([
    ["https://example.com/reports/q1-pipeline.txt?token=secret", "q1-pipeline.txt"],
    ["https://example.com/docs/Annual%20Report%202025.pdf", "Annual Report 2025.pdf"],
    ["https://files.example.com/d/GRANTSECRET0123456789abcdef.pdf", "files.example.com-3.pdf"],
    ["https://files.example.com/d/0123456789abcdef0123456789abcdef", "files.example.com-3.pdf"],
    ["https://files.example.com/", "files.example.com-3.pdf"],
    [`https://files.example.com/${"a-".repeat(60)}.pdf`, "files.example.com-3.pdf"],
  ])("%s → %s", (url, name) => {
    expect(urlDerivedFilename(new URL(url), 3, "application/pdf")).toBe(name);
  });

  it("keeps ordinary word-separated filenames", () => {
    expect(looksLikeUrlFilename("quarterly_report_2024_final_version.pdf")).toBe(true);
    expect(looksLikeUrlFilename("README")).toBe(false);
  });

  it("gives a URL an opaque canonical ID that still matches on re-ingest", () => {
    const id = opaqueCanonicalIdForUrl("https://example.com/products/#pricing");
    expect(id).toMatch(/^url:[0-9a-f]{64}$/);
    expect(id).toBe(opaqueCanonicalIdForUrl("https://example.com/products"));
    expect(opaqueCanonicalIdForUrl("https://example.com/a.pdf?X-Amz-Signature=SIG")).not.toContain("SIG");
  });
});

describe("replayed URL-intake receipts", () => {
  it("never replays an old receipt's URL-derived names, messages or canonical IDs", () => {
    const grant = "https://files.example.com/d/GRANTSECRET0123456789abcdef/report.pdf?X-Amz-Signature=SIGSECRET";
    const old = {
      project: { id: "p1", name: "Import from files.example.com" },
      run: { id: "r1" },
      documents: [{ id: "d1", filename: "GRANT2SECRET0123456789abcdef.txt", mimeType: "text/plain", canonicalId: "https://files.example.com/x?sig=SIGSECRET" }],
      ingested: [{ filename: "GRANT2SECRET0123456789abcdef.txt", mimeType: "text/plain" }],
      warnings: [`1 of 2 files were not accepted: ${grant}.`],
      rejected: [{ filename: grant, statusCode: 400, code: "rejected", message: `Failed to fetch ${grant}: 503` }],
    } as never;
    const replayed = sanitizeReplayedUrlIntake(old);
    expect(JSON.stringify(replayed)).not.toMatch(/GRANT|SIGSECRET/);
    expect(replayed.rejected).toEqual([{ index: 0, filename: "urls[0]", statusCode: 400, code: "rejected", message: "The URL's content could not be taken" }]);
    expect(replayed.documents[0]).toMatchObject({ filename: "url-0.txt", canonicalId: opaqueCanonicalIdForUrl("https://files.example.com/x?sig=SIGSECRET") });
    expect(replayed.warnings).toEqual(["1 of 2 files were not accepted: urls[0]."]);
  });

  it("leaves a current receipt's fixed copy alone", () => {
    const current = {
      project: { id: "p1" }, run: { id: "r1" },
      documents: [{ id: "d1", filename: "notes.txt", mimeType: "text/plain", canonicalId: "url:abc" }],
      warnings: ["1 of 2 files were not accepted: urls[1]."],
      rejected: [{ index: 1, filename: "urls[1]", statusCode: 400, code: "rejected", message: "The URL's host could not be resolved" }],
    } as never;
    expect(sanitizeReplayedUrlIntake(current)).toEqual(current);
  });
});
