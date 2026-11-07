import { describe, expect, it, vi } from "vitest";
import { assertResourceCapacity, ResourceCapacityError, withResourceCapacityGuard } from "../lib/resource-capacity.js";
import { fetchWithProviderRetry } from "../lib/provider-retry.js";
import { isDocumentLevelFailure } from "../lib/document-failure.js";
import { CommandRunner } from "../tools/runner.js";

const pressure = () => { throw new ResourceCapacityError(); };

describe("resource admission at execution", () => {
  it("permits cached bookkeeping but refuses a later cache-bypassing request before spend admission", async () => {
    const send = vi.fn(async () => new Response("ok"));
    const admit = vi.fn(async () => {});
    await withResourceCapacityGuard(pressure, async () => {
      expect(await Promise.resolve("cached manifest")).toBe("cached manifest");
      await expect(fetchWithProviderRetry("https://provider.invalid", {}, {
        provider: "test", label: "cache bypass", maxRetries: 0, fetchImpl: send,
        gate: { admit, failed() {}, async unbilled() { return true; } },
      })).rejects.toBeInstanceOf(ResourceCapacityError);
    });
    expect(send).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it("refuses command execution before staging or reading an oversized/malicious source", async () => {
    const runner = new CommandRunner();
    await expect(withResourceCapacityGuard(pressure, () => runner.run({
      binary: "not-a-real-parser", args: ["/hostile/customer.pdf"], available: true,
    }))).rejects.toBeInstanceOf(ResourceCapacityError);
  });

  it("isolates simultaneous activity guards and leaves outer contexts unchanged", async () => {
    const check = vi.fn();
    const rejected = withResourceCapacityGuard(pressure, async () => {
      await Promise.resolve();
      expect(() => assertResourceCapacity()).toThrow(ResourceCapacityError);
    });
    const accepted = withResourceCapacityGuard(check, async () => {
      await Promise.resolve();
      assertResourceCapacity();
    });
    await Promise.all([rejected, accepted]);
    assertResourceCapacity();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("never treats allocation pressure as a bad document", () => {
    expect(isDocumentLevelFailure(new Error("command admission", { cause: new ResourceCapacityError() }))).toBe(false);
  });
});
