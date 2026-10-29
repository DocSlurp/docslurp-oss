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
 */
export type VisionRoutingV2Setting =
  | { mode: "off" }
  | { mode: "on" }
  | { mode: "workspaces"; workspaceIds: ReadonlySet<string> };

export const VISION_ROUTING_V2_ENV = "VISION_ROUTING_V2";

export interface RoutingVersionOptions {
  /** Legacy vision routing v2 (VISION_ROUTING_V2). Defaults to off. */
  routingV2?: boolean;
}

/** Routing version recorded in stage stats so telemetry can tell canary runs apart. */
export function routingVersion(routingV2: boolean): "v2" | "v1" {
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
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > 0 && entries.every((entry) => WORKSPACE_ID.test(entry) && !RESERVED.has(entry.toLowerCase()))) {
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

const resolvedRuns = new WeakMap<WorkspaceRun, boolean>();

/**
 * Whether the run routes with v2, resolved once per run object so every stage of a run agrees
 * even if the environment changes mid-run.
 */
export function resolveRunRoutingV2(
  run: WorkspaceRun,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const cached = resolvedRuns.get(run);
  if (cached !== undefined) return cached;
  const enabled = visionRoutingV2Enabled(parseVisionRoutingV2(env[VISION_ROUTING_V2_ENV]), run.workspaceId);
  resolvedRuns.set(run, enabled);
  return enabled;
}

/** Test hook: forget which malformed values already warned. */
export function resetVisionRoutingV2WarningsForTest(): void {
  warnedValues.clear();
}
