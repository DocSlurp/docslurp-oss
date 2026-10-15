import type { WorkspaceRunProgressSnapshot } from "@docslurp/shared";

type Stream = {
  readonly aborted: boolean;
  onAbort(callback: () => void): void;
  writeSSE(frame: { event: string; data: string }): Promise<void>;
};

/** Current-state convergence: notification bursts invalidate one snapshot;
 * they do not enqueue an unbounded history of expensive snapshot reads. */
export async function streamRunProgressSnapshots(args: {
  stream: Stream;
  snapshot: () => Promise<WorkspaceRunProgressSnapshot | null>;
  subscribe: (invalidate: () => void) => Promise<{ close(): Promise<void> }>;
}): Promise<void> {
  const { stream } = args;
  let wake: (() => void) | undefined;
  let dirty = true;
  let aborted = stream.aborted;
  stream.onAbort(() => { aborted = true; wake?.(); });
  const subscription = await args.subscribe(() => { dirty = true; wake?.(); });
  let refreshedAt = -Infinity;
  let heartbeatAt = Date.now();
  try {
    while (!aborted) {
      const now = Date.now();
      if ((dirty && now - refreshedAt >= 1_000) || now - refreshedAt >= 10_000) {
        dirty = false;
        const snapshot = await args.snapshot();
        if (aborted) break;
        if (!snapshot) {
          await stream.writeSSE({ event: "error", data: JSON.stringify({ code: "access_revoked", error: "Run access is no longer available" }) });
          break;
        }
        await stream.writeSSE({ event: "snapshot", data: JSON.stringify(snapshot) });
        refreshedAt = Date.now();
        const control = snapshot.run.controlState;
        const paused = control === "paused" || snapshot.progress?.lifecycleStatus === "paused";
        if (!paused && (["completed", "failed"].includes(snapshot.run.status) || ["cancelled", "dead-letter"].includes(control ?? ""))) break;
      }
      if (Date.now() - heartbeatAt >= 4_000) {
        await stream.writeSSE({ event: "heartbeat", data: "{}" });
        heartbeatAt = Date.now();
      }
      if (aborted) break;
      const delay = Math.max(1, Math.min(
        4_000 - (Date.now() - heartbeatAt),
        10_000 - (Date.now() - refreshedAt),
        dirty ? 1_000 - (Date.now() - refreshedAt) : Infinity,
      ));
      // Wake on an invalidation, timeout, or abort; release every timer when
      // woken so a disconnected client leaves no background work behind.
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, delay);
        function done() { clearTimeout(timer); wake = undefined; resolve(); }
        wake = done;
        if (aborted) done();
      });
    }
  } finally {
    wake?.();
    await subscription.close();
  }
}
