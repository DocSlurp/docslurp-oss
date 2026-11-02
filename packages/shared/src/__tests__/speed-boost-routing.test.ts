import { afterEach, expect, it, vi } from "vitest";
import { createOpenRouterRoutingFetch, isSpeedBoostEligible, speedBoostModel, setOpenRouterProviderPolicyResolver } from "../openrouter-routing.js";
afterEach(() => setOpenRouterProviderPolicyResolver(undefined));
it("maps only reviewed eligible identities on explicit opt-in", () => {
  for (const base of ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash", "openai/gpt-6-luna"]) {
    expect(isSpeedBoostEligible(base)).toBe(true);
    expect(speedBoostModel(base, false)).toBe(base);
    expect(speedBoostModel(base, true)).toBe(`${base}:nitro`);
    expect(speedBoostModel(`${base}:nitro`, true)).toBe(`${base}:nitro`);
  }
  for (const model of ["unknown/model", "openai/gpt-6-pro", "openai/gpt-6-ultra", "z-ai/glm-5.3-flash:nitro:nitro"]) {
    expect(isSpeedBoostEligible(model)).toBe(false);
    expect(speedBoostModel(model, true)).toBe(model);
  }
});
it("boosts generation but never embeddings and preserves negative provider constraints", async () => {
  setOpenRouterProviderPolicyResolver(() => ({ allowChinaProviders: false, speedBoost: true }));
  const send = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}));
  const wrapped = createOpenRouterRoutingFetch(send);
  await wrapped("https://openrouter.ai/api/v1/chat/completions", { body: JSON.stringify({ model: "z-ai/glm-5.3-flash", provider: { quantizations: ["fp16"], max_price: { prompt: 0.2, completion: 0.3 } } }) });
  const body = JSON.parse(send.mock.calls[0]![1]!.body as string);
  expect(body).toMatchObject({ model: "z-ai/glm-5.3-flash:nitro", provider: { sort: "throughput", quantizations: ["fp16"], max_price: { prompt: 0.2, completion: 0.3 } } });
  expect(body.provider.only.length).toBeGreaterThan(0);
  await wrapped("https://openrouter.ai/api/v1/embeddings", { body: JSON.stringify({ model: "openai/gpt-6-luna", input: "text" }) });
  expect(JSON.parse(send.mock.calls[1]![1]!.body as string).model).toBe("openai/gpt-6-luna");
  await expect(wrapped("https://openrouter.ai/api/v1/chat/completions", { body: JSON.stringify({ model: "z-ai/glm-5.3-flash", provider: { only: ["z-ai"] } }) })).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(2);
});

it("refuses direct Nitro for explicitly unboosted calls but preserves standalone policies", () => {
  expect(() => speedBoostModel("z-ai/glm-5.3-flash:nitro", false)).toThrow("speedBoost");
  expect(speedBoostModel("z-ai/glm-5.3-flash:nitro", undefined)).toBe("z-ai/glm-5.3-flash:nitro");
});
