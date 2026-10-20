import { defaultPipelineFeatures, getPipelineStageOrder } from "@docslurp/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/client", () => ({ Connection: { connect: vi.fn() }, Client: class {} }));

const { pipelineStageOrderForStart } = await import("../lib/temporal.js");

describe("pipelineStageOrderForStart (M8)", () => {
  const stored = { ...defaultPipelineFeatures, indexingMode: "map" as const };

  it("compiles a stored map pipeline as full while the deferred flag is off", () => {
    const order = pipelineStageOrderForStart(stored, false);
    expect(order).toEqual(getPipelineStageOrder({ ...stored, indexingMode: "full" }));
    expect(order).toContain("embed");
    expect(order).not.toContain("document-map");
  });

  it("keeps the deferred order when the flag is on", () => {
    expect(pipelineStageOrderForStart(stored, true)).toEqual(getPipelineStageOrder(stored));
    expect(pipelineStageOrderForStart(stored, true)).toContain("document-map");
  });
});
