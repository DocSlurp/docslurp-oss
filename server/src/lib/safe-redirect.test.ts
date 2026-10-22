import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "./safe-redirect.js";

describe("safeRedirectPath", () => {
  it("keeps same-origin paths with query and hash", () => {
    expect(safeRedirectPath("/app/sso?linked=1#top", "/")).toBe("/app/sso?linked=1#top");
    expect(safeRedirectPath("  /app  ", "/")).toBe("/app");
  });

  it.each([
    null,
    undefined,
    42,
    "",
    "app",
    "https://evil.example/",
    "//evil.example",
    "/\\evil.example",
    "/\\/evil.example",
    "\\\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
  ])("rejects %j", (value) => {
    expect(safeRedirectPath(value, "/fallback")).toBe("/fallback");
  });

  it("leaves percent-encoded bytes encoded in a same-origin path", () => {
    expect(safeRedirectPath("/%0d%0aSet-Cookie:x", "/")).toBe("/%0d%0aSet-Cookie:x");
  });

  it("never resolves to another origin", () => {
    for (const candidate of ["/\\evil.example", "/\t\\evil.example", "/ /evil.example"]) {
      const path = safeRedirectPath(candidate, "/");
      expect(new URL(path, "https://docslurp.io").origin).toBe("https://docslurp.io");
    }
  });
});
