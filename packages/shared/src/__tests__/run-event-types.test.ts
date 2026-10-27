import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workspaceRunEventTypeSchema } from "../run.js";

const workerSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../worker/src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

describe("run event types", () => {
  it("lists every event type the worker writes, so the events and progress APIs can read them", () => {
    const written = new Set<string>();
    for (const file of sourceFiles(workerSrc)) {
      for (const match of readFileSync(file, "utf8").matchAll(/eventType:\s*"([a-z_]+\.[a-z_]+)"/g)) written.add(match[1]!);
    }
    expect(written.size).toBeGreaterThan(3);
    const known = new Set<string>(workspaceRunEventTypeSchema.options);
    expect([...written].filter((type) => !known.has(type))).toEqual([]);
  });
});
