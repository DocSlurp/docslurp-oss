import { emitTelemetryLog } from "@docslurp/shared/observability";
import { isBillingEnforced } from "@docslurp/shared";
import { providerCostLossItems, type ProviderCostLossItem, type ProviderCostLossOrgTotal } from "../usage-attribution.js";
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
 * from the last hour, never skip a later one. A new leader does not know the
 * alerts the previous one fired, so it cannot send their resolution.
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

/** Per-org checks from the window's SQL totals; orgs that fired before and are now below threshold resolve. */
export function providerCostLossChecks(
  orgs: readonly ProviderCostLossOrgTotal[],
  items: readonly ProviderCostLossItem[],
  thresholdCents: number,
  previouslyFiring: ReadonlySet<string>,
): AlertCheck[] {
  const models = new Map<string, Map<string, number>>();
  for (const item of items) {
    if (item.refunded || !item.topModel) continue;
    const org = models.get(item.orgId) ?? new Map<string, number>();
    org.set(item.topModel, (org.get(item.topModel) ?? 0) + item.lossCents);
    models.set(item.orgId, org);
  }
  const checks: AlertCheck[] = [];
  const seen = new Set<string>();
  for (const org of orgs) {
    seen.add(org.orgId);
    const firing = org.lossCents >= thresholdCents;
    if (!firing && !previouslyFiring.has(org.orgId)) continue;
    const topModels = [...(models.get(org.orgId) ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([model]) => model).join(",") || null;
    checks.push({
      id: `${PROVIDER_COST_LOSS_ALERT_PREFIX}${org.orgId}`,
      state: firing ? "firing" : "ok",
      severity: "warning",
      summary: firing
        ? `Org ${org.orgId} lost ${round(org.lossCents)}¢ in the last hour: provider cost ${round(org.providerCostCents)}¢ vs ${round(org.creditCents)} credits over ${org.items} item(s)`
        : `Org ${org.orgId} provider costs are back within credits charged`,
      details: {
        orgId: org.orgId, lossCents: round(org.lossCents), providerCostCents: round(org.providerCostCents), creditCents: round(org.creditCents),
        estimatedCostCents: round(org.estimatedCostCents), items: org.items, refundedItems: org.refundedItems, topModels, thresholdCents,
      },
    });
  }
  for (const orgId of previouslyFiring) {
    if (!seen.has(orgId)) checks.push(resolvedCheck(orgId, thresholdCents));
  }
  return checks;
}

function resolvedCheck(orgId: string, thresholdCents: number): AlertCheck {
  return { id: `${PROVIDER_COST_LOSS_ALERT_PREFIX}${orgId}`, state: "ok", severity: "warning",
    summary: `Org ${orgId} provider costs are back within credits charged`, details: { orgId, lossCents: 0, thresholdCents } };
}

export interface ProviderCostLossDeps {
  query: (args: { since: Date; until: Date }) => Promise<{ items: ProviderCostLossItem[]; orgs: ProviderCostLossOrgTotal[] }>;
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

const QUERY_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class ProviderCostLossMonitor {
  private lastRunAt = 0;
  private lastChecks: AlertCheck[] = [];
  private readonly firing = new Set<string>();
  private readonly emitted = new Map<string, number>();

  constructor(private readonly settings: ProviderCostLossSettings, private readonly deps: ProviderCostLossDeps = defaultDeps) {}

  /** Checks for this evaluation; between runs the previous checks are returned unchanged. */
  async evaluate(): Promise<AlertCheck[]> {
    if (this.settings.thresholdCents <= 0 || !this.deps.billingEnforced()) {
      // Turned off while an alert fired: resolve it rather than leave it active forever.
      const resolved = [...this.firing].map((orgId) => resolvedCheck(orgId, this.settings.thresholdCents));
      this.firing.clear();
      this.lastChecks = [];
      return resolved;
    }
    const now = this.deps.now();
    if (this.lastRunAt && now - this.lastRunAt < this.settings.intervalMs) return this.lastChecks;
    this.lastRunAt = now;
    const until = new Date(now - this.settings.settleMs);
    const since = new Date(until.getTime() - this.settings.windowMs);
    let items: ProviderCostLossItem[];
    let orgs: ProviderCostLossOrgTotal[];
    try {
      // The statement timeout bounds the database; this bounds the whole call so a tick never stalls on it.
      ({ items, orgs } = await withTimeout(this.deps.query({ since, until }), QUERY_TIMEOUT_MS));
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
    this.lastChecks = providerCostLossChecks(orgs, items, this.settings.thresholdCents, this.firing);
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
