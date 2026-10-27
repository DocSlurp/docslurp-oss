import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { visionImageForModel, visionModelAcceptsImage } from "./vision-image-formats.js";

const WEBP = Buffer.from("RIFF\0\0\0\0WEBPVP8L", "latin1");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("vision image formats", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function file(bytes: Buffer): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-vision-format-"));
    dirs.push(dir);
    const target = path.join(dir, "page.webp");
    await writeFile(target, bytes);
    return target;
  }

  it("accepts PNG and JPEG everywhere and WebP only on probed models", () => {
    expect(visionModelAcceptsImage("anything/new", "image/png")).toBe(true);
    expect(visionModelAcceptsImage("deepseek/deepseek-v4.1-flash-1017", "image/webp")).toBe(true);
    expect(visionModelAcceptsImage("gpt-4.1-mini", "image/webp")).toBe(false);
    expect(visionModelAcceptsImage("Qwen/Qwen2.5-VL-3B-Instruct", "image/webp")).toBe(false);
  });

  it("sends WebP as is to a verified model", async () => {
    const run = vi.fn();
    const out = await visionImageForModel({ model: "z-ai/glm-5.3-flash", imagePath: await file(WEBP), fallbackMimeType: "image/png", runner: { run } as never });
    expect(out).toMatchObject({ mimeType: "image/webp", transcoded: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("transcodes WebP to PNG through the sandboxed dwebp for an unverified model", async () => {
    const imagePath = await file(WEBP);
    const run = vi.fn(async (plan: { args: string[] }) => {
      await writeFile(plan.args[plan.args.indexOf("-o") + 1]!, PNG);
      return { stdout: "", stderr: "" };
    });
    const decodeWebpToPng = vi.fn(async (source: string, output: string) => ({ binary: "dwebp", args: ["-quiet", "-o", output, "--", source], available: true }));
    const out = await visionImageForModel({ model: "gpt-4.1-mini", imagePath, fallbackMimeType: "image/png", runner: { run, decodeWebpToPng } as never });
    expect(out).toMatchObject({ mimeType: "image/png", transcoded: true });
    expect(out.bytes.equals(PNG)).toBe(true);
    expect(decodeWebpToPng).toHaveBeenCalledWith(imagePath, `${imagePath}.vision.png`);
    expect(run).toHaveBeenCalledOnce();
  });

  it("labels by the bytes, not the caller's default", async () => {
    const out = await visionImageForModel({ model: "gpt-4.1-mini", imagePath: await file(PNG), fallbackMimeType: "image/webp", runner: { run: vi.fn() } as never });
    expect(out).toMatchObject({ mimeType: "image/png", transcoded: false });
  });
});
