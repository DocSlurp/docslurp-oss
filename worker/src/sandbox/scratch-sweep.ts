import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Per-command sandbox scratch (`<root>/run-XXXXXX`) is removed by whoever created it once the
 * command is gone: parser-sandbox.sh's EXIT trap, or the landlock provider after verified teardown.
 * A launcher SIGKILLed before its trap ran, a crashed worker, or a poisoned command leaves it
 * behind. This sweep removes those.
 *
 * Each instance has a sibling `run-XXXXXX.owner` holding the host pid whose exit means the sandbox
 * is gone. It lives outside the instance, where the parser cannot write.
 */

export interface SweepOptions {
  now?: number;
  /** An instance whose owner has exited is removed once it is at least this old (creation races). */
  ownerGoneAfterMs?: number;
  /** An instance without a readable owner is removed once it is this old (longer than any command runs). */
  unownedAfterMs?: number;
  isAlive?: (pid: number) => boolean;
}

const DEFAULT_OWNER_GONE_AFTER_MS = 60_000;
const DEFAULT_UNOWNED_AFTER_MS = 3 * 60 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

/** Remove stale `run-*` instance directories under `root`. Returns the removed paths. */
export function sweepStaleSandboxScratch(root: string, options: SweepOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const ownerGoneAfterMs = options.ownerGoneAfterMs ?? DEFAULT_OWNER_GONE_AFTER_MS;
  const unownedAfterMs = options.unownedAfterMs ?? DEFAULT_UNOWNED_AFTER_MS;
  const isAlive = options.isAlive ?? pidAlive;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    if (!/^run-[A-Za-z0-9]+$/.test(name)) continue;
    const dir = path.join(root, name);
    let ageMs: number;
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory()) continue;
      ageMs = now - stat.mtimeMs;
    } catch {
      continue;
    }
    const ownerFile = `${dir}.owner`;
    const owner = readOwner(ownerFile);
    const stale = owner === null ? ageMs >= unownedAfterMs : ageMs >= ownerGoneAfterMs && !isAlive(owner);
    if (!stale) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ownerFile, { force: true });
      removed.push(dir);
    } catch (error) {
      console.warn(`[parser-sandbox] status=sweep-failed dir=${dir} error=${(error as Error).message}`);
    }
  }
  if (removed.length > 0) console.warn(`[parser-sandbox] status=swept-stale-scratch root=${root} count=${removed.length}`);
  return removed;
}

const sweepers = new Map<string, NodeJS.Timeout>();

/** Sweep `root` now and then periodically for the life of the process (once per root). */
export function startSandboxScratchSweeper(root: string, intervalMs = DEFAULT_SWEEP_INTERVAL_MS): void {
  const key = path.resolve(root);
  if (sweepers.has(key)) return;
  sweepStaleSandboxScratch(key);
  const timer = setInterval(() => sweepStaleSandboxScratch(key), intervalMs);
  timer.unref();
  sweepers.set(key, timer);
}
