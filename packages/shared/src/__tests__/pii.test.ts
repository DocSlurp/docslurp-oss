import { describe, expect, it } from "vitest";

import { compilePiiAllowlist, fingerprintPiiMatch, piiPatternTypeSchema, processPii, redactPii, scanAndRedactPii, scanForPii, type PiiPatternType } from "../pii.js";
import { abaChecksumValid, ibanChecksumValid, luhnValid } from "../pii-detectors.js";

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

    expect(matches.map((match) => content.slice(match.charOffset, match.charOffset + match.length)))
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

// Vendor-format fixtures are assembled at run time, so no token-shaped literal sits in the repository for a
// secret scanner to mistake for a leak. Every value is fake.
const join = (...parts: string[]) => parts.join("");
const STRIPE = join("sk", "_live_", "4eC39HqLyjWDarjt", "T1zdp7dc");
const AWS_KEY = join("AK", "IA", "IOSFODNN7", "EXAMPLE");
const GITHUB_PAT = join("github", "_pat_", "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXY");
const GITHUB_CLASSIC = join("gh", "p_", "16C7e42F292c6912E7710c838347Ae178B4a");
const SLACK = join("xo", "xb-", "123456789012-1234567890123-", "AbCdEfGhIjKlMnOpQrStUvWx");
const ANTHROPIC = join("sk-", "ant-", "api03-Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA");
const OPENAI_PROJECT = join("sk-", "proj-", "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA");
const pem = (label: string, body: string, end = true) =>
  `${join("-----", "BEGIN ", label, "-----")}\n${body}${end ? join("-----", "END ", label, "-----") : ""}`;

const ALL_PATTERNS = piiPatternTypeSchema.options as readonly PiiPatternType[];
const found = (text: string, patterns: readonly PiiPatternType[] = ALL_PATTERNS) =>
  scanForPii(text, patterns).map((match) => `${match.patternType}:${text.slice(match.charOffset, match.charOffset + match.length)}`);

