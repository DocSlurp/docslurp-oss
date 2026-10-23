import { Hono } from "hono";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_VOICE_MAX_BYTES, CHAT_VOICE_MODEL } from "@docslurp/shared/chat-voice";

const mocks = vi.hoisted(() => ({ spend: vi.fn(), record: vi.fn(), workspace: vi.fn(), sql: vi.fn((..._args: unknown[]) => Promise.resolve([])) }));
vi.mock("../services/billing/spend-guard.js", () => ({ assertCanSpend: mocks.spend }));
vi.mock("../db.js", () => ({ sql: mocks.sql }));
vi.mock("../lib/ai-usage.js", () => ({ recordUsageEvent: mocks.record }));
vi.mock("../lib/ai.js", () => ({ resolveOpenRouterApiKey: () => process.env.OPENROUTER_API_KEY }));
vi.mock("../services/workspaces.js", () => ({ getWorkspace: mocks.workspace }));
const { WorkspaceChatVoice } = await import("../lib/chat-voice.js");
const { chatVoiceRoutes } = await import("../routes/chat-voice.js");

const usage = { seconds: 12.5, input_tokens: 0, output_tokens: 0, cost: 0.0003472222 };
const providerFetch = vi.fn();
const context = { userId: "user", scope: { workspaceId: "ws", orgId: "org" } };
/** 16 kHz mono 16-bit PCM WAV with `samples` of silence: the only format the hosted model accepts. */
function wav(samples = 1600): Uint8Array {
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + samples * 2, 4); out.write("WAVE", 8);
  out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16_000, 24); out.writeUInt32LE(32_000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(out);
}
const wavBytes = wav();
const audio = () => new Blob([wavBytes], { type: "audio/wav" });

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubGlobal("fetch", providerFetch);
  providerFetch.mockReset().mockResolvedValue(Response.json({ text: " My question? ", usage }, { headers: { "x-generation-id": "gen-1" } }));
  mocks.spend.mockReset().mockResolvedValue(undefined);
  mocks.record.mockReset().mockResolvedValue({});
  mocks.workspace.mockReset().mockResolvedValue({ id: "ws", orgId: "org" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Mastra workspace speech input", () => {
  it("uses OpenRouter's transcription contract and persists duration-only spend with workspace scope", async () => {
    const voice = new WorkspaceChatVoice(context, "standard");
    expect(await voice.listen(audio())).toBe("My question?");
    const [url, options] = providerFetch.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(JSON.parse(options.body)).toEqual({
      model: CHAT_VOICE_MODEL,
      input_audio: { data: Buffer.from(wavBytes).toString("base64"), format: "wav" },
      response_format: "json",
    });
    expect(mocks.record).toHaveBeenCalledWith({ ...context, usage: expect.objectContaining({
      provider: "openrouter", model: "microsoft/mai-transcribe-2", metric: "chat.transcription",
      inputTokens: 0, outputTokens: 0, amount: 12.5, unit: "second", costCents: usage.cost * 100,
      metadata: expect.objectContaining({ generationId: "gen-1", costSource: "provider" }),
    }) });
  });

  // The hosted model answers webm/m4a with a provider 400 (a paid round-trip that surfaced as a 502).
  it.each([
    ["webm", new Blob([Buffer.from("1a45dfa3", "hex")], { type: "audio/webm;codecs=opus" })],
    ["m4a", new Blob([Buffer.from("0000001c66747970", "hex")], { type: "audio/mp4" })],
    ["ogg", new Blob([Buffer.from("OggS")], { type: "audio/ogg" })],
    ["webm labelled as wav", new Blob([Buffer.from("1a45dfa3", "hex")], { type: "audio/wav" })],
    ["wav bytes without a wav type", new Blob([wavBytes], { type: "application/octet-stream" })],
  ])("rejects %s recordings with 415 before any privacy, spend or provider work", async (_label, recording) => {
    await expect(new WorkspaceChatVoice(context, "standard").listen(recording)).rejects.toMatchObject({ status: 415 });
    expect(mocks.spend).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each(["audio/wav", "audio/x-wav", "audio/wave", "audio/wav;codecs=1"])("accepts %s recordings", async (type) => {
    await new WorkspaceChatVoice(context, "standard").listen(new Blob([wavBytes], { type }));
    expect(JSON.parse(providerFetch.mock.calls[0][1].body).input_audio.format).toBe("wav");
  });

  it("preserves actual token counts and includes separate BYOK charges", async () => {
    providerFetch.mockResolvedValue(Response.json({ text: "Hello", usage: { ...usage, input_tokens: 23, output_tokens: 4, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.001 } } }));
    await new WorkspaceChatVoice(context, "standard").listen(audio());
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ usage: expect.objectContaining({ inputTokens: 23, outputTokens: 4, costCents: 0.1 }) }));
  });

  it("does not fabricate token counts when only duration is reported", async () => {
    providerFetch.mockResolvedValue(Response.json({ text: "Hello", usage: { seconds: 10, cost: 0.001 } }));
    await new WorkspaceChatVoice(context, "standard").listen(audio());
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ usage: expect.objectContaining({ inputTokens: undefined, outputTokens: undefined, metadata: expect.objectContaining({ tokenUsageReported: false }) }) }));
  });

  it("records billed silence before returning an empty transcript", async () => {
    providerFetch.mockResolvedValue(Response.json({ text: " ", usage }));
    expect(await new WorkspaceChatVoice(context, "standard").listen(audio())).toBe("");
    expect(mocks.record).toHaveBeenCalledOnce();
  });

  it("rejects invalid, empty, oversized and unsupported audio before spending", async () => {
    const voice = new WorkspaceChatVoice(context, "standard");
    for (const [file, status] of [[null, 400], [new Blob([]), 400], [new Blob(["x"], { type: "text/plain" }), 415], [new Blob([new Uint8Array(CHAT_VOICE_MAX_BYTES + 1)], { type: "audio/wav" }), 413]] as const) {
      await expect(voice.listen(file)).rejects.toMatchObject({ status });
    }
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("handles missing configuration, upstream failures and missing usage without leaking upstream details", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const voice = new WorkspaceChatVoice(context, "standard");
    expect(await voice.getListener()).toEqual({ enabled: false });
    await expect(voice.listen(audio())).rejects.toMatchObject({ status: 503 });
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    providerFetch.mockResolvedValue(new Response("private upstream detail", { status: 429 }));
    await expect(voice.listen(audio())).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining("private"), cause: expect.objectContaining({ message: expect.stringContaining("private upstream detail") }) });
    providerFetch.mockResolvedValue(Response.json({ text: "Hello" }));
    await expect(voice.listen(audio())).rejects.toMatchObject({ status: 502 });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("checks the workspace spend limit before submitting any audio", async () => {
    mocks.spend.mockRejectedValue(new Error("Budget exhausted"));
    await expect(new WorkspaceChatVoice(context, "standard").listen(audio())).rejects.toThrow("Budget exhausted");
    expect(mocks.spend).toHaveBeenCalledWith("org", "ws");
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("does not return a transcript if usage persistence fails", async () => {
    mocks.record.mockRejectedValue(new Error("DB unavailable"));
    await expect(new WorkspaceChatVoice(context, "standard").listen(audio())).rejects.toThrow("DB unavailable");
  });
});

describe("workspace transcription route", () => {
  function app() {
    const server = new Hono();
    server.use("*", async (c, next) => { c.set("sessionUser", { id: "user", email: "", name: "" }); await next(); });
    return server.route("/workspaces", chatVoiceRoutes);
  }
  function upload() { const form = new FormData(); form.set("audio", audio(), "recording.wav"); return form; }

  it("answers non-WAV uploads with an actionable 415 and no provider call", async () => {
    const form = new FormData();
    form.set("audio", new Blob([Buffer.from("1a45dfa3", "hex")], { type: "audio/webm" }), "recording.webm");
    const response = await app().request("/workspaces/ws/chat/transcribe", { method: "POST", body: form });
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: { code: "unsupported_type", message: "This file type isn’t supported." } });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("checks workspace access before calling the provider", async () => {
    mocks.workspace.mockResolvedValue(null);
    const response = await app().request("/workspaces/other/chat/transcribe", { method: "POST", body: upload() });
    expect(response.status).toBe(404);
    expect(mocks.workspace).toHaveBeenCalledWith("other", "user");
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("returns a reviewable transcript and rejects malformed requests", async () => {
    const server = app();
    const response = await server.request("/workspaces/ws/chat/transcribe", { method: "POST", body: upload() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "My question?", model: CHAT_VOICE_MODEL });
    const bad = await server.request("/workspaces/ws/chat/transcribe", { method: "POST", body: "not multipart" });
    expect(bad.status).toBe(400);
  });

  it("refuses hosted transcription for local-only workspaces without auditing", async () => {
    mocks.workspace.mockResolvedValue({ id: "ws", orgId: "org", pipeline: { privacyMode: "local-only" } });
    mocks.sql.mockClear();
    const response = await app().request("/workspaces/ws/chat/transcribe", { method: "POST", body: upload() });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "forbidden", message: "You don’t have access to this action. Ask your workspace administrator for help." } });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("audits blocked transcription for strict-privacy workspaces", async () => {
    mocks.workspace.mockResolvedValue({ id: "ws", orgId: "org", pipeline: { privacyMode: "strict-privacy" } });
    mocks.sql.mockClear();
    const response = await app().request("/workspaces/ws/chat/transcribe", { method: "POST", body: upload() });
    expect(response.status).toBe(403);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(mocks.sql.mock.calls.some((call) => Array.isArray(call[0]) && String((call[0] as string[]).join("")).includes("insert into privacy_audit_log"))).toBe(true);
    expect(mocks.sql).toHaveBeenCalledWith([expect.objectContaining({
      workspace_id: "ws", endpoint: "blocked:api.chat.transcription", privacy_mode: "strict-privacy",
    })], "document_id", "run_id", "workspace_id", "model_id", "endpoint", "privacy_mode");
  });

  it("bounds uploads before parsing multipart data", async () => {
    const response = await app().request("/workspaces/ws/chat/transcribe", { method: "POST", headers: { "content-length": String(CHAT_VOICE_MAX_BYTES + 20_000) }, body: "x" });
    expect(response.status).toBe(413);
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
