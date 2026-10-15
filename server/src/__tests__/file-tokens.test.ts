import { beforeEach, describe, expect, it } from "vitest";

import { openFileToken, resetFileTokenKeyForTests, sealFileToken, type FileTokenClaims } from "../lib/file-tokens.js";

const claims: FileTokenClaims = { uri: "s3://bucket/user/run/images/doc/page-0001.png", sub: "user-a", bind: "s:session-a", exp: 2_000_000_000, name: "page-0001.png" };
const now = 1_900_000_000_000;

describe("file proxy tokens", () => {
  beforeEach(() => {
    process.env.SECRETS_ENCRYPTION_KEY = "a".repeat(64);
    delete process.env.FILE_TOKEN_SECRET;
    resetFileTokenKeyForTests();
  });

  it("round-trips sealed claims and hides the storage key", () => {
    const token = sealFileToken(claims);
    expect(openFileToken(token, now)).toEqual(claims);
    expect(token).not.toContain("bucket");
    expect(Buffer.from(token, "base64url").toString("latin1")).not.toContain("page-0001");
    // Synthetic IV: equal claims seal identically (stable URLs); any change differs entirely.
    expect(sealFileToken(claims)).toBe(token);
    const other = sealFileToken({ ...claims, bind: "s:session-b" });
    expect(other).not.toBe(token);
    expect(other.slice(0, 16)).not.toBe(token.slice(0, 16));
  });

  it("rejects expired tokens", () => {
    expect(openFileToken(sealFileToken({ ...claims, exp: Math.floor(now / 1000) }), now)).toBeNull();
  });

  it("rejects any modified byte", () => {
    const raw = Buffer.from(sealFileToken(claims), "base64url");
    for (const index of [0, 13, raw.length >> 1, raw.length - 1]) {
      const copy = Buffer.from(raw);
      copy[index] ^= 0x01;
      expect(openFileToken(copy.toString("base64url"), now)).toBeNull();
    }
  });

  it("rejects tokens sealed under another key (rotation revokes all URLs)", () => {
    const token = sealFileToken(claims);
    process.env.FILE_TOKEN_SECRET = "b".repeat(64);
    resetFileTokenKeyForTests();
    expect(openFileToken(token, now)).toBeNull();
  });

  it("rejects malformed and oversized input without throwing", () => {
    for (const bad of ["", "not a token!", "AAAA", "x".repeat(5000), "../../etc/passwd"]) {
      expect(openFileToken(bad, now)).toBeNull();
    }
  });
});
