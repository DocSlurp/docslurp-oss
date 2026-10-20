import { execInSession } from "./exec.js";
import type { SandboxCommand, SandboxSession } from "./types.js";

/**
 * Parsers whose shared libraries a sandbox can hide (ffmpeg's libblas.so.3 resolves
 * through /etc/alternatives). The probe command only links libc, so run these for real.
 */
export const PARSER_BINARY_CHECKS: ReadonlyArray<readonly [name: string, flag: string]> = [
  ["ffprobe", "-version"],
  ["ffmpeg", "-version"],
  ["pdftoppm", "-v"],
  ["pandoc", "--version"],
];

export interface ParserBinaryCheckResult {
  failures: string[];
  skipped: string[];
  /** The session is remote, so local binaries say nothing about the provider's image. */
  remote?: boolean;
}

/** Run each installed parser binary through `session`, then close it. */
export async function checkParserBinaries(args: {
  session: SandboxSession;
  resolveBinary: (name: string) => string | undefined;
  buildCommand: (binary: string, args: string[]) => SandboxCommand;
}): Promise<ParserBinaryCheckResult> {
  const { session } = args;
  try {
    if (session.isolation.location === "remote") {
      return { failures: [], skipped: PARSER_BINARY_CHECKS.map(([name]) => name), remote: true };
    }
    const failures: string[] = [];
    const skipped: string[] = [];
    for (const [name, flag] of PARSER_BINARY_CHECKS) {
      const binary = args.resolveBinary(name);
      if (!binary) {
        skipped.push(name);
        continue;
      }
      const command = args.buildCommand(binary, [flag]);
      let exitCode: number | null = null;
      let detail = "";
      try {
        const result = await execInSession(session, command);
        exitCode = result.exitCode;
        if (exitCode !== 0) detail = result.stderr.trim().split("\n")[0];
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
      if (exitCode !== 0) failures.push(`${name} fails inside the parser sandbox (exit ${exitCode}): ${detail}`);
    }
    return { failures, skipped };
  } finally {
    await session.close();
  }
}
