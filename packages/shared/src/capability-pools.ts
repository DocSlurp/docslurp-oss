/**
 * Capability pools: for each billed page capability, the named, ordered list of providers or services that can serve
 * it, with automatic failover down the list.
 *
 * - `text`: text-layer conversion (a PDF's own text, in a sandboxed VM or, for customer-owned execution, locally).
 * - `ocr`: scanned page reading. Stage `read` is the first read (an OCR recogniser or a page image reader service);
 *   stage `second-read` is the hosted re-read of a page the first read doubts (ocr-escalation-routes.ts).
 * - `vision`: vision-model interpretation of a page (the default vision model and its automatic fallback).
 *
 * A member is either an LLM route (a model plus a host allowlist) or a registered service (a plugin backend id). Every
 * member records where it processes pages (from stated evidence only, never from a company's headquarters), whether
 * the pool may fail over to it automatically, its measured quality and pages per $1 (each with the eval run that
 * measured it), and its admission check (the automatic-call margin gate for LLM routes; a service's own budgets).
 *
 * Open defaults: core defines the LLM members below and the built-in local services; a deployment's plugins register
 * service members by id (the extractor plugin `poolMembers`, worker extractors/plugins.ts). OSS builds, tests and fails
 * over with only these defaults. Prices, margins and multipliers are not part of a pool: the margin gate asks the
 * pricing provider at call time.
 *
 * Every member has a stable, public-safe id, `<capability>.<kind>.<engine>.<region>` (`ocr.llm.glm-5.3-flash+wafer.us`,
 * `text.service.vm-pdf.us`), that is stamped wherever a member serves a page (read results, usage metadata), so a
 * per-page extract record can say what produced it. It never names a private fork, a host credential or a price.
 */
import { automaticCallMarginDecision, visionAutomaticRoute, type AutomaticCallDecision, type AutomaticCallRoute } from "./automatic-call-margin.js";
import { OCR_ESCALATION_ROUTES, ocrEscalationAutomaticRoute, type OcrEscalationRoute } from "./ocr-escalation-routes.js";
import { hostMatchesEndpoint } from "./provider-pools.js";

export const POOL_CAPABILITIES = ["text", "ocr", "vision"] as const;
export type PoolCapability = (typeof POOL_CAPABILITIES)[number];
export type PoolMemberKind = "llm" | "service";
/** `read`: serves the page; `second-read` (ocr only): re-reads a page the first read doubts. */
export type PoolMemberStage = "read" | "second-read";
/** Where a member processes pages. `local`: inside this deployment (built-in members only). */
export type PoolRegion = "US" | "EU" | "local";
export type PoolRegionEvidenceKind = "endpoint-tag" | "provider-docs" | "openrouter-metadata" | "deployment";

/** Where one host (or service) processes pages, and the stated evidence. */
export interface PoolRegionEvidence {
  readonly region: PoolRegion;
  readonly evidence: PoolRegionEvidenceKind;
  /** URL or endpoint tag the evidence comes from. */
  readonly source: string;
  /** YYYY-MM-DD the evidence was checked. */
  readonly checked: string;
}

/** A measurement with the eval run that produced it. */
export interface PoolMeasurement {
  readonly value: number;
  readonly evalRef: string;
}

/** Fields shared by every member. */
interface PoolMemberBase {
  /** `<capability>.<kind>.<engine>.<region>`: stable, public-safe, a bounded telemetry label (poolMemberId). */
  readonly id: string;
  readonly capability: PoolCapability;
  readonly kind: PoolMemberKind;
  readonly stage: PoolMemberStage;
  /** Generic engine or route label (`glm-5.3-flash+wafer`, `vm-pdf`). */
  readonly engine: string;
  /** Region of the member: every host's region (`US`, `EU`, `local`), joined when they differ (`US+EU`). */
  readonly region: string;
  /** Per-host (LLM) or per-service evidence. */
  readonly regions: readonly PoolRegionEvidence[];
  /** The pool may move to this member on its own when an earlier member refuses or is unavailable. */
  readonly automaticFailover: boolean;
  /** Tier-benchmark composite (tolerant-markdown@v1 `content`), or null when unmeasured. */
  readonly quality: PoolMeasurement | null;
  /** Measured pages per $1 of provider cost, or null when unmeasured. */
  readonly pagesPerDollar: PoolMeasurement | null;
  /** `margin-gate`: automatic-call margin gate at call time; `service-budget`: the service's own budgets and caps; `none`: the project chose it. */
  readonly admission: "margin-gate" | "service-budget" | "none";
  /** Defined by core (open default), not registered by a plugin. */
  readonly builtin: boolean;
}

