import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

const sqlSpy = vi.fn(() => { throw new Error("the public estimate must not touch the database"); });
vi.mock("../db.js", () => ({ sql: new Proxy(sqlSpy, { get: () => sqlSpy }) }));

const { estimateRoutes } = await import("../routes/estimate.js");

function app() {
  return new Hono().route("/v1/estimate", estimateRoutes);
}

function profile(bytes: number, pages: number) {
  return {
    schema: 1, profiler: "test", kind: "pdf", format: "pdf", bytes, pages,
    pdf: {
      sampledPages: 2, textLayerPages: 2, wordsPerPage: [0, 0, 0, 0, 2, 0], lowTextPages: 0, blankPages: 0, rasterPages: 0,
      imagePages: 0, images: 0, imageCoverage: [2, 0, 0, 0, 0], furnitureImages: 0, layoutHeavyPages: 0, vectorHeavyPages: 0,
      unmappedFontPages: 0, drawnContent: false, budgetExhausted: false, sampledWords: 700, medianPageAreaSqIn: 94, maxPageAreaSqIn: 94,
      sampledChars: 4_200, sampledTextLines: 80, charsByFontSize: [0, 0, 0, 4_200, 0], invisibleChars: 0, offCropChars: 0,
      sampledTextEquivalents: 2, sampledAreaEquivalents: 2, sampledPageEquivalents: 2, maxPageEquivalents: 1, textEquivalentsPerPage: [2, 0, 0, 0, 0, 0, 0], areaEquivalentsPerPage: [2, 0, 0, 0, 0, 0, 0, 0], densePages: 0, medianPageWidthPt: 612, medianPageHeightPt: 792, maxPageWidthPt: 612, maxPageHeightPt: 792, offPageChars: 0, tinyCharsDropped: 0, textEstimatedPages: 0,
    },
  };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app().request("/v1/estimate", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers }, body: JSON.stringify(body) });

afterEach(() => { vi.unstubAllEnvs(); });

describe("POST /v1/estimate (public)", () => {
  it("quotes profiles with no account, reads no tenant data and labels the answer an estimate", async () => {
    const response = await post({ files: [{ name: "a.pdf", size: 40_000, profile: profile(40_000, 12) }], settings: { quality: "good", hostingMonths: 6 } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const quote = await response.json() as { kind: string; pricingVersion: string; validUntil: string; pages: { low: number }; settings: { quality: string; hostingMonths: number } };
    expect(quote).toMatchObject({ kind: "estimate", pricingVersion: expect.any(String), pages: { low: 12, high: 12 }, settings: { quality: "good", hostingMonths: 6 } });
    expect(Date.parse(quote.validUntil)).toBeGreaterThan(Date.now());
    expect(sqlSpy).not.toHaveBeenCalled();
  });

  it("refuses hostile or oversized requests", async () => {
    const good = { name: "a.pdf", size: 40_000, profile: profile(40_000, 12) };
    expect((await post({ files: [{ ...good, profile: { ...good.profile, credits: 0 } }] })).status).toBe(400);
    expect((await post({ files: [good], settings: { margin: 1 } })).status).toBe(400);
    expect((await post({ files: [good], workspace: "ws-1" })).status).toBe(400);
    expect((await post({ files: Array.from({ length: 201 }, () => good) })).status).toBe(413);
    const huge = await app().request("/v1/estimate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: [good], pad: "x".repeat(1_100_000) }) });
    expect(huge.status).toBe(413);
  });

  it("clamps a profile that lies about its file: another size is ignored, counts are bounded", async () => {
    const lying = await (await post({ files: [{ name: "a.pdf", size: 40_000, profile: profile(9, 9_999_999) }] })).json() as { files: { profiled: number }; pages: { high: number } };
    expect(lying.files.profiled).toBe(0);
    expect(lying.pages.high).toBeLessThan(100);
  });

  it("quotes a stuffed profile at its page equivalents, and clamps an equivalent count no page could hold", async () => {
    const stuffed = profile(40_000, 2);
    stuffed.pdf = { ...stuffed.pdf, sampledChars: 70_000, charsByFontSize: [70_000, 0, 0, 0, 0], sampledTextEquivalents: 20, sampledPageEquivalents: 20, maxPageEquivalents: 10, textEquivalentsPerPage: [0, 0, 0, 0, 2, 0, 0], densePages: 2 };
    const quote = await (await post({ files: [{ name: "a.pdf", size: 40_000, profile: stuffed }] })).json() as { pages: { low: number; high: number } };
    expect(quote.pages).toEqual({ low: 20, high: 20 });
    // Equivalents the measured glyphs, lines and area cannot hold are clamped to what they can: text (2 pages + 70,000 / 3,500
    // + 80 / 60) plus area (2 pages).
    const inflated = { ...stuffed, pdf: { ...stuffed.pdf, sampledTextEquivalents: 5_000, sampledPageEquivalents: 5_000, maxPageEquivalents: 5_000 } };
    const clamped = await (await post({ files: [{ name: "a.pdf", size: 40_000, profile: inflated }] })).json() as { pages: { high: number } };
    expect(clamped.pages.high).toBeLessThanOrEqual(2 + 20 + 2 + 2);
  });

  it("rate limits per client IP", async () => {
    vi.stubEnv("ESTIMATE_RATE_LIMIT_PER_MINUTE", "2");
    const body = { files: [{ name: "a.pdf", size: 1_000 }] };
    const headers = { "x-forwarded-for": "198.51.100.23" };
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await post(body, headers)).status);
    expect(statuses.at(-1)).toBe(429);
  });
});
