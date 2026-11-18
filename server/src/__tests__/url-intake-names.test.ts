import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { json: (value: unknown) => value, array: (value: unknown) => value }) }));

const { urlDerivedFilename } = await import("../services/remote-ingest.js");
const { opaqueCanonicalIdForUrl } = await import("../lib/canonical-id.js");
const { INTAKE_RECEIPT_VERSION, replayedPayload } = await import("../services/project-intake-actions.js");
const { canonicalIdForUrl } = await import("../lib/canonical-id.js");
const { publicDocumentIdentity } = await import("../lib/url-document-identity.js");
const { mapDocument } = await import("../services/run-records.js");

describe("URL-derived names", () => {
  it.each<string>([
    "https://example.com/reports/q1-pipeline.txt?token=secret",
    "https://example.com/docs/Annual%20Report%202025.pdf",
    // Grant-shaped paths with an extension and separators: no heuristic can tell them from filenames.
    "https://files.example.com/d/share-7f3k-q9zx-report.pdf",
    "https://files.example.com/d/GRANT-SECRET_x1.y2.pdf",
    "https://files.example.com/",
  ])("%s → <host>-<index><ext>", (url) => {
    expect(urlDerivedFilename(new URL(url), 3, "application/pdf")).toBe(`${new URL(url).hostname}-3.pdf`);
  });

  it("gives a URL an opaque canonical ID that still matches on re-ingest", () => {
    const id = opaqueCanonicalIdForUrl("https://example.com/products/#pricing");
    expect(id).toMatch(/^url:[0-9a-f]{64}$/);
    expect(id).toBe(opaqueCanonicalIdForUrl("https://example.com/products"));
    expect(opaqueCanonicalIdForUrl("https://example.com/a.pdf?X-Amz-Signature=SIG")).not.toContain("SIG");
  });
});

describe("replayed URL-intake receipts", () => {
  const grant = "https://files.example.com/d/GRANTSECRET0123456789abcdef/report.pdf?X-Amz-Signature=SIGSECRET";
  const legacy = () => ({
    payload: {
      project: { id: "p1", name: "GRANTSECRET report", slug: "grantsecret-report" },
      run: { id: "r1", projectName: "GRANTSECRET report" },
      documents: [
        { id: "d1", filename: "GRANTSECRET.txt", title: "GRANTSECRET", mimeType: "text/plain", sourceKey: "u1/0f5c3a5e-3b7e-4c43-9a59-2d3c0e1b9a10/raw/8d0a2f6c-91b1-4b8e-a5d2-6a3f7c1e0b42-GRANTSECRET.txt", canonicalId: "https://files.example.com/x?sig=SIGSECRET" },
        // A malformed scheme-prefixed caller value must not throw (M4).
        { id: "d2", filename: "b.txt", mimeType: "text/plain", sourceKey: "k/b.txt", canonicalId: "foo://[bad" },
      ],
      ingested: [{ filename: "GRANTSECRET.txt", mimeType: "text/plain" }],
      warnings: [`1 of 3 files were not accepted: ${grant}.`],
      rejected: [{ filename: grant, statusCode: 400, code: "rejected", message: `Failed to fetch ${grant}: 503` }],
    },
    status: 201, temporalDeferred: false,
  }) as never;

  it("re-derives every name field of a legacy (unversioned) receipt", () => {
    const replayed = replayedPayload("uploads.url", legacy(), [grant, "https://docs.example.com/a.txt"]);
    expect(JSON.stringify(replayed)).not.toMatch(/GRANT|SIGSECRET|grantsecret/);
    expect(replayed.project).toMatchObject({ id: "p1", name: "Import from files.example.com", slug: "p1" });
    expect(replayed.run).toMatchObject({ projectName: "Import from files.example.com" });
    expect(replayed.documents[0]).toMatchObject({
      filename: "url-0.txt",
      sourceKey: "u1/0f5c3a5e-3b7e-4c43-9a59-2d3c0e1b9a10/raw/8d0a2f6c-91b1-4b8e-a5d2-6a3f7c1e0b42-url-0.txt",
      canonicalId: opaqueCanonicalIdForUrl("https://files.example.com/x?sig=SIGSECRET"),
    });
    expect(replayed.documents[0]).not.toHaveProperty("title");
    expect(replayed.documents[1]!.canonicalId).toMatch(/^url:[0-9a-f]{64}$/);
    expect(replayed.rejected).toEqual([{ index: 0, filename: "urls[0]", statusCode: 400, code: "rejected", message: "The URL's content could not be taken" }]);
    expect(replayed.warnings).toEqual(["1 of 3 files were not accepted: urls[0]."]);
    // Without the request's URLs the title is generic.
    expect(replayedPayload("extracts.url", legacy()).project.name).toBe("URL import");
  });

  it("replays a current-version receipt's response fields only, unchanged", () => {
    const payload = {
      project: { id: "p1", name: "Import from example.com" }, run: { id: "r1" },
      documents: [{ id: "d1", filename: "example.com-0.txt", mimeType: "text/plain", canonicalId: "/products" }],
      warnings: [], internalNote: "never replayed",
    };
    const replayed = replayedPayload("uploads.url", { payload, status: 201, temporalDeferred: false, receiptVersion: INTAKE_RECEIPT_VERSION } as never);
    const { internalNote: _dropped, ...expected } = payload;
    expect(replayed).toEqual(expected);
  });

  it("leaves receipts of other routes as stored", () => {
    const stable = legacy() as { payload: unknown };
    expect(replayedPayload("uploads.bulk", stable as never)).toBe(stable.payload);
  });
});