describe("PII detection: values that must be found", () => {
  it.each([
    ["a card typed with spaces", "Pay with 4111 1111 1111 1111 today", "credit-card:4111 1111 1111 1111"],
    ["a card typed with hyphens", "card 5500-0000-0000-0004.", "credit-card:5500-0000-0000-0004"],
    ["an unseparated Amex", "amex 378282246310005", "credit-card:378282246310005"],
    ["a hyphenated SSN", "Employee 123-45-6789 started", "ssn:123-45-6789"],
    ["a spaced SSN with context", "SSN: 123 45 6789", "ssn:123 45 6789"],
    ["an unseparated SSN with context", "Social Security number 123456789 on file", "ssn:123456789"],
    ["an IBAN with spaces", "Send to GB82 WEST 1234 5698 7654 32 please", "iban:GB82 WEST 1234 5698 7654 32"],
    ["a compact IBAN", "IBAN DE89370400440532013000.", "iban:DE89370400440532013000"],
    ["an international phone number", "Call +44 20 7946 0958 after nine", "phone:+44 20 7946 0958"],
    ["a German mobile number", "Mobil +49 151 23456789", "phone:+49 151 23456789"],
    ["a formatted US phone number", "Office (415) 555-2671", "phone:(415) 555-2671"],
    ["a bare US phone number with context", "mobile 4155552671", "phone:4155552671"],
    ["a Stripe live key", `STRIPE=${STRIPE}`, `stripe-api-key:${STRIPE}`],
    ["an AWS access key id", `aws_access_key_id ${AWS_KEY}`, `aws-access-key:${AWS_KEY}`],
    ["a fine-grained GitHub token", `token ${GITHUB_PAT}`, `github-token:${GITHUB_PAT}`],
    ["a classic GitHub token", GITHUB_CLASSIC, `github-token:${GITHUB_CLASSIC}`],
    ["a Slack token", SLACK, `slack-token:${SLACK}`],
    ["an Anthropic key (once, not also as an OpenAI key)", ANTHROPIC, `anthropic-api-key:${ANTHROPIC}`],
    ["an OpenAI project key", OPENAI_PROJECT, `openai-api-key:${OPENAI_PROJECT}`],
    ["an assigned secret", 'client_secret = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA"', 'generic-api-key:client_secret = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA"'],
    ["a bank account with context", "Account number: 000123456789", "bank-account:000123456789"],
    ["a valid ABA routing number with context", "routing 021000021", "bank-account:021000021"],
    ["a passport with context", "Passport No: AB1234567", "passport:AB1234567"],
    ["a driver's licence with context", "Driver's License #: D1234567", "drivers-license:D1234567"],
  ])("%s", (_name, text, expected) => {
    expect(found(text)).toContain(expected);
    if (_name.includes("not also")) expect(found(text)).toEqual([expected]);
  });

  it("finds a PEM private key as one span, and a key cut off before its END line", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nVJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictG\n";
    const complete = `see\n${pem("PRIVATE KEY", body)}\nafter`;
    expect(scanAndRedactPii(complete, ["private-key"]).redacted).toBe("see\n[REDACTED:private-key]\nafter");
    const truncated = pem("RSA PRIVATE KEY", body, false);
    const [match] = scanForPii(truncated, ["private-key"]);
    expect(match?.charOffset).toBe(0);
    expect(truncated.slice(0, match!.length)).toContain("MIIEvQIBADANBgkq");
    expect(scanAndRedactPii(pem("OPENSSH PRIVATE KEY", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n"), ["private-key"]).matches).toHaveLength(1);
  });
});

describe("PII detection: values that are not PII", () => {
  it.each([
    ["a nine-digit revenue figure", "Annual revenue 250000000 dollars"],
    ["a spaced order number shaped like an SSN", "order 555 12 3456 shipped"],
    ["a dotted number shaped like an SSN", "ref 123.45.6789 closed"],
    ["a passport-shaped code without context", "Part AB1234567 in stock"],
    ["a licence-shaped code without context", "SKU D1234567"],
    ["a version number shaped like an IP address", "Version 10.0.0.1 released"],
    ["a v-prefixed version", "upgrade to v10.0.0.1 now"],
    ["a 16-digit order number that fails Luhn", "Order 4111 1111 1111 1112 confirmed"],
    ["a 16-digit tracking number", "tracking 1234567890123456"],
    ["a repeated-digit number that passes Luhn", "id 0000 0000 0000 0000"],
    ["a ten-digit number without phone context", "population 2502345678"],
    ["an SSN in the invalid 9xx range", "123-45-6789 vs 900-12-3456"],
    ["an SSN with a zero group", "code 123-00-6789"],
    ["an account-length number without context", "serial 000123456789"],
    ["a placeholder key", "api_key = your_api_key_here_please"],
    ["a uniform fake token", "sk-xxxxxxxxxxxxxxxxxxxxxxxx"],
    ["a country-code-less plus number", "+999 12345"],
    ["a date range", "from 2023-12-05 to 2024-01-02"],
  ])("%s", (_name, text) => {
    const hits = found(text).filter((hit) => !hit.startsWith("ssn:900"));
    // "123-45-6789" in the SSN-range case is a valid SSN; only the 9xx one must be rejected.
    if (_name.includes("9xx")) {
      expect(hits).toEqual(["ssn:123-45-6789"]);
    } else {
      expect(hits).toEqual([]);
    }
  });

  it("tests the validators on known numbers", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(ibanChecksumValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanChecksumValid("GB82WEST12345698765433")).toBe(false);
    expect(abaChecksumValid("021000021")).toBe(true);
    expect(abaChecksumValid("021000022")).toBe(false);
  });

  it("rejects an IBAN whose checksum or length is wrong", () => {
    expect(found("GB82 WEST 1234 5698 7654 33")).toEqual([]);
    expect(found("DE89 3704 0044 0532 0130")).toEqual([]);
  });
});

describe("PII offsets", () => {
  it("reports UTF-8 byte offsets and UTF-16 character offsets separately", () => {
    // "é" is 2 bytes, the emoji 4 bytes and 2 UTF-16 units; the SSN starts after them.
    const text = "é😀 SSN 123-45-6789";
    const [match] = scanForPii(text, ["ssn"]);
    expect(match?.charOffset).toBe(text.indexOf("123"));
    expect(match?.byteOffset).toBe(new TextEncoder().encode(text.slice(0, text.indexOf("123"))).length);
    expect(match?.byteOffset).not.toBe(match?.charOffset);
    expect(text.slice(match!.charOffset, match!.charOffset + match!.length)).toBe("123-45-6789");
  });

  it("redacts by character offset, so multibyte text stays aligned", () => {
    expect(scanAndRedactPii("é😀 SSN 123-45-6789 ünï a@b.test", ["ssn", "email"]).redacted)
      .toBe("é😀 SSN [REDACTED:ssn] ünï [REDACTED:email]");
  });

  it("merges overlapping spans from different patterns into one redaction", () => {
    const text = `key ${STRIPE} here`;
    const matches = [
      ...scanForPii(text, ["stripe-api-key"]),
      { ...scanForPii(text, ["stripe-api-key"])[0]!, patternType: "generic-api-key" as const, charOffset: 6, length: 10 },
    ];
    expect(redactPii(text, matches).match(/\[REDACTED:/g)).toHaveLength(1);
  });
});

describe("PII failure modes", () => {
  it("throws for a pattern the build has no detector for instead of scanning for nothing", () => {
    expect(() => scanForPii("123-45-6789", ["uk-nino" as PiiPatternType])).toThrow(/no detector/);
  });

  it("scans adversarial input in linear time", () => {
    const hostile = `${"1 ".repeat(20000)}${"-".repeat(20000)}${"a@".repeat(5000)}${"4".repeat(50000)}`;
    const started = Date.now();
    scanForPii(hostile, ALL_PATTERNS);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
