/**
 * Deployment profile and kill switches (docs/self-host/deployment-profile.md).
 *
 * `DOCSLURP_PROFILE` (`service` | `selfhost` | `dev`) says who runs this deployment; `DOCSLURP_DISABLE` is a closed list
 * of kill switches. `resolveDeploymentProfile(env)` turns them, with the isolation floor, into one frozen posture object
 * that the worker and the server read at startup. It replaces the scattered startup checks (`assertServiceProfileRuntime`,
 * the profile reads beside `vmOnlyParsing` and the host-PDF guard) with one function.
 *
 * **Isolation floor.** Parsing is VM-only in every non-development environment (`isDevelopmentEnvironment`, #398/#419),
 * whatever the profile. Development means NODE_ENV empty, `development` or `test` in both the given and the process
 * environment, and never under `service`. No profile and no switch lowers the floor: `dev` outside development and
 * `service` outside NODE_ENV=production refuse to start instead.
 *
 * **Compatibility (release R0).** Old names stay accepted beside the new ones: `DOCSLURP_SERVICE_PROFILE`
 * (`service`, `self-hosted`) beside `DOCSLURP_PROFILE`. When both are set and agree the posture carries a warning; when
 * they disagree startup refuses. A legacy setting that lowers what a switch lowers (`DOCSLURP_OCR_MODE=off` beside
 * `DOCSLURP_DISABLE=ocr`) is also a warning. A switch and a legacy value never "conflict" in the other direction: the
 * switch only lowers, so the lower of the two applies (refusing would turn an emergency kill switch into an outage).
 *
 * Readers on hot paths never throw: `disabledSwitches(env)` reads an unparseable `DOCSLURP_DISABLE` as every switch on
 * (fail closed), and `serviceProfileFromEnv(env)` reads a disagreement as the stricter value. Startup refuses both.
 */
import { isDevelopmentEnvironment, normalizeEnvSetting } from "./runtime-environment.js";

type Env = Readonly<Record<string, string | undefined>>;

export const DEPLOYMENT_PROFILE_ENV = "DOCSLURP_PROFILE";
export const LEGACY_SERVICE_PROFILE_ENV = "DOCSLURP_SERVICE_PROFILE";
export const DISABLE_ENV = "DOCSLURP_DISABLE";

export const DEPLOYMENT_PROFILES = ["service", "selfhost", "dev"] as const;
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];

/** `DOCSLURP_SERVICE_PROFILE` values, the vocabulary every pre-R0 reader understands. */
export const LEGACY_SERVICE_PROFILES = ["service", "self-hosted"] as const;
export type LegacyServiceProfile = (typeof LEGACY_SERVICE_PROFILES)[number];

/**
 * The closed `DOCSLURP_DISABLE` vocabulary (design 2.5). Every token is known from R0, so a rollback to R0 never meets
 * an unknown token.
 */
export const DISABLE_TOKENS = [
  "ai",
  "ai-rescue",
  "ai-escalation",
  "page-reader",
  "ocr",
  "router",
  "figures",
  "charts",
  "charts-ai",
  "figure-resume",
] as const;
export type DisableToken = (typeof DISABLE_TOKENS)[number];

/**
 * What each switch also turns off. `ai` turns off every model read in extraction: rescue, escalation, the page image
 * reader, decision models (deterministic routing only) and AI chart reads; `smart` runs as `balanced` without AI
 * (applyKillSwitchesToPipeline). `charts` turns off all chart export, including AI chart reads.
 */
const IMPLIES: Readonly<Partial<Record<DisableToken, readonly DisableToken[]>>> = {
  ai: ["ai-rescue", "ai-escalation", "page-reader", "router", "charts-ai"],
  charts: ["charts-ai"],
};

const LEGACY_TO_PROFILE: Readonly<Record<LegacyServiceProfile, DeploymentProfile>> = { service: "service", "self-hosted": "selfhost" };
const PROFILE_TO_LEGACY: Readonly<Record<DeploymentProfile, LegacyServiceProfile | null>> = { service: "service", selfhost: "self-hosted", dev: null };

export class DeploymentProfileError extends Error {
  constructor(message: string) {
    super(`${message}; refusing to start`);
    this.name = "DeploymentProfileError";
  }
}

