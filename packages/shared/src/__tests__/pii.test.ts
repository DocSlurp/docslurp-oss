import { describe, expect, it } from "vitest";

import { compilePiiAllowlist, fingerprintPiiMatch, processPii, scanAndRedactPii, scanForPii } from "../pii.js";

describe("PII scanning", () => {
  it("returns non-reversible fingerprints instead of visible match prefixes", () => {
    const [match] = scanForPii("Contact admin@example.com for access.", ["email"]);

    expect(match).toMatchObject({
      patternType: "email",
      matchedPrefix: fingerprintPiiMatch("email", "admin@example.com")
    });
    expect(match?.matchedPrefix).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(match?.matchedPrefix).not.toContain("adm");
    expect(match?.matchedPrefix).not.toContain("admin@example.com");
  });

  it("records the page number passed in options", () => {
    const [match] = scanForPii("SSN 123-45-6789", ["ssn"], { pageNumber: 4 });
    expect(match?.pageNumber).toBe(4);
  });
});

describe("PII allowlist", () => {
  it("suppresses values that fully match an allowlist expression", () => {
    const content = "Support: help@example.com. Personal: jane.doe@private.test.";
    const matches = scanForPii(content, ["email"], { allowlistPatterns: [".*@example\\.com"] });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchedPrefix).toBe(fingerprintPiiMatch("email", "jane.doe@private.test"));
  });

  it("is case-insensitive and anchored to the whole detected value", () => {
    const content = "Contact HELP@EXAMPLE.COM or help@example.com.evil.test";
    const matches = scanForPii(content, ["email"], { allowlistPatterns: ["help@example\\.com"] });

    expect(matches.map((match) => content.slice(match.byteOffset, match.byteOffset + match.length)))
      .toEqual(["help@example.com.evil.test"]);
  });

  it("treats invalid expressions as literals instead of throwing", () => {
    expect(compilePiiAllowlist(["[unterminated"])("[UNTERMINATED")).toBe(true);
    expect(compilePiiAllowlist(["", "   "])("anything")).toBe(false);
  });
});

describe("PII redaction", () => {
  it("merges overlapping matches into one redaction span", () => {
    const content = "Call 555-12-3456 now";
    const { matches, redacted } = scanAndRedactPii(content, ["ssn", "phone", "drivers-license"]);

    expect(matches.length).toBeGreaterThan(0);
    expect(redacted).not.toMatch(/\d{4}/);
    expect(redacted.match(/\[REDACTED:/g)).toHaveLength(1);
    expect(redacted).toBe("Call [REDACTED:ssn] now");
  });

  it("leaves allowlisted values in place", () => {
    const { redacted } = scanAndRedactPii("a@example.com b@corp.test", ["email"], {
      allowlistPatterns: ["a@example\\.com"],
    });
    expect(redacted).toBe("a@example.com [REDACTED:email]");
  });

  it("applies the policy allowlist in processPii", () => {
    const result = processPii("keep@example.com drop@corp.test", {
      enabled: true,
      patterns: ["email"],
      action: "redact_artifacts",
      allowlistPatterns: ["keep@example\\.com"],
    });
    expect(result.matches).toHaveLength(1);
    expect(result.redactedContent).toBe("keep@example.com [REDACTED:email]");
  });
});
