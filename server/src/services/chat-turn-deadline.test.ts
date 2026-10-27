import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { nativeApiErrors, nativeErrorHandler } from "../lib/api-error.js";
import { ChatTurnDeadline, ChatTurnDeadlineError, chatTurnTimeBudget, CHAT_TURN_TIME_BUDGET_DEFAULTS, isChatTurnTimeout, raceAbort } from "./chat-turn-deadline.js";

describe("chat turn time budget", () => {
  it("defaults below the ~120 s edge timeout and reads the CHAT_AGENT_* knobs", () => {
    expect(chatTurnTimeBudget({})).toEqual({ turnDeadlineMs: 100_000, stepTimeoutMs: 45_000, toolTimeoutMs: 30_000, finalReserveMs: 20_000 });
    expect(chatTurnTimeBudget({ CHAT_AGENT_TURN_DEADLINE_MS: "80000", CHAT_AGENT_STEP_TIMEOUT_MS: "20000",
      CHAT_AGENT_TOOL_TIMEOUT_MS: "15000", CHAT_AGENT_FINAL_RESERVE_MS: "10000" }))
      .toEqual({ turnDeadlineMs: 80_000, stepTimeoutMs: 20_000, toolTimeoutMs: 15_000, finalReserveMs: 10_000 });
  });

  it("ignores invalid values and keeps budgets inside the deadline", () => {
    expect(chatTurnTimeBudget({ CHAT_AGENT_TURN_DEADLINE_MS: "soon", CHAT_AGENT_STEP_TIMEOUT_MS: "-1" })).toEqual(CHAT_TURN_TIME_BUDGET_DEFAULTS);
    expect(chatTurnTimeBudget({ CHAT_AGENT_TURN_DEADLINE_MS: "30000", CHAT_AGENT_STEP_TIMEOUT_MS: "90000", CHAT_AGENT_TOOL_TIMEOUT_MS: "90000", CHAT_AGENT_FINAL_RESERVE_MS: "25000" }))
      .toEqual({ turnDeadlineMs: 30_000, stepTimeoutMs: 30_000, toolTimeoutMs: 30_000, finalReserveMs: 15_000 });
  });

  it("caps tool and tool-step budgets to end before the final reserve; the final step gets the rest", () => {
    const deadline = new ChatTurnDeadline({ turnDeadlineMs: 100_000, stepTimeoutMs: 45_000, toolTimeoutMs: 30_000, finalReserveMs: 20_000 }, 0);
    const at = (ms: number) => ms;
    expect(deadline.toolBudgetMs(at(10_000))).toBe(30_000);
    expect(deadline.toolBudgetMs(at(60_000))).toBe(20_000);
    expect(deadline.toolBudgetMs(at(85_000))).toBe(0);
    expect(deadline.stepBudgetMs(false, at(50_000))).toBe(30_000);
    expect(deadline.stepBudgetMs(true, at(85_000))).toBe(15_000);
    expect(deadline.inFinalReserve(at(79_999))).toBe(false);
    expect(deadline.inFinalReserve(at(80_000))).toBe(true);
    deadline.dispose();
  });

  it("aborts at the deadline with a timeout reason, and on client abort with the client's reason", async () => {
    const deadline = new ChatTurnDeadline({ turnDeadlineMs: 20, stepTimeoutMs: 20, toolTimeoutMs: 20, finalReserveMs: 5 });
    await new Promise(resolve => deadline.signal.addEventListener("abort", resolve, { once: true }));
    expect(deadline.expired).toBe(true);
    expect(isChatTurnTimeout(deadline.signal.reason)).toBe(true);
    const client = new AbortController();
    const other = new ChatTurnDeadline({ turnDeadlineMs: 60_000, stepTimeoutMs: 1_000, toolTimeoutMs: 1_000, finalReserveMs: 1_000 }, Date.now(), client.signal);
    const step = other.child("step", 60_000);
    client.abort(new Error("gone"));
    expect(other.clientAborted).toBe(true);
    expect(other.expired).toBe(false);
    expect(step.signal.aborted).toBe(true);
    expect(step.timedOut()).toBe(false);
    step.dispose();
    other.dispose();
  });

  it("uses only the turn timer when a child can use all remaining time", async () => {
    vi.useFakeTimers();
    const deadline = new ChatTurnDeadline({ turnDeadlineMs: 200, stepTimeoutMs: 100, toolTimeoutMs: 100, finalReserveMs: 50 });
    const child = deadline.child("step", deadline.stepBudgetMs(true));
    try {
      // Two independent timers for the same boundary can fire in either order.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(child.signal.reason).toBe(deadline.signal.reason);
      expect(deadline.expired).toBe(true);
      expect(child.timedOut()).toBe(false);
    } finally {
      child.dispose();
      deadline.dispose();
      vi.useRealTimers();
    }
  });

  it("raceAbort settles at the abort even when the work never does", async () => {
    const controller = new AbortController();
    const pending = raceAbort(new Promise(() => undefined), controller.signal);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });

  it("answers a turn that produced nothing with 424 chat_deadline_exceeded", async () => {
    const app = new Hono();
    app.onError(nativeErrorHandler((_error, c) => c.json({ error: "internal" }, 500)));
    app.route("/v1/chat", new Hono().use("*", nativeApiErrors).post("/", () => { throw new ChatTurnDeadlineError(100_000); }));
    const response = await app.request("/v1/chat", { method: "POST" });
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({ error: { code: "chat_deadline_exceeded" } });
  });
});
