import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { CommandPlan } from "../tools/runner.js";
import { detectImageLayout, detectImageLayoutAtEndpoint, parseImageLayout } from "./image-layout.js";

const payload = () => ({ schemaVersion: 1, coordinateSpace: "normalized-source", model: { id: "detector", revision: "test" }, device: "cpu", image: { width: 20, height: 10 }, supportedLabels: ["figure"], regions: [{ label: "figure", rawLabel: "picture", confidence: 0.8, bbox: [0.1, 0.2, 0.9, 0.8] }] });

describe("image layout transport boundary", () => {
  it("preserves raw coarse classes without inventing unsupported distinctions", () => {
    const parsed = parseImageLayout(payload());
    expect(parsed.regions[0]).toEqual(payload().regions[0]);
    expect(parsed.supportedLabels).not.toContain("photo");
    expect(() => parseImageLayout({ ...payload(), regions: [{ ...payload().regions[0], label: "photo" }] })).toThrow("not declared supported");
  });
  it.each([[0.9, 0.2, 0.1, 0.8], [-0.1, 0, 1, 1], [0, 0, Infinity, 1], [0, 0, 1]])("rejects invalid source boxes %j", (...bbox) => {
    expect(() => parseImageLayout({ ...payload(), regions: [{ ...payload().regions[0], bbox }] })).toThrow();
  });
  it("preserves declared geometric coverage and validates visual fingerprints", () => {
    const region = { ...payload().regions[0], imageCoverage: 0.48, coverageKind: "half-page", fingerprint: { algorithm: "dhash-64", value: "0123456789abcdef" } };
    expect(parseImageLayout({ ...payload(), regions: [region] }).regions[0]).toEqual(region);
    expect(() => parseImageLayout({ ...payload(), regions: [{ ...region, fingerprint: { algorithm: "dhash-64", value: "bad" } }] })).toThrow("fingerprint");
  });
  it("rejects unknown coordinate spaces and nonfinite confidence", () => {
    expect(() => parseImageLayout({ ...payload(), coordinateSpace: "pixels" })).toThrow("coordinate space");
    expect(() => parseImageLayout({ ...payload(), regions: [{ ...payload().regions[0], confidence: NaN }] })).toThrow("finite");
  });
  it("stages bytes, requests the exact device offline, validates provenance, and cleans up", async () => {
    const runtime = await mkdtemp(path.join(tmpdir(), "docslurp-layout-test-"));
    let output = "";
    const options = { python: path.join(runtime, "bin", "python"), script: path.join(runtime, "infer.py"), cacheDirectory: runtime, model: "heron" as const, device: "cpu" as const };
    await mkdir(path.join(runtime, "bin"));
    await writeFile(path.join(runtime, "pyvenv.cfg"), "home = /usr/bin\n");
    await writeFile(options.python, "");
    await writeFile(options.script, "");
    try {
      const input = await sharp({ create: { width: 20, height: 10, channels: 3, background: "white" } }).png().toBuffer();
      const runner = { run: async (plan: CommandPlan) => {
        expect(plan.timeoutMs).toBe(120_000);
        expect(plan.bundleRoots).toContain(runtime);
        expect(plan.bundleEnv?.HF_HUB_OFFLINE).toBe("1");
        expect(plan.args).toContain("cpu");
        output = plan.args[plan.args.indexOf("--output") + 1];
        await writeFile(output, JSON.stringify(payload()));
        return { stdout: "", stderr: "" };
      } };
      const result = await detectImageLayout(input, options, runner);
      expect(result.image.sha256).toMatch(/^[a-f0-9]{64}$/);
      await expect(access(output)).rejects.toThrow();
      const wrongDevice = { run: async (plan: CommandPlan) => {
        output = plan.args[plan.args.indexOf("--output") + 1];
        await writeFile(output, JSON.stringify({ ...payload(), device: "cuda" }));
        return { stdout: "", stderr: "" };
      } };
      await expect(detectImageLayout(input, options, wrongDevice)).rejects.toThrow("changed requested device");
      await expect(access(output)).rejects.toThrow();
      const wrongSize = { run: async (plan: CommandPlan) => {
        output = plan.args[plan.args.indexOf("--output") + 1];
        await writeFile(output, JSON.stringify({ ...payload(), image: { width: 10, height: 20 } }));
        return { stdout: "", stderr: "" };
      } };
      await expect(detectImageLayout(input, options, wrongSize)).rejects.toThrow("dimensions");
      await expect(access(output)).rejects.toThrow();
    } finally { await rm(runtime, { recursive: true, force: true }); }
  });
});


describe("resident image layout transport", () => {
  it("sends raw bytes and verifies model identity and source hash", async () => {
    const input = await sharp({ create: { width: 20, height: 10, channels: 3, background: "white" } }).png().toBuffer();
    let badHash = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(input);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ...payload(), image: { width: 20, height: 10, sha256: badHash ? "wrong" : createHash("sha256").update(input).digest("hex") } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test listener");
      const options = { endpoint: `http://127.0.0.1:${address.port}/layout`, expectedModelId: "detector", expectedRevision: "test", device: "cpu" as const };
      const result = await detectImageLayoutAtEndpoint(input, options);
      expect(result.regions).toHaveLength(1);
      await expect(detectImageLayoutAtEndpoint(input, { ...options, expectedRevision: "different" })).rejects.toThrow("model identity");
      await expect(detectImageLayoutAtEndpoint(input, { ...options, device: "cuda" })).rejects.toThrow("device");
      badHash = true;
      await expect(detectImageLayoutAtEndpoint(input, options)).rejects.toThrow("source hash");
      await expect(detectImageLayoutAtEndpoint(input, { ...options, endpoint: "https://example.com/layout" })).rejects.toThrow("127.0.0.1");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
