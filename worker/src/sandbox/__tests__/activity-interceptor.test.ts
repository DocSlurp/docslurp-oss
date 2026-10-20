import { MockActivityEnvironment } from "@temporalio/testing";
import { describe, expect, it, vi } from "vitest";

import { createSandboxActivityInterceptor } from "../activity-interceptor.js";
import { sandboxScopeStorage } from "../session-context.js";
import type { SandboxSession } from "../types.js";

function fakeSession(close: () => Promise<void>): SandboxSession {
  return {
    providerId: "fake",
    isolation: { filesystem: false, network: "none", processes: false, location: "local" },
    close,
  };
}

async function runActivity(
  open: (activityId: string) => Promise<SandboxSession>,
  body: () => Promise<unknown>,
) {
  const environment = new MockActivityEnvironment({ activityId: "activity-42" });
  const interceptor = createSandboxActivityInterceptor(open)(environment.context).inbound!;
  // Capture the outcome inside the activity so the Temporal test runtime does not log a failed activity.
  const outcome = await environment.run(async (): Promise<{ value: unknown } | { error: unknown }> => {
    try {
      return { value: await interceptor.execute!({ args: [], headers: {} }, body as never) };
    } catch (error) {
      return { error };
    }
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

describe("sandbox activity interceptor", () => {
  it("closes the session exactly once when the activity throws", async () => {
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => fakeSession(close));
    await expect(
      runActivity(open, async () => {
        await sandboxScopeStorage.getStore()!.get();
        throw new Error("parser exploded");
      }),
    ).rejects.toThrow("parser exploded");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("opens the session with the activity id and closes it after a normal return", async () => {
    const close = vi.fn(async () => {});
    const open = vi.fn(async (_id: string) => fakeSession(close));
    const result = await runActivity(open, async () => {
      await sandboxScopeStorage.getStore()!.get();
      return "done";
    });
    expect(result).toBe("done");
    expect(open).toHaveBeenCalledWith("activity-42");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("never opens a session for an activity that runs no command", async () => {
    const open = vi.fn(async () => fakeSession(async () => {}));
    await runActivity(open, async () => "idle");
    expect(open).not.toHaveBeenCalled();
  });
});
