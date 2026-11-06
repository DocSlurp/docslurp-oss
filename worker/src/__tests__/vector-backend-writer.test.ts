import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { vectorBackendEnvAllowlist } from "../tools/process-env.js";

/** Chroma was removed (owner decision 2026-11-05): the vector writer has no Chroma path, and its env keys are gone. */
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/vector_backend_write.py");

describe("vector_backend_write.py without Chroma", () => {
  it("refuses --backend chroma before reading any input", () => {
    const result = spawnSync("python3", ["-I", script, "--input", "/nonexistent", "--output", "/nonexistent", "--backend", "chroma", "--collection", "c"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/invalid choice: 'chroma' \(choose from 'lancedb', 'milvus'\)/);
  });

  it("has no Chroma client code and passes no Chroma env", () => {
    expect(readFileSync(script, "utf8")).not.toMatch(/chroma/i);
    expect(vectorBackendEnvAllowlist.some((key) => key.startsWith("CHROMA"))).toBe(false);
  });
});
