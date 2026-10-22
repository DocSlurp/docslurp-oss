import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema } from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { MIMO_TRANSCRIPTION_PROMPT, MIMO_VISION_MODEL, mimoOpenRouterParams, mimoVisionPrompt, normalizeMimoMathDelimiters, postProcessMimoTranscription } from "../tools/vision-model-mimo.js";
import { executeVisionRuntime, visionPromptTemplates } from "../tools/vision-runtime.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sentBody(vision: Record<string, unknown>) {
  const bodies: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  }));
  const dir = await mkdtemp(join(tmpdir(), "mimo-vision-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await executeVisionRuntime({
    imagePath,
    outputPath: `${imagePath}.json`,
    vision: visionConfigSchema.parse(vision),
    cfg: { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config,
    runner: new CommandRunner(),
    privacyMode: "standard",
  });
  return bodies[0]!;
}

describe("MiMo vision profile", () => {
  it("replaces only the default <OCR> template for the exact MiMo id", () => {
    expect(mimoVisionPrompt(MIMO_VISION_MODEL, undefined)).toBe(MIMO_TRANSCRIPTION_PROMPT);
    expect(mimoVisionPrompt(MIMO_VISION_MODEL, "<OCR>")).toBe(MIMO_TRANSCRIPTION_PROMPT);
    expect(mimoVisionPrompt(MIMO_VISION_MODEL, "markdown")).toBeUndefined();
    expect(mimoVisionPrompt(MIMO_VISION_MODEL, "form-fields")).toBeUndefined();
    expect(mimoVisionPrompt("xiaomi/mimo-v2.6-pro", "<OCR>")).toBeUndefined();
    expect(mimoVisionPrompt("google/gemini-3.1-flash-lite", "<OCR>")).toBeUndefined();
  });

  it("asks for delimited LaTeX and real Markdown tables", () => {
    expect(MIMO_TRANSCRIPTION_PROMPT).toContain("$$...$$");
    expect(MIMO_TRANSCRIPTION_PROMPT).toContain("pipe table");
    expect(MIMO_TRANSCRIPTION_PROMPT.length).toBeLessThan(2_000);
  });

  it("prefers the fast endpoints with fallbacks allowed, and only for MiMo", () => {
    expect(mimoOpenRouterParams(MIMO_VISION_MODEL)).toEqual({ provider: { order: ["relace", "deepinfra"], allow_fallbacks: true } });
    expect(mimoOpenRouterParams("deepseek/deepseek-v4.1-flash")).toEqual({});
    expect(mimoOpenRouterParams(undefined)).toEqual({});
  });

  it("sends MiMo the transcription prompt, provider preference and reasoning floor", async () => {
    const body = await sentBody({ modelUri: `llm://openrouter/${MIMO_VISION_MODEL}` });
    expect(body.model).toBe(MIMO_VISION_MODEL);
    expect(body.messages[1].content[0].text).toBe(MIMO_TRANSCRIPTION_PROMPT);
    expect(body.provider).toEqual({ order: ["relace", "deepinfra"], allow_fallbacks: true });
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.temperature).toBe(0);
  });

  it("keeps an explicit template for MiMo and leaves other models unchanged", async () => {
    const explicit = await sentBody({ modelUri: `llm://openrouter/${MIMO_VISION_MODEL}`, prompt: "layout" });
    expect(explicit.messages[1].content[0].text).toBe(visionPromptTemplates.layout);
    const other = await sentBody({});
    expect(other.messages[1].content[0].text).toBe(visionPromptTemplates["<OCR>"]);
    expect(other.provider).toBeUndefined();
  });
});

describe("normalizeMimoMathDelimiters", () => {
  const norm = normalizeMimoMathDelimiters;
  it("wraps a stand-alone line of bare structured LaTeX", () => {
    expect(norm("A = \\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}")).toBe("$$A = \\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}$$");
    expect(norm("Intro\n\np(\\theta \\mid D) = \\frac{a}{b}\n\nAfter")).toBe("Intro\n\n$$p(\\theta \\mid D) = \\frac{a}{b}$$\n\nAfter");
  });
  it("wraps a bare multi-line environment through its end", () => {
    expect(norm("\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}")).toBe("$$\n\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}\n$$");
  });
  it("converts \\( \\) and \\[ \\] delimiters, including multi-line display blocks", () => {
    expect(norm("with \\(d_k = 64\\) keys")).toBe("with $d_k = 64$ keys");
    expect(norm("\\[\nf(x) = \\frac{1}{x}\n\\]")).toBe("$$\nf(x) = \\frac{1}{x}\n$$");
  });
  it("leaves an inline span that runs across lines verbatim", () => {
    const text = "\\(f(x)=\\begin{cases}\nx & x \\ge 0\\\\\n-x & x < 0\n\\end{cases}\\)";
    expect(norm(text)).toBe(text);
  });
  it("leaves delimited math, row spacing, code, tables, headings and prose alone", () => {
    const text = [
      "# The \\alpha release",
      "Prose with $x^2$ and a price of $5.",
      "$$",
      "c_i = \\begin{cases} a \\\\[4pt] b \\end{cases}",
      "$$",
      "$$\\sum_i x_i$$",
      "| \\alpha | 1 |",
      "- \\frac{a}{b} in a list",
      "```",
      "\\frac{a}{b}",
      "```",
      "\\newcommand{\\R}{\\mathbb{R}} \\times {",
      "int main() { return a \\cdot b; }",
    ].join("\n");
    expect(norm(text)).toBe(text);
  });
  it("applies only to MiMo", () => {
    expect(postProcessMimoTranscription(MIMO_VISION_MODEL, "\\frac{a}{b}")).toBe("$$\\frac{a}{b}$$");
    expect(postProcessMimoTranscription("google/gemini-3.1-flash-lite", "\\frac{a}{b}")).toBe("\\frac{a}{b}");
  });
});
