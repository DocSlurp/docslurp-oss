import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { MediaProvider, MediaScope, AudioInput, Transcription } from "../types.js";
import { parseTranscription, jsonResponse } from "../providers.js";
import { capacityEndpoint } from "./network.js";
import { CapacityController } from "./controller.js";
import { DeepInfraCapacityProvider, VastCapacityProvider, type HostTemplate } from "./providers.js";
import type { CapacityLease, CapacityLeaseStore, CapacityProvider } from "./types.js";
export interface CapacitySettings {
  provider: string; template: HostTemplate; endpointTemplate: string;
  ttlMs: number; dailyBudgetUsd: number; maxConcurrent: number;
}
/** Operator-owned config only. Never accept a template or endpoint from an upload/workspace. */
export function capacitySettings(env: NodeJS.ProcessEnv = process.env): CapacitySettings | null {
  if (env.MEDIA_CAPACITY_ENABLED !== "true") return null;
  if (env.MEDIA_CAPACITY_HOST_CLASS_APPROVED !== "true" || !env.MEDIA_CAPACITY_CONFIG_FILE) throw new Error("Capacity host class and operator configuration must be approved");
  const settings = JSON.parse(readFileSync(env.MEDIA_CAPACITY_CONFIG_FILE, "utf8")) as CapacitySettings;
  for (const value of [settings.ttlMs, settings.dailyBudgetUsd, settings.maxConcurrent]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid capacity limits");
  }
  if (settings.ttlMs > 7200000 || settings.ttlMs < 60000 || !Number.isInteger(settings.maxConcurrent)) throw new Error("Invalid capacity lifetime/concurrency");
  // This implementation deliberately requires tailnet transport for provisioned inference.
  const endpoint = new URL(settings.endpointTemplate.replaceAll("{{name}}", "docslurp-test"));
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".ts.net")) throw new Error("Provisioned media requires a Tailscale HTTPS endpoint");
  return settings;
}
export function capacityProviders(settings: CapacitySettings, env: NodeJS.ProcessEnv = process.env): Map<string, CapacityProvider> {
  const provider = settings.provider === "deepinfra" ? new DeepInfraCapacityProvider(env.DEEPINFRA_API_KEY ?? "", settings.template)
    : settings.provider === "vast" ? new VastCapacityProvider(env.VAST_API_KEY ?? "", settings.template) : null;
  if (!provider) throw new Error("Unknown capacity provider");
  return new Map([[provider.id, provider]]);
}
/** One lazy lease per document, reused across chunks and released by extractMedia finally. */
export class LeasedMediaProvider implements MediaProvider {
  readonly id: string;
  /** Self-hosted ASR response shape is not guaranteed to carry segment timestamps, so no chunk overlap is sent. */
  readonly supportsSegments = false;
  readonly priceUsdPerMinute = 0; // Host time is recorded separately through the scoped capacity ledger.
  private lease?: CapacityLease;
  constructor(readonly model: string, private readonly scope: MediaScope, private readonly settings: CapacitySettings,
    private readonly controller: CapacityController, private readonly maxRunCostCents: number | null) { this.id = `${settings.provider}-capacity`; }
  async transcribe(input: AudioInput, signal: AbortSignal): Promise<Transcription> {
    if (!this.lease) this.lease = await this.controller.acquire(this.settings.provider, { scope: this.scope,
      ttlMs: this.settings.ttlMs, budgetUsd: this.settings.dailyBudgetUsd,
      maxConcurrent: this.settings.maxConcurrent, maxRunCostCents: this.maxRunCostCents });
    if (Date.now() >= this.lease.deadline - 30000) throw new Error("Capacity deadline reached");
    signal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, this.lease.deadline - Date.now() - 30000))]);
    let endpoint = "";
    let ready = false;
    while (!ready) {
      signal.throwIfAborted();
      try {
        endpoint = await capacityEndpoint(this.settings.endpointTemplate, this.lease.name, true);
        const health = await fetch(new URL("health", endpoint), { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: "error" });
        if (health.ok) { const body = await jsonResponse(health) as { model?: string }; ready = body.model === this.model; }
        else await health.body?.cancel();
      } catch { signal.throwIfAborted(); }
      if (!ready) await delay(2000, undefined, { signal });
    }
    const response = await fetch(new URL("transcribe", endpoint), { method: "POST", signal, redirect: "error",
      headers: { "Content-Type": "audio/wav" }, body: Uint8Array.from(input.bytes) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Remote ASR HTTP ${response.status}`); }
    return parseTranscription(await jsonResponse(response), input.durationSeconds, 0);
  }
  async release(): Promise<{ leaseId: string; costUsd: number } | null> {
    if (!this.lease) return null;
    return { leaseId: this.lease.id, costUsd: await this.controller.release(this.lease) };
  }
}
export function leasedMediaProvider(model: string, scope: MediaScope, store: CapacityLeaseStore, cap: number | null) {
  const settings = capacitySettings(); if (!settings) throw new Error("Dedicated media capacity is disabled");
  return new LeasedMediaProvider(model, scope, settings, new CapacityController(store, capacityProviders(settings)), cap);
}
