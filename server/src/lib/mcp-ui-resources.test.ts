import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { UPLOAD_HTML, UPLOAD_HTML_SHA256 } from "../mcp-ui/upload-bundle.generated.js";
import { CONNECT_SRC_PLACEHOLDER, UPLOAD_UI_URI, uploadUiConnectDomains, uploadUiResource } from "./mcp-ui-resources.js";

const r2 = { bucket: "docs", region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com/", forcePathStyle: true };

describe("upload widget connect domains", () => {
  it("uses the endpoint origin for path-style storage", () => {
    expect(uploadUiConnectDomains(r2, "")).toEqual(["https://acct.r2.cloudflarestorage.com"]);
  });
  it("adds the bucket virtual-host origin when not path-style", () => {
    expect(uploadUiConnectDomains({ ...r2, forcePathStyle: false }, "")).toEqual(["https://acct.r2.cloudflarestorage.com", "https://docs.acct.r2.cloudflarestorage.com"]);
  });
  it("derives regional and virtual-hosted AWS origins without an endpoint", () => {
    expect(uploadUiConnectDomains({ bucket: "b", region: "us-east-1", endpoint: null, forcePathStyle: false }, "")).toEqual(["https://s3.us-east-1.amazonaws.com", "https://b.s3.us-east-1.amazonaws.com"]);
  });
  it("appends validated, deduped extra origins and drops junk, paths and wildcards", () => {
    expect(uploadUiConnectDomains(r2, "https://cdn.example.com/x, *, ftp://nope, not a url, https://acct.r2.cloudflarestorage.com, https://cdn.example.com"))
      .toEqual(["https://acct.r2.cloudflarestorage.com", "https://cdn.example.com"]);
  });
});

describe("upload widget resource", () => {
  it("is absent without a bundle", () => {
    expect(uploadUiResource({ bundle: () => null })).toBeNull();
  });
  it("carries the mcp-app mime type and csp on both the listing and the content", () => {
    const resource = uploadUiResource({ bundle: () => "<html></html>", connectDomains: () => ["https://s3.test"] })!;
    for (const entry of [resource.listing, resource.content]) {
      expect(entry).toMatchObject({ uri: resource.uri, mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { connectDomains: ["https://s3.test"] }, prefersBorder: false } } });
    }
    expect(resource.content.text).toBe("<html></html>");
  });
});

describe("upload widget connect domains hardening", () => {
  it("never throws on a malformed storage endpoint and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = { bucket: "docs", region: "auto", endpoint: "not a url", forcePathStyle: true };
    expect(uploadUiConnectDomains(bad, "https://cdn.example.com")).toEqual(["https://cdn.example.com"]);
    expect(uploadUiConnectDomains(bad, "")).toEqual([]);
    expect(warn.mock.calls.filter(call => String(call[0]).includes("storage endpoint"))).toHaveLength(1);
    warn.mockRestore();
  });
  it("warns once about dropped MCP_UI_CONNECT_DOMAINS entries", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    uploadUiConnectDomains(r2, "only-once-a.example, only-once-b.example");
    uploadUiConnectDomains(r2, "only-once-a.example, only-once-b.example");
    expect(warn.mock.calls.filter(call => String(call[0]).includes("MCP_UI_CONNECT_DOMAINS"))).toHaveLength(2);
    warn.mockRestore();
  });
});

describe("generated upload widget bundle", () => {
  const html = readFileSync(new URL("../mcp-ui/upload.html", import.meta.url), "utf8");

  it("is in sync with upload.html (run `pnpm -C server build:mcp-ui` after editing the widget)", () => {
    expect(UPLOAD_HTML).toBe(html);
    expect(UPLOAD_HTML_SHA256).toBe(createHash("sha256").update(html, "utf8").digest("hex"));
  });

  it("serves the real bundle under a versioned uri with the connect-src placeholder substituted", () => {
    const resource = uploadUiResource({ connectDomains: () => ["https://s3.test", "https://b.s3.test"] })!;
    expect(resource.uri).toBe(UPLOAD_UI_URI);
    expect(resource.uri).toBe(`ui://docslurp/upload/${UPLOAD_HTML_SHA256.slice(0, 12)}`);
    expect(UPLOAD_HTML).toContain(CONNECT_SRC_PLACEHOLDER);
    expect(resource.content.text).not.toContain(CONNECT_SRC_PLACEHOLDER);
    expect(resource.content.text).toContain("connect-src https://s3.test https://b.s3.test");
    expect(resource.content.text.length).toBeGreaterThan(10_000);
    expect(uploadUiResource({ connectDomains: () => [] })!.content.text).toContain("connect-src 'none'");
  });
});
