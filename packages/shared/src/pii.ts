import { z } from "zod";

export const piiPatternTypeSchema = z.enum([
  "ssn",
  "credit-card",
  "phone",
  "email",
  "openai-api-key",
  "anthropic-api-key",
  "github-token",
  "generic-api-key",
  "ip-address",
  "bank-account",
  "iban",
  "passport",
  "drivers-license",
]);
export type PiiPatternType = z.infer<typeof piiPatternTypeSchema>;

export const piiPolicyActionSchema = z.enum([
  "flag_for_review",
  "redact_artifacts",
  "block_indexing",
]);
export type PiiPolicyAction = z.infer<typeof piiPolicyActionSchema>;

export const piiPolicySchema = z.object({
  enabled: z.boolean().default(false),
  patterns: z.array(piiPatternTypeSchema).default([
    "ssn",
    "credit-card",
    "openai-api-key",
    "anthropic-api-key",
    "github-token",
    "generic-api-key",
  ]),
  action: piiPolicyActionSchema.default("flag_for_review"),
  allowlistPatterns: z.array(z.string()).default([]),
});
export type PiiPolicy = z.infer<typeof piiPolicySchema>;

export const defaultPiiPolicy: PiiPolicy = piiPolicySchema.parse({});

export type PiiMatch = {
  patternType: PiiPatternType;
  matchedPrefix: string;  // keyed by legacy DB column; stores a non-reversible match fingerprint
  pageNumber: number | null;
  byteOffset: number;
  length: number;
};

export type PiiScanResult = {
  matches: PiiMatch[];
  redactedContent?: string;
};

// Regex patterns for each PII type
const PATTERNS: Record<PiiPatternType, RegExp> = {
  "ssn": /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  "credit-card": /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g,
  "phone": /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  "email": /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  "openai-api-key": /\bsk-[A-Za-z0-9\-_]{20,}\b/g,
  "anthropic-api-key": /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
  "github-token": /\bghp_[A-Za-z0-9]{36}\b|\bgho_[A-Za-z0-9]{36}\b|\bghs_[A-Za-z0-9]{36}\b/g,
  "generic-api-key": /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token)\s*[=:]\s*['"]?([A-Za-z0-9\-_.]{16,})['"]?/gi,
  "ip-address": /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
  "bank-account": /\b[0-9]{8,17}\b(?=.*\b(?:account|acct|routing|aba)\b)/gi,
  "iban": /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7}(?:[A-Z0-9]?){0,16}\b/g,
  "passport": /\b[A-Z]{1,2}[0-9]{6,9}\b/g,
  "drivers-license": /\b[A-Z]{1,2}[0-9]{5,9}\b/g,
};

const SHA256_INITIAL_HASH = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Hex(input: string): string {
  const bytes = Array.from(new TextEncoder().encode(input));
  const bitLength = bytes.length * 8;

  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }

  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) {
    bytes.push((high >>> shift) & 0xff);
  }
  for (let shift = 24; shift >= 0; shift -= 8) {
    bytes.push((low >>> shift) & 0xff);
  }

  const hash = SHA256_INITIAL_HASH.slice();
  const words = new Array<number>(64);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] = (
        (bytes[position] << 24)
        | (bytes[position + 1] << 16)
        | (bytes[position + 2] << 8)
        | bytes[position + 3]
      ) >>> 0;
    }

    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((value) => value.toString(16).padStart(8, "0")).join("");
}

export function fingerprintPiiMatch(patternType: PiiPatternType, value: string): string {
  return `sha256:${sha256Hex(`${patternType}\0${value}`)}`;
}

export type PiiScanOptions = {
  /** Page the scanned text came from, recorded on each match. */
  pageNumber?: number | null;
  /**
   * Workspace allowlist (`piiPolicy.allowlistPatterns`). A detected value is
   * suppressed when it fully matches any entry. Entries are case-insensitive
   * regular expressions; an entry that is not a valid expression is compared
   * as a case-insensitive literal. Entries are only ever tested against the
   * short detected value, never the whole document.
   */
  allowlistPatterns?: readonly string[];
};

