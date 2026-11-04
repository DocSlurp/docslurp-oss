import { emitTelemetryLog } from "@docslurp/shared/observability";
import { isBillingEnforced } from "@docslurp/shared";
import { providerCostLossItems, type ProviderCostLossItem } from "../usage-attribution.js";
import type { AlertCheck } from "./alert-rules.js";

/**
 * Loss alerts: an item (chat turn, finished run, search session) whose
 * provider cost exceeded the credits it charged. Provider cost is the
 * provider-reported charge, or the live/hardcoded list-price estimate where no
 * receipt arrived, so a loss "at list price" alerts as well as a measured one.
 *
 * - Every loss item emits one `docslurp.billing.provider_cost_loss` telemetry
 *   event (warn), once per item per process.
 * - Per organization, losses summed over the last hour (refunded turns
 *   excluded: their loss is the refund policy) fire
 *   `provider-cost-loss:<orgId>` at ALERT_PROVIDER_LOSS_CENTS (default 100,
 *   i.e. $1), through the normal alert tracker and delivery.
 *
 * Runs on the alert leader only, at most every ALERT_PROVIDER_LOSS_INTERVAL_MS
 * (default 5 minutes), and only where billing is enforced (with billing off
 * every item charges 0 credits). ALERT_PROVIDER_LOSS_CENTS=0 disables it.
 * Item dedupe is in memory: a new leader or a restart can re-emit an item
 * from the last hour, never skip a later one.
 */

export interface ProviderCostLossSettings {
  thresholdCents: number;
  intervalMs: number;
  /** Items whose last event is newer than this are left to settle (late usage writes). */
  settleMs: number;
  windowMs: number;
}

export function resolveProviderCostLossSettings(env: NodeJS.ProcessEnv = process.env): ProviderCostLossSettings {
  const read = (name: string, fallback: number, min = 0) => {
    const value = Number(env[name]?.trim());
    return env[name]?.trim() && Number.isFinite(value) && value >= min ? value : fallback;
  };
  return {
    thresholdCents: read("ALERT_PROVIDER_LOSS_CENTS", 100),
    intervalMs: read("ALERT_PROVIDER_LOSS_INTERVAL_MS", 5 * 60_000, 10_000),
    settleMs: read("ALERT_PROVIDER_LOSS_SETTLE_MS", 2 * 60_000),
    windowMs: 60 * 60_000,
  };
}

export const PROVIDER_COST_LOSS_ALERT_PREFIX = "provider-cost-loss:";

const round = (cents: number) => Math.round(cents * 10_000) / 10_000;

/** Per-org checks from the window's loss items; orgs that fired before and are now below threshold resolve. */
export function providerCostLossChecks(
  items: readonly ProviderCostLossItem[],
  thresholdCents: number,
  previouslyFiring: ReadonlySet<string>,
): AlertCheck[] {
  const byOrg = new Map<string, { loss: number; cost: number; credits: number; estimated: number; items: number; refundedItems: number; models: Map<string, number> }>();
  for (const item of items) {
    const org = byOrg.get(item.orgId) ?? { loss: 0, cost: 0, credits: 0, estimated: 0, items: 0, refundedItems: 0, models: new Map() };
    if (item.refunded) org.refundedItems += 1;
    else {
      org.loss += item.lossCents; org.cost += item.providerCostCents; org.credits += item.creditCents;
      org.estimated += item.estimatedCostCents; org.items += 1;
      if (item.topModel) org.models.set(item.topModel, (org.models.get(item.topModel) ?? 0) + item.lossCents);
    }
    byOrg.set(item.orgId, org);
  }
  const checks: AlertCheck[] = [];
  for (const [orgId, org] of byOrg) {
    const firing = org.loss >= thresholdCents;
    if (!firing && !previouslyFiring.has(orgId)) continue;
    const topModels = [...org.models].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([model]) => model).join(",") || null;
    checks.push({
      id: `${PROVIDER_COST_LOSS_ALERT_PREFIX}${orgId}`,
      state: firing ? "firing" : "ok",
      severity: "warning",
      summary: firing
        ? `Org ${orgId} lost ${round(org.loss)}¢ in the last hour: provider cost ${round(org.cost)}¢ vs ${round(org.credits)} credits over ${org.items} item(s)`
        : `Org ${orgId} provider costs are back within credits charged`,
      details: {
        orgId, lossCents: round(org.loss), providerCostCents: round(org.cost), creditCents: round(org.credits),
        estimatedCostCents: round(org.estimated), items: org.items, refundedItems: org.refundedItems, topModels, thresholdCents,
      },
    });
  }
  for (const orgId of previouslyFiring) {
    if (byOrg.has(orgId)) continue;
    checks.push({ id: `${PROVIDER_COST_LOSS_ALERT_PREFIX}${orgId}`, state: "ok", severity: "warning",
      summary: `Org ${orgId} provider costs are back within credits charged`, details: { orgId, lossCents: 0, thresholdCents } });
  }
  return checks;
}

