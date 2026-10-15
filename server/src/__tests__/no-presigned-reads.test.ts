import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" || entry === "__tests__" ? [] : sources(path);
    return /\.(ts|tsx|astro|mjs)$/.test(entry) && !/\.test\./.test(entry) ? [path] : [];
  });
}

describe("storage reads go only through the file proxy", () => {
  it("never presigns a GetObject for a client", () => {
    // Reads stream through /v1/files (routes/files.ts) with session/key-bound
    // tokens. Presigned PUTs for direct uploads (lib/storage.ts) are the only
    // presigned URLs allowed.
    const offenders = sources(root).filter((file) => {
      const text = readFileSync(file, "utf8");
      return text.includes("getSignedUrl") && /\bGetObjectCommand\b/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
