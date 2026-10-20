import type { SandboxCommand, SandboxResult, SandboxSession } from "./types.js";

/** Run a command to completion through whichever entry point the session offers. */
export async function execInSession(session: SandboxSession, command: SandboxCommand): Promise<SandboxResult> {
  if (session.run) return session.run(command);
  if (!session.spawn) throw new Error(`Session '${session.providerId}' offers neither spawn nor run`);
  const child = session.spawn(command);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), command.limits.timeoutMs);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
