/**
 * Worker side of the capability pools (@docslurp/shared capability-pools.ts): resolve them once at startup from core's
 * members, the built-in local services this deployment runs, and the members plugins register; refuse to start when any
 * member could send a customer page outside the US and EU; log them; and record which member served a page and every
 * failover, per capability, on the pipeline meter (docs/pipeline-metrics.md).
 */
import {
  activeCapabilityPools, assertCapabilityPoolRegions, capabilityPoolsLogLine, isAutomaticSelectionDenied, localPdfModeRequested,
  attestedRegion, buildDecisionModelCatalog, findJinaNanoUri, poolHostRegion, switchDisabled, isLocalModelProvider, localServiceMember, lookupPrivateModelRoute, parseLlmModelUri, poolMemberForModel, resolveCapabilityPools, setActiveCapabilityPools, visionRouteRegionProblem,
  visionModelCatalog, visionModelUriProblem, visionProfileCatalog,
  type CapabilityPools, type PoolCapability, type PoolFailoverReason, type ServicePoolMember,
} from "@docslurp/shared";
import { recordPipelineTelemetry } from "@docslurp/shared/observability";

import { pageImageReaderProvider, poolServiceMembers, sandboxedOcrProvider, sandboxedPdfProviders } from "../extractors/plugins.js";
import { setTextPoolTelemetry } from "../extractors/text-pool.js";
import { VISION_MODEL_PROFILES, visionModelProfile } from "../tools/vision-model-profiles.js";
import { decisionModelRegionProblem } from "../routing/decision-client.js";

type Env = NodeJS.ProcessEnv;

/** Every plugin service that serves pages, by capability: each must be a registered pool member. */
function pluginServices(): Array<{ capability: PoolCapability; backend: string }> {
  return [
    ...sandboxedPdfProviders().map((provider) => ({ capability: "text" as const, backend: provider.id })),
    ...(sandboxedOcrProvider() ? [{ capability: "ocr" as const, backend: sandboxedOcrProvider()!.id }] : []),
    ...(pageImageReaderProvider() ? [{ capability: "ocr" as const, backend: pageImageReaderProvider()!.id }] : []),
  ];
}

/** Built-in services that run inside this deployment (customer-owned local execution only). */
function localMembers(env: Env): ServicePoolMember[] {
  const members: ServicePoolMember[] = [];
  if (localPdfModeRequested(env)) members.push(localServiceMember("text", "local-pdf", "local-pdf"));
  if (env.DOCSLURP_OCR_MODE?.trim().toLowerCase() === "local") members.push(localServiceMember("ocr", "local-ocr", "local-ocr"));
  return members;
}

/**
 * Resolve, check and activate this worker's pools; throws (the worker refuses to start) when:
 * - a member's hosts or service region is not US or EU from stated evidence (or this deployment, for built-ins);
 * - a plugin serves pages without registering its pool member (its region would be unknown);
 * - DOCSLURP_OCR_ESCALATION_MODEL or DOCSLURP_VISION_FALLBACK_MODEL names a model that is no pool member.
 */
