/**
 * A linear pre-scan of untrusted JSON text before JSON.parse: bounds nesting depth and the number of arrays and
 * objects, the shapes that make JSON.parse allocate many times the input size (measured: deep nesting ~29 bytes of heap
 * per input byte, empty arrays ~11, empty objects ~19; strings and numbers ~1 or less). Throws past either bound.
 * Malformed JSON is left for JSON.parse to reject.
 */
export function assertJsonShape(text: string, limits: { maxDepth: number; maxContainers: number }): void {
  let depth = 0, containers = 0, inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++; // backslash: skip the escaped character
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 34) inString = true;
    else if (c === 91 || c === 123) {
      if (++depth > limits.maxDepth) throw new Error("JSON nesting exceeds limit");
      if (++containers > limits.maxContainers) throw new Error("JSON container count exceeds limit");
    } else if (c === 93 || c === 125) depth--;
  }
}
