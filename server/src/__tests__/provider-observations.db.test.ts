import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { parseEndpointListing, pollProviderObservations, readProviderObservations, recordServedLatency } from "../services/provider-observations.js";

let sql: ReturnType<typeof postgres>;
let stop: () => Promise<void>;
beforeAll(async () => {
  const db = await startMigratedPostgres();
  stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
}, 60_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

const listing = (endpoints: unknown[]) => ({ data: { endpoints } });
const endpoint = (tag: string, prompt: string, completion: string, extra: Record<string, unknown> = {}) =>
  ({ tag, provider_name: tag, pricing: { prompt, completion }, quantization: "fp8", status: 0, uptime_last_30m: 99.5, ...extra });
const fakeFetch = (payloads: Record<string, unknown>): typeof fetch => (async (url: string | URL | Request) => {
  const model = String(url).replace("https://openrouter.ai/api/v1/models/", "").replace("/endpoints", "");
  if (!(model in payloads)) return new Response("missing", { status: 404 });
  return new Response(JSON.stringify(payloads[model]), { status: 200 });
}) as typeof fetch;

describe("provider endpoint listings", () => {
  it("converts per-token prices to per million and skips malformed or hostile entries", () => {
    const rows = parseEndpointListing("acme/m", listing([
      endpoint("fireworks", "0.0000003", "0.0000012"),
      endpoint("bad-price", "-1", "abc"),
      { tag: "x".repeat(500), pricing: {} },
      "not an object",
      endpoint("odd-uptime", "0.0000001", "0.0000002", { uptime_last_30m: 400, status: "down" }),
    ]));
    expect(rows.map((row) => row.endpoint)).toEqual(["fireworks", "bad-price", "odd-uptime"]);
    expect(rows[0]).toMatchObject({ input: 0.3, output: 1.2, uptime30m: 99.5, status: 0 });
    expect(rows[1]).toMatchObject({ input: null, output: null });
    expect(rows[2]).toMatchObject({ uptime30m: null, status: null });
    expect(parseEndpointListing("acme/m", { data: null })).toEqual([]);
  });
});

describe("provider observation store (migration 0136)", () => {
  it("polls once per interval, keeps going past a failing model and serves the latest row per endpoint", async () => {
    const first = await pollProviderObservations({ sql, models: ["acme/a", "acme/missing"], fetchImpl: fakeFetch({ "acme/a": listing([endpoint("fireworks", "0.0000003", "0.0000012"), endpoint("parasail/fp8", "0.0000003", "0.0000012")]) }) });
    expect(first).toBe(2);
    // Within the interval: no second poll anywhere in the fleet.
    expect(await pollProviderObservations({ sql, models: ["acme/a"], fetchImpl: fakeFetch({}) })).toBeNull();
    // A newer listing supersedes the older row in the current view.
    await sql`update provider_endpoint_observations set observed_at = observed_at - interval '1 hour'`;
    expect(await pollProviderObservations({ sql, models: ["acme/a"], fetchImpl: fakeFetch({ "acme/a": listing([endpoint("fireworks", "0.0000002", "0.0000008", { uptime_last_30m: 80 })]) }) })).toBe(1);
    const current = await readProviderObservations(["acme/a"], sql);
    expect(current.find((row) => row.endpoint === "fireworks")).toMatchObject({ inputUsdPerMTok: 0.2, outputUsdPerMTok: 0.8, uptime30m: 80 });
    expect(current.find((row) => row.endpoint === "parasail/fp8")).toMatchObject({ inputUsdPerMTok: 0.3 });
  });

  it("joins the median served latency of the last two hours; old or invalid samples are ignored", async () => {
    for (const latencyMs of [400, 600, 800]) await recordServedLatency({ model: "acme/a", endpoint: "fireworks", latencyMs, generationMs: 2_000 }, sql);
    await recordServedLatency({ model: "acme/a", endpoint: "fireworks", latencyMs: -5, generationMs: null }, sql);
    await sql`insert into provider_endpoint_observations (source, model, endpoint, latency_ms, observed_at) values ('traffic', 'acme/a', 'fireworks', 90000, now() - interval '3 hours')`;
    const fireworks = (await readProviderObservations(["acme/a"], sql)).find((row) => row.endpoint === "fireworks");
    expect(fireworks?.latencyP50Ms).toBe(600);
  });

  it("refuses unknown sources and negative prices at the database", async () => {
    await expect(sql`insert into provider_endpoint_observations (source, model, endpoint) values ('tenant-upload', 'acme/a', 'x')`).rejects.toThrow();
    await expect(sql`insert into provider_endpoint_observations (source, model, endpoint, input_usd_per_mtok) values ('traffic', 'acme/a', 'x', -1)`).rejects.toThrow();
  });
});
