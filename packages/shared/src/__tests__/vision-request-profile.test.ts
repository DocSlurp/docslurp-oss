import { describe, expect, it } from "vitest";

import { privateEndpointRegistrySchema } from "../private-endpoints.js";
import { KNOWN_VISION_REQUEST_PROFILES, visionRequestProfileFor, visionRequestProfileSchema } from "../vision-request-profile.js";

describe("vision request profiles", () => {
  it("ships LightOnOCR-3 with its authors' client settings", () => {
    expect(visionRequestProfileFor("lightonai/LightOnOCR-3-0.8B")).toEqual({
      promptMode: "image-only", systemMessage: false, temperature: 0.2, topP: 1, maxOutputTokens: "server", contextTokens: 18_000, maxLongEdgePx: 2_048,
    });
    expect(visionRequestProfileFor("lightonai/LightOnOCR-3-1B")).toMatchObject({ maxLongEdgePx: 1_540, contextTokens: 16_384 });
    for (const profile of Object.values(KNOWN_VISION_REQUEST_PROFILES)) expect(visionRequestProfileSchema.safeParse(profile).success).toBe(true);
  });

  it("applies an operator override field by field, and returns nothing for an unprofiled model", () => {
    expect(visionRequestProfileFor("lightonai/LightOnOCR-3-0.8B", { maxLongEdgePx: 1_540 })).toMatchObject({ promptMode: "image-only", maxLongEdgePx: 1_540 });
    expect(visionRequestProfileFor("acme/vlm", { temperature: 0.1 })).toEqual({ temperature: 0.1 });
    expect(visionRequestProfileFor("acme/vlm")).toBeUndefined();
    expect(visionRequestProfileFor(undefined)).toBeUndefined();
  });

  it("refuses an unbounded output cap and out-of-range values", () => {
    expect(visionRequestProfileSchema.safeParse({ maxOutputTokens: "server" }).success).toBe(false);
    expect(visionRequestProfileSchema.safeParse({ maxLongEdgePx: 8_000 }).success).toBe(false);
    expect(visionRequestProfileSchema.safeParse({ topP: 0 }).success).toBe(false);
    expect(visionRequestProfileSchema.safeParse({ temperature: 3 }).success).toBe(false);
    expect(visionRequestProfileSchema.safeParse({ promptMode: "grounding" }).success).toBe(false);
    expect(visionRequestProfileSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it("accepts a registry vision profile only on vision models", () => {
    const entry = (model: Record<string, unknown>) => privateEndpointRegistrySchema.safeParse([{
      alias: "gpu1", baseUrl: "https://gpu1.example.com/v1", auth: { tokenEnv: "GPU1_TOKEN" },
      models: [model], attestation: { tenancy: "single-tenant", hostProvider: "runpod", region: "us-east" },
    }]);
    expect(entry({ id: "lightonai/LightOnOCR-3-0.8B", capability: "vision", vision: { maxLongEdgePx: 1_540 } }).success).toBe(true);
    expect(entry({ id: "acme/text", capability: "text", vision: { temperature: 0.2 } }).success).toBe(false);
    expect(entry({ id: "acme/vlm", capability: "vision", vision: { maxOutputTokens: "server" } }).success).toBe(false);
  });
});