export type PiiAllowlist = (value: string) => boolean;

/** Compile allowlist entries once; returns a predicate over detected values. */
export function compilePiiAllowlist(entries: readonly string[] = []): PiiAllowlist {
  const matchers: Array<(value: string) => boolean> = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    let regex: RegExp | null = null;
    try {
      regex = new RegExp(`^(?:${entry})$`, "i");
    } catch {
      regex = null;
    }
    if (regex) {
      const compiled = regex;
      matchers.push((value) => compiled.test(value));
    } else {
      const literal = entry.toLowerCase();
      matchers.push((value) => value.toLowerCase() === literal);
    }
  }
  return (value) => matchers.some((matches) => matches(value));
}

/**
 * Scan text content for PII patterns.
 * Returns matches with non-reversible fingerprints (never the full match or visible prefix).
 * Values matching the allowlist are dropped.
 */
export function scanForPii(
  content: string,
  patterns: readonly PiiPatternType[],
  options: PiiScanOptions = {}
): PiiMatch[] {
  const matches: PiiMatch[] = [];
  const pageNumber = options.pageNumber ?? null;
  const allowlisted = compilePiiAllowlist(options.allowlistPatterns ?? []);

  for (const patternType of patterns) {
    const regex = new RegExp(PATTERNS[patternType].source, PATTERNS[patternType].flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const fullMatch = match[0];
      if (allowlisted(fullMatch)) continue;
      matches.push({
        patternType,
        matchedPrefix: fingerprintPiiMatch(patternType, fullMatch),
        pageNumber,
        byteOffset: match.index,
        length: fullMatch.length,
      });
    }
  }

  return matches.sort((a, b) => a.byteOffset - b.byteOffset || b.length - a.length);
}

/**
 * Redact PII matches from content, replacing each with [REDACTED:type].
 * Overlapping matches (for example a number that is both a phone and an SSN
 * candidate) are merged into one span, labelled with the earliest, longest match.
 */
export function redactPii(content: string, matches: readonly PiiMatch[]): string {
  if (matches.length === 0) return content;

  const ordered = [...matches].sort((a, b) => a.byteOffset - b.byteOffset || b.length - a.length);
  const spans: Array<{ start: number; end: number; patternType: PiiPatternType }> = [];
  for (const match of ordered) {
    const start = match.byteOffset;
    const end = match.byteOffset + match.length;
    const last = spans[spans.length - 1];
    if (last && start < last.end) {
      last.end = Math.max(last.end, end);
    } else {
      spans.push({ start, end, patternType: match.patternType });
    }
  }

  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += `${content.slice(cursor, span.start)}[REDACTED:${span.patternType}]`;
    cursor = span.end;
  }
  return result + content.slice(cursor);
}

/** Scan one text and return its matches plus the redacted text. */
export function scanAndRedactPii(
  content: string,
  patterns: readonly PiiPatternType[],
  options: PiiScanOptions = {}
): { matches: PiiMatch[]; redacted: string } {
  const matches = scanForPii(content, patterns, options);
  return { matches, redacted: matches.length > 0 ? redactPii(content, matches) : content };
}

/**
 * Full PII scan + optional redaction.
 */
export function processPii(
  content: string,
  policy: PiiPolicy,
  pageNumber: number | null = null
): PiiScanResult {
  if (!policy.enabled || policy.patterns.length === 0) {
    return { matches: [] };
  }

  const matches = scanForPii(content, policy.patterns, {
    pageNumber,
    allowlistPatterns: policy.allowlistPatterns,
  });

  if (policy.action === "redact_artifacts" && matches.length > 0) {
    return { matches, redactedContent: redactPii(content, matches) };
  }

  return { matches };
}
