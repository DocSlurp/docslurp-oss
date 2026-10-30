import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRoutingTargetCatalog,
  defaultVisionConfig,
  visionModelCatalog,
  visionModelUriProblem,
  type Assignment,
  type RoutingTarget,
  type RoutingVisionCatalogEntry,
} from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";
import { resetStreamingSupportForTest } from "../tools/vision-stream.js";
import { visionConfigForModel } from "./routed-vision.js";
import { BaselineRouter } from "./routers/baseline.js";
import { buildRuntimeCatalog, loadRuntimePolicyPack, loadRuntimePrices, routingAssetPath, RUNTIME_POLICY_PACKS, vlmTargetProblem } from "./runtime.js";
import { BIG_BUDGET, makePage } from "./testing.js";

/**
 * One admission source for VLM targets: the vision runtime refuses any route `visionModelUriProblem` rejects, so
 * the routing catalog drops those targets and the planner never plans a page the runtime would refuse.
 */
const env = {
  OPENROUTER_API_KEY: "or-key",
  LIGHTONOCR_3_ENDPOINT_URL: "http://gpu.internal/lightonocr",
  MINERU_2_5_ENDPOINT_URL: "http://gpu.internal/mineru",
  INFINITY_PARSER2_ENDPOINT_URL: "http://gpu.internal/infinity",
} as unknown as NodeJS.ProcessEnv;

/** Hosted targets the seed and transcription catalogs offer that are outside the priced vision catalog today. */
const FILTERED_TODAY = [
  "vlm:openrouter/anthropic/claude-haiku-5.5",
  "vlm:openrouter/anthropic/claude-sonnet-5.5",
  "vlm:openrouter/google/gemini-3.5-flash-lite",
];

const isVlmId = (id: string) => id.startsWith("vlm:");

/** Why tools/vision-runtime.ts would refuse `uri` before sending (it parses the URI, then checks the route). */
function runtimeRefusal(uri: string): string | null {
  try {
    return visionModelUriProblem(uri);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** `vlm:<provider>/<model>` → `llm://<provider>/<model>`, for pack targets the seed catalog does not list. */
const uriOfId = (id: string) => `llm://${id.slice("vlm:".length)}`;

function presence(source: NodeJS.ProcessEnv): Record<string, boolean> {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => typeof value === "string" && value !== "").map(([key]) => [key, true]));
}

/** The seed catalog before the vision admission filter. */
function unfilteredTargets(): RoutingTarget[] {
  const prices = loadRuntimePrices();
  return buildRoutingTargetCatalog({
    visionCatalog: visionModelCatalog as unknown as readonly RoutingVisionCatalogEntry[],
    ...(prices ? { prices, checkedAt: prices.asOf } : {}),
    env: presence(env),
  }).targets;
}

/** Every `vlm:` target id a shipped policy pack names. */
async function packTargetIds(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const name of Object.values(RUNTIME_POLICY_PACKS)) {
    const file = routingAssetPath(name);
    expect(file, name).not.toBeNull();
    const ids = new Set<string>();
    const walk = (value: unknown) => {
      if (typeof value === "string") {
        if (isVlmId(value)) ids.add(value);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          if (isVlmId(key)) ids.add(key);
          walk(inner);
        }
      }
    };
    walk(JSON.parse(await readFile(file!, "utf8")));
    out.set(name, [...ids].sort());
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VLM target admission", () => {
  it("every hosted target in the seed catalog and every shipped pack passes visionModelUriProblem or is filtered", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unfiltered = new Map(unfilteredTargets().map((target) => [target.id, target]));
    const admitted = new Set(buildRuntimeCatalog({ env }).allTargets.map((target) => target.id));
    const ids = new Set<string>([...unfiltered.keys()].filter(isVlmId));
    const packs = await packTargetIds();
    for (const packIds of packs.values()) packIds.forEach((id) => ids.add(id));
    expect(ids.size).toBeGreaterThan(5);

    const filtered: string[] = [];
    for (const id of ids) {
      const target = unfiltered.get(id);
      const uri = target?.ref.modelUri ?? uriOfId(id);
      const problem = runtimeRefusal(uri);
      if (problem) {
        // Refused by the runtime: never plannable, never resolvable from a stored plan.
        expect(admitted.has(id), `${id}: ${problem}`).toBe(false);
        filtered.push(id);
      } else if (target) {
        expect(admitted.has(id), id).toBe(true);
        expect(vlmTargetProblem(target)).toBeNull();
      }
    }
    for (const id of FILTERED_TODAY) {
      expect(unfiltered.has(id), `${id} is offered by the seed catalog`).toBe(true);
      expect(filtered).toContain(id);
    }
  });

  it("names, once per target, what it filters", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fresh = await import("./runtime.js");
    fresh.buildRuntimeCatalog({ env });
    fresh.buildRuntimeCatalog({ env });
    const lines = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[page-router] target="));
    for (const id of FILTERED_TODAY) expect(lines.filter((line) => line.includes(`target=${id} `))).toHaveLength(1);
  });
});

