import { describe, expect, it } from "vitest";
import { createOpenRouterRoutingFetch, OUTPUT_PRICE_CEILING_USD_PER_MTOK } from "../openrouter-routing.js";

/** Council round 4 (R4-4): the output-price ceiling is the default; only audio transcription is exempt. */
async function sentBody(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {};
  const upstream = async (_input: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response("{}", { status: 200 });
  };
  await createOpenRouterRoutingFetch(upstream as unknown as typeof fetch)(`https://openrouter.ai${path}`, { method: "POST", body: JSON.stringify(body) });
  return sent;
}

describe("OpenRouter output-price ceiling", () => {
  it("applies to generation, embeddings and any other endpoint, including ones added later", async () => {
    for (const path of ["/api/v1/chat/completions", "/api/v1/responses", "/api/v1/embeddings", "/api/v1/rerank", "/api/v1/images/generations"]) {
      const body = await sentBody(path, { model: "acme/model", input: "x" });
      expect({ path, ceiling: (body.provider as { max_price?: { completion?: number } } | undefined)?.max_price?.completion })
        .toEqual({ path, ceiling: OUTPUT_PRICE_CEILING_USD_PER_MTOK });
    }
  });

  it("is left off audio transcription only (billed per audio input, no output tokens)", async () => {
    const body = await sentBody("/api/v1/audio/transcriptions", { model: "acme/transcribe", input_audio: { data: "", format: "wav" } });
    expect(body).not.toHaveProperty("provider");
  });
});
