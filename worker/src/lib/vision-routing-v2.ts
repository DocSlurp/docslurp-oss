import type { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import type { WorkspaceRun } from "../models.js";

/**
 * Canary gate for legacy vision routing v2 (native word counts from the text layer, whole-word
 * labels, numeric-row tables, garbled-text and Unicode-math signals, structured routes for OCR'd
 * pages and the widened legacy vision selector). Read from `VISION_ROUTING_V2`:
 *
 * - `off` (default, also when unset or empty): routing as before v2.
 * - `on`: every run.
 * - a comma-separated list of workspace ids: runs in those workspaces only.
 *
 * Any other value reads as `off` with one warning per distinct value, so a typo never widens
 * the canary. Pure routing functions take the decision as `{ routingV2 }`; only stages call this.
 *
 * The environment is read once per run, when the run starts (`pinRunRoutingVersion` from
 * `startRun`), and the resolved version is persisted as a run artifact. Every later stage, shard
 * and page task of the run reads that artifact (`resolveRunRoutingV2`, v1 when it is missing), so
 * workers with different environments, retries and rehydrated runs all route the run the same way.
 */
export type VisionRoutingV2Setting =
  | { mode: "off" }
  | { mode: "on" }
  | { mode: "workspaces"; workspaceIds: ReadonlySet<string> };

export const VISION_ROUTING_V2_ENV = "VISION_ROUTING_V2";
/** Run artifact slot holding the run's resolved routing version (`v1` or `v2`). */
export const VISION_ROUTING_VERSION_SLOT = "run:vision-routing-version";

export type RoutingVersion = "v1" | "v2";

export interface RoutingVersionOptions {
  /** Legacy vision routing v2 (VISION_ROUTING_V2). Defaults to off. */
  routingV2?: boolean;
}

/** Routing version recorded in stage stats so telemetry can tell canary runs apart. */
export function routingVersion(routingV2: boolean): RoutingVersion {
  return routingV2 ? "v2" : "v1";
}

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// Boolean-looking words are mistakes for on/off, never workspace ids.
const RESERVED = new Set(["true", "false", "yes", "no", "1", "0", "enabled", "disabled", "all", "none", "on", "off"]);
const warnedValues = new Set<string>();

export function parseVisionRoutingV2(
  raw: string | undefined,
  warn: (message: string) => void = (message) => console.warn(message),
): VisionRoutingV2Setting {
  const value = raw?.trim() ?? "";
  const lower = value.toLowerCase();
  if (lower === "" || lower === "off") return { mode: "off" };
  if (lower === "on") return { mode: "on" };
  // Every entry is validated as written: an empty entry (`ws-a,,`, `,ws-a`, `ws-a,`) is a
  // malformed list, not a shorter one.
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.every((entry) => WORKSPACE_ID.test(entry) && !RESERVED.has(entry.toLowerCase()))) {
    return { mode: "workspaces", workspaceIds: new Set(entries) };
  }
  if (!warnedValues.has(value)) {
    warnedValues.add(value);
    warn(
      `[vision-routing] ${VISION_ROUTING_V2_ENV}=${JSON.stringify(value.slice(0, 200))} is not off, on or a ` +
        "comma-separated list of workspace ids; routing v2 stays off",
    );
  }
  return { mode: "off" };
}

export function visionRoutingV2Enabled(setting: VisionRoutingV2Setting, workspaceId: string | null | undefined): boolean {
  if (setting.mode === "on") return true;
  if (setting.mode === "off") return false;
  return typeof workspaceId === "string" && setting.workspaceIds.has(workspaceId);
}

type RunRoutingState = { run: Pick<WorkspaceRun, "id" | "workspaceId">; artifactLedger: DocumentArtifactLedger };

/**
 * Resolves the run's routing version from the environment unless the run already has one, and
 * records it in the run's artifacts (persisted by the caller's next checkpoint). Called by
 * `startRun` before any stage executes; idempotent, so a retried start keeps the first value.
 */
export function pinRunRoutingVersion(
  state: RunRoutingState,
  env: Record<string, string | undefined> = process.env,
): RoutingVersion {
  const stored = state.artifactLedger.read(VISION_ROUTING_VERSION_SLOT);
  if (stored === "v1" || stored === "v2") return stored;
  if (stored !== undefined) {
    // Unknown value (a later version this worker does not know): never widen to v2.
    console.warn(`[vision-routing] run=${state.run.id} has routing version ${JSON.stringify(stored.slice(0, 40))}; routing as v1`);
    return "v1";
  }
  const version = routingVersion(visionRoutingV2Enabled(parseVisionRoutingV2(env[VISION_ROUTING_V2_ENV]), state.run.workspaceId));
  state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, version);
  return version;
}

/**
 * Whether the run routes with v2: the version pinned at run start. Only `startRun` reads the
 * environment; a run without a pin (started before pins existed, or a state built outside
 * `startRun`) routes as v1, so no later stage, shard or retry can fill in a different value.
 */
export function resolveRunRoutingV2(state: RunRoutingState): boolean {
  const stored = state.artifactLedger.read(VISION_ROUTING_VERSION_SLOT);
  if (stored === "v2") return true;
  if (stored !== undefined && stored !== "v1") {
    console.warn(`[vision-routing] run=${state.run.id} has routing version ${JSON.stringify(stored.slice(0, 40))}; routing as v1`);
  }
  return false;
}

/** Test hook: forget which malformed values already warned. */
export function resetVisionRoutingV2WarningsForTest(): void {
  warnedValues.clear();
}
