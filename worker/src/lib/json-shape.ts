/**
 * A linear pre-scan of untrusted JSON text before JSON.parse: bounds nesting depth, the number of arrays and objects,
 * the number of scalars (strings, object keys, numbers, true, false, null) and the length of any one string. These are
 * what make JSON.parse allocate many times the input size (measured: deep nesting ~29 bytes of heap per input byte,
 * empty arrays ~11, empty objects ~19), or allocate one huge value. Throws past any bound; malformed JSON is left for
 * JSON.parse to reject.
 */
export interface JsonShapeLimits {
  maxDepth: number;
  maxContainers: number;
  /** Strings (object keys included), numbers and literals together. */
  maxScalars?: number;
  /** Longest string, in characters of its JSON text (escapes included). */
  maxStringLength?: number;
}

export function assertJsonShape(text: string, limits: JsonShapeLimits): void {
  const maxScalars = limits.maxScalars ?? Number.POSITIVE_INFINITY;
  const maxStringLength = limits.maxStringLength ?? Number.POSITIVE_INFINITY;
  let depth = 0, containers = 0, scalars = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      // A string: skip to its closing quote, counting its length.
      if (++scalars > maxScalars) throw new Error("JSON scalar count exceeds limit");
      const start = i;
      for (i++; i < text.length; i++) {
        const d = text.charCodeAt(i);
        if (d === 92) i++;
        else if (d === 34) break;
        if (i - start > maxStringLength) throw new Error("JSON string length exceeds limit");
      }
    } else if (c === 91 || c === 123) {
      if (++depth > limits.maxDepth) throw new Error("JSON nesting exceeds limit");
      if (++containers > limits.maxContainers) throw new Error("JSON container count exceeds limit");
    } else if (c === 93 || c === 125) depth--;
    else if (c === 45 || (c >= 48 && c <= 57) || c === 116 || c === 102 || c === 110) {
      // A number or literal: one scalar, then skip the rest of its token.
      if (++scalars > maxScalars) throw new Error("JSON scalar count exceeds limit");
      while (i + 1 < text.length && isTokenChar(text.charCodeAt(i + 1))) i++;
    }
  }
}

/** Characters of a number or literal token: digits, letters, `.`, `+`, `-`. */
function isTokenChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 43 || c === 45;
}