describe("public read boundary for stored documents", () => {
  const row = (overrides: Record<string, unknown>) => ({ source_key: "u1/0f5c3a5e-3b7e-4c43-9a59-2d3c0e1b9a10/raw/8d0a2f6c-91b1-4b8e-a5d2-6a3f7c1e0b42-GRANTSECRET.pdf", mime_type: "application/pdf", ...overrides });

  it("redacts a legacy URL-origin document's server-derived canonical ID and URL-named source key", () => {
    const sourceUrl = "https://files.example.com/d/GRANTSECRET.pdf?X-Amz-Signature=SIGSECRET";
    const identity = publicDocumentIdentity(row({ canonical_id: canonicalIdForUrl(sourceUrl), metadata: { sourceUrl } }));
    expect(identity.canonicalId).toBe(opaqueCanonicalIdForUrl(sourceUrl));
    expect(identity.sourceKey).toBe("u1/0f5c3a5e-3b7e-4c43-9a59-2d3c0e1b9a10/raw/8d0a2f6c-91b1-4b8e-a5d2-6a3f7c1e0b42-files.example.com.pdf");
    expect(JSON.stringify(identity)).not.toMatch(/GRANTSECRET|SIGSECRET/);
  });

  it("keeps a caller's own canonical ID, current safe keys and non-URL documents, and never throws", () => {
    const sourceUrl = "https://files.example.com/d/a.pdf";
    expect(publicDocumentIdentity(row({ canonical_id: "/products", metadata: { sourceUrl } })).canonicalId).toBe("/products");
    expect(publicDocumentIdentity(row({ canonical_id: "https://example.com/mine", metadata: { sourceUrl } })).canonicalId).toBe("https://example.com/mine");
    expect(publicDocumentIdentity(row({ canonical_id: "foo://[bad", metadata: { sourceUrl } })).canonicalId).toBe("foo://[bad");
    const safeKey = "u1/0f5c3a5e-3b7e-4c43-9a59-2d3c0e1b9a10/raw/8d0a2f6c-91b1-4b8e-a5d2-6a3f7c1e0b42-files.example.com-2.pdf";
    expect(publicDocumentIdentity(row({ source_key: safeKey, canonical_id: "url:abc", metadata: { sourceUrl } }))).toEqual({ canonicalId: "url:abc", sourceKey: safeKey });
    const upload = row({ canonical_id: "https://example.com/x", metadata: {} });
    expect(publicDocumentIdentity(upload)).toEqual({ canonicalId: "https://example.com/x", sourceKey: upload.source_key });
    expect(() => publicDocumentIdentity(row({ canonical_id: "https://x", metadata: { sourceUrl: "not a url" } }))).not.toThrow();
  });

  it("applies at the run-records document mapper (run and project responses)", () => {
    const sourceUrl = "https://files.example.com/d/GRANTSECRET.pdf?sig=SIGSECRET";
    const document = mapDocument({
      id: "00000000-0000-4000-8000-000000000001", user_id: "u1", org_id: "o1", project_id: "00000000-0000-4000-8000-000000000002",
      run_id: "00000000-0000-4000-8000-000000000003", filename: "files.example.com-0.pdf",
      status: "queued", extraction_mode: "fast", page_count: 1, created_at: new Date(), updated_at: new Date(),
      ...row({ canonical_id: canonicalIdForUrl(sourceUrl), metadata: { sourceUrl } }),
    } as never);
    expect(JSON.stringify(document)).not.toMatch(/GRANTSECRET|SIGSECRET/);
  });
});
