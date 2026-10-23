import { describe, expect, it } from "vitest";

import { UPLOAD_UI_URI, uploadUiConnectDomains, uploadUiResource } from "./mcp-ui-resources.js";

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
      expect(entry).toMatchObject({ uri: UPLOAD_UI_URI, mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { connectDomains: ["https://s3.test"] }, prefersBorder: false } } });
    }
    expect(resource.content.text).toBe("<html></html>");
  });
});
