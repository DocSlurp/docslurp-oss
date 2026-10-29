import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * Process containment and verified teardown for local parser commands.
 *
 * A command runs in its own process group (`detached`), and, where the host allows it, in its
 * own PID namespace: `unshare --pid --fork --kill-child` makes the command the namespace's init,
 * killed when unshare dies. When a namespace's init exits, the kernel SIGKILLs every process left
 * in it, and reaps them all before init itself is reaped. unshare waits for init, so unshare's
 * exit means the namespace is empty: no descendant of the command can survive it, whether it
 * re-parented, called setsid, or closed its stdio. That is the guarantee that lets a caller
 * release a slot and remove scratch once the command settles.
 *
 * Process-group containment alone does not give it: a descendant that calls setsid leaves the
 * group. Untrusted parser work refuses to run without a PID namespace (see policy.ts); only
 * trusted commands (vector writers) and the explicitly unisolated `none` mode run that way.
 */

export type Containment = "pid-namespace" | "process-group";

/**
 * unshare flags: own user, PID and mount namespace, the command as init (killed if unshare dies),
 * and a /proc showing only the namespace (bwrap needs it to match its pid; parsers no longer see
 * host processes).
 */
export const PID_NAMESPACE_FLAGS = ["--user", "--map-current-user", "--pid", "--mount-proc", "--fork", "--kill-child"] as const;

const UNSHARE_CANDIDATES = ["/usr/bin/unshare", "/bin/unshare"];
const PROBE_TIMEOUT_MS = 10_000;

interface ContainedState {
  containment: Containment;
  afterTeardown: Array<() => void>;
}

const containedChildren = new WeakMap<ChildProcess, ContainedState>();

export function unshareBinary(): string | null {
  return UNSHARE_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

let pidNamespaceProbe: { ok: boolean; detail: string } | undefined;

/** Whether this host can start commands in their own PID namespace (cached). */
export function probePidNamespace(): { ok: boolean; detail: string } {
  pidNamespaceProbe ??= (() => {
    if (process.platform !== "linux") return { ok: false, detail: `PID namespaces need Linux (platform ${process.platform})` };
    const unshare = unshareBinary();
    if (!unshare) return { ok: false, detail: "unshare (util-linux) is not installed" };
    const result = spawnSync(unshare, [...PID_NAMESPACE_FLAGS, "--", "/bin/sh", "-c", "exit 0"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      timeout: PROBE_TIMEOUT_MS,
    });
    if (result.status === 0) return { ok: true, detail: "pid namespace available" };
    const reason = result.stderr?.trim() || result.error?.message || `unshare exited with status ${result.status}`;
    return { ok: false, detail: `cannot create a PID namespace: ${reason}` };
  })();
  return pidNamespaceProbe;
}

/**
 * Spawn `binary args` contained: in a new process group, and in a new PID namespace when
 * `containment` is "pid-namespace". Never pass an AbortSignal to spawn: Node would SIGTERM only the
 * root and report the abort before anything exited. superviseChild handles abort and teardown.
 */
export function spawnContained(
  binary: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; containment: Containment },
): ChildProcess {
  let file = binary;
  let argv = args;
  if (options.containment === "pid-namespace") {
    const unshare = unshareBinary();
    if (!unshare) throw new Error("unshare (util-linux) is not installed; cannot start a command in its own PID namespace");
    file = unshare;
    argv = [...PID_NAMESPACE_FLAGS, "--", binary, ...args];
  }
  const child = spawn(file, argv, {
    env: options.env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  containedChildren.set(child, { containment: options.containment, afterTeardown: [] });
  return child;
}

export function containmentOf(child: ChildProcess): Containment | undefined {
  return containedChildren.get(child)?.containment;
}

/** Run `cleanup` once the command's teardown is verified; never while any of its processes may live. */
export function afterTeardown(child: ChildProcess, cleanup: () => void): void {
  const state = containedChildren.get(child);
  if (!state) throw new Error("afterTeardown needs a child started by spawnContained");
  state.afterTeardown.push(cleanup);
}

/** A command whose processes could not be confirmed gone. Its slot must stay out of service. */
export class CommandTeardownError extends Error {
  readonly poisoned = true;
  constructor(message: string) {
    super(message);
    this.name = "CommandTeardownError";
  }
}

export function isCommandTeardownError(error: unknown): error is CommandTeardownError {
  return error instanceof CommandTeardownError;
}

let unverifiedTeardowns = 0;

/** Commands this process could not confirm were torn down (each one poisoned its slot). */
export function unverifiedTeardownCount(): number {
  return unverifiedTeardowns;
}

export interface CommandExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Why the command was terminated (abort, timeout, budget), or null if it ended on its own. */
  reason: Error | null;
}

export interface SupervisedChild {
  /**
   * Resolves once the command ended, every process it started is gone and its stdio closed.
   * Rejects with a spawn error, or a CommandTeardownError when teardown could not be verified
   * within the bound (stdio is destroyed then, so it never hangs).
   */
  readonly done: Promise<CommandExit>;
  /** Stop the command: SIGTERM, then after the grace period (or at once if `immediate`) SIGKILL. */
  terminate(reason: Error, options?: { immediate?: boolean }): void;
}

export interface TeardownTimings {
  /** SIGTERM to SIGKILL. */
  graceMs: number;
  /** After the launcher's descendants are SIGKILLed, how long it gets to run its EXIT trap. */
  launcherGraceMs: number;
  /** After SIGKILL, how long the command gets to be confirmed gone before its slot is poisoned. */
  verifyMs: number;
}

export const DEFAULT_TEARDOWN_TIMINGS: TeardownTimings = { graceMs: 2_000, launcherGraceMs: 1_000, verifyMs: 5_000 };

function positive(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function teardownTimings(env: NodeJS.ProcessEnv = process.env): TeardownTimings {
  return {
    graceMs: positive(env.WORKER_COMMAND_ABORT_GRACE_MS) ?? DEFAULT_TEARDOWN_TIMINGS.graceMs,
    launcherGraceMs: positive(env.WORKER_COMMAND_LAUNCHER_GRACE_MS) ?? DEFAULT_TEARDOWN_TIMINGS.launcherGraceMs,
    verifyMs: positive(env.WORKER_COMMAND_TEARDOWN_VERIFY_MS) ?? DEFAULT_TEARDOWN_TIMINGS.verifyMs,
  };
}

function abortError(signal: AbortSignal): Error {
  const error = new Error("The operation was aborted", { cause: signal.reason });
  error.name = "AbortError";
  return error;
}

function signalPids(pids: Iterable<number>, signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    // EPERM: a member exists that we may not signal. Only ESRCH means the group is empty.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** pid -> ppid for every process this host lists, or null where ps is unavailable. */
async function processTable(): Promise<Map<number, number> | null> {
  return await new Promise((resolve) => {
    const ps = spawn("ps", ["-axo", "pid=,ppid="], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    ps.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    ps.on("error", () => resolve(null));
    ps.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const table = new Map<number, number>();
      for (const line of stdout.split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid!, ppid!);
      }
      resolve(table);
    });
  });
}

function descendantsOf(table: Map<number, number>, roots: number[]): number[] {
  const found = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of table) {
      if (!found.has(pid) && found.has(ppid)) {
        found.add(pid);
        changed = true;
      }
    }
  }
  for (const root of roots) found.delete(root);
  return [...found];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Direct children of `pid`: from /proc on Linux (no ps needed), else from a process table. */
