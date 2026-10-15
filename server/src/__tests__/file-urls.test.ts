import { beforeEach, describe, expect, it, vi } from "vitest";

const ctx = vi.hoisted(() => ({ userId: null as string | null, sessionId: null as string | null, apiKeyId: null as string | null }));
vi.mock("../config.js", () => ({ env: { apiUrl: "https://docslurp.io/" } }));
vi.mock("../lib/request-context.js", () => ({
  currentRequestUserId: () => ctx.userId,
  currentRequestSessionId: () => ctx.sessionId,
  currentRequestApiKeyId: () => ctx.apiKeyId,
}));

const { fileUrlForArtifact, safeFileName } = await import("../lib/file-urls.js");
const { openFileToken, resetFileTokenKeyForTests } = await import("../lib/file-tokens.js");
const { redactFileTokenPath } = await import("../lib/file-token-path.js");

const uri = "s3://bucket/user/run/images/doc/page-0003.png";
const tokenOf = (url: string) => url.split("/v1/files/")[1]!.split("/")[0]!;

describe("file proxy URLs", () => {
  beforeEach(() => {
    process.env.SECRETS_ENCRYPTION_KEY = "c".repeat(64);
    resetFileTokenKeyForTests();
    Object.assign(ctx, { userId: null, sessionId: null, apiKeyId: null });
  });

  it("never issues an unbound URL outside an authenticated request", () => {
    expect(() => fileUrlForArtifact(uri)).toThrow(/authenticated request/);
    ctx.userId = "user-a";
    expect(() => fileUrlForArtifact(uri)).toThrow(/authenticated request/);
  });

  it("binds browser URLs to the session and keeps them same-origin", () => {
    Object.assign(ctx, { userId: "user-a", sessionId: "sess-1" });
    const { url, expiresAt } = fileUrlForArtifact(uri, null, 1_900_000_000_000);
    expect(url).toMatch(/^\/v1\/files\/[A-Za-z0-9_-]+\/page-0003\.png$/);
    expect(url).not.toContain("bucket");
    expect(openFileToken(tokenOf(url), 1_900_000_000_000)).toMatchObject({ uri, sub: "user-a", bind: "s:sess-1", name: "page-0003.png" });
    const lifetime = Date.parse(expiresAt) - 1_900_000_000_000;
    expect(lifetime).toBeGreaterThanOrEqual(3600_000);
    expect(lifetime).toBeLessThanOrEqual(3600_000 + 900_000);
  });

  it("issues the same URL within a window so viewers don't re-download", () => {
    Object.assign(ctx, { userId: "user-a", sessionId: "sess-1" });
    const start = 1_900_000_000_000 - (1_900_000_000_000 % 900_000);
    const first = fileUrlForArtifact(uri, null, start + 1_000).url;
    expect(fileUrlForArtifact(uri, null, start + 800_000).url).toBe(first);
    expect(fileUrlForArtifact(uri, null, start + 901_000).url).not.toBe(first);
    ctx.sessionId = "sess-2";
    expect(fileUrlForArtifact(uri, null, start + 1_000).url).not.toBe(first);
  });

  it("binds API key URLs to the key and makes them absolute", () => {
    Object.assign(ctx, { userId: "user-a", sessionId: null, apiKeyId: "key-9" });
    const { url } = fileUrlForArtifact(uri, "Quarterly report.pdf");
    expect(url.startsWith("https://docslurp.io/v1/files/")).toBe(true);
    expect(url.endsWith("/Quarterly%20report.pdf")).toBe(true);
    expect(openFileToken(tokenOf(url))).toMatchObject({ bind: "k:key-9", name: "Quarterly report.pdf" });
  });

  it("reduces filenames to a safe basename", () => {
    expect(safeFileName("../../etc/passwd", uri)).toBe("passwd");
    expect(safeFileName('a"b\r\nc<script>.html', uri)).toBe("a-b-c-script-.html");
    expect(safeFileName(null, uri)).toBe("page-0003.png");
    expect(safeFileName("...", uri)).toBe("file");
  });

  it("redacts tokens from logged paths", () => {
    expect(redactFileTokenPath("/v1/files/abc123/page.png")).toBe("/v1/files/:token");
    expect(redactFileTokenPath("/v1/documents/1")).toBe("/v1/documents/1");
  });
});
