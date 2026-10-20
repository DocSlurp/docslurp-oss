import { SandboxPolicyError, type SandboxIsolation } from "./types.js";

const UNISOLATED_WARNING = "[parser-sandbox] status=unisolated";

/**
 * Production requires filesystem isolation and at least tcp-only network
 * isolation. Provider `none` is allowed only with an explicit override.
 */
export function assertSandboxPolicy(args: {
  providerId: string;
  isolation: SandboxIsolation;
  env: NodeJS.ProcessEnv;
}): { warnings: string[] } {
  const { providerId, isolation, env } = args;
  const allowUnisolated = env.DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED === "true";
  const warnings: string[] = [];

  if (providerId === "none" && allowUnisolated) warnings.push(UNISOLATED_WARNING);

  if (env.NODE_ENV !== "production") return { warnings };

  if (providerId === "none") {
    if (!allowUnisolated) {
      throw new SandboxPolicyError(
        "parser sandbox provider 'none' is not allowed in production; choose another provider " +
          "or set DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true to run parsers unisolated",
      );
    }
    return { warnings };
  }

  if (!isolation.filesystem) {
    throw new SandboxPolicyError(`parser sandbox provider '${providerId}' does not isolate the filesystem`);
  }
  if (isolation.network === "none") {
    throw new SandboxPolicyError(`parser sandbox provider '${providerId}' does not isolate the network`);
  }
  return { warnings };
}
