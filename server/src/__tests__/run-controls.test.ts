import { describe, expect, it } from "vitest";

import { planRunControlUpdate } from "../services/runs.js";

describe("planRunControlUpdate", () => {
  it("pauses queued runs immediately", () => {
    expect(
      planRunControlUpdate(
        { status: "queued", priority: 0, controlState: null },
        { action: "pause" }
      )
    ).toEqual({
      status: "queued",
      controlState: "paused",
      controlRequestedAt: "now",
      immediate: true
    });
  });

  it("marks processing runs as pause requested", () => {
    expect(
      planRunControlUpdate(
        { status: "processing", priority: 0, controlState: null },
        { action: "pause" }
      )
    ).toEqual({
      status: "processing",
      controlState: "pause_requested",
      controlRequestedAt: "now",
      immediate: false
    });
  });

  it("resumes paused runs back to queued state", () => {
    expect(
      planRunControlUpdate(
        { status: "queued", priority: 0, controlState: "paused" },
        { action: "resume" }
      )
    ).toEqual({
      status: "queued",
      controlState: null,
      controlRequestedAt: null,
      error: null,
      immediate: true
    });
  });

  it("cancels queued work immediately", () => {
    expect(
      planRunControlUpdate(
        { status: "queued", priority: 0, controlState: null },
        { action: "cancel" }
      )
    ).toEqual({
      status: "failed",
      controlState: "cancelled",
      controlRequestedAt: "now",
      error: "Cancelled by operator",
      immediate: true
    });
  });

  it("reprioritizes within bounds", () => {
    expect(
      planRunControlUpdate(
        { status: "queued", priority: 0, controlState: null },
        { action: "reprioritize", priority: 200 }
      )
    ).toEqual({
      priority: 100,
      controlRequestedAt: null,
      immediate: true
    });
  });
});
