import { superviseChild } from "./teardown.js";
import type { SandboxCommand, SandboxResult, SandboxSession } from "./types.js";

/** Run a command to completion through whichever entry point the session offers. */
export async function execInSession(session: SandboxSession, command: SandboxCommand): Promise<SandboxResult> {
  if (session.run) return session.run(command);
  if (!session.spawn) throw new Error(`Session '${session.providerId}' offers neither spawn nor run`);
  const child = session.spawn(command);
  // The time limit goes through the same verified teardown as the runner's: nothing outlives the call.
  const supervised = superviseChild(child, { label: command.binary });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(
    () => supervised.terminate(new Error(`${command.binary} exceeded ${command.limits.timeoutMs} ms`), { immediate: true }),
    command.limits.timeoutMs,
  );
  try {
    const { code } = await supervised.done;
    return { exitCode: code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
