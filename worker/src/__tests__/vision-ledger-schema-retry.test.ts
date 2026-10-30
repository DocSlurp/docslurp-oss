import { describe, expect, it, vi } from "vitest";

import { assertVisionLedgerSchemaWithRetry, VisionLedgerSchemaError } from "../db/vision-attempt-store.js";
import { classifyWorkerFailure } from "../temporal/worker-supervisor.js";

/** temporal/worker.ts: only a ledger schema mismatch is fatal at startup; a connection failure is retried. */
describe("vision ledger startup schema check", () => {
  const options = () => ({ sleep: vi.fn(async (_ms: number) => undefined), log: vi.fn() });

  it("retries a connection failure and starts once the database answers", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    const check = vi.fn().mockRejectedValueOnce(refused).mockRejectedValueOnce(refused).mockResolvedValue(undefined);
    const opts = options();
    await expect(assertVisionLedgerSchemaWithRetry(check, opts)).resolves.toBeUndefined();
    expect(check).toHaveBeenCalledTimes(3);
    expect(opts.sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
  });

  it("gives up after its attempts with the connection error itself, which the worker classifies as retryable", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    const check = vi.fn().mockRejectedValue(refused);
    const error = await assertVisionLedgerSchemaWithRetry(check, { ...options(), attempts: 3 }).catch((e: unknown) => e);
    expect(error).toBe(refused);
    expect(check).toHaveBeenCalledTimes(3);
    expect(classifyWorkerFailure(error).fatal).toBe(false);
  });

  it("does not retry a schema mismatch", async () => {
    const mismatch = new VisionLedgerSchemaError("vision attempt ledger is from an earlier draft of migration 0101; database reset required");
    const check = vi.fn().mockRejectedValue(mismatch);
    const opts = options();
    await expect(assertVisionLedgerSchemaWithRetry(check, opts)).rejects.toBe(mismatch);
    expect(check).toHaveBeenCalledTimes(1);
    expect(opts.sleep).not.toHaveBeenCalled();
  });
});
