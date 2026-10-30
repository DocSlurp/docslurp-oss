import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OPENROUTER_BASE_URL, visionConfigSchema, visionListPriceCents } from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";
import { priceVisionResult } from "../lib/guarded-vision-call.js";
import { visionMaxPrice } from "../test/vision-max-price.js";
import { detectDegeneration, VisionOutputRejectedError, withIgnoredProvider } from "../tools/vision-stream.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const cfg = { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;

async function run(config: Config = cfg) {
  const dir = await mkdtemp(join(tmpdir(), "vision-guard-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return executeVisionRuntime({
    imagePath, outputPath: `${imagePath}.json`, vision: visionConfigSchema.parse({ modelUri: "llm://openrouter/google/gemini-2.5-flash-lite" }), gate: null,
    cfg: config, runner: new CommandRunner(), privacyMode: "standard",
  });
}

const enc = new TextEncoder();
function sse(chunks: Array<Record<string, unknown> | string>, opts: { onCancel?: () => void } = {}): Response {
  const events = chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < events.length) controller.enqueue(enc.encode(events[i++]!));
      else controller.close();
    },
    cancel: () => opts.onCancel?.(),
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const delta = (content: string, extra: Record<string, unknown> = {}) => ({ id: "gen-1", model: "m", provider: "ProvA", choices: [{ delta: { content } }], ...extra });
const finish = (reason: string, usage?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "gen-1", model: "m", provider: "ProvA", choices: [{ delta: { content: "" }, finish_reason: reason, ...extra }], ...(usage ? { usage } : {}),
});
const okStream = (text = "# Page\n\nHello", provider = "ProvA") => sse([
  delta(text, { provider }), finish("stop", { prompt_tokens: 1000, completion_tokens: 50, cost: 0.001 }, {}),
].map((c: any) => ({ ...c, provider })));

function stubFetch(responses: Array<Response | (() => Response)>) {
  const bodies: Array<Record<string, any>> = [];
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return typeof next === "function" ? next() : next;
  });
  vi.stubGlobal("fetch", fn);
  return { fn, bodies };
}

describe("degeneration detector", () => {
  it("fires on observed loop shapes", () => {
    expect(detectDegeneration("# T\n" + "| ".repeat(2_000))?.reason).toBe("repeated-pattern");
    expect(detectDegeneration("x" + "&nbsp;".repeat(500))?.reason).toBeDefined();
    expect(detectDegeneration("שלום " + "תחתי ".repeat(500))?.reason).toBe("repeated-pattern");
    expect(detectDegeneration(" ".repeat(1_600))?.reason).toBe("whitespace-run");
    let seed = 7;
    const vocab = ["alpha", "beta", "gamma", "delta"];
    const varied = Array.from({ length: 700 }, () => vocab[(seed = (seed * 1103515245 + 12345) % 2147483648) % 4]).join(" ");
    expect(detectDegeneration(varied)?.reason).toBe("low-diversity");
  });

  it("fires on a runaway spaced or unspaced leader line but not on a real table of contents", () => {
    expect(detectDegeneration("9.1 Null and Alternative Hypotheses " + ". ".repeat(200))?.reason).toBe("leader-run");
    expect(detectDegeneration("Intro " + "·".repeat(300))?.reason).toBeDefined();
    expect(detectDegeneration("Intro " + "… ".repeat(160))?.reason).toBe("leader-run");
    expect(detectDegeneration("Intro " + "-_".repeat(150))?.reason).toBeDefined();
    const toc = Array.from({ length: 60 }, (_, i) => `${i + 1}.${i % 4} Hypothesis testing topic ${i} ${". ".repeat(50)}${i * 7 + 1}`).join("\n");
    expect(detectDegeneration(toc)).toBeNull();
  });

  it("does not fire on dense tables, dot leaders or repeated form lines", () => {
    const table = ["| Item | Q1 | Q2 | Q3 | Q4 |", "|---|---|---|---|---|",
      ...Array.from({ length: 300 }, (_, i) => `| Line ${i} | ${i * 3 % 97} | ${i * 7 % 89} | ${(i * 11) % 83} | ${i % 5} |`)].join("\n");
    expect(detectDegeneration(table)).toBeNull();
    const toc = Array.from({ length: 80 }, (_, i) => `Chapter ${i + 1}: Topic number ${i * 13} ${".".repeat(70)} ${i * 4 + 3}`).join("\n");
    expect(detectDegeneration(toc)).toBeNull();
    const form = Array.from({ length: 45 }, () => "Name: ______________________  Date: ____________  Signature: ____________________").join("\n");
    expect(detectDegeneration(form)).toBeNull();
    const emptyRows = ["| A | B | C |", "|---|---|---|", ...Array.from({ length: 50 }, () => "|   |   |   |")].join("\n");
    expect(detectDegeneration(emptyRows)).toBeNull();
    expect(detectDegeneration("." .repeat(150))).toBeNull();
  });

  it("merges provider.ignore with existing preferences", () => {
    expect(withIgnoredProvider({ provider: { order: ["a"], ignore: ["x"] } }, "y")).toEqual({ provider: { order: ["a"], ignore: ["x", "y"] } });
  });
});

