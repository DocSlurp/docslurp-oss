import { afterEach, describe, expect, it, vi } from "vitest";

import { recordRemoteUsage } from "../tools/runner.js";

afterEach(() => vi.restoreAllMocks());

describe("recordRemoteUsage", () => {
  it("logs remote provider cost it cannot put on a usage ledger instead of dropping it silently", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    recordRemoteUsage({ provider: "modal", model: "modal-sandbox", metric: "sandbox_compute", amount: 1.5, unit: "second", costCents: 0.42, metadata: {} });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toMatch(/^\[usage-unrecorded\] provider=modal model=modal-sandbox metric=sandbox_compute .*costCents=0.42/);
  });
});
