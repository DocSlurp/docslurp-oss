/**
 * Deployment profile and kill switches (docs/self-host/deployment-profile.md).
 *
 * `DOCSLURP_PROFILE` (`service` | `selfhost` | `dev`) says who runs this deployment; `DOCSLURP_DISABLE` is a closed list
 * of kill switches. `resolveDeploymentProfile(env)` turns them, with the isolation floor, into one frozen posture object
 * that the worker and the server read at startup. It replaces the startup check (`assertServiceProfileRuntime` now
 * resolves it) and every legacy profile read (`serviceProfileFromEnv`). Enforcement points (sandbox policy, host-PDF
 * guard, probe and engine loaders) keep calling `vmOnlyParsing` / `isDevelopmentEnvironment`, the same floor the
 * posture's `vmOnlyParsing` reports; routing them through the posture object is follow-up work, not a behaviour change.
 *
 * **Isolation floor.** Parsing is VM-only in every non-development environment (`isDevelopmentEnvironment`, #398/#419),
 * whatever the profile. Development means NODE_ENV empty, `development` or `test` in both the given and the process
 * environment, and never under `service`. No profile and no switch lowers the floor: `dev` outside development and
 * `service` outside NODE_ENV=production refuse to start instead.
 *
 * **Retired names (release R1).** The old profile variable is a tombstone (retired-env.ts): set, it refuses startup.
 * Release R0 read it beside `DOCSLURP_PROFILE`; roll back from R1 only to R0. A legacy setting that lowers what a switch
 * lowers (`DOCSLURP_OCR_MODE=off` beside `DOCSLURP_DISABLE=ocr`) is a warning. A switch and a legacy value never
 * "conflict" in the other direction: the switch only lowers, so the lower of the two applies (refusing would turn an
 * emergency kill switch into an outage).
 *
 * Readers on hot paths never throw: `disabledSwitches(env)` reads an unparseable `DOCSLURP_DISABLE` as every switch on
 * (fail closed), and `serviceProfileFromEnv(env)` reads a disagreement as the stricter value. Startup refuses both.
 */
import { DISABLE_ENV, DISABLE_TOKENS, type DisableToken, disabledSwitches, expandDisableTokens, parseDisableList } from "./kill-switches.js";
import { retiredEnvRefusal } from "./retired-env.js";
import { isDevelopmentEnvironment, normalizeEnvSetting } from "./runtime-environment.js";

export * from "./kill-switches.js";

type Env = Readonly<Record<string, string | undefined>>;

export const DEPLOYMENT_PROFILE_ENV = "DOCSLURP_PROFILE";

export const DEPLOYMENT_PROFILES = ["service", "selfhost", "dev"] as const;
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];

/** The legacy profile vocabulary (`service`, `self-hosted`) the OCR and PDF mode readers still use internally. */
export const LEGACY_SERVICE_PROFILES = ["service", "self-hosted"] as const;
export type LegacyServiceProfile = (typeof LEGACY_SERVICE_PROFILES)[number];

const PROFILE_TO_LEGACY: Readonly<Record<DeploymentProfile, LegacyServiceProfile | null>> = { service: "service", selfhost: "self-hosted", dev: null };

export class DeploymentProfileError extends Error {
  constructor(message: string) {
    super(`${message}; refusing to start`);
    this.name = "DeploymentProfileError";
  }
}

function rawProfile(env: Env): string {
  return normalizeEnvSetting(env[DEPLOYMENT_PROFILE_ENV]);
}

/**
 * `DOCSLURP_PROFILE` in the legacy vocabulary the OCR and PDF mode readers and pricing use (`service`, `self-hosted`).
 * Never throws: any value containing `service` is `service` (the stricter reading); an unknown value is null. Startup
 * refuses unknown values first.
 */
export function serviceProfileFromEnv(env: Env): LegacyServiceProfile | null {
  const profile = rawProfile(env);
  if (profile.includes("service")) return "service";
  return (DEPLOYMENT_PROFILES as readonly string[]).includes(profile) ? PROFILE_TO_LEGACY[profile as DeploymentProfile] : null;
}

/** True when either profile name says `service`. */
export function serviceProfileActive(env: Env): boolean {
  return serviceProfileFromEnv(env) === "service";
}

