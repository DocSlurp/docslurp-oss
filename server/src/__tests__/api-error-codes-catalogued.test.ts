import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { API_ERROR_CODES } from "@docslurp/shared";

const routesDir = join(import.meta.dirname, "..", "routes");

describe("route error codes", () => {
  it("every literal code passed to apiStatusError is in the shared catalogue, so clients never get a collapsed code", () => {
    const known = new Set<string>(API_ERROR_CODES);
    const unknown: string[] = [];
    for (const file of readdirSync(routesDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      const source = readFileSync(join(routesDir, file), "utf8");
      for (const match of source.matchAll(/apiStatusError\([^;]*?\{\s*code:\s*"([a-z0-9_]+)"/g)) {
        if (!known.has(match[1]!)) unknown.push(`${file}: ${match[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
