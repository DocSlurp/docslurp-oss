/**
 * The parser VMs one worker process may run at once, across all its activities' sessions (VM pool follow-up). Each VM
 * takes a token before Modal creates it and returns it when it is terminated. When none is free, a waiting VM first
 * asks the sessions to reap an idle VM (another activity's pool may hold one it is not using), then waits for a release.
 * The fleet's worst case is workers x this limit, whatever each activity's own cap.
 */
export class VmBudget {
  private used = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly reapers = new Set<() => boolean>();

  constructor(readonly limit: number) {}

  get inUse(): number {
    return this.used;
  }

  /** A session's "terminate one idle VM now" hook; returns whether it freed one. */
  register(reapIdle: () => boolean): () => void {
    this.reapers.add(reapIdle);
    return () => this.reapers.delete(reapIdle);
  }

  /** Take a token, waiting while every one is held. `abandoned()` true (the session closed) ends the wait with a throw. */
  async acquire(abandoned: () => boolean): Promise<void> {
    while (this.used >= this.limit) {
      if (abandoned()) throw new Error("parser VM session closed while waiting for a VM");
      for (const reap of this.reapers) if (reap()) break;
      if (this.used < this.limit) continue; // a reaped VM returned its token synchronously
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); resolve(); };
        // Re-check periodically: a session that closes while this waits releases nothing to wake it.
        const timer = setTimeout(() => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve();
        }, 1_000);
        timer.unref();
        this.waiters.push(wake);
      });
    }
    if (abandoned()) throw new Error("parser VM session closed while waiting for a VM");
    this.used++;
  }

  release(): void {
    this.used = Math.max(0, this.used - 1);
    this.waiters.shift()?.();
  }
}
