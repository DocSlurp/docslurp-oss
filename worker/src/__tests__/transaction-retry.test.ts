import { describe, expect, it } from "vitest";

import { isRetryableTransactionError, retryTransaction } from "../db/transaction-retry.js";

const pgError = (code: string) => Object.assign(new Error(code), { code });

describe("retryTransaction", () => {
  const quiet = { sleep: async () => undefined, log: () => undefined, random: () => 0 };

  it("retries deadlock and serialization victims, then returns the result", async () => {
    const failures = [pgError("40P01"), pgError("40001")];
    const attempts: number[] = [];
    const result = await retryTransaction("t", async (attempt) => {
      attempts.push(attempt);
      const failure = failures.shift();
      if (failure) throw failure;
      return "ok";
    }, quiet);
    expect(result).toBe("ok");
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    await expect(retryTransaction("t", async () => {
      calls++;
      throw pgError("23505");
    }, quiet)).rejects.toMatchObject({ code: "23505" });
    expect(calls).toBe(1);
  });

  it("gives up after the attempt budget with the last error", async () => {
    let calls = 0;
    await expect(retryTransaction("t", async () => {
      calls++;
      throw pgError("40P01");
    }, { ...quiet, attempts: 3 })).rejects.toMatchObject({ code: "40P01" });
    expect(calls).toBe(3);
  });

  it("backs off exponentially with jitter", async () => {
    const delays: number[] = [];
    let calls = 0;
    await retryTransaction("t", async () => {
      if (++calls < 4) throw pgError("40P01");
      return null;
    }, { sleep: async (ms) => { delays.push(ms); }, log: () => undefined, random: () => 0.5, baseDelayMs: 10 });
    expect(delays).toEqual([15, 30, 60]);
  });

  it("recognises only Postgres retryable codes", () => {
    expect(isRetryableTransactionError(pgError("40P01"))).toBe(true);
    expect(isRetryableTransactionError(pgError("40001"))).toBe(true);
    expect(isRetryableTransactionError(pgError("57014"))).toBe(false);
    expect(isRetryableTransactionError(new Error("deadlock detected"))).toBe(false);
    expect(isRetryableTransactionError(null)).toBe(false);
  });
});
