// Chart export through the real vision runtime and stream wrapper (executeVisionRuntime -> runGuardedChatCompletion),
// with a scripted fetch underneath. The generator tests in chart-export.test.ts use a fake client that bypasses the
// stream's own retries; these pin what the provider actually sees: one billed request per chart call, the cut-off
// retry at the larger cap, the repair sized to the first answer, and the image limit (council round 2, M2/M3).
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultChartExportConfig, defaultPipelineFeatures, OPENROUTER_BASE_URL, type ChartExportConfig } from "@docslurp/shared";

import type { WorkerAiUsageInput } from "../lib/ai-usage.js";
import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";
import { CHART_EXPORT_LIMITS, chartCallRuntimeOptions } from "./config.js";
import { exportVisual } from "./generator.js";
import { chartExportVisionConfig } from "./model-selection.js";
import type { ChartModelClient, VisualCandidate } from "./types.js";

const MODEL_URI = "llm://openrouter/openai/gpt-6-luna";
const cfg = { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config;
const candidate: VisualCandidate = { id: "p1-i0", pageNumber: 1, imageIndex: 0, bbox: { x: 0, y: 0, width: 400, height: 300 }, kind: "chart", detectedBy: "router-inset" };
const chartConfig: ChartExportConfig = { ...defaultChartExportConfig, enabled: true, formats: ["description", "mermaid"] };
const BAR_SPEC = {
  kind: "chart", chartType: "bar", title: "Quarterly revenue",
  yAxis: { label: "Revenue", unit: "USD m", scale: "linear", min: null, max: null },
  series: [{ name: "Revenue", points: [{ x: "Q1", y: 10 }, { x: "Q2", y: 12.5 }, { x: "Q3", y: 15 }] }],
  summary: "Revenue grows every quarter, from 10 to 15.",
};

afterEach(() => vi.unstubAllGlobals());

/** A PNG whose header says `width` x `height` (the runtime reads only the header). */
async function png(width: number, height: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chart-runtime-"));
  const path = join(dir, "chart.png");
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(header, 0);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  await writeFile(path, header);
  return path;
}

type Answer = { content: string; finish: string; completionTokens: number };

/** Scripted OpenRouter: one JSON response per request, in order; records every request body. */
function scriptedFetch(answers: Answer[]) {
  const bodies: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    bodies.push(JSON.parse(String(init.body)));
    const answer = answers.shift();
    if (!answer) throw new Error("no scripted answer");
    return new Response(JSON.stringify({
      id: `gen-${bodies.length}`, model: "openai/gpt-6-luna", provider: "OpenAI",
      choices: [{ message: { content: answer.content }, finish_reason: answer.finish }],
      usage: { prompt_tokens: 1_500, completion_tokens: answer.completionTokens },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return bodies;
}

/** The production chart model client's runtime call (stages/vision-extract.ts), minus the run's guards. */
const runtimeClient: ChartModelClient = {
  async complete(request) {
    const result = await executeVisionRuntime({
      imagePath: request.image.path,
      mimeType: request.image.mimeType,
      outputPath: `${request.image.path}.${request.purpose}.json`,
      vision: chartExportVisionConfig(defaultPipelineFeatures.vision as never, request.modelUri),
      cfg,
      runner: new CommandRunner(),
      privacyMode: "standard",
      outputSchema: null,
      gate: null,
      promptText: request.prompt,
      ...chartCallRuntimeOptions(request),
    });
    return {
      text: result.text, model: result.model, provider: result.route.provider, inputTokens: result.inputTokens,
      outputTokens: result.outputTokens, costCents: 0, latencyMs: result.latencyMs, finishReason: result.finishReason ?? null,
    };
  },
};

async function read(imagePath: string) {
  const usage: WorkerAiUsageInput[] = [];
  const out = await exportVisual({
    candidate, image: { path: imagePath, mimeType: "image/png" }, deterministic: null, config: chartConfig,
    generatorModelUri: MODEL_URI, client: runtimeClient, recordUsage: (input) => usage.push(input), documentId: "doc-1",
  });
  return { ...out, usage };
}

describe("chart export through the vision runtime", () => {
  it("sends a cut-off spec once, then one retry at the larger cap: two billed requests, no stream retry", async () => {
    const cutOff = `{"kind":"chart","chartType":"line","series":[{"name":"a","points":[${'{"x":1,"y":2},'.repeat(200)}`;
    const bodies = scriptedFetch([
      { content: cutOff, finish: "length", completionTokens: CHART_EXPORT_LIMITS.maxOutputTokensPerCall },
      { content: JSON.stringify(BAR_SPEC), finish: "stop", completionTokens: 400 },
    ]);
    const { visual, calls } = await read(await png(800, 600));
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.max_tokens)).toEqual([CHART_EXPORT_LIMITS.maxOutputTokensPerCall, CHART_EXPORT_LIMITS.maxExpandedOutputTokens]);
    expect(bodies.every((body) => !body.stream)).toBe(true);
    expect(calls.map((call) => call.purpose)).toEqual(["spec", "expand"]);
    expect(visual?.outputs.mermaid).toBeTruthy();
  });

  it("stops after the expanded retry is cut off too: still two requests, the visual falls back", async () => {
    const cutOff = `{"kind":"chart","series":[${'{"x":1},'.repeat(200)}`;
    const bodies = scriptedFetch([
      { content: cutOff, finish: "length", completionTokens: CHART_EXPORT_LIMITS.maxOutputTokensPerCall },
      { content: cutOff, finish: "length", completionTokens: CHART_EXPORT_LIMITS.maxExpandedOutputTokens },
    ]);
    const { calls } = await read(await png(800, 600));
    expect(bodies).toHaveLength(2);
    expect(calls.map((call) => call.purpose)).toEqual(["spec", "expand"]);
  });

  it("repairs a short invalid answer (not a cut-off) with a cap sized to that answer", async () => {
    const bodies = scriptedFetch([
      { content: "Here is the chart: {not json", finish: "stop", completionTokens: 120 },
      { content: JSON.stringify(BAR_SPEC), finish: "stop", completionTokens: 400 },
    ]);
    const { visual, calls } = await read(await png(800, 600));
    expect(calls.map((call) => call.purpose)).toEqual(["spec", "repair"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.max_tokens).toBe(120 + CHART_EXPORT_LIMITS.repairOutputSlackTokens);
    expect(visual?.outputs.mermaid).toBeTruthy();
  });

  it("does not retry a refused spec on another route: one billed request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bodies = scriptedFetch([{ content: "", finish: "content_filter", completionTokens: 0 }]);
    const { visual, calls } = await read(await png(800, 600));
    warn.mockRestore();
    expect(bodies).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ok).toBe(false);
    expect(visual).toBeNull();
  });

  it("sends nothing for an image above the chart image limit, or of unknown size", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bodies = scriptedFetch([]);
    const large = await read(await png(4_000, 4_000));
    const dir = await mkdtemp(join(tmpdir(), "chart-runtime-"));
    const unknown = join(dir, "chart.png");
    await writeFile(unknown, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const unsized = await read(unknown);
    warn.mockRestore();
    expect(bodies).toHaveLength(0);
    for (const out of [large, unsized]) {
      expect(out.calls.map((call) => call.responded)).toEqual([false]);
      expect(out.visual).toBeNull();
    }
  });
});
