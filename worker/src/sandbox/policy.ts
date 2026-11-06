import { SandboxPolicyError, type SandboxIsolation } from "./types.js";

const UNISOLATED_WARNING = "[parser-sandbox] status=unisolated";

/**
 * Every environment requires process teardown (a PID namespace, so a parser's descendants die with
 * it); only `none` with the explicit unisolated override may run without it. Production requires the audited remote VM provider, full network isolation and filesystem isolation.
 * Local namespace providers and the unisolated development override never qualify in production.
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

  if (!isolation.processes && !(providerId === "none" && allowUnisolated)) {
    throw new SandboxPolicyError(
      `parser sandbox provider '${providerId}' cannot guarantee that a parser's processes die with it ` +
        "(no PID namespace: unprivileged user namespaces or util-linux unshare unavailable); refusing untrusted " +
        "parser work. With provider 'none', DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true runs parsers unisolated",
    );
  }

  if (env.NODE_ENV !== "production" && process.env.NODE_ENV !== "production") return { warnings };

  // Provider identity matters: `remote` alone does not attest a VM boundary. Keep this
  // allowlist closed until a new provider has independent security review.
  if (providerId !== "modal" || isolation.location !== "remote") {
    throw new SandboxPolicyError(
      `parser sandbox provider '${providerId}' lacks the required production VM boundary; ` +
        "configure DOCSLURP_PARSER_SANDBOX=modal. Local namespaces and " +
        "DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED cannot bypass this requirement",
    );
  }
  if (!isolation.filesystem || isolation.network !== "full") {
    throw new SandboxPolicyError("production parser VMs require filesystem isolation and full network isolation");
  }
  return { warnings };
}