export function isDisableToken(value: string): value is DisableToken {
  return (DISABLE_TOKENS as readonly string[]).includes(value);
}

/** Parse `DOCSLURP_DISABLE`: comma list, trimmed, lower-cased; empty entries ignored. Unknown tokens are returned apart. */
export function parseDisableList(raw: string | undefined | null): { tokens: DisableToken[]; unknown: string[] } {
  const tokens = new Set<DisableToken>();
  const unknown: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const token = normalizeEnvSetting(entry);
    if (!token) continue;
    if (isDisableToken(token)) tokens.add(token);
    else unknown.push(token.slice(0, 40));
  }
  return { tokens: DISABLE_TOKENS.filter((token) => tokens.has(token)), unknown };
}

/** The switches the given tokens turn off, with their implications, in vocabulary order. */
export function expandDisableTokens(tokens: Iterable<DisableToken>): DisableToken[] {
  const off = new Set<DisableToken>();
  for (const token of tokens) {
    off.add(token);
    for (const implied of IMPLIES[token] ?? []) off.add(implied);
  }
  return DISABLE_TOKENS.filter((token) => off.has(token));
}

const ALL_OFF: ReadonlySet<DisableToken> = new Set(DISABLE_TOKENS);
let lastParsed: { raw: string; set: ReadonlySet<DisableToken> } | null = null;

/**
 * The switches that are off under `env` (`DOCSLURP_DISABLE` with implications). Never throws: a value with an unknown
 * token reads as every switch off (fail closed); startup refuses it (resolveDeploymentProfile).
 */
export function disabledSwitches(env: Env): ReadonlySet<DisableToken> {
  const raw = env[DISABLE_ENV] ?? "";
  if (lastParsed?.raw === raw) return lastParsed.set;
  const parsed = parseDisableList(raw);
  const set: ReadonlySet<DisableToken> = parsed.unknown.length > 0 ? ALL_OFF : new Set(expandDisableTokens(parsed.tokens));
  lastParsed = { raw, set };
  return set;
}

/** True when `token` (or a switch that implies it) is in `DOCSLURP_DISABLE`. */
export function switchDisabled(env: Env, token: DisableToken): boolean {
  return disabledSwitches(env).has(token);
}

function rawProfile(env: Env): string {
  return normalizeEnvSetting(env[DEPLOYMENT_PROFILE_ENV]);
}

function rawLegacyProfile(env: Env): string {
  return normalizeEnvSetting(env[LEGACY_SERVICE_PROFILE_ENV]);
}

/**
 * The legacy `DOCSLURP_SERVICE_PROFILE` view of this environment, reading both names, for the readers that predate
 * `DOCSLURP_PROFILE` (OCR and PDF modes, pricing). Never throws: when the two names disagree, or a value is unknown, the
 * stricter reading wins (`service` if either side says it, then `self-hosted`). Startup refuses those cases.
 */
