import type { WorkspaceRunEvent } from "@docslurp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseRunEventHint, RunEventHub, type RunEventHubDeps, type RunEventHubRow } from "../services/run-event-hub.js";

/**
 * In-memory stand-in for workspace_run_events with the same cursor semantics
 * as the SQL in services/runs.ts: rows with created_at >= after, ordered by
 * created_at, id. `commit` makes rows visible; NOTIFY is a separate, optional
 * hint, exactly as workers send it (one per flush, not per event).
 */
class EventTable {
  rows: RunEventHubRow[] = [];
  queries = 0;
  private hint: ((payload: string) => void) | null = null;
  private base = Date.parse("2026-10-09T12:00:00.000Z");

  deps(): RunEventHubDeps {
    return {
      listen: async (onHint) => {
        this.hint = onHint;
        return { close: async () => { this.hint = null; } };
      },
      fetchEvents: async (cursors, limit) => {
        this.queries += 1;
        const after = new Map(cursors.map((cursor) => [cursor.runId, Date.parse(cursor.after)]));
        return this.sorted()
          .filter((row) => after.has(row.event.runId) && Date.parse(row.cursor) >= after.get(row.event.runId)!)
          .slice(0, limit);
      },
      latestEvents: async (runId, lookbackMs) => {
        const rows = this.sorted().filter((row) => row.event.runId === runId);
        const newest = rows.length ? Date.parse(rows[rows.length - 1]!.cursor) : 0;
        return rows.filter((row) => Date.parse(row.cursor) >= newest - lookbackMs);
      },
    };
  }

  /** Commits events stamped at `offsetMs` past the base time; does not notify. */
  commit(runId: string, items: Array<[id: string, offsetMs: number, type?: string]>): void {
    for (const [id, offsetMs, type] of items) {
      const createdAt = new Date(this.base + offsetMs).toISOString();
      this.rows.push({
        cursor: createdAt,
        event: { id, runId, userId: "u1", type: type ?? "run.progress", createdAt } as unknown as WorkspaceRunEvent,
      });
    }
  }

  notify(runIds: string[]): void {
    this.hint?.(JSON.stringify({ runIds }));
  }

