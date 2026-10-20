import { Context } from "@temporalio/activity";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";

import { runWithSandboxScope, SandboxSessionScope } from "./session-context.js";
import type { SandboxSession } from "./types.js";

/**
 * Gives every activity execution its own sandbox session scope and closes it when the
 * activity ends, whether it returns, throws or is cancelled.
 */
export function createSandboxActivityInterceptor(
  open: (activityId: string) => Promise<SandboxSession>,
): ActivityInterceptorsFactory {
  return () => ({
    inbound: {
      async execute(input, next) {
        const scope = new SandboxSessionScope(() => open(Context.current().info.activityId));
        try {
          return await runWithSandboxScope(scope, () => next(input));
        } finally {
          await scope.close();
        }
      },
    },
  });
}