export function serviceProfileFromEnv(env: Env): LegacyServiceProfile | null {
  const profile = rawProfile(env);
  const legacy = rawLegacyProfile(env);
  if (profile.includes("service") || legacy.includes("service")) return "service";
  const mapped = (DEPLOYMENT_PROFILES as readonly string[]).includes(profile) ? PROFILE_TO_LEGACY[profile as DeploymentProfile] : null;
  if (legacy === "self-hosted" || mapped === "self-hosted") return "self-hosted";
  return null;
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
  profileSource: "DOCSLURP_PROFILE" | "DOCSLURP_SERVICE_PROFILE" | "both" | "default";
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

export type ResolveDeploymentProfileOptions = {
  /**
   * Refuse an unset profile outside development (default true). The R0 API passes false and warns instead: the hosted
   * app has no profile until the R1 config change; the worker, which reads customer bytes, always refuses.
   */
  requireProfile?: boolean;
};

/**
 * The deployment's posture. Throws `DeploymentProfileError` (startup refuses) on: an unknown profile value; the old and
 * new profile names disagreeing; `dev` outside development; `service` without NODE_ENV=production; no profile outside
 * development (unless `requireProfile: false`); an unknown `DOCSLURP_DISABLE` token.
 */
export function resolveDeploymentProfile(env: Env, options: ResolveDeploymentProfileOptions = {}): DeploymentPosture {
  const warnings: string[] = [];
  const profileRaw = rawProfile(env);
  const legacyRaw = rawLegacyProfile(env);
  if (profileRaw && !(DEPLOYMENT_PROFILES as readonly string[]).includes(profileRaw)) {
    throw new DeploymentProfileError(`${DEPLOYMENT_PROFILE_ENV} must be one of ${DEPLOYMENT_PROFILES.join(", ")}; got ${JSON.stringify(profileRaw.slice(0, 40))}`);
  }
  if (legacyRaw && !(LEGACY_SERVICE_PROFILES as readonly string[]).includes(legacyRaw)) {
    throw new DeploymentProfileError(`${LEGACY_SERVICE_PROFILE_ENV} must be one of ${LEGACY_SERVICE_PROFILES.join(", ")}; got ${JSON.stringify(legacyRaw.slice(0, 40))}`);
  }
  const fromNew = profileRaw ? (profileRaw as DeploymentProfile) : null;
  const fromOld = legacyRaw ? LEGACY_TO_PROFILE[legacyRaw as LegacyServiceProfile] : null;
  if (fromNew && fromOld && fromNew !== fromOld) {
    throw new DeploymentProfileError(`${DEPLOYMENT_PROFILE_ENV}=${fromNew} conflicts with ${LEGACY_SERVICE_PROFILE_ENV}=${legacyRaw}; set only ${DEPLOYMENT_PROFILE_ENV}`);
  }
  if (fromNew && fromOld) {
    warnings.push(`${LEGACY_SERVICE_PROFILE_ENV}=${legacyRaw} repeats ${DEPLOYMENT_PROFILE_ENV}=${fromNew}; remove ${LEGACY_SERVICE_PROFILE_ENV} before release R1 refuses it`);
  } else if (fromOld) {
    warnings.push(`${LEGACY_SERVICE_PROFILE_ENV} is deprecated; set ${DEPLOYMENT_PROFILE_ENV}=${fromOld} instead (release R1 refuses the old name)`);
  }

  const development = isDevelopmentEnvironment(env as Record<string, string | undefined>);
  const nodeEnv = normalizeEnvSetting(env.NODE_ENV);
  let profile: DeploymentProfile;
  let profileSource: DeploymentPosture["profileSource"];
  if (fromNew || fromOld) {
    profile = (fromNew ?? fromOld) as DeploymentProfile;
    profileSource = fromNew && fromOld ? "both" : fromNew ? "DOCSLURP_PROFILE" : "DOCSLURP_SERVICE_PROFILE";
  } else if (development) {
    profile = "dev";
    profileSource = "default";
    warnings.push(`${DEPLOYMENT_PROFILE_ENV} is unset; running as dev (allowed only in development)`);
  } else if (options.requireProfile === false) {
    // Treated as selfhost for what it permits (nothing below the VM-only floor); the worker never takes this path.
    profile = "selfhost";
    profileSource = "default";
    warnings.push(`${DEPLOYMENT_PROFILE_ENV} is unset outside development (NODE_ENV=${nodeEnv || "unset"}); set service or selfhost (release R1 refuses to start without it)`);
  } else {
    throw new DeploymentProfileError(`${DEPLOYMENT_PROFILE_ENV} is required outside development (NODE_ENV=${nodeEnv || "unset"}); set service or selfhost`);
  }

  if (profile === "dev" && !development) {
    throw new DeploymentProfileError(`${DEPLOYMENT_PROFILE_ENV}=dev is only for development (NODE_ENV empty, development or test); got NODE_ENV=${nodeEnv || "unset"}`);
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
 * (`auto`) and drops rescue reads and the chart model tier; `ai-rescue` drops rescue reads (`visionFallback`);
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
  if (off.has("ai-rescue") && next.visionFallback !== false) set({ visionFallback: false });
  if (off.has("charts-ai") && next.chartExport?.tier === "models") set({ chartExport: { ...next.chartExport, tier: "free" } });
  if (off.has("charts") && next.chartExport && next.chartExport.tier && next.chartExport.tier !== "off") {
    set({ chartExport: { ...next.chartExport, tier: "off" } });
  }
  return next;
}