export interface LlmPoolMember extends PoolMemberBase {
  readonly kind: "llm";
  /** `llm://` model URI. */
  readonly model: string;
  /** OpenRouter endpoint tags (or a direct provider slug) the route is restricted to. */
  readonly hosts: readonly string[];
  /** For an OCR second read: the escalation route (with its price ceiling) this member sends. */
  readonly escalationRoute?: OcrEscalationRoute;
}

export interface ServicePoolMember extends PoolMemberBase {
  readonly kind: "service";
  /** The plugin backend id that serves it (a provider's `id`). */
  readonly backend: string;
}

export type CapabilityPoolMember = LlmPoolMember | ServicePoolMember;

/** What a plugin registers for one of its services (extractor plugin `poolMembers`). */
export interface CapabilityPoolServiceRegistration {
  readonly capability: PoolCapability;
  /** Defaults to `read`. `second-read` only for `ocr`. */
  readonly stage?: PoolMemberStage;
  /** The provider id of the plugin service that serves it (sandboxedPdf / sandboxedOcr / pageImageReader `id`). */
  readonly backend: string;
  /** Generic, public-safe engine label for the member id: lowercase letters, digits and `-`, 2-24 characters. */
  readonly engine: string;
  /** Where the service processes pages, with stated evidence. `local` is refused for a plugin. */
  readonly regions: readonly PoolRegionEvidence[];
  readonly automaticFailover: boolean;
  readonly quality?: PoolMeasurement | null;
  readonly pagesPerDollar?: PoolMeasurement | null;
  /** Position among the capability's service members (lower first); ties keep registration order. */
  readonly priority?: number;
}

export type CapabilityPools = Readonly<Record<PoolCapability, readonly CapabilityPoolMember[]>>;

/** Why a pool moved past a member (bounded telemetry label). */
export const POOL_FAILOVER_REASONS = ["margin", "routing", "unavailable", "privacy", "error", "unsupported"] as const;
export type PoolFailoverReason = (typeof POOL_FAILOVER_REASONS)[number];

const ENGINE = /^[a-z0-9][a-z0-9.-]{0,30}(\+[a-z0-9][a-z0-9-]{0,20})?$/;
const SERVICE_ENGINE = /^[a-z][a-z0-9-]{1,23}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Hosts whose processing region is stated, by provider slug, when the endpoint tag itself names no region. Only stated
 * evidence: a provider's own documentation (quoted at the source) or OpenRouter's provider `datacenters` metadata. A
 * provider whose documentation allows processing anywhere (a "global" default) is not listed, whatever its headquarters.
 */
export const POOL_PROVIDER_REGIONS: Readonly<Record<string, PoolRegionEvidence>> = Object.freeze({
  // "all information you provide will be maintained on web servers and systems located within the U.S."
  friendli: { region: "US", evidence: "provider-docs", source: "https://friendli.ai/privacypolicy", checked: "2026-10-26" },
  // "Your data may be transferred, stored, and processed outside of your jurisdiction, specifically in the United States."
  deepinfra: { region: "US", evidence: "provider-docs", source: "https://deepinfra.com/privacy", checked: "2026-10-26" },
  // "Specifically, we have servers for the Service in the US."
  fireworks: { region: "US", evidence: "provider-docs", source: "https://fireworks.ai/privacy-policy", checked: "2026-10-26" },
  gmicloud: { region: "US", evidence: "openrouter-metadata", source: "https://openrouter.ai/api/v1/providers", checked: "2026-10-26" },
  morph: { region: "US", evidence: "openrouter-metadata", source: "https://openrouter.ai/api/v1/providers", checked: "2026-10-26" },
});

