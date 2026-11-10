import { SandboxRunError } from "../../types.js";

/**
 * The parser VMs one worker process may run at once, across all its activities' sessions (VM pool follow-up). Each VM
 * takes a token before Modal creates it and returns it when it is terminated. When none is free, a waiting VM first
 * asks the sessions to reap an idle VM (another activity's pool may hold one it is not using), then waits for a release.
 * The fleet's worst case is workers x this limit, whatever each activity's own cap.
 */
export class VmBudget {
  private used = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly reapers = new Set<VmBudgetMember>();

  constructor(readonly limit: number) {}

  get inUse(): number {
    return this.used;
  }

  /** A session's hooks: whether it holds an idle VM, and "terminate one idle VM now" (returns whether it began to). */
  register(member: VmBudgetMember): () => void {
    this.reapers.add(member);
    return () => this.reapers.delete(member);
  }

  /** Whether `member` could get a VM token now or soon: one is free, or another session holds an idle VM to give up. */
  available(member?: VmBudgetMember): boolean {
    return this.used < this.limit || [...this.reapers].some((other) => other !== member && other.hasIdle());
  }

  /**
   * Take a token, waiting while every one is held. `abandoned()` true (the session closed) ends the wait with a throw, and
   * an abort of `signal` ends it with SandboxRunError("aborted") (recheck T #2).
   */
  async acquire(abandoned: () => boolean, signal?: AbortSignal, self?: VmBudgetMember): Promise<void> {
    const check = () => {
      if (signal?.aborted) throw new SandboxRunError("modal sandbox command aborted");
      if (abandoned()) throw new Error("parser VM session closed while waiting for a VM");
    };
    while (this.used >= this.limit) {
      check();
      // Never the waiting session's own idle VM: that one is handed to the waiting command instead (real-Modal P2).
      for (const member of this.reapers) if (member !== self && member.reapIdle()) break;
      if (this.used < this.limit) continue;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          const index = this.waiters.indexOf(done);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve();
        };
        // Re-check periodically: a session that closes while this waits releases nothing to wake it.
        const timer = setTimeout(done, 1_000);
        timer.unref();
        signal?.addEventListener("abort", done, { once: true });
        this.waiters.push(done);
      });
    }
    check();
    this.used++;
  }

  /** Let every waiter re-check now (a session's own VM became idle and may be handed over). */
  wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  release(): void {
    this.used = Math.max(0, this.used - 1);
    this.waiters[0]?.();
  }
}

export interface VmBudgetMember {
  hasIdle(): boolean;
  reapIdle(): boolean;
}