/** Legacy settings that lower what a switch lowers (design 3.1), as [switch, variable, values that mean off]. */
const LEGACY_SWITCH_EQUIVALENTS: ReadonlyArray<readonly [DisableToken, string, readonly string[]]> = [
  ["ocr", "DOCSLURP_OCR_MODE", ["off"]],
  ["ai-escalation", "DOCSLURP_OCR_ESCALATION", ["off", "0", "false"]],
  ["page-reader", "DOCSLURP_OCR_PAGE_READER", ["off"]],
  ["router", "PAGE_ROUTER_MODE", ["off"]],
  ["figures", "DOCSLURP_DOPPLER_IMAGE_EXTRACT", ["off", "0", "false"]],
  ["charts", "DOCSLURP_CHART_EXPORT", ["off", "0", "false", "no"]],
  ["charts-ai", "DOCSLURP_CHART_EXPORT", ["free"]],
  ["figure-resume", "DOCSLURP_FIGURE_RESUME", ["off", "0", "false"]],
];

export type DeploymentPosture = Readonly<{
  /** Bumped when the posture's meaning changes; workers advertise it to `/ops/worker-fleet` (`extractionConfig`). */
  extractionConfig: 1;
  profile: DeploymentProfile;
  /** Where the profile came from. `default` = unset in development (`dev`, with a warning). */
  profileSource: "DOCSLURP_PROFILE" | "default";
  /** The legacy reading every pre-R0 reader uses (`serviceProfileFromEnv`). */
  legacyServiceProfile: LegacyServiceProfile | null;
  /** NODE_ENV is development in both the given and the process environment, and the profile is not `service`. */
  development: boolean;
  /** The isolation floor: true in every non-development environment, whatever the profile. */
  vmOnlyParsing: boolean;
  /** Host-sandboxed parsing (`local` OCR/PDF modes, the `none`/bubblewrap sandboxes) may be selected at all. */
  hostSandboxAllowed: boolean;
  /** In-process native engines, probes and `local-cli` readers may be selected at all (still operator opt-in). */
  inProcessReadersAllowed: boolean;
  /** `DOCSLURP_DISABLE` as configured (vocabulary order). */
  disable: readonly DisableToken[];
  /** The switches that are off, with implications. */
  disabled: readonly DisableToken[];
  warnings: readonly string[];
}>;

/**
 * The deployment's posture. Throws `DeploymentProfileError` (startup refuses) on: a retired variable (retired-env.ts);
 * an unknown profile value; `dev` outside development; `service` without NODE_ENV=production; no profile outside
 * development; an unknown `DOCSLURP_DISABLE` token.
 */
export function resolveDeploymentProfile(env: Env): DeploymentPosture {
  const warnings: string[] = [];
  const retired = retiredEnvRefusal(env);
  if (retired) throw new DeploymentProfileError(retired.replace(/; refusing to start$/, ""));
  const profileRaw = rawProfile(env);
  if (profileRaw && !(DEPLOYMENT_PROFILES as readonly string[]).includes(profileRaw)) {
    throw new DeploymentProfileError(`${DEPLOYMENT_PROFILE_ENV} must be one of ${DEPLOYMENT_PROFILES.join(", ")}; got ${JSON.stringify(profileRaw.slice(0, 40))}`);
  }
  const fromNew = profileRaw ? (profileRaw as DeploymentProfile) : null;

  const development = isDevelopmentEnvironment(env as Record<string, string | undefined>);
  const nodeEnv = normalizeEnvSetting(env.NODE_ENV);
  let profile: DeploymentProfile;
  let profileSource: DeploymentPosture["profileSource"];
  if (fromNew) {
    profile = fromNew;
    profileSource = "DOCSLURP_PROFILE";
  } else if (development) {
    profile = "dev";
    profileSource = "default";
    warnings.push(`${DEPLOYMENT_PROFILE_ENV} is unset; running as dev (allowed only in development)`);
  } else {
    throw new DeploymentProfileError(`${DEPLOYMENT_PROFILE_ENV} is required outside development (NODE_ENV=${nodeEnv || "unset"}); set service or selfhost`);
  }

  if (profile === "dev" && !development) {
    throw new DeploymentProfileError(`${DEPLOYMENT_PROFILE_ENV}=dev is only for development (NODE_ENV empty, development or test); got NODE_ENV=${nodeEnv || "unset"}`);
  }
  if (profile === "selfhost" && development && !nodeEnv) {
    warnings.push(`${DEPLOYMENT_PROFILE_ENV}=selfhost with NODE_ENV unset counts as development: host sandboxes and in-process readers may be selected; set NODE_ENV=production for VM-only parsing`);
  }
  if (profile === "service" && nodeEnv !== "production") {
    throw new DeploymentProfileError(`${DEPLOYMENT_PROFILE_ENV}=service requires NODE_ENV=production (got ${nodeEnv ? `'${nodeEnv}'` : "unset"})`);
  }

  const parsed = parseDisableList(env[DISABLE_ENV]);
  if (parsed.unknown.length > 0) {
    throw new DeploymentProfileError(`${DISABLE_ENV} has unknown token(s) ${parsed.unknown.map((token) => JSON.stringify(token)).join(", ")}; known: ${DISABLE_TOKENS.join(", ")}`);
  }
  const disabled = expandDisableTokens(parsed.tokens);
  for (const [token, variable, offValues] of LEGACY_SWITCH_EQUIVALENTS) {
    const value = normalizeEnvSetting(env[variable]);
    if (!value || !offValues.includes(value)) continue;
    if (parsed.tokens.includes(token)) {
      warnings.push(`${variable}=${value} repeats ${DISABLE_ENV}=${token}; remove ${variable} before release R1 refuses it`);
    }
  }

  const vmOnlyParsing = !development;
  return Object.freeze({
    extractionConfig: 1 as const,
    profile,
    profileSource,
    legacyServiceProfile: PROFILE_TO_LEGACY[profile],
    development,
    vmOnlyParsing,
    hostSandboxAllowed: !vmOnlyParsing && profile !== "service",
    inProcessReadersAllowed: !vmOnlyParsing && profile !== "service",
    disable: Object.freeze([...parsed.tokens]),
    disabled: Object.freeze(disabled),
    warnings: Object.freeze(warnings),
  });
}

