import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { OPERATOR_CONFIG_KNOBS } from "@docslurp/shared/operator-config";

/**
 * The API applies only the operator config variables marked `both` (operator-config.ts): a `worker` variable the API
 * read would then differ between the API and the worker. This fails when API code names a worker-only variable.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe("operator config variables the API reads", () => {
  it("names no worker-only variable in API code", () => {
    const root = resolve(import.meta.dirname, "..");
    const text = sources(root).map((path) => readFileSync(path, "utf8")).join("\n");
    const offenders = OPERATOR_CONFIG_KNOBS.filter((knob) => knob.readers === "worker" && new RegExp(`\\b${knob.env}\\b`).test(text)).map((knob) => knob.env);
    expect(offenders).toEqual([]);
  });
});