/** The region an endpoint tag states (`wafer/us`, `amazon-bedrock/us-east-1`, `google-vertex/europe`), or null. */
export function endpointTagRegion(host: string): "US" | "EU" | null {
  const segments = host.trim().toLowerCase().split("/").slice(1);
  for (const segment of segments) {
    if (/^us(-[a-z]+-\d+)?$/.test(segment)) return "US";
    if (/^(eu|europe)(-[a-z]+-\d+)?$/.test(segment)) return "EU";
  }
  return null;
}

/** Stated region evidence for a host, or null when nothing states one (never inferred from headquarters). */
export function poolHostRegion(host: string, checked = "2026-11-17"): PoolRegionEvidence | null {
  const tagged = endpointTagRegion(host);
  if (tagged) return { region: tagged, evidence: "endpoint-tag", source: host, checked };
  const segments = host.trim().toLowerCase().split("/");
  // A provider-level statement covers its endpoints unless the tag names a region of its own (handled above) or a
  // non-regional routing tier that may route elsewhere (`/global`).
  if (segments.slice(1).some((segment) => segment === "global")) return null;
  return POOL_PROVIDER_REGIONS[segments[0]!] ?? null;
}

function regionLabel(regions: readonly PoolRegionEvidence[]): string {
  return [...new Set(regions.map((entry) => entry.region))].sort().join("+");
}

/** `<capability>.<kind>.<engine>.<region>` with the region lowercased (`us`, `eu`, `eu+us`, `local`). */
export function poolMemberId(capability: PoolCapability, kind: PoolMemberKind, engine: string, region: string): string {
  return `${capability}.${kind}.${engine}.${region.toLowerCase()}`;
}

function llmMember(spec: {
  capability: PoolCapability; stage: PoolMemberStage; engine: string; model: string; hosts: readonly string[];
  automaticFailover: boolean; quality: PoolMeasurement | null; pagesPerDollar: PoolMeasurement | null;
  admission: LlmPoolMember["admission"]; escalationRoute?: OcrEscalationRoute;
}): LlmPoolMember {
  const regions = spec.hosts.map((host) => {
    const found = poolHostRegion(host);
    if (!found) throw new Error(`capability pool ${spec.capability}/${spec.engine}: host ${host} has no stated US or EU region`);
    return found;
  });
  const region = regionLabel(regions);
  return Object.freeze({
    id: poolMemberId(spec.capability, "llm", spec.engine, region), capability: spec.capability, kind: "llm" as const, stage: spec.stage,
    engine: spec.engine, region, regions: Object.freeze(regions), automaticFailover: spec.automaticFailover, quality: spec.quality,
    pagesPerDollar: spec.pagesPerDollar, admission: spec.admission, builtin: true, model: spec.model, hosts: Object.freeze([...spec.hosts]),
    ...(spec.escalationRoute ? { escalationRoute: spec.escalationRoute } : {}),
  });
}

const CANDIDATES_RUN = "tier-benchmark-v1/page-ocr/development/dev-page-ocr-20261117-pool-candidates";
const GLM_WAFER_RUN = "tier-benchmark-v1/page-ocr/development/dev-page-ocr-20261116-glm-wafer";
const QWEN_RUN = "tier-benchmark-v1/page-ocr/development/dev-page-ocr-20261114-gpu-tier";

/** Engine labels of the OCR second-read routes, by OCR route option id (OCR_ESCALATION_ROUTES). */
const SECOND_READ_MEASUREMENTS: Readonly<Record<string, { engine: string; quality: PoolMeasurement | null; pagesPerDollar: PoolMeasurement | null }>> = {
  // Pinned wafer/us, markdown-transcription (the escalation prompt): composite 0.932 (text 0.918, tables 0.927, math 1.000).
  "scan-ocr/hosted-escalation-glm": { engine: "glm-5.3-flash+wafer", quality: { value: 0.932, evalRef: GLM_WAFER_RUN }, pagesPerDollar: { value: 3454, evalRef: GLM_WAFER_RUN } },
  // Pinned morph/fp8, escalation prompt: composite 0.927 (text 0.907, tables 0.931, math 1.000); p50 54 s a page.
  "scan-ocr/hosted-escalation-glm-morph": { engine: "glm-5.3-flash+morph", quality: { value: 0.927, evalRef: CANDIDATES_RUN }, pagesPerDollar: { value: 3549, evalRef: CANDIDATES_RUN } },
  // Production route and prompt: composite 0.913 (text 0.922, tables 0.874, math 0.989).
  "scan-ocr/hosted-escalation": { engine: "qwen3-vl-30b-a3b+deepinfra", quality: { value: 0.913, evalRef: QWEN_RUN }, pagesPerDollar: null },
};

