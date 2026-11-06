import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("executes generated-canvas and encoded-image requests with real guest codecs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-image-guest-test-"));
  try {
    const input = path.join(dir, "request.json"), output = path.join(dir, "result.json");
    await writeFile(input, JSON.stringify({ input: { create: { width: 32, height: 48, channels: 3, background: "#123456" } }, options: {}, operations: [{ method: "png", args: [] }], terminal: "toBuffer", args: [{ resolveWithObject: true }] }));
    const run = () => promisify(execFile)(process.execPath, [path.resolve("scripts/image-task.mjs"), input, output], { timeout: 10000 });
    await run();
    const generated = JSON.parse(await readFile(output, "utf8"));
    expect(generated.info).toMatchObject({ width: 32, height: 48, format: "png" });
    await writeFile(input, JSON.stringify({ input: generated.data, options: {}, operations: [], terminal: "metadata", args: [] }));
    await run();
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ width: 32, height: 48, format: "png" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
