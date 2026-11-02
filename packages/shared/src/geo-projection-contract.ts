/** Canonical JSON for projection digests. Hash the UTF-8 bytes with SHA-256.
 * Objects sort keys lexically; arrays retain order. Reject lossy JSON coercions.
 */
export function canonicalGeoProjectionJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(input: unknown): string {
    if (input === null) return "null";
    if (typeof input === "string" || typeof input === "boolean") return JSON.stringify(input);
    if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== "object" || input === null) throw new Error("Projection input must be JSON");
    if (ancestors.has(input)) throw new Error("Projection input must not be cyclic");
    const array = Array.isArray(input);
    if (!array && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
      throw new Error("Projection input must contain plain JSON objects");
    }
    if (Object.getOwnPropertySymbols(input).length) throw new Error("Projection input must not contain symbol keys");
    ancestors.add(input);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array && key === "length") continue;
        if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("Projection input must contain JSON data properties");
      }
      if (array) {
        if (Object.keys(input).length !== input.length) throw new Error("Projection arrays must be dense and have no extra properties");
        const values: string[] = [];
        for (let index = 0; index < input.length; index++) {
          if (!Object.hasOwn(input, index)) throw new Error("Projection arrays must be dense");
          values.push(encode(descriptors[String(index)].value));
        }
        return `[${values.join(",")}]`;
      }
      return `{${Object.keys(descriptors).sort().map(key => `${JSON.stringify(key)}:${encode(descriptors[key].value)}`).join(",")}}`;
    } finally {
      ancestors.delete(input);
    }
  }
  return encode(value);
}

/** RFC6901 pointer for one top-level output field; never a nested path. */
export function geoProjectionFieldPointer(name: string): string {
  return `/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}
