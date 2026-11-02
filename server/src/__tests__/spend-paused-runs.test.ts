import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = Object.assign(vi.fn(), { begin: vi.fn() });
vi.mock("../db.js", () => ({ sql: sqlMock }));
vi.mock("../lib/temporal.js", () => ({ signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn() }));

const { sweepSpendPausedRuns } = await import("../services/spend-paused-runs.js");

const text = (strings: unknown) => (Array.isArray(strings) ? strings.join("?") : String(strings));
const status = (available: number) => ({
  org_id: "org-1", funded: false, available, reserved: 0,
  workspace_budget_paused: false, org_budget_paused: false, workspace_in_org: true,
});

describe("spend-paused run sweep", () => {
  const signals = { pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined) };

  beforeEach(() => {
    sqlMock.mockReset();
    sqlMock.begin.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(sqlMock));
    signals.pause.mockClear();
    signals.resume.mockClear();
  });

  function respond(available: Record<string, number>, lease = { lease_remaining: 0.5, available_credits: 10, outstanding_credits: 0.5, block_reason: null as string | null }) {
    const updates: string[] = [];
    sqlMock.mockImplementation((strings: unknown, ...values: unknown[]) => {
      const query = text(strings);
      if (query.includes("from workspace_runs\n    where pause_reason is not null")) {
        return Promise.resolve([
          { id: "run-ok", org_id: "org-ok", workspace_id: "ws-ok", user_id: "u1", pause_reason: "credit_exhausted" },
          { id: "run-blocked", org_id: "org-blocked", workspace_id: "ws-b", user_id: "u1", pause_reason: "credit_exhausted" },
        ]);
      }
      if (query.includes("select id, org_id, workspace_id, user_id, pause_reason from workspace_runs")) {
        const id = values[0] as string;
        return Promise.resolve([{ id, org_id: id === "run-ok" ? "org-ok" : "org-blocked", workspace_id: "ws", user_id: "u1", pause_reason: "credit_exhausted" }]);
      }
      if (query.includes("from grant_credit_lease(")) return Promise.resolve([lease]);
      if (query.includes("org_spend_status")) return Promise.resolve([status(available[values[0] as string] ?? 0)]);
      if (query.includes("update workspace_runs")) {
        updates.push(values.find((value) => typeof value === "string" && value.startsWith("run-")) as string);
        return Promise.resolve([{ id: "run-ok", user_id: "u1", pause_reason: "credit_exhausted" }]);
      }
      return Promise.resolve([]);
    });
    return updates;
  }

  it("resumes runs whose org may spend again and re-sends pause to the rest", async () => {
    // Free orgs keep 100 credits for chat: runs resume only above that.
    const updates = respond({ "org-ok": 112, "org-blocked": -3 });
    expect(await sweepSpendPausedRuns({ sql: sqlMock as never, signals })).toEqual({ resumed: 1, stillBlocked: 1 });
    expect(updates).toEqual(["run-ok"]);
    expect(signals.resume).toHaveBeenCalledWith("run-ok");
    expect(signals.pause).toHaveBeenCalledWith("run-blocked");
    expect(signals.resume).not.toHaveBeenCalledWith("run-blocked");
  });

  it.each([
    { lease_remaining: Number.NaN, block_reason: null },
    { lease_remaining: 0.5, block_reason: "credit_exhausted" },
  ])("does not signal resume for an unusable lease %j", async (lease) => {
    respond({ "org-ok": 112, "org-blocked": 112 }, { ...lease, available_credits: 10, outstanding_credits: 0.5 });
    expect(await sweepSpendPausedRuns({ sql: sqlMock as never, signals })).toEqual({ resumed: 0, stillBlocked: 2 });
    expect(signals.resume).not.toHaveBeenCalled();
  });

  it("keeps runs paused while only the chat reserve is left", async () => {
    respond({ "org-ok": 60, "org-blocked": 100 });
    expect(await sweepSpendPausedRuns({ sql: sqlMock as never, signals })).toEqual({ resumed: 0, stillBlocked: 2 });
  });

  it("does not resume at exactly 0 available credits", async () => {
    respond({ "org-ok": 0, "org-blocked": 0 });
    expect(await sweepSpendPausedRuns({ sql: sqlMock as never, signals })).toEqual({ resumed: 0, stillBlocked: 2 });
  });
});
