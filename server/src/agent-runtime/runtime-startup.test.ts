import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./native-host.js", () => ({ createNativeChatHost: state.create }));
vi.mock("../config.js", () => ({ env: { databaseUrl: "postgres://local-test@127.0.0.1:1/test" } }));
vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("./operation-policy.js", () => ({ createNativeOperationPolicy: vi.fn() }));
vi.mock("./project-chat-executor.js", () => ({ createProjectChatExecutor: vi.fn() }));
let runtime: typeof import("./runtime.js") | undefined;
beforeEach(() => {
  vi.resetModules(); state.create.mockReset();
  vi.stubEnv("MASTRA_REDIS_URL", "redis://127.0.0.1:1");
});
afterEach(async () => { await runtime?.closeNativeChatRuntime().catch(() => {}); runtime = undefined; vi.unstubAllEnvs(); });

it("shares one startup attempt but permits a fresh attempt after initialization fails", async () => {
  state.create.mockRejectedValueOnce(new Error("temporary backend outage"));
  state.create.mockResolvedValueOnce({ close: async () => {} });
  runtime = await import("./runtime.js");
  const first = runtime.nativeChatRuntime();
  expect(runtime.nativeChatRuntime()).toBe(first);
  await expect(first).rejects.toThrow("temporary backend outage");
  await expect(runtime.nativeChatRuntime()).resolves.toHaveProperty("close");
  expect(state.create).toHaveBeenCalledTimes(2);
});

it("does not start a producer using only the rate-limit endpoint", async () => {
  vi.stubEnv("MASTRA_REDIS_URL", undefined);
  vi.stubEnv("API_RATE_LIMIT_REDIS_URL", "redis://127.0.0.1:1");
  runtime = await import("./runtime.js");
  await expect(runtime.nativeChatRuntime()).rejects.toThrow("native_chat_shared_transport_required");
  expect(state.create).not.toHaveBeenCalled();
});
