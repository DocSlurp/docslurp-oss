/**
 * Detectors behind scanForPii. A bare regex over text flags order numbers as
 * card numbers and nine-digit revenue figures as SSNs, and misses a card typed
 * with spaces, so each detector here finds candidates with a separator-tolerant
 * pattern and then proves them: a checksum (Luhn, IBAN mod 97, ABA), a
 * structural rule (SSN area and group ranges, country calling codes, IBAN
 * lengths) or a context window ("passport", "account number") around a bare
 * number. Secret formats follow the vendors' published prefixes (the same ones
 * gitleaks and Microsoft Presidio recognize) and reject placeholders.
 *
 * Every function is pure and linear in the input: patterns use bounded
 * repetition and no nested quantifiers, so hostile text cannot stall a scan.
 */
import type { PiiPatternType } from "./pii.js";

/** A candidate match: [start, end) in UTF-16 code units of the scanned string. */
export type PiiSpan = { start: number; end: number };
export type PiiDetector = (content: string) => PiiSpan[];

function* matchAll(content: string, pattern: RegExp): Generator<RegExpExecArray> {
  const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[0].length === 0) regex.lastIndex += 1;
    yield match;
  }
}

/** True when `pattern` occurs in the `before` characters preceding or the `after` characters following the span. */
function hasContext(content: string, span: PiiSpan, pattern: RegExp, before = 48, after = 24): boolean {
  const window = `${content.slice(Math.max(0, span.start - before), span.start)}\u0000${content.slice(span.end, span.end + after)}`;
  return pattern.test(window);
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

// ---------------------------------------------------------------- checksums

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Issuer ranges and lengths of the card networks that print a Luhn digit. */
export function cardNumberPlausible(digits: string): boolean {
  const length = digits.length;
  if (length < 12 || length > 19 || /^(\d)\1+$/.test(digits)) return false;
  const prefix = (count: number) => Number(digits.slice(0, count));
  if (digits[0] === "4") return length === 13 || length === 16 || length === 19; // Visa
  if ((prefix(2) >= 51 && prefix(2) <= 55) || (prefix(4) >= 2221 && prefix(4) <= 2720)) return length === 16; // Mastercard
  if (prefix(2) === 34 || prefix(2) === 37) return length === 15; // American Express
  if (prefix(4) === 6011 || prefix(2) === 65 || (prefix(3) >= 644 && prefix(3) <= 649) || (prefix(6) >= 622126 && prefix(6) <= 622925)) return length >= 16 && length <= 19; // Discover
  if (prefix(2) === 62) return length >= 16 && length <= 19; // UnionPay
  if (prefix(4) >= 3528 && prefix(4) <= 3589) return length >= 16 && length <= 19; // JCB
  if ((prefix(3) >= 300 && prefix(3) <= 305) || prefix(2) === 36 || prefix(2) === 38 || prefix(2) === 39) return length === 14; // Diners Club
  if ([5018, 5020, 5038, 6304, 6759].includes(prefix(4)) || (prefix(4) >= 6761 && prefix(4) <= 6763)) return length >= 12 && length <= 19; // Maestro
  return false;
}

/** ISO 13616 mod-97 over the rearranged IBAN. */
export function ibanChecksumValid(iban: string): boolean {
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    const value = code >= 65 && code <= 90 ? String(code - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** ABA routing number weights 3-7-1. */
export function abaChecksumValid(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const d = [...digits].map(Number) as number[];
  return (3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!)) % 10 === 0;
}

export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ------------------------------------------------------------ card numbers

const CARD_CANDIDATE = /(?<![\d-])(?:\d[ -]?){11,18}\d(?![\d-])/g;

const cardNumbers: PiiDetector = (content) => {
  const spans: PiiSpan[] = [];
  for (const match of matchAll(content, CARD_CANDIDATE)) {
    const digits = digitsOf(match[0]);
    // Mixed separators ("4111-1111 1111-1111") are not how a card is printed.
    const separators = new Set(match[0].replace(/\d/g, ""));
    if (separators.size > 1) continue;
    if (cardNumberPlausible(digits) && luhnValid(digits)) spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
};

// -------------------------------------------------------------------- SSN

const SSN_CONTEXT = /\b(?:ssn|social[\s-]?security|soc\.?\s*sec|ss\s?#|ss\s?no|tax(?:payer)?\s?(?:id|number|no)|tin|itin)\b/i;
const ADVERTISED_SSNS = new Set(["078051120", "219099999", "457555462"]);

const ssns: PiiDetector = (content) => {
  const spans: PiiSpan[] = [];
  for (const match of matchAll(content, /(?<![\d-])(\d{3})([- .]?)(\d{2})\2(\d{4})(?![\d-])/g)) {
    const [, area, separator, group, serial] = match as unknown as [string, string, string, string, string];
    if (area === "000" || area === "666" || area[0] === "9" || group === "00" || serial === "0000") continue;
    if (ADVERTISED_SSNS.has(`${area}${group}${serial}`)) continue;
    const span = { start: match.index, end: match.index + match[0].length };
    // Hyphenated nine digits are the SSN notation; any other layout is a bare number
    // (revenue, an order number) unless the text around it says "SSN" or "tax ID".
    if (separator !== "-" && !hasContext(content, span, SSN_CONTEXT, 40, 16)) continue;
    spans.push(span);
  }
  return spans;
};

// ----------------------------------------------------------------- phones

/** ITU-T E.164 country calling codes (the 1-3 digit prefixes in use). */
const COUNTRY_CODES = new Set([
  "1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86",
  "90", "91", "92", "93", "94", "95", "98",
  "211", "212", "213", "216", "218", "220", "221", "222", "223", "224", "225", "226", "227", "228", "229", "230", "231", "232",
  "233", "234", "235", "236", "237", "238", "239", "240", "241", "242", "243", "244", "245", "246", "248", "249", "250", "251",
  "252", "253", "254", "255", "256", "257", "258", "260", "261", "262", "263", "264", "265", "266", "267", "268", "269",
  "290", "291", "297", "298", "299",
  "350", "351", "352", "353", "354", "355", "356", "357", "358", "359", "370", "371", "372", "373", "374", "375", "376", "377",
  "378", "379", "380", "381", "382", "383", "385", "386", "387", "389",
  "420", "421", "423", "500", "501", "502", "503", "504", "505", "506", "507", "508", "509", "590", "591", "592", "593", "594",
  "595", "596", "597", "598", "599",
  "670", "672", "673", "674", "675", "676", "677", "678", "679", "680", "681", "682", "683", "685", "686", "687", "688", "689",
  "690", "691", "692",
  "850", "852", "853", "855", "856", "880", "886",
  "960", "961", "962", "963", "964", "965", "966", "967", "968", "970", "971", "972", "973", "974", "975", "976", "977",
  "992", "993", "994", "995", "996", "998",
]);

function startsWithCountryCode(digits: string): boolean {
  return COUNTRY_CODES.has(digits.slice(0, 1)) || COUNTRY_CODES.has(digits.slice(0, 2)) || COUNTRY_CODES.has(digits.slice(0, 3));
}

const PHONE_CONTEXT = /\b(?:phone|tel|telephone|mobile|cell|fax|call|whatsapp|contact|ph)\b/i;

const phones: PiiDetector = (content) => {
  const spans: PiiSpan[] = [];
  // International: a leading "+" is the signal; the digits must start with a real calling code.
  for (const match of matchAll(content, /(?<![\w+])\+\d(?:[\d ().-]{5,20})\d(?![\d-]|\.\d)/g)) {
    const raw = match[0];
    const digits = digitsOf(raw);
    if (digits.length < 8 || digits.length > 15 || !startsWithCountryCode(digits)) continue;
    if (/[ .-]{2,}/.test(raw)) continue;
    spans.push({ start: match.index, end: match.index + raw.length });
  }
  // North American numbers written without "+": formatted, or named as a phone number.
  const nanp = /(?<![\w.+-])(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[ .-]?[2-9]\d{2}[ .-]?\d{4}(?!\w|[.-]\d)/g;
  for (const match of matchAll(content, nanp)) {
    const span = { start: match.index, end: match.index + match[0].length };
    const formatted = /[ .()-]/.test(match[0].replace(/^\+?1[ .-]?/, ""));
    if (formatted || hasContext(content, span, PHONE_CONTEXT, 24, 8)) spans.push(span);
  }
  return spans;
};

// ----------------------------------------------------------------- emails

const emails: PiiDetector = (content) => {
  const spans: PiiSpan[] = [];
  for (const match of matchAll(content, /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g)) {
    const [local] = match[0].split("@") as [string];
    if (local.startsWith(".") || local.endsWith(".") || match[0].includes("..") || match[0].length > 254) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
};

// ------------------------------------------------------------------- IBAN

/** IBAN registry lengths by country. */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24,
  DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28,
  HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20,
  LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29,
  RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22,
  VG: 24, XK: 20,
};

const ibans: PiiDetector = (content) => {
  const spans: PiiSpan[] = [];
  let resumeAt = 0;
  for (const match of matchAll(content, /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?=[ -]?[A-Z0-9])/g)) {
    if (match.index < resumeAt) continue;
    const expected = IBAN_LENGTHS[match[0].slice(0, 2)];
    if (!expected) continue;
    // Walk the printed groups ("DE89 3704 0044 ...") until the country's length is reached.
    let compact = "";
    let end = match.index;
    for (let at = match.index; at < content.length && compact.length < expected; at += 1) {
      const char = content[at]!;
      if (/[A-Z0-9]/.test(char)) {
        compact += char;
        end = at + 1;
      } else if ((char === " " || char === "-") && /[A-Z0-9]/.test(content[at + 1] ?? "")) {
        continue;
      } else {
        break;
      }
    }
    if (compact.length !== expected || /[A-Za-z0-9]/.test(content[end] ?? "") || !ibanChecksumValid(compact)) continue;
    spans.push({ start: match.index, end });
    resumeAt = end;
  }
  return spans;
};

// ---------------------------------------------------- numbers needing context

const BANK_CONTEXT = /\b(?:account|acct|a\/c|checking|savings|bank)(?:\s+(?:no|num|number|#))?\.?\s*[:#-]?\s*$/i;
const ROUTING_CONTEXT = /\b(?:routing|aba|rtn)(?:\s+(?:no|num|number|#))?\.?\s*[:#-]?\s*$/i;

const bankAccounts: PiiDetector = (content) => {
  const spans: PiiSpan[] = [];
  for (const match of matchAll(content, /(?<![\w.-])\d{8,17}(?![\w]|[.-]\d)/g)) {
    const span = { start: match.index, end: match.index + match[0].length };
    const before = content.slice(Math.max(0, span.start - 40), span.start);
    if (ROUTING_CONTEXT.test(before)) {
      if (match[0].length === 9 && abaChecksumValid(match[0])) spans.push(span);
    } else if (BANK_CONTEXT.test(before) && !/^(\d)\1+$/.test(match[0])) {
      spans.push(span);
    }
  }
  return spans;
};

const PASSPORT_CONTEXT = /\bpassport(?:\s+(?:no|num|number|#))?\.?\s*[:#-]?\s*$/i;
const LICENSE_CONTEXT = /\b(?:driver'?s?|driving)\s+licen[cs]e(?:\s+(?:no|num|number|#))?\.?\s*[:#-]?\s*$|\bdl\s*(?:no|num|number|#)\s*[:#-]?\s*$|\blicen[cs]e\s+(?:no|num|number|#)\s*[:#-]?\s*$/i;

function contextualId(context: RegExp, shape: RegExp, minDigits: number): PiiDetector {
  return (content) => {
    const spans: PiiSpan[] = [];
    for (const match of matchAll(content, shape)) {
      const before = content.slice(Math.max(0, match.index - 40), match.index);
      if (!context.test(before)) continue;
      if (digitsOf(match[0]).length < minDigits) continue;
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
    return spans;
  };
}

const passports = contextualId(PASSPORT_CONTEXT, /(?<![\w-])[A-Z]{0,2}\d{6,9}(?![\w-])/g, 6);
const driversLicenses = contextualId(LICENSE_CONTEXT, /(?<![\w-])[A-Z]{0,2}[A-Z0-9]{5,14}(?![\w-])/g, 5);

// -------------------------------------------------------------- IP addresses

const VERSION_CONTEXT = /\b(?:version|ver|release|build|rev|revision|sdk|api|protocol|oid|v)\.?\s*[:=]?\s*$/i;

const ipAddresses: PiiDetector = (content) => {
  const spans: PiiSpan[] = [];
  for (const match of matchAll(content, /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)/g)) {
    const octets = match[0].split(".");
    // No leading zeros ("010" is ambiguous) and every octet within range.
    if (octets.some((octet) => Number(octet) > 255 || (octet.length > 1 && octet.startsWith("0")))) continue;
    if (match[0] === "0.0.0.0") continue;
    if (VERSION_CONTEXT.test(content.slice(Math.max(0, match.index - 14), match.index))) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
};

// ------------------------------------------------------------------ secrets

const PLACEHOLDER = /^(?:x+|\*+|\.+|0+|(\d)\1+|your[\w-]*|example[\w-]*|changeme|placeholder|replace[\w-]*|insert[\w-]*|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\})$/i;

/** A value that is plainly not a live secret: a placeholder, or too uniform to be random. */
function looksLikeRealSecret(value: string, minEntropy: number): boolean {
  const body = value.replace(/^(?:sk-(?:ant-|proj-|svcacct-|admin-)?|(?:sk|rk)_(?:live|test|prod)_|gh[pousr]_|github_pat_|xox[baprs]-|AIza)/, "");
  return !PLACEHOLDER.test(body) && shannonEntropy(body) >= minEntropy;
}

function prefixed(pattern: RegExp, minEntropy = 2.5): PiiDetector {
  return (content) => {
    const spans: PiiSpan[] = [];
    for (const match of matchAll(content, pattern)) {
      if (looksLikeRealSecret(match[0], minEntropy)) spans.push({ start: match.index, end: match.index + match[0].length });
    }
    return spans;
  };
}

const openAiKeys = prefixed(/(?<![\w-])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}(?![\w-])/g);
const anthropicKeys = prefixed(/(?<![\w-])sk-ant-[A-Za-z0-9_-]{20,}(?![\w-])/g);
const githubTokens = prefixed(/(?<![\w-])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![\w-])/g);
const stripeKeys = prefixed(/(?<![\w-])(?:sk|rk)_(?:live|test|prod)_[A-Za-z0-9]{10,99}(?![\w-])/g);
const slackTokens = prefixed(/(?<![\w-])xox[baprs]-[A-Za-z0-9-]{10,250}(?![\w-])/g);
const googleKeys = prefixed(/(?<![\w-])AIza[A-Za-z0-9_-]{35}(?![\w-])/g);
const jwts = prefixed(/(?<![\w-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![\w-])/g);

// AKIA / ASIA / ... followed by 16 base32 characters (gitleaks aws-access-token).
const awsAccessKeys = prefixed(/(?<![\w-])(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}(?![\w-])/g, 2.0);

const GENERIC_SECRET = /\b(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[=:]\s*['"]?([A-Za-z0-9\-_.+/=]{16,})['"]?/gi;

const genericSecrets: PiiDetector = (content) => {
  const spans: PiiSpan[] = [];
  for (const match of matchAll(content, GENERIC_SECRET)) {
    const value = match[1] ?? "";
    if (!PLACEHOLDER.test(value) && shannonEntropy(value) >= 3.0) spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
};

/**
 * PEM private keys. A complete block is one span. A block cut off before its END line
 * (a truncated page) still reports the header and the base64 lines that follow it, because
 * a key fragment in the text is as sensitive as the whole key.
 */
const privateKeys: PiiDetector = (content) => {
  const spans: PiiSpan[] = [];
  const header = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
  for (const match of matchAll(content, header)) {
    const afterHeader = match.index + match[0].length;
    const footer = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
    footer.lastIndex = afterHeader;
    const end = footer.exec(content.slice(0, afterHeader + 32768));
    if (end) {
      spans.push({ start: match.index, end: end.index + end[0].length });
      continue;
    }
    const body = /^(?:\s*(?:[A-Za-z0-9+/=]{16,}|[A-Za-z-]+: .+))+/.exec(content.slice(afterHeader, afterHeader + 32768));
    spans.push({ start: match.index, end: afterHeader + (body?.[0].length ?? 0) });
  }
  return spans;
};

export const PII_DETECTORS: Record<PiiPatternType, PiiDetector> = {
  "ssn": ssns,
  "credit-card": cardNumbers,
  "phone": phones,
  "email": emails,
  "openai-api-key": openAiKeys,
  "anthropic-api-key": anthropicKeys,
  "github-token": githubTokens,
  "generic-api-key": genericSecrets,
  "ip-address": ipAddresses,
  "bank-account": bankAccounts,
  "iban": ibans,
  "passport": passports,
  "drivers-license": driversLicenses,
  "aws-access-key": awsAccessKeys,
  "stripe-api-key": stripeKeys,
  "slack-token": slackTokens,
  "google-api-key": googleKeys,
  "jwt": jwts,
  "private-key": privateKeys,
};
