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
  it("never presigns a GetObject for a client, except the export download", () => {
    // Reads stream through /v1/files (routes/files.ts) with session/key-bound
    // tokens. Presigned PUTs for direct uploads are allowed, and one presigned
    // GET: lib/storage.ts signDownloadGet, a link of at most five minutes for
    // zip exports, signed right after the export is authorized, so multi-GB
    // archives download from storage instead of through the API.
    const offenders = sources(root).filter((file) => {
      const text = readFileSync(file, "utf8");
      if (file.endsWith(join("lib", "storage.ts"))) return /new GetObjectCommand/.test(text.replace(/export async function signDownloadGet[\s\S]*?\n}\n/, ""));
      return text.includes("getSignedUrl") && /\bGetObjectCommand\b/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it("signs download links only for zip exports", () => {
    // An extract's download is its run-scoped zip export, signed after the extract is authorized.
    const callers = sources(root).filter((file) => !file.endsWith(join("lib", "storage.ts")) && readFileSync(file, "utf8").includes("signDownloadGet"));
    expect(callers.map((file) => file.slice(root.length + 1)).sort()).toEqual([join("services", "document-exports.ts"), join("services", "extracts.ts")]);
  });
});