/** The OCR second-read members: the escalation routes, in order, each its own member. */
function secondReadMembers(routes: readonly OcrEscalationRoute[]): LlmPoolMember[] {
  return routes.map((route) => {
    const measured = SECOND_READ_MEASUREMENTS[route.optionId];
    const hosts = route.priceCeiling?.hosts ?? (route.model.startsWith("llm://deepinfra/") ? ["deepinfra"] : null);
    if (!measured || !hosts) throw new Error(`capability pool ocr: escalation route ${route.optionId} has no pool member definition`);
    return llmMember({ capability: "ocr", stage: "second-read", engine: measured.engine, model: route.model, hosts, automaticFailover: true,
      quality: measured.quality, pagesPerDollar: measured.pagesPerDollar, admission: "margin-gate", escalationRoute: route });
  });
}

/** GPT-6 Luna, the default vision model, on its US hosts (worker vision-model-profiles.ts keeps the same allowlist). */
export const VISION_LUNA_HOSTS = Object.freeze(["amazon-bedrock/us-east-1", "azure/us"]);
/** GLM 5.3 Flash's vision hosts with a stated US region (worker vision-model-profiles.ts keeps the same allowlist). */
export const VISION_GLM_HOSTS = Object.freeze(["wafer/us", "friendli", "inference-net/us"]);

const VISION_MEMBERS: readonly LlmPoolMember[] = Object.freeze([
  // Production vision prompt (page-markdown-latex), pinned Bedrock us-east-1: composite 0.931 (text 0.928, tables 0.904,
  // math 1.000). Azure us with the transcription prompt: 0.935.
  llmMember({ capability: "vision", stage: "read", engine: "gpt-6-luna", model: "llm://openrouter/openai/gpt-6-luna", hosts: VISION_LUNA_HOSTS,
    automaticFailover: false, quality: { value: 0.931, evalRef: CANDIDATES_RUN }, pagesPerDollar: { value: 1649, evalRef: CANDIDATES_RUN }, admission: "none" }),
  // The deployment's default automatic fallback (DOCSLURP_VISION_FALLBACK_MODEL overrides it): composite 0.932 on
  // wafer/us and on friendli, 0.927 on inference-net/us (production prompt). Admitted per call by the margin gate.
  llmMember({ capability: "vision", stage: "read", engine: "glm-5.3-flash", model: "llm://openrouter/z-ai/glm-5.3-flash", hosts: VISION_GLM_HOSTS,
    automaticFailover: true, quality: { value: 0.932, evalRef: CANDIDATES_RUN }, pagesPerDollar: { value: 1569, evalRef: CANDIDATES_RUN }, admission: "margin-gate" }),
]);

/** Core's LLM members, in pool order. */
export function builtinLlmPoolMembers(routes: readonly OcrEscalationRoute[] = OCR_ESCALATION_ROUTES): LlmPoolMember[] {
  return [...secondReadMembers(routes), ...VISION_MEMBERS];
}

/** A built-in service that runs inside this deployment (customer-owned local execution). */
export function localServiceMember(capability: PoolCapability, backend: string, engine: string): ServicePoolMember {
  const regions = [{ region: "local" as const, evidence: "deployment" as const, source: "this deployment", checked: "2026-11-17" }];
  return Object.freeze({ id: poolMemberId(capability, "service", engine, "local"), capability, kind: "service" as const, stage: "read" as const,
    engine, region: "local", regions: Object.freeze(regions), automaticFailover: false, quality: null, pagesPerDollar: null,
    admission: "service-budget" as const, builtin: true, backend });
}

const validMeasurement = (value: PoolMeasurement | null | undefined, max: number) => value == null
  || (typeof value.value === "number" && Number.isFinite(value.value) && value.value >= 0 && value.value <= max && typeof value.evalRef === "string" && value.evalRef.trim().length > 0);

