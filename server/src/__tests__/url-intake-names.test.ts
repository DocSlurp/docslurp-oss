import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { json: (value: unknown) => value, array: (value: unknown) => value }) }));

const { urlDerivedFilename } = await import("../services/remote-ingest.js");
const { opaqueCanonicalIdForUrl } = await import("../lib/canonical-id.js");
const { INTAKE_RECEIPT_VERSION, replayedPayload } = await import("../services/project-intake-actions.js");
const { canonicalIdForUrl } = await import("../lib/canonical-id.js");
const { publicDocumentIdentity, withUniqueRedactedFilenames } = await import("../lib/url-document-identity.js");
const { mapRunForensicsDocument } = await import("../services/run-forensics.js");
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

  it("hashes the full normalized URL: two long URLs sharing a 2,048-character prefix stay distinct", () => {
    const prefix = `https://example.com/${"a".repeat(2100)}`;
    const [one, two] = [`${prefix}?part=1`, `${prefix}?part=2`];
    expect(canonicalIdForUrl(one)).toBe(canonicalIdForUrl(two));
    expect(opaqueCanonicalIdForUrl(one)).not.toBe(opaqueCanonicalIdForUrl(two));
  });

  it("gives a URL an opaque canonical ID that still matches on re-ingest", () => {
    const id = opaqueCanonicalIdForUrl("https://example.com/products/#pricing");
    expect(id).toMatch(/^url:[0-9a-f]{64}$/);
    // The fragment is never sent, so it is not identity; the path is kept exactly: /manual and /manual/ differ.
    expect(id).toBe(opaqueCanonicalIdForUrl("https://example.com/products/"));
    expect(opaqueCanonicalIdForUrl("https://example.com/manual")).not.toBe(opaqueCanonicalIdForUrl("https://example.com/manual/"));
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
    // d1's canonical ID is the server's legacy default for one of the request's URLs.
    const replayed = replayedPayload("uploads.url", legacy(), [grant, "https://files.example.com/x?sig=SIGSECRET"]);
    expect(JSON.stringify(replayed)).not.toMatch(/GRANT|SIGSECRET|grantsecret/);
    expect(replayed.project).toMatchObject({ id: "p1", name: "Import from files.example.com", slug: "p1" });
    expect(replayed.run).toMatchObject({ projectName: "Import from files.example.com" });
    expect(replayed.documents[0]).toMatchObject({
      filename: "url-0.txt",
      sourceKey: "u1/0f5c3a5e-3b7e-4c43-9a59-2d3c0e1b9a10/raw/8d0a2f6c-91b1-4b8e-a5d2-6a3f7c1e0b42-url-0.txt",
      canonicalId: opaqueCanonicalIdForUrl("https://files.example.com/x?sig=SIGSECRET"),
    });
    expect(replayed.documents[0]).not.toHaveProperty("title");
    // A caller's own value (here malformed) is never rewritten, and nothing throws.
    expect(replayed.documents[1]!.canonicalId).toBe("foo://[bad");
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
    expect(publicDocumentIdentity(row({ source_key: safeKey, canonical_id: "url:abc", filename: "files.example.com-2.pdf", metadata: { sourceUrl } }))).toEqual({ canonicalId: "url:abc", sourceKey: safeKey, filename: "files.example.com-2.pdf", filenameRedacted: false });
    const upload = row({ canonical_id: "https://example.com/x", filename: "GRANTLIKE.pdf", metadata: {} });
    expect(publicDocumentIdentity(upload)).toEqual({ canonicalId: "https://example.com/x", sourceKey: upload.source_key, filename: "GRANTLIKE.pdf", filenameRedacted: false });
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

describe("read-boundary filenames", () => {
  const legacyRow = (id: string, filename: string, sourceUrl: string) => ({
    id, user_id: "u1", org_id: "o1", project_id: "00000000-0000-4000-8000-000000000002",
    run_id: "00000000-0000-4000-8000-000000000003", filename, mime_type: "application/pdf",
    source_key: `u1/0f5c3a5e-3b7e-4c43-9a59-2d3c0e1b9a10/raw/8d0a2f6c-91b1-4b8e-a5d2-6a3f7c1e0b42-${filename}`,
    canonical_id: canonicalIdForUrl(sourceUrl), metadata: { sourceUrl },
    status: "queued", extraction_mode: "fast", page_count: 1, created_at: new Date(), updated_at: new Date(),
  });

  it("presents a legacy URL-derived filename as <host><ext>, unique within the response", () => {
    const documents = withUniqueRedactedFilenames([
      mapDocument(legacyRow("00000000-0000-4000-8000-00000000000a", "GRANTSECRET-one.pdf", "https://files.example.com/d/GRANTSECRET-one.pdf?sig=S1") as never),
      mapDocument(legacyRow("00000000-0000-4000-8000-00000000000b", "GRANTSECRET-two.pdf", "https://files.example.com/d/GRANTSECRET-two.pdf?sig=S2") as never),
      // Already the safe form: kept, and the redacted names never collide with it.
      mapDocument(legacyRow("00000000-0000-4000-8000-00000000000c", "files.example.com-1.pdf", "https://files.example.com/x.pdf") as never),
      // Not URL-origin: never touched.
      mapDocument({ ...legacyRow("00000000-0000-4000-8000-00000000000d", "files.example.com.pdf", "https://x"), metadata: {} } as never),
    ]);
    expect(documents.map((document) => document.filename)).toEqual(["files.example.com-2.pdf", "files.example.com-3.pdf", "files.example.com-1.pdf", "files.example.com.pdf"]);
    expect(JSON.stringify(documents)).not.toMatch(/GRANTSECRET|S1|S2/);
  });

  it("applies the same redaction in the run-forensics document mapper", () => {
    const sourceUrl = "https://files.example.com/d/GRANTSECRET.pdf?X-Amz-Signature=SIGSECRET";
    const row = { ...legacyRow("00000000-0000-4000-8000-00000000000e", "GRANTSECRET.pdf", sourceUrl), created_at: "2026-11-18", updated_at: "2026-11-18" };
    const document = mapRunForensicsDocument(row as never);
    expect(document).toMatchObject({ filename: "files.example.com.pdf", canonicalId: opaqueCanonicalIdForUrl(sourceUrl) });
    expect(JSON.stringify(document)).not.toMatch(/GRANTSECRET|SIGSECRET/);
  });
});