export function initializeCapabilityPools(env: Env = process.env, log: (line: string) => void = console.log): CapabilityPools {
  const services = [...localMembers(env), ...poolServiceMembers()];
  const pools = resolveCapabilityPools({ services, env });
  const problems: string[] = [];
  // One registration per service: a backend id serves at most one member of a capability.
  const seen = new Set<string>();
  for (const member of services) {
    const key = `${member.capability}:${member.backend}`;
    if (seen.has(key)) problems.push(`the ${member.capability} backend ${member.backend} is registered by more than one pool member`);
    seen.add(key);
  }
  // Every vision profile's host allowlist (a project may choose any of these models) must be stated US or EU hosts.
  for (const model of Object.keys(VISION_MODEL_PROFILES)) {
    const problem = visionRouteRegionProblem(model, profileHosts(model));
    if (problem) problems.push(`vision profile: ${problem}`);
  }
  // Every catalog model a project can select (not refused) and every preset must reach only stated US or EU hosts (or
  // run inside this deployment); a refused model is rejected by config validation and never offered.
  for (const entry of visionModelCatalog) {
    if ("refusedReason" in entry || entry.target !== "hosted") continue;
    const problem = visionPageRouteRegionProblem(entry.uri);
    if (problem) problems.push(`vision catalog: ${problem}`);
  }
  // The page router's hosted decision models (when the router is on) must reach only stated US or EU upstreams.
  const routerMode = env.PAGE_ROUTER_MODE?.trim().toLowerCase();
  if ((routerMode === "shadow" || routerMode === "active") && !switchDisabled(env, "router")) {
    const present = Object.fromEntries(Object.keys(env).filter((key) => env[key]?.trim()).map((key) => [key, true]));
    for (const model of buildDecisionModelCatalog({ env: present }).models) {
      const problem = decisionModelRegionProblem(model);
      if (problem) problems.push(`page router (PAGE_ROUTER_MODE=${routerMode}): ${problem}`);
    }
  }
  // Media frame descriptions go to the configured media vision provider: it must state a US or EU region too.
  if (env.MEDIA_REMOTE_ENABLED === "true" && !poolHostRegion(env.MEDIA_VISION_PROVIDER?.trim() || "deepinfra")) {
    problems.push(`media vision provider ${env.MEDIA_VISION_PROVIDER} states no US or EU hosting region`);
  }
  // A private page-image embedder (Jina) must attest a US or EU region.
  const jina = findJinaNanoUri();
  if (jina) {
    const problem = privateRouteRegionProblem(jina, "embedding");
    if (problem) problems.push(`page-image embedder: ${problem}`);
  }
  problems.push(...priceCeilingHostProblems(pools));
  for (const [key, preset] of Object.entries(visionProfileCatalog)) {
    const uri = preset.config.modelUri;
    const problem = visionModelUriProblem(uri) ?? visionPageRouteRegionProblem(uri);
    if (problem) problems.push(`vision preset ${key}: ${problem}`);
  }
  for (const { capability, backend } of pluginServices()) {
    if (!services.some((member) => member.capability === capability && member.backend === backend)) {
      problems.push(`the ${capability} service ${backend} registers no capability pool member (extractor plugin poolMembers), so where it processes pages is unknown`);
    }
  }
  const escalation = env.DOCSLURP_OCR_ESCALATION_MODEL?.trim();
  if (escalation && !isAutomaticSelectionDenied(escalation) && !poolMemberForModel("ocr", escalation, "second-read", pools)) {
    problems.push(`DOCSLURP_OCR_ESCALATION_MODEL=${escalation} is not an ocr second-read pool member`);
  }
  const fallback = env.DOCSLURP_VISION_FALLBACK_MODEL?.trim();
  if (fallback && fallback !== "off" && !poolMemberForModel("vision", fallback, "read", pools)) {
    problems.push(`DOCSLURP_VISION_FALLBACK_MODEL=${fallback} is not a vision pool member`);
  }
  if (problems.length) throw new Error(`capability pools: ${problems.join("; ")}; refusing to start`);
  assertCapabilityPoolRegions(pools);
  setActiveCapabilityPools(pools);
  setTextPoolTelemetry({ served: (id, pages) => recordPoolServed("text", id, pages), failover: (from, to, reason) => recordPoolFailover("text", from, to, reason) });
  log(capabilityPoolsLogLine(pools));
  return pools;
}

/**
 * The deployment's automatic vision fallback for a page read on `model` when the project names none:
 * DOCSLURP_VISION_FALLBACK_MODEL (`off` disables it), else the next automatic member of the vision pool after the
 * member serving `model`. Null when `model` is no pool member or nothing follows it.
 */
export function defaultVisionFallbackModel(model: string, env: Env = process.env, pools: CapabilityPools = activeCapabilityPools()): string | null {
  const configured = env.DOCSLURP_VISION_FALLBACK_MODEL?.trim();
  if (configured === "off" || !visionPoolFallbackEnabled(env)) return null;
  const primary = poolMemberForModel("vision", model, "read", pools);
  if (!primary) return null;
  if (configured) {
    const member = poolMemberForModel("vision", configured, "read", pools);
    return member && member.id !== primary.id ? member.model : null;
  }
  const members = pools.vision;
  const next = members.slice(members.findIndex((member) => member.id === primary.id) + 1)
    .find((member) => member.kind === "llm" && member.stage === "read" && member.automaticFailover);
  return next && next.kind === "llm" ? next.model : null;
}

/** Planning tokens of one page read (a page image plus the prompt in, a page of Markdown out), for a cost estimate. */
const ESTIMATE_PAGE_TOKENS = { input: 3_000, output: 560 } as const;

/**
 * Estimated cents per page of a vision fallback on `model`: a pool member sent under its own price ceiling is estimated
 * at that ceiling (what it can be billed at most), anything else at its catalog estimate. Null when neither is known.
 */
export function visionFallbackCentsPerPage(model: string, catalogCents: number | null, pools: CapabilityPools = activeCapabilityPools()): number | null {
  const ceiling = poolMemberForModel("vision", model, "read", pools)?.priceCeiling;
  if (!ceiling) return catalogCents;
  return (ESTIMATE_PAGE_TOKENS.input * ceiling.inputUsdPerMTok + ESTIMATE_PAGE_TOKENS.output * ceiling.outputUsdPerMTok) / 1e4;
}

