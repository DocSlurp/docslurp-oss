import { afterEach, expect, it, vi } from "vitest";
import { CommandRunner } from "../tools/runner.js";

afterEach(() => vi.unstubAllEnvs());

it("passes configured local model defaults to helper scripts and honors explicit selections", async () => {
  vi.stubEnv("DOCSLURP_LOCAL_OCR_MODEL", "vendor/local-ocr");
  vi.stubEnv("DOCSLURP_CLIP_MODEL", "vendor/local-classifier");
  const runner = new CommandRunner();
  vi.spyOn(runner, "isAvailable").mockResolvedValue(true);
  const ocr = await runner.florence2("page.png", "out.json", "<OCR>");
  const clip = await runner.transformersJsClip("page.png", "out.json", "text,photo");
  const explicit = await runner.florence2("page.png", "out.json", "<OCR>", "vendor/workspace-ocr");
  expect(ocr.args.slice(-2)).toEqual(["--model", "vendor/local-ocr"]);
  expect(clip.args.slice(-2)).toEqual(["--model", "vendor/local-classifier"]);
  expect(explicit.args.slice(-2)).toEqual(["--model", "vendor/workspace-ocr"]);
});
