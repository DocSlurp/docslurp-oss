import { describe, expect, it } from "vitest";
import { isLockConflict, withLockRetry } from "../lib/lock-retry.js";

describe("lock retry", () => {
  it("retries lock conflicts, deadlocks and a full shared lock table (53200), then answers the caller's busy error", async () => {
    for (const code of ["55P03", "40P01", "53200"]) expect(isLockConflict({ code })).toBe(true);
    expect(isLockConflict({ code: "23505" })).toBe(false);
    let attempts = 0;
    const busy = new Error("busy");
    await expect(withLockRetry(async () => { attempts++; throw Object.assign(new Error("out of shared memory"), { code: "53200" }); }, () => busy)).rejects.toBe(busy);
    expect(attempts).toBe(6);
    // A conflict that clears is retried to success; any other error is not retried.
    attempts = 0;
    expect(await withLockRetry(async () => { if (++attempts < 3) throw { code: "53200" }; return "done"; }, () => busy)).toBe("done");
    attempts = 0;
    await expect(withLockRetry(async () => { attempts++; throw { code: "23505" }; }, () => busy)).rejects.toEqual({ code: "23505" });
    expect(attempts).toBe(1);
  });
});
