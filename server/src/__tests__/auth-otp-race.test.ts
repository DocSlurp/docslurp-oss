import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailOTP } from "better-auth/plugins";

// Deterministic reproduction of restoration overtaking a concurrently issued OTP.
// No external mail, database, or credentials are used.
describe("OTP generation ordering", () => {
  it("keeps a resend valid when an older wrong-code verification restores its record", async () => {
    const database = { user: [], session: [], account: [], verification: [] };
    const auth = betterAuth({
      baseURL: "http://localhost:4321",
      secret: "test-secret-for-otp-concurrency-".padEnd(48, "x"),
      database: memoryAdapter(database),
      plugins: [emailOTP({ sendVerificationOTP: async () => {}, storeOTP: "plain", allowedAttempts: 5 })],
    });
    const context = await auth.$context;
    const adapter = context.internalAdapter;
    const identifier = "email-verification-otp-race@example.com";
    await adapter.createVerificationValue({ identifier, value: "111111:0", expiresAt: new Date(Date.now() + 60_000) });
    const consumed = await adapter.consumeVerificationValue(identifier);
    expect(consumed).not.toBeNull();
    await adapter.createVerificationValue({ identifier, value: "222222:0", expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(2_000) });
    // This is the native atomicVerifyOTP wrong-code restoration operation.
    await adapter.createVerificationValue({ identifier, value: "111111:1", expiresAt: consumed!.expiresAt });
    expect((await adapter.consumeVerificationValue(identifier))?.value).toBe("222222:0");
  });
});