/**
 * The canonical text a posture digest is computed over (sorted keys, warnings left out): two processes with the same
 * effective posture produce the same text. The worker hashes it for `/ops/worker-fleet`.
 */
export function postureFingerprint(posture: DeploymentPosture): string {
  return JSON.stringify({
    extractionConfig: posture.extractionConfig,
    profile: posture.profile,
    development: posture.development,
    vmOnlyParsing: posture.vmOnlyParsing,
    hostSandboxAllowed: posture.hostSandboxAllowed,
    inProcessReadersAllowed: posture.inProcessReadersAllowed,
    disabled: [...posture.disabled],
  });
}

/** A run pipeline's switch-relevant fields (legacy shape, as the worker reads runs in R0). */
export type KillSwitchPipeline = {
  quality?: string | null;
  visionFallback?: boolean | null;
  chartExport?: { tier?: string | null; enabled?: boolean | null } | null;
  /** Legacy shapes may still carry `vision.forceAllPages` (smart); normalized pipelines do not. */
  vision?: object | null;
};

/**
 * `pipeline` as a run executes it under the deployment's switches. Only lowers: `ai` runs `smart` (`good`) as `balanced`
 * (`auto`) and drops rescue reads and the chart model tier; `ai-rescue` drops rescue reads (`visionFallback`) on
 * `fastest`/`balanced` runs (a `smart` run's every-page reads are not rescue reads);
 * `charts-ai` keeps chart export on its free tier. Returns the same object when nothing changes.
 */
export function applyKillSwitchesToPipeline<T extends KillSwitchPipeline>(pipeline: T, env: Env): T {
  const off = disabledSwitches(env);
  if (off.size === 0) return pipeline;
  let next = pipeline;
  const set = (patch: Partial<KillSwitchPipeline>) => {
    next = { ...next, ...patch };
  };
  if (off.has("ai")) {
    if (next.quality === "good") set({ quality: "auto" });
    const vision = next.vision as { forceAllPages?: unknown } | null | undefined;
    if (vision?.forceAllPages) set({ vision: { ...vision, forceAllPages: false } });
  }
  // `ai-rescue` alone leaves `smart` its every-page reads (those are not rescue reads); `ai` lowered smart above.
  if (off.has("ai-rescue") && next.visionFallback !== false && next.quality !== "good") set({ visionFallback: false });
  if (off.has("charts-ai") && next.chartExport?.tier === "models") set({ chartExport: { ...next.chartExport, tier: "free" } });
  if (off.has("charts") && next.chartExport && next.chartExport.tier && next.chartExport.tier !== "off") {
    set({ chartExport: { ...next.chartExport, tier: "off" } });
  }
  return next;
}