/** A plugin's registration as a member; throws listing what is wrong. `local` regions are refused for plugins. */
export function serviceMemberFromRegistration(registration: CapabilityPoolServiceRegistration): ServicePoolMember {
  const problems: string[] = [];
  if (!POOL_CAPABILITIES.includes(registration.capability)) problems.push(`unknown capability ${String(registration.capability)}`);
  const stage = registration.stage ?? "read";
  if (stage !== "read" && !(stage === "second-read" && registration.capability === "ocr")) problems.push(`stage ${stage} is not valid for ${registration.capability}`);
  if (!SERVICE_ENGINE.test(registration.engine ?? "")) problems.push("engine must be 2-24 lowercase letters, digits or -");
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(registration.backend ?? "")) problems.push("backend must be the provider's lowercase id");
  if (!Array.isArray(registration.regions) || registration.regions.length === 0) problems.push("regions must state where the service processes pages");
  for (const entry of registration.regions ?? []) {
    if (entry.region !== "US" && entry.region !== "EU") problems.push(`region ${String(entry.region)} is not US or EU`);
    if (!["endpoint-tag", "provider-docs", "openrouter-metadata"].includes(entry.evidence)) problems.push(`region evidence ${String(entry.evidence)} is not stated evidence`);
    if (typeof entry.source !== "string" || !entry.source.trim()) problems.push("region evidence needs a source");
    if (!DATE.test(entry.checked ?? "")) problems.push("region evidence needs a checked date (YYYY-MM-DD)");
  }
  if (typeof registration.automaticFailover !== "boolean") problems.push("automaticFailover must be true or false");
  if (!validMeasurement(registration.quality, 1)) problems.push("quality must be 0-1 with an evalRef");
  if (!validMeasurement(registration.pagesPerDollar, 10_000_000)) problems.push("pagesPerDollar must be positive with an evalRef");
  if (registration.priority !== undefined && !Number.isFinite(registration.priority)) problems.push("priority must be a number");
  if (problems.length) throw new Error(`capability pool member ${registration.capability}/${registration.engine}: ${problems.join("; ")}`);
  const regions = registration.regions.map((entry) => Object.freeze({ ...entry }));
  const region = regionLabel(regions);
  return Object.freeze({
    id: poolMemberId(registration.capability, "service", registration.engine, region), capability: registration.capability, kind: "service" as const,
    stage, engine: registration.engine, region, regions: Object.freeze(regions), automaticFailover: registration.automaticFailover,
    quality: registration.quality ?? null, pagesPerDollar: registration.pagesPerDollar ?? null, admission: "service-budget" as const, builtin: false,
    backend: registration.backend,
  });
}

/**
 * Resolve the pools: service members first in each capability (by priority, then registration order), then core's LLM
 * members, each capability's `read` stage before its `second-read` stage. `DOCSLURP_CAPABILITY_POOL_<CAPABILITY>` (member
 * ids, comma-separated) sets a pool's members and order explicitly; an id it names that is not defined is an error.
 */
export function resolveCapabilityPools(args: {
  services?: readonly ServicePoolMember[];
  llm?: readonly LlmPoolMember[];
  env?: Record<string, string | undefined>;
} = {}): CapabilityPools {
  const services = args.services ?? [];
  const llm = args.llm ?? builtinLlmPoolMembers();
  const env = args.env ?? (typeof process !== "undefined" ? process.env : {});
  const all: CapabilityPoolMember[] = [...services, ...llm];
  const ids = new Set<string>();
  for (const member of all) {
    if (ids.has(member.id)) throw new Error(`capability pool member ${member.id} is defined twice`);
    if (!/^[a-z]+\.(llm|service)\./.test(member.id) || !ENGINE.test(member.engine) || member.id.length > 48) throw new Error(`capability pool member id ${member.id} is not a bounded label`);
    ids.add(member.id);
  }
  const indexed = services.map((member, index) => ({ member, index }));
  const out = {} as Record<PoolCapability, readonly CapabilityPoolMember[]>;
  for (const capability of POOL_CAPABILITIES) {
    const configured = env[`DOCSLURP_CAPABILITY_POOL_${capability.toUpperCase()}`]?.trim();
    let members: CapabilityPoolMember[];
    if (configured) {
      members = configured.split(",").map((id) => id.trim()).filter(Boolean).map((id) => {
        const member = all.find((candidate) => candidate.id === id);
        if (!member) throw new Error(`DOCSLURP_CAPABILITY_POOL_${capability.toUpperCase()} names ${id}, which no core definition or plugin registers`);
        if (member.capability !== capability) throw new Error(`DOCSLURP_CAPABILITY_POOL_${capability.toUpperCase()} names ${id}, a ${member.capability} member`);
        return member;
      });
      if (new Set(members.map((member) => member.id)).size !== members.length) throw new Error(`DOCSLURP_CAPABILITY_POOL_${capability.toUpperCase()} names a member twice`);
    } else {
      const ordered = indexed.filter(({ member }) => member.capability === capability)
        .sort((a, b) => ((priorities.get(a.member) ?? 0) - (priorities.get(b.member) ?? 0)) || a.index - b.index).map(({ member }) => member);
      members = [...ordered, ...llm.filter((member) => member.capability === capability)];
    }
    const stageRank = (member: CapabilityPoolMember) => (member.stage === "read" ? 0 : 1);
    out[capability] = Object.freeze(members.map((member, index) => ({ member, index }))
      .sort((a, b) => stageRank(a.member) - stageRank(b.member) || a.index - b.index).map(({ member }) => member));
  }
  return Object.freeze(out);
}

