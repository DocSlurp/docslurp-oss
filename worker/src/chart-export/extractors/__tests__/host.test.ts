import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChartExtractRefusedError,
  extractDeterministicVisualsBatch,
  extractDeterministicVisualsFile,
  extractDeterministicVisualsInProcess,
  MAX_BATCH_INPUTS,
  validateDeterministicBatch,
  validateDeterministicResult,
} from "../host.js";
import { genericBar } from "./fixtures.js";

afterEach(() => vi.unstubAllEnvs());

async function withInput(content: string, fn: (input: string) => Promise<void>) {
  const base = process.env.TMPDIR || tmpdir();
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "docslurp-chart-host-test-"));
  try {
    const input = path.join(dir, "input.svg");
    await writeFile(input, content);
    await fn(input);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const goodResult = {
  schemaVersion: "chart-export-deterministic@v1",
  visuals: [{ source: "svg-geometry", kind: "chart", confidence: 0.9, spec: { kind: "chart", chartType: "bar", series: [{ name: "s", points: [{ x: "a", y: 1 }] }] }, digest: null, locator: "svg", slide: null, sheet: null, generator: null, reason: null }],
  refusals: [],
};

describe("deterministic chart extraction: parser VM boundary", () => {
  it("refuses in-process parsing in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => extractDeterministicVisualsInProcess({ kind: "svg", text: "<svg/>" })).toThrow(ChartExtractRefusedError);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    expect(() => extractDeterministicVisualsInProcess({ kind: "svg", text: "<svg/>" })).toThrow(/requires-parser-vm/);
  });

  it("runs the guest through the runner in production and validates its result", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await withInput(genericBar(["a", "b"], [1, 2], 4), async (input) => {
      const run = vi.fn(async (plan: { args: string[] }) => {
        expect(plan.args[0]).toBe("--disallow-code-generation-from-strings");
        expect(plan.args[1]).toMatch(/chart-export-extract\.mjs$/);
        expect(plan.args[2]).toBe(input);
        await writeFile(plan.args[4]!, JSON.stringify(goodResult));
        return { stdout: "", stderr: "" };
      });
      const result = await extractDeterministicVisualsFile({ inputPath: input, kind: "svg", runner: { run } as never, log: () => {} });
      expect(run).toHaveBeenCalledOnce();
      expect(result.visuals[0]!.spec).toMatchObject({ kind: "chart", chartType: "bar" });
    });
  });

  it("fails closed when the VM is unavailable: no host parsing fallback", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await withInput(genericBar(["a", "b"], [1, 2], 4), async (input) => {
      const logs: string[] = [];
      const run = vi.fn(async () => { throw new Error("no parser VM provider (secret-token-123)"); });
      await expect(extractDeterministicVisualsFile({ inputPath: input, kind: "svg", runner: { run } as never, log: (m) => logs.push(m) })).rejects.toThrow(/guest-unavailable/);
      expect(logs.join("\n")).toContain("reason=guest-unavailable");
      expect(logs.join("\n")).not.toContain("secret-token-123");
    });
  });

  it("rejects malformed, oversized or extra-field guest output", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const bad: unknown[] = [
      { ...goodResult, schemaVersion: "v0" },
      { ...goodResult, extra: 1 },
      { ...goodResult, visuals: [{ ...goodResult.visuals[0], confidence: 2 }] },
      { ...goodResult, visuals: [{ ...goodResult.visuals[0], kind: "diagram" }] },
      { ...goodResult, visuals: [{ ...goodResult.visuals[0], spec: { kind: "chart", chartType: "bar", series: [] } }] },
      { ...goodResult, visuals: [{ ...goodResult.visuals[0], locator: "x".repeat(600) }] },
      { ...goodResult, visuals: [{ ...goodResult.visuals[0], __proto__: { polluted: true }, injected: "<script>" }] },
      { ...goodResult, visuals: Array.from({ length: 300 }, () => goodResult.visuals[0]) },
    ];
    for (const payload of bad) {
      await withInput("<svg/>", async (input) => {
        const run = vi.fn(async (plan: { args: string[] }) => { await writeFile(plan.args[4]!, JSON.stringify(payload)); return { stdout: "", stderr: "" }; });
        await expect(extractDeterministicVisualsFile({ inputPath: input, kind: "svg", runner: { run } as never, log: () => {} })).rejects.toThrow(/invalid-guest-result/);
      });
    }
    await withInput("<svg/>", async (input) => {
      const run = vi.fn(async (plan: { args: string[] }) => { await writeFile(plan.args[4]!, "{not json"); return { stdout: "", stderr: "" }; });
      await expect(extractDeterministicVisualsFile({ inputPath: input, kind: "svg", runner: { run } as never, log: () => {} })).rejects.toThrow(/not-json/);
      const silent = vi.fn(async () => ({ stdout: "", stderr: "" }));
      await expect(extractDeterministicVisualsFile({ inputPath: input, kind: "svg", runner: { run: silent } as never, log: () => {} })).rejects.toThrow(/no-output/);
    });
  });

  it("refuses oversized inputs before any parse", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await withInput(" ".repeat(5 * 1024 * 1024 + 1), async (input) => {
      const run = vi.fn();
      await expect(extractDeterministicVisualsFile({ inputPath: input, kind: "svg", runner: { run } as never, log: () => {} })).rejects.toThrow(/input-too-large/);
      expect(run).not.toHaveBeenCalled();
    });
  });

  it("runs the same guest code in-process outside production", async () => {
    await withInput(genericBar(["a", "b"], [1, 2], 4), async (input) => {
      const run = vi.fn();
      const result = await extractDeterministicVisualsFile({ inputPath: input, kind: "svg", runner: { run } as never });
      expect(run).not.toHaveBeenCalled();
      expect(result.visuals).toHaveLength(1);
      expect(validateDeterministicResult(result)).toBe(result);
    });
  });

  it("batches SVG inputs: one result per input in order, an oversized input refused alone, more than the cap refused", async () => {
    await withInput(genericBar(["a", "b"], [1, 2], 4), async (good) => {
      await withInput(" ".repeat(5 * 1024 * 1024 + 1), async (big) => {
        const run = vi.fn();
        const results = await extractDeterministicVisualsBatch({ inputPaths: [good, big, good], runner: { run } as never, log: () => {} });
        expect(run).not.toHaveBeenCalled();
        expect(results.map((r) => r.visuals.length)).toEqual([1, 0, 1]);
        expect(results[1]!.refusals).toEqual([{ locator: "svg", reason: "input-too-large" }]);
        await expect(extractDeterministicVisualsBatch({ inputPaths: Array.from({ length: MAX_BATCH_INPUTS + 1 }, () => good), runner: { run } as never, log: () => {} }))
          .rejects.toThrow(/too-many-inputs/);
      });
    });
  });

  it("in production sends a batch as one VM run (first input, request, output, then the rest) with a scaled timeout", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await withInput(genericBar(["a"], [1], 2), async (input) => {
      const run = vi.fn(async (plan: { args: string[]; timeoutMs: number }) => {
        expect(plan.args[2]).toBe(input);
        expect(plan.args[0]).toBe("--disallow-code-generation-from-strings");
        expect(plan.args.slice(5)).toEqual([input, input]);
        expect(plan.timeoutMs).toBe(66_000);
        await writeFile(plan.args[4]!, JSON.stringify({ schemaVersion: "chart-export-deterministic-batch@v1", results: [goodResult, goodResult, goodResult] }));
        return { stdout: "", stderr: "" };
      });
      const results = await extractDeterministicVisualsBatch({ inputPaths: [input, input, input], runner: { run } as never, log: () => {} });
      expect(run).toHaveBeenCalledOnce();
      expect(results).toHaveLength(3);
      expect(() => validateDeterministicBatch({ schemaVersion: "chart-export-deterministic-batch@v1", results: [goodResult] }, 2)).toThrow(ChartExtractRefusedError);
    });
  });
});
