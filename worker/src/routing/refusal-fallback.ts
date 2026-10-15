/**
 * Next-best target for a page a provider refused (deterministic content-filter refusal).
 *
 * The planned cascade leg may itself be the refusing vendor (Haiku refuses, Sonnet is the planned escalation), and
 * an assignment with no planned leg still needs an answer. This picks the best remaining hosted/private VLM that can
 * serve the assignment's role from a different vendor, ranked by the policy pack's fitted overall pass rate (when the
 * pack maps the target) and then by price. Pure.
 */

import type { Assignment, PolicyPack, PolicyTargetMapping, RoutingTarget } from "@docslurp/shared";

import { targetMappings } from "./policy.js";

/** Vendor key of a VLM target: `anthropic` for `llm://openrouter/anthropic/claude-haiku-5.5`, `private/<id>` for private endpoints. */
export function vendorOfTarget(target: Pick<RoutingTarget, "id" | "ref">): string {
  const uri = target.ref.modelUri ?? target.id;
  const path = uri.replace(/^llm:\/\//, "").replace(/^vlm:/, "");
  const parts = path.split("/");
  // llm://<provider>/<vendor>/<model> (openrouter) or llm://private/<model>.
  if (parts[0] === "private") return `private/${parts[1] ?? ""}`;
  return (parts.length >= 3 ? parts[1] : parts[0])!.toLowerCase();
}

export interface RefusalFallbackInput {
  assignment: Pick<Assignment, "role" | "targetId">;
  catalog: readonly RoutingTarget[];
  pack?: PolicyPack | null;
  /** Vendors that already refused this page. */
  refusedVendors: ReadonlySet<string>;
  /** Targets that must not be picked (already tried). */
  excludeTargetIds?: ReadonlySet<string>;
}

export function rankRefusalFallbacks(input: RefusalFallbackInput): RoutingTarget[] {
  const mapping = input.pack ? targetMappings(input.pack) : new Map<string, PolicyTargetMapping>();
  const outputPrice = (t: RoutingTarget) => t.pricing.outputUsdPerMTok ?? Number.POSITIVE_INFINITY;
  return input.catalog
    .filter((t) =>
      (t.kind === "hosted-vlm" || t.kind === "private-vlm")
      && !!t.ref.modelUri
      && t.roles.includes(input.assignment.role)
      && t.id !== input.assignment.targetId
      && !input.excludeTargetIds?.has(t.id)
      && !input.refusedVendors.has(vendorOfTarget(t)))
    .sort((a, b) => {
      const pa = mapping.get(a.id)?.pass.overall.baseRate ?? -1;
      const pb = mapping.get(b.id)?.pass.overall.baseRate ?? -1;
      return pb - pa || outputPrice(a) - outputPrice(b) || a.id.localeCompare(b.id);
    });
}