function childrenOf(pid: number, table: Map<number, number> | null): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return table ? [...table].filter(([, ppid]) => ppid === pid).map(([child]) => child) : [];
  }
}

/**
 * Own a contained child's lifecycle: abort, explicit termination (timeouts, budgets, output caps)
 * and normal exit all end in the same verified teardown, and `done` settles only after it.
 *
 * Termination: SIGTERM the process group; after `graceMs`, SIGKILL everything below the launcher
 * first so a launcher such as parser-sandbox.sh can run its EXIT trap, then (after
 * `launcherGraceMs`) the launcher itself. In a PID namespace the launcher is the namespace init,
 * and killing it takes the whole namespace with it.
 *
 * Verification: the root has exited (for a PID namespace, unshare reaped the init, so the
 * namespace is empty) and the root's process group is empty. Anything left in the group after
 * the root exits is SIGKILLed. If that cannot be confirmed within `verifyMs`, stdio is destroyed,
 * the failure is logged loudly, and `done` rejects with CommandTeardownError.
 */
export function superviseChild(
  child: ChildProcess,
  options: { label: string; signal?: AbortSignal; timings?: TeardownTimings; context?: Record<string, string | number | undefined> },
): SupervisedChild {
  const state = containedChildren.get(child);
  if (!state) throw new Error("superviseChild needs a child started by spawnContained");
  const timings = options.timings ?? teardownTimings();
  const pid = child.pid;
  const namespaced = state.containment === "pid-namespace";

  let reason: Error | null = null;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let terminating = false;
  let settled = false;
  let stdioClosed = false;
  const timers = new Set<NodeJS.Timeout>();
  const onExitWaiters: Array<() => void> = [];

  let resolveDone!: (value: CommandExit) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<CommandExit>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const describe = () =>
    Object.entries({ label: options.label, pid, containment: state.containment, ...options.context })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");

  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  const cleanup = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    options.signal?.removeEventListener("abort", onAbort);
  };

  const runAfterTeardown = () => {
    for (const fn of state.afterTeardown.splice(0)) {
      try {
        fn();
      } catch (error) {
        console.error(`[worker-command] status=cleanup-failed ${describe()} error=${(error as Error).message}`);
      }
    }
  };

  const settle = () => {
    if (settled || !exit || !stdioClosed) return;
    settled = true;
    cleanup();
    runAfterTeardown();
    resolveDone({ ...exit, reason });
  };

  const fail = (error: Error, unverified: boolean) => {
    if (settled) return;
    settled = true;
    cleanup();
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (unverified) {
      unverifiedTeardowns += 1;
      // Alertable: a command's processes may still be running and its slot is out of service.
      console.error(
        `[worker-command] status=teardown-unverified metric=command_teardown_unverified ` +
          `count=${unverifiedTeardowns} ${describe()} detail=${JSON.stringify(error.message)}`,
      );
    } else {
      runAfterTeardown();
    }
    rejectDone(error);
  };

  const unverified = (detail: string) =>
    fail(new CommandTeardownError(`${options.label} teardown could not be verified: ${detail}`), true);

  /** After the root exits: SIGKILL stragglers in its group until it is empty, within the bound. */
  const verifyAfterExit = async () => {
    if (pid === undefined) return;
    const deadline = Date.now() + timings.verifyMs;
    while (signalGroup(pid, 0)) {
      if (settled) return;
      if (Date.now() >= deadline) return unverified(`process group ${pid} still has members after ${timings.verifyMs} ms`);
      signalGroup(pid, "SIGKILL");
      await sleep(25);
    }
    // Every process is gone. With a PID namespace no writer of the stdio pipes survives, so they
    // reach EOF once read. Without one, a setsid'd descendant can still hold them: bound the wait.
    if (!namespaced && !stdioClosed) {
      later(timings.verifyMs, () => {
        if (!stdioClosed) unverified("stdio is still held open after the process group emptied (a descendant left it)");
      });
    }
    settle();
  };

  const escalate = async () => {
    if (pid === undefined || exit || settled) return;
    const table = await processTable();
    if (exit || settled) return;
    // The launcher: the namespace init (unshare's child), or the root itself for a plain group.
    const launchers = namespaced ? childrenOf(pid, table) : [pid];
    const below = table ? descendantsOf(table, launchers) : [];
    if (below.length > 0) {
      signalPids(below, "SIGKILL");
      await Promise.race([new Promise<void>((resolve) => onExitWaiters.push(resolve)), sleep(timings.launcherGraceMs)]);
    }
    if (exit || settled) return;
    console.error(`[worker-command] status=abort-kill ${describe()} grace_ms=${timings.graceMs} descendants=${below.length}`);
    const deadline = Date.now() + timings.verifyMs;
    while (!exit && !settled) {
      if (Date.now() >= deadline) return unverified(`the command did not exit within ${timings.verifyMs} ms of SIGKILL`);
      if (namespaced) {
        // Killing the init tears down the namespace; unshare then exits. Never kill unshare first:
        // its exit would no longer imply that the namespace is empty.
        signalPids(childrenOf(pid, null), "SIGKILL");
      } else {
        signalGroup(pid, "SIGKILL");
      }
      await Promise.race([new Promise<void>((resolve) => onExitWaiters.push(resolve)), sleep(100)]);
    }
  };

  const terminate = (why: Error, terminateOptions?: { immediate?: boolean }) => {
    reason ??= why;
    if (terminating || settled || pid === undefined) return;
    terminating = true;
    if (exit) return; // already exited; verification is under way
    if (!terminateOptions?.immediate) {
      // A namespace init only receives signals it handles; the rest of the group gets TERM anyway.
      signalGroup(pid, "SIGTERM");
    }
    later(terminateOptions?.immediate ? 0 : timings.graceMs, () => void escalate());
  };

  function onAbort() {
    terminate(abortError(options.signal!));
  }

  child.once("exit", (code, signal) => {
    exit = { code, signal };
    for (const resolve of onExitWaiters.splice(0)) resolve();
    void verifyAfterExit();
  });
  child.once("close", () => {
    stdioClosed = true;
    settle();
  });
  child.on("error", (error) => {
    // A failed spawn leaves nothing to tear down. Any later error (a failed kill) changes nothing.
    if (pid === undefined) fail(error, false);
  });

  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  return { done, terminate };
}
