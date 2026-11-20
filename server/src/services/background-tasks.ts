import { startWithRetry, type StartWithRetry } from "../lib/start-with-retry.js";

type Stop = () => void | Promise<void>;

/** One background task of the API process: a timer, a refresher, a pool to close or a LISTEN subscription. */
export interface BackgroundTask {
  name: string;
  /** Starts the task. May return the function that stops this start. */
  start: () => void | Stop;
  /** Stops the task, when `start` returns nothing. */
  stop?: Stop;
}

export interface BackgroundTasks {
  /**
   * Adds a task, or replaces the one already registered under its name. The embedding host registers its own tasks
   * here before the API starts; after start it throws, because a task added then would silently never run.
   */
  register(task: BackgroundTask): void;
  /** Starts every task in registration order. A task that throws stops startup: the caller retries it. */
  start(): void;
  /** Stops what `start` started, in the same order. A stop that fails is logged and the rest still stop. */
  stop(): Promise<void>;
  names(): string[];
}

/**
 * The API process's background tasks as one list: what `start` starts is exactly what `stop` stops, so a task can
 * no longer be started without a matching stop (or the reverse) by editing only one of two lists.
 */
export function createBackgroundTasks(
  builtIn: readonly BackgroundTask[],
  log: (line: string) => void = (line) => console.error(line),
): BackgroundTasks {
  const tasks: BackgroundTask[] = [];
  let running: Array<{ name: string; stop?: Stop }> = [];
  let started = false;
  const add = (task: BackgroundTask) => {
    const existing = tasks.findIndex((candidate) => candidate.name === task.name);
    if (existing >= 0) tasks[existing] = task;
    else tasks.push(task);
  };
  for (const task of builtIn) add(task);
  return {
    register(task) {
      if (started) throw new Error(`Background task "${task.name}" was registered after the API started; register it before startup`);
      add(task);
    },
    start() {
      started = true;
      for (const task of tasks) {
        const stop = task.start();
        running.push({ name: task.name, stop: typeof stop === "function" ? stop : task.stop });
      }
    },
    async stop() {
      const stopping = running;
      running = [];
      started = false;
      for (const task of stopping) {
        try {
          await task.stop?.();
        } catch (error) {
          log(`[${task.name}] stop failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    names: () => tasks.map((task) => task.name),
  };
}

/**
 * A LISTEN subscription as a background task: started with retry (lib/start-with-retry.ts) and never awaited, so a
 * database that is down at boot does not block startup; stopping cancels a pending retry, then unsubscribes.
 */
export function subscriptionTask(name: string, subscribe: () => Promise<void>, unsubscribe: () => Promise<void>): BackgroundTask {
  let pending: StartWithRetry | undefined;
  return {
    name,
    start() {
      pending = startWithRetry(name, subscribe);
    },
    async stop() {
      pending?.stop();
      pending = undefined;
      await unsubscribe();
    },
  };
}
