import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { createMigratedDatabase, serveOnRandomPort } from "@docslurp/worker/testing";
import { emailOTP } from "better-auth/plugins";

// Deterministic reproduction of restoration overtaking a concurrently issued OTP.
// Run the production migration and real adapter; mail remains stubbed.
let pool: Pool;
let stop: () => Promise<void>;
beforeAll(async () => {
  const database = await createMigratedDatabase();
  const serving = await serveOnRandomPort(database, { maxConnections: 8 });
  pool = new Pool({ connectionString: `postgres://postgres@127.0.0.1:${serving.port}/postgres` });
  stop = async () => { await pool.end(); await serving.server.stop(); await database.close(); };
}, 120_000);
afterAll(async () => { await stop?.(); });
describe("OTP generation ordering", () => {
  it("keeps a resend valid when an older wrong-code verification restores its record", async () => {
    const auth = betterAuth({
      baseURL: "http://localhost:4321",
      secret: "test-secret-for-otp-concurrency-".padEnd(48, "x"),
      database: pool,
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
    // The fence survives successful use/deletion of B.
    await adapter.createVerificationValue({ identifier, value: "111111:2", expiresAt: consumed!.expiresAt });
    expect(await adapter.consumeVerificationValue(identifier)).toBeNull();
  });
});

// Pause the actual native verifier after it deletes A, rather than simulating
// the restoration in application code. The resend uses a second auth instance.
it("fences restoration through native endpoints after a concurrent resend", async () => {
  const emails: string[] = [];
  let issued = 100000;
  const options = {
    baseURL: "http://localhost:4321",
    secret: "test-secret-for-otp-concurrency-".padEnd(48, "x"),
    database: pool,
    rateLimit: { enabled: false },
    plugins: [emailOTP({ generateOTP: () => String(++issued), sendVerificationOTP: async ({ otp }) => { emails.push(otp); },
      storeOTP: "hashed", allowedAttempts: 5, expiresIn: 43_200 })],
  };
  const first = betterAuth(options);
  const second = betterAuth(options);
  const email = "endpoint-race@example.com";
  const context = await first.$context;
  await context.internalAdapter.createUser({ email, name: "Race", emailVerified: false }, { method: "email-otp" });
  await first.api.sendVerificationOTP({ body: { email, type: "email-verification" } });
  const old = emails[0]!;
  const consume = context.internalAdapter.consumeVerificationValue.bind(context.internalAdapter);
  let resume!: () => void;
  let signal!: () => void;
  const paused = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  context.internalAdapter.consumeVerificationValue = async identifier => {
    const result = await consume(identifier);
    signal();
    await gate;
    return result;
  };
  const wrong = first.api.verifyEmailOTP({ body: { email, otp: "wrong!" } }).catch(error => error);
  await paused;
  try {
    await second.api.sendVerificationOTP({ body: { email, type: "email-verification" } });
  } finally { resume(); }
  expect((await wrong).statusCode).toBe(400);
  context.internalAdapter.consumeVerificationValue = consume;
  const rows = await pool.query('SELECT value, "expiresAt" FROM verification WHERE identifier = $1', [`email-verification-otp-${email}`]);
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0].value).not.toContain(emails[1]);
  expect(new Date(rows.rows[0].expiresAt).getTime() - Date.now()).toBeGreaterThan(43_100_000);
  await expect(first.api.verifyEmailOTP({ body: { email, otp: old } })).rejects.toThrow();
  await expect(second.api.verifyEmailOTP({ body: { email, otp: emails[1]! } })).resolves.toBeDefined();
  await expect(first.api.verifyEmailOTP({ body: { email, otp: old } })).rejects.toThrow();
});
