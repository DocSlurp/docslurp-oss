import { Context } from "@temporalio/activity";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";

import { interruptionFailure, teardownFailure } from "../temporal/failure-classification.js";
import { closeSandboxQuietly, runWithSandboxScope, SandboxSessionScope } from "./session-context.js";
import { flushSourceQuarantine } from "./source-quarantine.js";
import { assertTeardownBreakerClosed } from "./teardown-breaker.js";
import type { SandboxSession } from "./types.js";

/**
 * Gives every activity execution its own sandbox session scope and closes it when the
 * activity ends, whether it returns, throws or is cancelled. A worker quarantined by the
 * teardown circuit breaker refuses new activities (retryable, so they run on another worker).
 *
 * An activity in which a command's teardown could not be verified (latched on its scope by
 * recordUnverifiedTeardown) always ends as the non-retryable teardown failure: when it returns,
 * when it throws something else (a watchdog, a parser fallback's own error), and when it is
 * cancelled or interrupted by shutdown. Otherwise the same input would retry on the next worker
 * and quarantine it too.
 */
export function createSandboxActivityInterceptor(
  open: (activityId: string) => Promise<SandboxSession>,
): ActivityInterceptorsFactory {
  return () => ({
    inbound: {
      async execute(input, next) {
        const activityId = Context.current().info.activityId;
        try {
          assertTeardownBreakerClosed();
        } catch (error) {
          console.error(`[worker-quarantine] status=refused-activity activity=${activityId} detail=${JSON.stringify((error as Error).message)}`);
          throw interruptionFailure(error);
        }
        const scope = new SandboxSessionScope(() => open(activityId));
        let outcome: { value: unknown } | { error: unknown };
        try {
          outcome = { value: await runWithSandboxScope(scope, () => next(input)) };
        } catch (error) {
          outcome = { error };
        } finally {
          await closeSandboxQuietly(() => scope.close(), `activity=${activityId}`);
        }
        const latched = scope.teardownError;
        if (latched) {
          const replaced = "error" in outcome ? ` replaced=${JSON.stringify(String((outcome.error as Error)?.name ?? outcome.error))}` : " replaced=success";
          console.error(`[worker-quarantine] status=activity-teardown activity=${activityId}${replaced}`);
          await flushSourceQuarantine();
          throw teardownFailure(latched);
        }
        if ("error" in outcome) throw outcome.error;
        return outcome.value as Awaited<ReturnType<typeof next>>;
      },
    },
  });
}
