import { afterEach, describe, expect, it, vi } from "vitest";
import { sendAuthEmailCode } from "../lib/auth-email.js";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("authentication email delivery", () => {
  it("rejects delivery without a real configured sender", async () => {
    vi.stubEnv("RESEND_API_KEY", ""); vi.stubEnv("EMAIL_FROM", "");
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    await expect(sendAuthEmailCode({ email: "user@example.com", otp: "123456" })).rejects.toThrow("disabled");
    expect(transport).not.toHaveBeenCalled();
  });
  it("sends the code privately through the configured provider", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key"); vi.stubEnv("EMAIL_FROM", "auth@example.com");
    const transport = vi.fn(async () => new Response('{}', { status: 200 })); vi.stubGlobal("fetch", transport);
    await sendAuthEmailCode({ email: "user@example.com", otp: "123456" });
    expect(transport).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({ signal: expect.any(AbortSignal), body: expect.stringContaining('123456') }));
  });
  it("fails closed on rejected delivery without exposing provider response secrets", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key"); vi.stubEnv("EMAIL_FROM", "auth@example.com");
    vi.stubGlobal("fetch", vi.fn(async () => new Response('secret provider payload', { status: 503 })));
    await expect(sendAuthEmailCode({ email: "user@example.com", otp: "123456" })).rejects.toThrow("Unable to send verification email");
  });
});