/** Registration priorities (registerServicePoolMember), read by resolveCapabilityPools. */
const priorities = new WeakMap<ServicePoolMember, number>();

/** serviceMemberFromRegistration, keeping the registration's priority for resolveCapabilityPools. */
export function registerServicePoolMember(registration: CapabilityPoolServiceRegistration): ServicePoolMember {
  const member = serviceMemberFromRegistration(registration);
  if (registration.priority !== undefined) priorities.set(member, registration.priority);
  return member;
}

/**
 * Every member sends customer pages, so every member must process them in the US or EU, from stated evidence, or run
 * inside this deployment (a built-in member only). Returns the problems (empty when the pools may serve).
 */
export function capabilityPoolRegionProblems(pools: CapabilityPools): string[] {
  const problems: string[] = [];
  for (const capability of POOL_CAPABILITIES) {
    for (const member of pools[capability]) {
      if (member.regions.length === 0) problems.push(`${member.id}: no region evidence`);
      for (const entry of member.regions) {
        const ok = entry.region === "US" || entry.region === "EU" || (entry.region === "local" && member.builtin && entry.evidence === "deployment");
        if (!ok) problems.push(`${member.id}: region ${String(entry.region)} (${String(entry.evidence)}) is not US, EU or this deployment`);
      }
      if (member.kind === "llm") {
        for (const host of member.hosts) {
          const stated = poolHostRegion(host);
          if (!stated) problems.push(`${member.id}: host ${host} has no stated US or EU region`);
        }
      }
    }
  }
  return problems;
}

/** Throws when any member may send a customer page outside the US and EU (worker startup refuses to run). */
export function assertCapabilityPoolRegions(pools: CapabilityPools): void {
  const problems = capabilityPoolRegionProblems(pools);
  if (problems.length) throw new Error(`capability pools send customer pages outside the US and EU or to an unknown region; refusing to start: ${problems.join("; ")}`);
}

/** One log line: each pool in order, `*` marking members the pool fails over to automatically. */
export function capabilityPoolsLogLine(pools: CapabilityPools): string {
  return `[capability-pools] ${POOL_CAPABILITIES.map((capability) => `${capability}=${pools[capability].map((member) => `${member.id}${member.automaticFailover ? "*" : ""}`).join(">") || "none"}`).join(" ")}`;
}

/** What a worker advertises and the ops fleet view shows: member ids in order, with stage, region and failover. */
export interface AdvertisedCapabilityPools {
  readonly [capability: string]: ReadonlyArray<{ id: string; stage: PoolMemberStage; region: string; failover: boolean; quality: number | null }>;
}

export function advertisedCapabilityPools(pools: CapabilityPools): AdvertisedCapabilityPools {
  return Object.fromEntries(POOL_CAPABILITIES.map((capability) => [capability, pools[capability].map((member) => ({
    id: member.id, stage: member.stage, region: member.region, failover: member.automaticFailover, quality: member.quality?.value ?? null,
  }))]));
}