  private sorted(): RunEventHubRow[] {
    return [...this.rows].sort((a, b) => a.cursor.localeCompare(b.cursor) || a.event.id.localeCompare(b.event.id));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("RunEventHub", () => {
  it("delivers a run's events in table order from one hint per batch, without per-event NOTIFY", async () => {
    const table = new EventTable();
    const hub = new RunEventHub(table.deps(), { pollMs: 60_000 });
    const received: string[] = [];
    await hub.subscribe((event) => { received.push(event.id); }, { runId: "run-1" });

    table.commit("run-1", [["e1", 1], ["e2", 2], ["e3", 3], ["e4", 4]]);
    table.notify(["run-1"]);
    await vi.waitFor(() => expect(received).toEqual(["e1", "e2", "e3", "e4"]));

    table.commit("run-1", [["e5", 5], ["e6", 6, "run.completed"]]);
    table.notify(["run-1"]);
    await vi.waitFor(() => expect(received).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]));
    await hub.close();
  });

  it("does not replay events that existed before the subscription", async () => {
    const table = new EventTable();
    table.commit("run-1", [["old-1", 1], ["old-2", 2]]);
    const hub = new RunEventHub(table.deps(), { pollMs: 60_000 });
    const received: string[] = [];
    await hub.subscribe((event) => { received.push(event.id); }, { runId: "run-1" });

    table.commit("run-1", [["new-1", 3]]);
    table.notify(["run-1"]);
    await vi.waitFor(() => expect(received).toEqual(["new-1"]));
    await hub.close();
  });

  it("delivers an earlier-stamped event that commits late (another worker's flush), exactly once", async () => {
    const table = new EventTable();
    const hub = new RunEventHub(table.deps(), { pollMs: 60_000 });
    const received: string[] = [];
    await hub.subscribe((event) => { received.push(event.id); }, { runId: "run-1" });

    table.commit("run-1", [["worker-a-2", 200]]);
    table.notify(["run-1"]);
    await vi.waitFor(() => expect(received).toEqual(["worker-a-2"]));

    // Worker B stamped its event earlier but its flush committed later.
    table.commit("run-1", [["worker-b-1", 100]]);
    table.notify(["run-1"]);
    await vi.waitFor(() => expect(received).toEqual(["worker-a-2", "worker-b-1"]));

    table.notify(["run-1"]);
    await settle();
    expect(received).toEqual(["worker-a-2", "worker-b-1"]);
    await hub.close();
  });

  it("still delivers by polling when the hint is lost", async () => {
    vi.useFakeTimers();
    const table = new EventTable();
    const hub = new RunEventHub(table.deps(), { pollMs: 1_000 });
    const received: string[] = [];
    await hub.subscribe((event) => { received.push(event.id); }, { runId: "run-1" });

    table.commit("run-1", [["silent", 1, "run.completed"]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(received).toEqual(["silent"]);
    await hub.close();
  });

  it("coalesces a burst of hints into one read and skips runs nobody watches", async () => {
    const table = new EventTable();
    const hub = new RunEventHub(table.deps(), { pollMs: 60_000 });
    const received: string[] = [];
    await hub.subscribe((event) => { received.push(event.id); }, { runId: "run-1" });
    const before = table.queries;

    table.commit("run-1", [["a", 1], ["b", 2]]);
    table.commit("run-2", [["other", 3]]);
    for (let i = 0; i < 10; i++) table.notify(["run-1", "run-2"]);
    await vi.waitFor(() => expect(received).toEqual(["a", "b"]));
    await settle();
    expect(table.queries - before).toBeLessThanOrEqual(2);

    table.notify(["run-2"]);
    await settle();
    expect(table.queries - before).toBeLessThanOrEqual(2);
    await hub.close();
  });

  it("fans every run's events out to an all-runs subscriber in order", async () => {
    const table = new EventTable();
    const hub = new RunEventHub(table.deps(), { pollMs: 60_000 });
    const all: string[] = [];
    const single: string[] = [];
    await hub.subscribe((event) => { all.push(`${event.runId}/${event.id}`); });
    const subscription = await hub.subscribe((event) => { single.push(event.id); }, { runId: "run-2" });

    // The all-runs view starts one lookback window back from "now"; stamp events at now.
    const now = Date.now() - Date.parse("2026-10-09T12:00:00.000Z");
    table.commit("run-1", [["x1", now + 1], ["x2", now + 2]]);
    table.commit("run-2", [["y1", now + 3]]);
    table.notify(["run-1", "run-2"]);
    await vi.waitFor(() => expect(all).toEqual(["run-1/x1", "run-1/x2", "run-2/y1"]));
    expect(single).toEqual(["y1"]);

    await subscription.close();
    table.commit("run-2", [["y2", now + 4]]);
    table.notify(["run-2"]);
    await vi.waitFor(() => expect(all).toContain("run-2/y2"));
    expect(single).toEqual(["y1"]);
    await hub.close();
  });

  it("pages through bursts larger than one read", async () => {
    const table = new EventTable();
    const hub = new RunEventHub(table.deps(), { pollMs: 60_000, batchLimit: 3 });
    const received: string[] = [];
    await hub.subscribe((event) => { received.push(event.id); }, { runId: "run-1" });

    table.commit("run-1", Array.from({ length: 10 }, (_, i): [string, number] => [`e${String(i).padStart(2, "0")}`, i + 1]));
    table.notify(["run-1"]);
    await vi.waitFor(() => expect(received).toHaveLength(10));
    expect(received).toEqual(Array.from({ length: 10 }, (_, i) => `e${String(i).padStart(2, "0")}`));
    await hub.close();
  });

  it("parses compact hints and legacy full-event payloads", () => {
    expect(parseRunEventHint('{"runIds":["a","b"]}')).toEqual(["a", "b"]);
    expect(parseRunEventHint('{"id":"e","runId":"a","type":"run.progress"}')).toEqual(["a"]);
    expect(parseRunEventHint("not json")).toEqual([]);
  });
});