/** The vision member id serving `model` (stamped on results and usage), or null. */
export function visionPoolMemberId(model: string, pools: CapabilityPools = activeCapabilityPools()): string | null {
  return poolMemberForModel("vision", model, "read", pools)?.id ?? null;
}

/** The ocr second-read member id of escalation route `optionId`, or null. */
export function secondReadPoolMemberId(optionId: string, pools: CapabilityPools = activeCapabilityPools()): string | null {
  return pools.ocr.find((member) => member.kind === "llm" && member.escalationRoute?.optionId === optionId)?.id ?? null;
}

/**
 * A member's price ceiling restricts its requests to `ceiling.hosts` (sent as `provider.only`): those hosts must be among
 * the member's own hosts, and each must state a US or EU region itself.
 */
export function priceCeilingHostProblems(pools: CapabilityPools): string[] {
  const problems: string[] = [];
  for (const member of [...pools.ocr, ...pools.vision]) {
    if (member.kind !== "llm" || !member.priceCeiling) continue;
    for (const host of member.priceCeiling.hosts) {
      if (!member.hosts.includes(host)) problems.push(`${member.id}: price ceiling host ${host} is not one of its hosts`);
      if (!poolHostRegion(host)) problems.push(`${member.id}: price ceiling host ${host} has no stated US or EU region`);
    }
  }
  return problems;
}

/** A vision profile's bounded OpenRouter allowlist, or null when it names none (or lets OpenRouter fall back anywhere). */
function profileHosts(model: string): string[] | null {
  const route = visionModelProfile(model)?.openRouterProvider;
  if (!route) return null;
  if ("only" in route) return [...route.only];
  return route.allow_fallbacks ? null : [...route.order];
}

/**
 * Why a page read on `modelUri` (a project's primary or fallback vision model) may not carry a customer page: null when
 * every host it can reach states a US or EU region, or it runs where no third party sees the page (a private operator
 * route, a local runtime). OpenRouter routes need a bounded profile allowlist; a direct provider route is its provider.
 */
export function visionPageRouteRegionProblem(modelUri: string): string | null {
  const trimmed = modelUri.trim();
  if (!/^llm:\/\//i.test(trimmed)) return visionRouteRegionProblem(trimmed, profileHosts(trimmed));
  let parsed: ReturnType<typeof parseLlmModelUri>;
  try {
    parsed = parseLlmModelUri(trimmed);
  } catch {
    return `${trimmed} is not a model route`;
  }
  if (isLocalModelProvider(parsed.provider)) return null;
  if (parsed.provider === "private") return privateRouteRegionProblem(trimmed, "vision");
  if (parsed.provider === "openrouter") return visionRouteRegionProblem(parsed.model, profileHosts(parsed.model));
  return visionRouteRegionProblem(trimmed, [parsed.provider]);
}

/**
 * Why a private (operator-registered) route may not carry customer content: its endpoint must attest a US or EU region
 * (`attestation.region`). An unregistered route is left to the caller's own fail-closed lookup.
 */
export function privateRouteRegionProblem(modelUri: string, capability: "vision" | "embedding" | "text"): string | null {
  const lookup = lookupPrivateModelRoute({ ref: modelUri, capability });
  if (!lookup.ok) return null;
  const region = lookup.route.endpoint.attestation.region;
  return attestedRegion(region) ? null : `${modelUri} is on a private endpoint attesting region "${region}", which is not US or EU`;
}

/** DOCSLURP_VISION_POOL_FALLBACK=on: page reads fall back to the vision pool's next member when the project names none. Off by default. */
export function visionPoolFallbackEnabled(env: Env = process.env): boolean {
  return ["on", "1", "true"].includes(env.DOCSLURP_VISION_POOL_FALLBACK?.trim().toLowerCase() ?? "");
}

/** A member served a page (`docslurp.capability_pool.served`, labels capability and member). Never throws. */
export function recordPoolServed(capability: PoolCapability, memberId: string | null, pages = 1): void {
  try {
    recordPipelineTelemetry("capability_pool.served", Math.max(0, pages), { capability, member: memberId ?? "unknown" });
  } catch {
    // Telemetry never fails a read.
  }
}

/**
 * The pool moved past `from` (`docslurp.capability_pool.failover`, labels capability, from, to, reason); `to` is null
 * when nothing was left. A routing refusal (no host under the request's constraints, nothing billed) is a failover
 * reason here and never a breaker failure. Never throws.
 */
export function recordPoolFailover(capability: PoolCapability, from: string | null, to: string | null, reason: PoolFailoverReason): void {
  try {
    recordPipelineTelemetry("capability_pool.failover", 1, { capability, from: from ?? "unknown", to: to ?? "none", reason });
    console.warn(`[capability-pools] failover capability=${capability} from=${from ?? "unknown"} to=${to ?? "none"} reason=${reason}`);
  } catch {
    // Telemetry never fails a read.
  }
}
