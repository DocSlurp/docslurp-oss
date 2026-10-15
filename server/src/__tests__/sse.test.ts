import { describe, expect, it, vi } from "vitest";

import { waitForSseAbort } from "../lib/sse.js";

describe("waitForSseAbort", () => {
  it("keeps the SSE callback alive until the stream aborts", async () => {
    vi.useFakeTimers();

    let abortListener: (() => void | Promise<void>) | null = null;
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockImplementation(
      async (ms: number) =>
        await new Promise((resolve) => {
          setTimeout(resolve, ms);
        })
    );

    const waitPromise = waitForSseAbort(
      {
        aborted: false,
        onAbort: (listener) => {
          abortListener = listener;
        },
        sleep
      },
      1000
    );

    await vi.advanceTimersByTimeAsync(2500);
    expect(sleep).toHaveBeenCalledTimes(3);

    expect(abortListener).not.toBeNull();
    await abortListener!();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(waitPromise).resolves.toBeUndefined();

    vi.useRealTimers();
  });

  it("returns immediately for an already aborted stream", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>();

    await waitForSseAbort({
      aborted: true,
      onAbort: () => undefined,
      sleep
    });

    expect(sleep).not.toHaveBeenCalled();
  });
});