export interface ProviderCostLossDeps {
  query: (args: { since: Date; until: Date }) => Promise<ProviderCostLossItem[]>;
  now: () => number;
  emit: (item: ProviderCostLossItem) => void;
  billingEnforced: () => boolean;
}

const defaultDeps: ProviderCostLossDeps = {
  query: (args) => providerCostLossItems(args),
  now: Date.now,
  emit: (item) => {
    const attributes = {
      "docslurp.loss.kind": item.kind, "docslurp.loss.key": item.key, "docslurp.orgId": item.orgId,
      "docslurp.loss.credit_cents": round(item.creditCents), "docslurp.loss.provider_cost_cents": round(item.providerCostCents),
      "docslurp.loss.estimated_cost_cents": round(item.estimatedCostCents), "docslurp.loss.loss_cents": round(item.lossCents),
      "docslurp.loss.refunded": item.refunded, "docslurp.loss.top_model": item.topModel ?? "",
    };
    console.warn(`[billing] provider_cost_loss kind=${item.kind} key=${item.key} org=${item.orgId} loss_cents=${round(item.lossCents)} provider_cost_cents=${round(item.providerCostCents)} credit_cents=${round(item.creditCents)} estimated_cost_cents=${round(item.estimatedCostCents)} refunded=${item.refunded} top_model=${item.topModel ?? ""}`);
    emitTelemetryLog({ eventName: "docslurp.billing.provider_cost_loss", severityText: item.refunded ? "info" : "warn", body: "Provider cost exceeded credits charged", attributes });
  },
  billingEnforced: () => isBillingEnforced(),
};

export class ProviderCostLossMonitor {
  private lastRunAt = 0;
  private lastChecks: AlertCheck[] = [];
  private readonly firing = new Set<string>();
  private readonly emitted = new Map<string, number>();

  constructor(private readonly settings: ProviderCostLossSettings, private readonly deps: ProviderCostLossDeps = defaultDeps) {}

  /** Checks for this evaluation; between runs the previous checks are returned unchanged. */
  async evaluate(): Promise<AlertCheck[]> {
    if (this.settings.thresholdCents <= 0 || !this.deps.billingEnforced()) return [];
    const now = this.deps.now();
    if (this.lastRunAt && now - this.lastRunAt < this.settings.intervalMs) return this.lastChecks;
    this.lastRunAt = now;
    const until = new Date(now - this.settings.settleMs);
    const since = new Date(until.getTime() - this.settings.windowMs);
    let items: ProviderCostLossItem[];
    try {
      items = await this.deps.query({ since, until });
    } catch (error) {
      console.error(`[alert] provider_cost_loss query failed: ${error instanceof Error ? error.message : String(error)}`);
      this.lastChecks = [...this.firing].map((orgId) => ({ id: `${PROVIDER_COST_LOSS_ALERT_PREFIX}${orgId}` as const, state: "unknown" as const, reason: "loss query failed" }));
      return this.lastChecks;
    }
    for (const item of items) {
      const key = `${item.kind}:${item.key}:${item.orgId}`;
      if (this.emitted.has(key)) continue;
      this.emitted.set(key, now);
      this.deps.emit(item);
    }
    // Remember items only as long as they can reappear in the window.
    for (const [key, at] of this.emitted) if (now - at > this.settings.windowMs + this.settings.settleMs) this.emitted.delete(key);
    this.lastChecks = providerCostLossChecks(items, this.settings.thresholdCents, this.firing);
    for (const check of this.lastChecks) {
      const orgId = check.id.slice(PROVIDER_COST_LOSS_ALERT_PREFIX.length);
      if (check.state === "firing") this.firing.add(orgId);
      else if (check.state === "ok") this.firing.delete(orgId);
    }
    return this.lastChecks;
  }

  /** Leadership moved: forget firing state without resolving (the new leader owns it). */
  reset(): void {
    this.lastRunAt = 0;
    this.lastChecks = [];
    this.firing.clear();
  }
}
