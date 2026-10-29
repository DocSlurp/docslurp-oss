import { Context } from "@temporalio/activity";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";

import { interruptionFailure } from "../temporal/failure-classification.js";
import { closeSandboxQuietly, runWithSandboxScope, SandboxSessionScope } from "./session-context.js";
import { assertTeardownBreakerClosed } from "./teardown-breaker.js";
import type { SandboxSession } from "./types.js";

/**
 * Gives every activity execution its own sandbox session scope and closes it when the
 * activity ends, whether it returns, throws or is cancelled. A worker quarantined by the
 * teardown circuit breaker refuses new activities (retryable, so they run on another worker).
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
        try {
          return await runWithSandboxScope(scope, () => next(input));
        } finally {
          await closeSandboxQuietly(() => scope.close(), `activity=${activityId}`);
        }
      },
    },
  });
}
