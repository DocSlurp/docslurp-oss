import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OPENROUTER_BASE_URL } from "@docslurp/shared";

import { isProviderRetryableError } from "../lib/provider-retry.js";
import { CommandRunner } from "../tools/runner.js";
import { detectModelSwap, normalizeModelIdentity, runVisionRequest, type VisionModelSwapPolicy } from "../tools/vision-runtime.js";

const REQUESTED = "deepseek/deepseek-v4.1-flash";

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(opts: { body: Record<string, unknown>; baseUrl?: string; swapPolicy?: VisionModelSwapPolicy }) {
  const dir = await mkdtemp(join(tmpdir(), "vision-swap-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: "text" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...opts.body,
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  return runVisionRequest({
    imagePath,
    mimeType: "image/png",
    outputPath: `${imagePath}.json`, gate: null,
    runner: new CommandRunner(),
    runtime: "openai-compatible",
    model: REQUESTED,
    prompt: "p",
    baseUrl: opts.baseUrl ?? OPENROUTER_BASE_URL,
    apiKey: "k",
    fetchImpl,
    swapPolicy: opts.swapPolicy,
  });
}

describe("vision model swap detection", () => {
  it("reports no swap when the served model is the requested one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run({ body: { model: REQUESTED, provider: "DeepSeek" } });
    expect(result.modelSwap).toBeUndefined();
    expect(result.servedModel).toBe(REQUESTED);
    expect(result.servedProvider).toBe("DeepSeek");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["deepseek-v4.1-flash", "DeepSeek/DeepSeek-V4.1-Flash", `${REQUESTED}:free`, `${REQUESTED}:nitro`])(
    "treats %s as the same weights",
    async (served) => {
      const result = await run({ body: { model: served } });
      expect(result.modelSwap).toBeUndefined();
      expect(result.servedModel).toBe(served);
    },
  );

  it("flags a snapshot mismatch with a structured warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run({ body: { model: "deepseek/deepseek-v4.1-flash-1017", provider: "deepseek" } });
    expect(result.modelSwap).toEqual({ requested: REQUESTED, served: "deepseek/deepseek-v4.1-flash-1017", provider: "deepseek" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`[vision-model-swap] requested=${REQUESTED} served=deepseek/deepseek-v4.1-flash-1017 provider=deepseek`));
  });

  it("flags a different family", () => {
    expect(detectModelSwap(REQUESTED, "qwen/qwen3-vl", null)).toMatchObject({ served: "qwen/qwen3-vl" });
    expect(normalizeModelIdentity("A/B:free")).toBe("b");
  });

  it("throws a retryable provider error under the fail policy", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = await run({ body: { model: "deepseek/deepseek-v4.1-flash-1017", provider: "deepseek" }, swapPolicy: "fail" }).catch((e) => e);
    expect(isProviderRetryableError(error)).toBe(true);
    expect(String(error.message)).toContain("deepseek-v4.1-flash-1017");
  });

  it("does not throw under the fail policy when nothing was swapped", async () => {
    const result = await run({ body: { model: REQUESTED }, swapPolicy: "fail" });
    expect(result.modelSwap).toBeUndefined();
  });

  it("does not false-positive when the response omits model", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run({ body: {}, swapPolicy: "fail" });
    expect(result.servedModel).toBeUndefined();
    expect(result.modelSwap).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not compare ids for non-OpenRouter servers that echo dated model names", async () => {
    const result = await run({ baseUrl: "https://api.openai.com/v1", body: { model: "gpt-4o-2024-08-06" }, swapPolicy: "fail" });
    expect(result.servedModel).toBe("gpt-4o-2024-08-06");
    expect(result.modelSwap).toBeUndefined();
  });
});
