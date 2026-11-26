import { currentOperatorConfigDigest } from "@docslurp/shared/operator-config";
import { createHash } from "node:crypto";

import { activeCapabilityPools, advertisedCapabilityPools, type AdvertisedCapabilityPools, type DeploymentPosture, isDevelopmentEnvironment, postureFingerprint, resolveDeploymentProfile, switchDisabled } from "@docslurp/shared";

/**
 * The isolation floor: every non-development environment requires the audited VM boundary, including the real process
 * floor. Never throws and never depends on the profile beyond `service` (which is never development): no profile, switch
 * or operator setting lowers it (@docslurp/shared deployment-profile.ts).
 */
export function vmOnlyParsing(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isDevelopmentEnvironment(env);
}

/**
 * Startup check (sandbox startup and worker preflight): resolve the deployment posture and throw when it refuses
 * (`DOCSLURP_PROFILE` unset outside development, `dev` outside development, `service` without NODE_ENV=production, the
 * old and new profile names disagreeing, an unknown `DOCSLURP_DISABLE` token). The worker reads customer bytes, so an
 * unset profile always refuses here outside development. Logs the posture's warnings once per process.
 */
export function assertServiceProfileRuntime(env: NodeJS.ProcessEnv = process.env): DeploymentPosture {
  const posture = resolveDeploymentProfile(env);
  if (env === process.env) logPostureOnce(posture);
  return posture;
}

let logged = false;

function logPostureOnce(posture: DeploymentPosture): void {
  if (logged) return;
  logged = true;
  for (const warning of posture.warnings) console.warn(`[deployment-profile] ${warning}`);
  console.log(
    `[deployment-profile] profile=${posture.profile} source=${posture.profileSource} vmOnlyParsing=${posture.vmOnlyParsing} ` +
      `disabled=${posture.disabled.join(",") || "none"} digest=${postureDigest(posture)}`,
  );
}

/** sha256 of the posture's canonical fingerprint, shortened; advertised to `/ops/worker-fleet`. */
export function postureDigest(posture: DeploymentPosture): string {
  return `sha256:${createHash("sha256").update(postureFingerprint(posture)).digest("hex").slice(0, 16)}`;
}

let processPosture: DeploymentPosture | null = null;

/** This process's posture (resolved once from process.env; throws when it refuses, like startup). */
export function deploymentPosture(): DeploymentPosture {
  processPosture ??= resolveDeploymentProfile(process.env);
  return processPosture;
}

/**
 * What this worker advertises in its capability-registry row (`/ops/worker-fleet`): extraction config version, posture
 * digest, profile and the switches that are off. Null when the posture does not resolve (startup refuses that first).
 */
export function advertisedWorkerConfig(): { extractionConfig: number; postureDigest: string; profile: string; disabled: string[]; operatorConfig: string | null; capabilityPools: AdvertisedCapabilityPools } | null {
  try {
    const posture = deploymentPosture();
    return {
      extractionConfig: posture.extractionConfig, postureDigest: postureDigest(posture), profile: posture.profile, disabled: [...posture.disabled],
      // The operator config file's digest (null without one): /ops/worker-fleet compares it with the app's.
      operatorConfig: currentOperatorConfigDigest(),
      // The resolved capability pools (member ids in order): /ops/worker-fleet shows them per worker.
      capabilityPools: advertisedCapabilityPools(activeCapabilityPools()),
    };
  } catch {
    return null;
  }
}

/**
 * Before running the `local-cli` vision reader (an in-process-class reader: a local model on this host). It is a
 * development opt-in only: refused under the VM-only floor (every non-development environment, whatever DOCSLURP_PROFILE
 * says) and under DOCSLURP_DISABLE=ai. Called where the reader executes, never where a command is only planned.
 */
export function assertLocalCliReaderAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (vmOnlyParsing(env)) throw new Error("the local-cli vision reader is refused outside development (VM-only parsing); configure a hosted or private vision route");
  if (switchDisabled(env, "ai")) throw new Error("the local-cli vision reader is off (DOCSLURP_DISABLE=ai)");
}