describe("guarded hosted vision request", () => {
  it("streams a normal response and takes provider usage and cost", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const { bodies } = stubFetch([okStream()]);
    const result = await run();
    expect(bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(result).toMatchObject({ text: "# Page\n\nHello", finishReason: "stop", attempts: 1, usageSource: "provider", inputTokens: 1000, outputTokens: 50 });
    expect(result.degenerate).toBeUndefined();
    expect(result.costCents).toBeCloseTo(0.1, 10);
    const lines = logs.mock.calls.map(([l]) => String(l));
    expect(lines.filter((l) => l.startsWith("[vision-attempt]"))).toHaveLength(1);
    // The guard never emits `[ai-usage]`: the caller logs the single billed total so log sums stay exact.
    expect(lines.filter((l) => l.startsWith("[ai-usage]"))).toHaveLength(0);
  });

  it("aborts a repetition loop mid-stream, estimates usage, and retries on another provider", async () => {
    let cancelled = false;
    const loop = sse([delta("# T\n"), ...Array.from({ length: 200 }, () => delta("| | | | | | | | | | | | | | | | "))], { onCancel: () => { cancelled = true; } });
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bodies } = stubFetch([loop, okStream("# Good")]);
    const result = await run();
    expect(cancelled).toBe(true);
    expect(bodies[1]!.provider).toEqual({ ignore: ["ProvA"], max_price: visionMaxPrice(bodies[0]!.model) });
    expect(result.text).toBe("# Good");
    expect(result.attempts).toBe(2);
    expect(result.degenerate).toMatchObject({ reason: "repeated-pattern" });
    expect(result.degenerate!.atChars).toBeGreaterThan(1_000);
    // Both attempts are summed: aborted attempt is estimated (not zero), second has provider usage.
    expect(result.usageSource).toBe("estimated");
    expect(result.outputTokens).toBeGreaterThan(50 + 300);
    expect(result.inputTokens).toBeGreaterThan(1000);
    // costCents is the provider's reported charge only (the second attempt), covering its own tokens; the aborted
    // attempt's estimated tokens are priced on the served route, never at configured rates.
    expect(result.costCents).toBeCloseTo(0.1, 10);
    expect(result.chargedTokens).toEqual({ inputTokens: 1000, outputTokens: 50 });
    const uncharged = { inputTokens: result.inputTokens - 1000, outputTokens: result.outputTokens - 50 };
    expect(priceVisionResult(result, cfg)).toBeCloseTo(0.1 + visionListPriceCents(result.route.model, uncharged)!, 10);
    const usageLines = logs.mock.calls.map(([l]) => String(l)).filter((l) => l.startsWith("[vision-attempt]"));
    expect(usageLines).toHaveLength(2);
    expect(usageLines[0]).toContain("outcome=degenerate");
  });

  it("aborts a spaced-leader runaway and takes the retry path", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runaway = sse([delta("9.1 Null and Alternative Hypotheses "), ...Array.from({ length: 100 }, () => delta(". . . . . . . . . . "))]);
    const { bodies } = stubFetch([runaway, okStream("# Contents")]);
    const result = await run();
    expect(result).toMatchObject({ text: "# Contents", attempts: 2 });
    expect(result.degenerate?.reason).toBe("leader-run");
    expect(bodies[1]!.provider).toEqual({ ignore: ["ProvA"], max_price: visionMaxPrice(bodies[0]!.model) });
  });

  it("uses the last streamed usage when the stream aborts after a usage chunk", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const loop = sse([delta("a", { usage: { prompt_tokens: 1700, completion_tokens: 321, cost: 0.002 } }), ...Array.from({ length: 200 }, () => delta("&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"))]);
    stubFetch([loop, okStream()]);
    const result = await run();
    expect(result.inputTokens).toBe(1700 + 1000);
    expect(result.outputTokens).toBe(321 + 50);
    expect(result.costCents).toBeCloseTo(0.2 + 0.1, 10);
  });

  it("does not abort legitimate dense table output", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const rows = Array.from({ length: 300 }, (_, i) => `| Line ${i} | ${i * 3 % 97} | ${i * 7 % 89} |\n`);
    stubFetch([sse([...rows.map((r) => delta(r)), finish("stop", { prompt_tokens: 10, completion_tokens: 9000 })])]);
    const result = await run();
    expect(result.attempts).toBe(1);
    expect(result.text.split("\n")).toHaveLength(300);
  });

  it("retries a content-filter refusal on another provider and succeeds", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const refusal = sse([delta("partial text"), finish("error", { prompt_tokens: 1500, completion_tokens: 600, cost: 0.0008 }, { error: { code: 403, message: "Output blocked by content filtering policy", metadata: { error_type: "refusal" } } })]);
    const { bodies } = stubFetch([refusal, okStream("# Ok", "ProvB")]);
    const result = await run();
    expect(bodies[1]!.provider).toEqual({ ignore: ["ProvA"], max_price: visionMaxPrice(bodies[0]!.model) });
    expect(result).toMatchObject({ text: "# Ok", attempts: 2, finishReason: "stop", inputTokens: 2500, outputTokens: 650 });
    expect(result.costCents).toBeCloseTo(0.18, 10);
  });

  it("retries finish_reason=content_filter with zero completion tokens", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const filtered = new Response(JSON.stringify({
      model: "m", provider: "Azure", choices: [{ message: { content: "cut off" }, finish_reason: "content_filter" }], usage: { prompt_tokens: 1200, completion_tokens: 0 },
    }), { headers: { "content-type": "application/json" } });
    const { bodies } = stubFetch([filtered, okStream("# Ok", "Bedrock")]);
    const result = await run();
    expect(bodies[0]!.provider).toEqual({ max_price: visionMaxPrice(bodies[0]!.model) });
    expect(bodies[1]!.provider).toEqual({ ignore: ["Azure"], max_price: visionMaxPrice(bodies[0]!.model) });
    expect(result.text).toBe("# Ok");
    expect(result.attempts).toBe(2);
  });

  it("treats an HTTP 200 error body with no choices as a retryable provider error", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const flex = new Response(JSON.stringify({ error: { message: "Flex processing is temporarily unavailable", code: 503 } }), { headers: { "content-type": "application/json" } });
    stubFetch([flex, okStream("# Ok")]);
    const result = await run();
    expect(result).toMatchObject({ text: "# Ok", attempts: 2 });
  });

  it("fails with a clear error after a second length outcome and sums both attempts", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const long = (provider: string) => sse([delta("text ".repeat(20), { provider }), finish("length", { prompt_tokens: 1000, completion_tokens: 16384, cost: 0.01 }, {})].map((c: any) => ({ ...c, provider })));
    stubFetch([long("ProvA"), long("ProvB")]);
    const error = await run().catch((e) => e);
    expect(error).toBeInstanceOf(VisionOutputRejectedError);
    expect(error.message).toMatch(/rejected after 2 attempts \(length/);
    expect(error.message).toContain("ProvA");
    expect(error.message).toContain("ProvB");
    expect(error).toMatchObject({ inputTokens: 2000, outputTokens: 32768 });
    expect(error.costCents).toBeCloseTo(2, 10);
    const lines = logs.mock.calls.map(([l]) => String(l));
    expect(lines.filter((l) => l.startsWith("[vision-attempt]"))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("[ai-usage]"))).toHaveLength(0);
  });

  it("falls back to non-streaming when the stream fails before the first chunk", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const broken = () => new Response(new ReadableStream({ start: (c) => c.error(new Error("socket hang up")) }), { headers: { "content-type": "text/event-stream" } });
    const plain = new Response(JSON.stringify({ choices: [{ message: { content: "plain" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { headers: { "content-type": "application/json" } });
    const { bodies } = stubFetch([broken, plain]);
    const result = await run();
    expect(bodies[0]!.stream).toBe(true);
    expect(bodies[1]!.stream).toBeUndefined();
    expect(result).toMatchObject({ text: "plain", attempts: 1 });
  });

  it("falls back to non-streaming when the endpoint rejects stream", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const plain = new Response(JSON.stringify({ choices: [{ message: { content: "plain" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    const { bodies } = stubFetch([new Response("stream not supported", { status: 400 }), plain]);
    const result = await run();
    expect(bodies.map((b) => b.stream)).toEqual([true, undefined]);
    expect(result.text).toBe("plain");
  });

  it("sends no stream fields with VISION_STREAMING=off", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const plain = new Response(JSON.stringify({ choices: [{ message: { content: "plain" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    const { bodies } = stubFetch([plain]);
    const result = await run({ ...cfg, visionStreaming: false });
    expect(bodies[0]!.stream).toBeUndefined();
    expect(bodies[0]!.stream_options).toBeUndefined();
    expect(result.text).toBe("plain");
  });

  it("honours the VISION_STREAMING env when the config does not set it", async () => {
    vi.stubEnv("VISION_STREAMING", "off");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { bodies } = stubFetch([new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))]);
    await run();
    expect(bodies[0]!.stream).toBeUndefined();
    expect(OPENROUTER_BASE_URL).toContain("openrouter");
  });
});