/** Defensive parse of an advertised summary (a worker registry row): anything malformed is dropped. */
export function parseAdvertisedCapabilityPools(value: unknown): AdvertisedCapabilityPools | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, Array<{ id: string; stage: PoolMemberStage; region: string; failover: boolean; quality: number | null }>> = {};
  for (const capability of POOL_CAPABILITIES) {
    const list = (value as Record<string, unknown>)[capability];
    if (!Array.isArray(list)) continue;
    out[capability] = list.slice(0, 16).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "string" || record.id.length > 48 || !/^[a-z0-9.+-]+$/.test(record.id)) return [];
      return [{
        id: record.id, stage: record.stage === "second-read" ? "second-read" as const : "read" as const,
        region: typeof record.region === "string" && record.region.length <= 12 ? record.region : "unknown",
        failover: record.failover === true, quality: typeof record.quality === "number" && Number.isFinite(record.quality) ? record.quality : null,
      }];
    });
  }
  return out;
}

let active: CapabilityPools | null = null;

/** The worker's resolved pools (set once at startup); core's defaults until then. */
export function activeCapabilityPools(): CapabilityPools {
  return active ?? (active = resolveCapabilityPools({ env: {} }));
}

export function setActiveCapabilityPools(pools: CapabilityPools): void {
  active = pools;
}

/** Test hook. */
export function resetActiveCapabilityPoolsForTests(): void {
  active = null;
}

/** The LLM member serving `model` for `capability` and `stage`, if any. */
export function poolMemberForModel(capability: PoolCapability, model: string, stage: PoolMemberStage = "read", pools: CapabilityPools = activeCapabilityPools()): LlmPoolMember | null {
  const bare = model.trim();
  const found = pools[capability].find((member): member is LlmPoolMember => member.kind === "llm" && member.stage === stage
    && (member.model === bare || member.model === `llm://openrouter/${bare}`));
  return found ?? null;
}

/** The service member served by plugin backend `backend` for `capability`, if any. */
export function poolMemberForBackend(capability: PoolCapability, backend: string, pools: CapabilityPools = activeCapabilityPools()): ServicePoolMember | null {
  return pools[capability].find((member): member is ServicePoolMember => member.kind === "service" && member.backend === backend) ?? null;
}

/**
 * The next member a pool fails over to automatically after `memberId` within its stage (vision: the default fallback),
 * or null.
 */
export function nextAutomaticPoolMember(capability: PoolCapability, memberId: string, pools: CapabilityPools = activeCapabilityPools()): CapabilityPoolMember | null {
  const members = pools[capability];
  const at = members.findIndex((member) => member.id === memberId);
  if (at < 0) return null;
  const stage = members[at]!.stage;
  return members.slice(at + 1).find((member) => member.stage === stage && member.automaticFailover) ?? null;
}

/** The automatic-call route an LLM member is priced on: its escalation route (price ceiling), else its vision route restricted to its hosts. */
export function poolMemberAutomaticRoute(member: LlmPoolMember): AutomaticCallRoute {
  if (member.escalationRoute) return ocrEscalationAutomaticRoute(member.escalationRoute);
  const base = visionAutomaticRoute(member.model);
  if (base.billing !== "openrouter") return base;
  // Never wider than the catalog's own allowlist; the member's hosts narrow it.
  const hosts = base.hosts?.length ? member.hosts.filter((host) => base.hosts!.some((allowed) => hostMatchesEndpoint(allowed, host) || allowed === host)) : [...member.hosts];
  return { ...base, hosts: hosts.length ? hosts : [...member.hosts] };
}

/**
 * The admission check of an LLM member for one page read: the automatic-call margin gate at the member's worst price
 * (`role`: `escalation` for a second read, `fallback` for a vision failover). Members a project chose (`admission:
 * none`) are not checked. Pure apart from the gate's price cache and pricing provider; never throws.
 */
export function poolMemberAdmission(member: LlmPoolMember, role: "escalation" | "fallback" | "pick", options: Parameters<typeof automaticCallMarginDecision>[2] = {}): AutomaticCallDecision | null {
  if (member.admission !== "margin-gate") return null;
  return automaticCallMarginDecision("page-transcription", poolMemberAutomaticRoute(member), { ...options, role });
}
