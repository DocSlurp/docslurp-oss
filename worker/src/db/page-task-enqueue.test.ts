import { expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { PageTaskStore } from "./page-task-store.js";
import type { VisionPageTask } from "../temporal/shared.js";

it("writes bounded planning batches and counts only once after all writes", async () => {
  const batches: number[] = [];
  const statements: string[] = [];
  const sql = Object.assign((first: TemplateStringsArray | unknown[]) => {
    if (!("raw" in first)) { batches.push(first.length); return {}; }
    const query = first.join("?");
    statements.push(query);
    return Promise.resolve(query.includes("count(*)") ? [{ total: 250 }] : []);
  }, { json: (value: unknown) => value }) as unknown as Sql<Record<string, unknown>>;
  const tasks = Array.from({ length: 250 }, (_, pageNumber) => ({
    runId: "run-a", documentId: "doc-a", pageNumber,
  } as VisionPageTask));
  const progress = vi.fn();
  expect(await new PageTaskStore(sql).enqueueWithPayload(tasks, progress)).toBe(250);
  expect(batches).toEqual([100, 100, 50]);
  expect(statements.filter((query) => query.includes("count(*)"))).toHaveLength(1);
  expect(statements.at(-1)).toContain("count(*)");
  expect(progress.mock.calls.map(([completed]) => completed)).toEqual([0, 100, 200, 250]);
});
