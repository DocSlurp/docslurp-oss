import { jsonResponse } from "../providers.js";
import type { CapacityProvider, CapacityQuote, CapacityResource } from "./types.js";
async function api(url: string, key: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Capacity API HTTP ${response.status}`); }
  if (response.status === 204) return {};
  return jsonResponse(response);
}
export interface HostTemplate {
  image: string; bootstrap: string; maxHourlyUsd: number; fixedReserveUsd: number;
  gpuConfig?: string; offerId?: number; diskGb?: number;
}
function validate(template: HostTemplate) {
  if (!/@sha256:[0-9a-f]{64}$/.test(template.image)) throw new Error("Capacity requires a digest-pinned image");
  if (!Number.isFinite(template.maxHourlyUsd) || template.maxHourlyUsd <= 0 || !Number.isFinite(template.fixedReserveUsd) || template.fixedReserveUsd < 0) throw new Error("Invalid capacity cost ceiling");
  if (/PRIVATE KEY|DEEPINFRA_API_KEY|VAST_API_KEY|DATABASE_URL|HF_TOKEN|tskey-/i.test(template.bootstrap)) throw new Error("Bootstrap must not contain infrastructure credentials or reusable tailnet keys");
}
/** API key stays on the controller. Bootstrap is operator-owned, never workspace input. */
export class DeepInfraCapacityProvider implements CapacityProvider {
  readonly id = "deepinfra";
  constructor(private readonly key: string, private readonly template: HostTemplate) { validate(template); if (!key || !template.gpuConfig) throw new Error("DeepInfra capacity configuration missing"); }
  async quote(): Promise<CapacityQuote> {
    const data = await api("https://api.deepinfra.com/v1/containers/gpu_availability", this.key);
    const match = data.gpus?.find((gpu: any) => gpu.gpu_config === this.template.gpuConfig && gpu.available === true);
    if (!match || !Number.isFinite(match.usd_per_hour) || match.usd_per_hour <= 0 || match.usd_per_hour > this.template.maxHourlyUsd) throw new Error("DeepInfra capacity unavailable or over ceiling");
    return { hourlyUsd: match.usd_per_hour, fixedReserveUsd: this.template.fixedReserveUsd, observedAt: Date.now() };
  }
  async inventory(): Promise<CapacityResource[]> {
    const data = await api("https://api.deepinfra.com/v1/containers", this.key);
    if (!Array.isArray(data)) throw new Error("Invalid DeepInfra capacity inventory");
    return data.map(row => ({ id: String(row.id), name: row.name, state: row.state, createdAt: row.start_ts * 1000 }));
  }
  async create(name: string): Promise<string> {
    const data = await api("https://api.deepinfra.com/v1/containers", this.key, "POST", { name,
      gpu_config: this.template.gpuConfig, container_image: this.template.image,
      cloud_init_user_data: this.template.bootstrap.replaceAll("{{name}}", name) });
    if (typeof data.container_id !== "string" || !data.container_id) throw new Error("Ambiguous DeepInfra create response");
    return data.container_id;
  }
  async destroy(id: string): Promise<void> { await api(`https://api.deepinfra.com/v1/containers/${encodeURIComponent(id)}`, this.key, "DELETE"); }
}
export class VastCapacityProvider implements CapacityProvider {
  readonly id = "vast";
  constructor(private readonly key: string, private readonly template: HostTemplate) { validate(template); if (!key || !Number.isSafeInteger(template.offerId) || !template.diskGb) throw new Error("Vast offer configuration missing"); }
  async quote(): Promise<CapacityQuote> {
    const data = await api("https://console.vast.ai/api/v0/bundles/", this.key, "POST", { id: { eq: this.template.offerId }, type: "on-demand", rented: { eq: false }, limit: 1 });
    const offer = data.offers?.find((row: any) => row.id === this.template.offerId);
    const hourlyUsd = Number(offer?.dph_total) + Number(offer?.storage_cost) * this.template.diskGb! / 720;
    if (!offer || !Number.isFinite(hourlyUsd) || hourlyUsd <= 0 || hourlyUsd > this.template.maxHourlyUsd) throw new Error("Vast offer unavailable or over ceiling");
    // Fixed reserve must cover transfer. Provider billing remains reconciled separately.
    return { hourlyUsd, fixedReserveUsd: this.template.fixedReserveUsd, observedAt: Date.now() };
  }
  async inventory(): Promise<CapacityResource[]> {
    const data = await api("https://console.vast.ai/api/v0/instances/", this.key);
    if (!Array.isArray(data.instances)) throw new Error("Invalid Vast inventory");
    return data.instances.map((row: any) => ({ id: String(row.id), name: row.label, state: row.actual_status, createdAt: row.start_date * 1000 }));
  }
  async create(name: string): Promise<string> {
    const data = await api(`https://console.vast.ai/api/v0/asks/${this.template.offerId}/`, this.key, "PUT", {
      client_id: "me", image: this.template.image, disk: this.template.diskGb, label: name,
      runtype: "args", onstart: this.template.bootstrap.replaceAll("{{name}}", name), env: {} });
    if (data.success !== true || !Number.isSafeInteger(data.new_contract)) throw new Error("Ambiguous Vast create response");
    return String(data.new_contract);
  }
  async destroy(id: string): Promise<void> {
    const data = await api(`https://console.vast.ai/api/v0/instances/${encodeURIComponent(id)}/`, this.key, "DELETE");
    if (data.success !== true) throw new Error("Vast deletion unacknowledged");
  }
}