describe("a built-in plan through the real vision runtime", () => {
  const cfg = {
    openRouterApiKey: "or-key", openAiApiKey: "sk-test", openAiBaseUrl: "https://api.openai.com/v1",
    costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03, visionStreaming: false,
  } as Config;

  it.each(Object.keys(RUNTIME_POLICY_PACKS) as Array<keyof typeof RUNTIME_POLICY_PACKS>)(
    "every VLM assignment and cascade leg the %s pack plans is sent, never refused",
    async (router) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      resetStreamingSupportForTest();
      const catalog = buildRuntimeCatalog({ env: { OPENROUTER_API_KEY: "or-key" } as unknown as NodeJS.ProcessEnv });
      const pages = [
        makePage({ pageNumber: 1, words: 0, textLayer: "absent", route: "handwriting-or-degraded", hint: null, fullPageImage: true, images: [{ coverage: 1 }] }),
        makePage({ pageNumber: 2, words: 300, math: 0.2, route: "formula-heavy" }),
        makePage({ pageNumber: 3, words: 250, tableRule: 3, route: "table-heavy" }),
        makePage({ pageNumber: 4, words: 120, images: [{ coverage: 0.6 }], route: "chart-or-figure" }),
      ];
      const plan = await new BaselineRouter({ pack: loadRuntimePolicyPack(router) }).plan(pages, catalog.targets, BIG_BUDGET, "cost-quality");
      const byId = new Map(catalog.allTargets.map((target) => [target.id, target]));
      const legs: Array<{ targetId: string; role: Assignment["role"] }> = plan.assignments.flatMap((assignment) => [
        { targetId: assignment.targetId, role: assignment.role },
        ...assignment.cascade.map((leg) => ({ targetId: leg.targetId, role: assignment.role })),
      ]);
      const vlmLegs = legs.filter((leg) => {
        const target = byId.get(leg.targetId);
        return target && (target.kind === "hosted-vlm" || target.kind === "private-vlm");
      });
      // Every planned target resolves in the catalog (none was planned from a filtered target).
      for (const leg of legs) expect(byId.has(leg.targetId) || !isVlmId(leg.targetId), leg.targetId).toBe(true);
      expect(vlmLegs.length, `${router} planned no VLM work`).toBeGreaterThan(0);

      const sends: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        sends.push(url);
        return new Response(JSON.stringify({ choices: [{ message: { content: "Total: 42" }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 80 } }),
          { headers: { "content-type": "application/json" } });
      }));
      const dir = await mkdtemp(join(tmpdir(), "routed-plan-"));
      const imagePath = join(dir, "page.png");
      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      for (const leg of vlmLegs) {
        const target = byId.get(leg.targetId)!;
        const vision = visionConfigForModel(defaultVisionConfig, target.ref.modelUri!, leg.role);
        const before = sends.length;
        const result = await executeVisionRuntime({
          imagePath, outputPath: `${imagePath}.json`, vision, cfg, runner: new CommandRunner(), privacyMode: "standard", gate: null,
        });
        expect(sends.length, leg.targetId).toBeGreaterThan(before);
        expect(result.route.billing, leg.targetId).toBe("openrouter");
      }
    },
  );
});
