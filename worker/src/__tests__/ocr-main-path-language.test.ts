import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { normalizePipelineFeatures } from "@docslurp/shared";

import { AUTO_LANGUAGE_LIMIT, resolveOcrLanguages, withKreuzbergOcrLanguage } from "../extractors/kreuzberg-ocr.js";
import { serializeExtractorOptions } from "../extractors/registry.js";
import type { Document, ProjectRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createProductionExecutorDeps } from "../routing/executors/deps.js";
import { ToCanonicalStage } from "../stages/to-canonical.js";
import { CommandRunner } from "../tools/runner.js";

/** Which language packs "exist": every `<code>.traineddata` named in `installed`. */
const packs = (...installed: string[]) => (file: string) => installed.some((code) => file.endsWith(`/${code}.traineddata`)) || file === "/usr/share/tessdata";
const env = { TESSDATA_PREFIX: "/usr/share/tessdata" } as NodeJS.ProcessEnv;

describe("the project OCR language reaches Kreuzberg", () => {
  it("passes a named language through", () => {
    expect(resolveOcrLanguages("chi_sim", env, packs("eng"))).toBe("chi_sim");
    const options = withKreuzbergOcrLanguage({}, "ell+eng", env, packs("eng"));
    expect(JSON.parse(serializeExtractorOptions(options, "kreuzberg")!)).toEqual({ ocr: { language: "ell+eng" } });
  });

  it("turns auto into English plus the installed major-script packs, capped", () => {
    expect(resolveOcrLanguages("auto", env, packs("eng", "rus", "ara"))).toBe("eng+rus+ara");
    expect(resolveOcrLanguages(undefined, env, packs("eng", "chi_sim", "rus", "ara", "jpn", "kor"))).toBe("eng+chi_sim+rus+ara");
    expect(resolveOcrLanguages("auto", env, packs("eng", "chi_sim", "rus", "ara", "jpn", "kor"))!.split("+")).toHaveLength(AUTO_LANGUAGE_LIMIT);
    expect(resolveOcrLanguages("auto", env, packs())).toBeNull();
  });

  it("keeps the language a project set on the Kreuzberg options and the other options untouched", () => {
    const options = { kreuzberg: { forceOcr: true, ocr: { language: "kor" } } };
    expect(withKreuzbergOcrLanguage(options, "deu", env, packs("eng"))).toBe(options);
    const merged = withKreuzbergOcrLanguage({ kreuzberg: { forceOcr: true } }, "deu", env, packs("eng"));
    expect(merged).toEqual({ kreuzberg: { forceOcr: true, ocr: { language: "deu" } } });
  });

  it("leaves options that disable OCR as they are", () => {
    const fast = { kreuzberg: { disableOcr: true } };
    expect(withKreuzbergOcrLanguage(fast, "auto", env, packs("eng", "rus"))).toBe(fast);
  });

  it("leaves the options alone when no pack is installed (OCR reports itself unavailable)", () => {
    expect(withKreuzbergOcrLanguage({}, "auto", env, packs())).toEqual({});
  });
});

const tsv = (words: Array<[conf: number, text: string]>) =>
  ["level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext", ...words.map(([conf, text], i) =>
    `5\t1\t1\t1\t1\t${i + 1}\t0\t0\t10\t10\t${conf}\t${text}`)].join("\n");

describe("page OCR of a non-Latin scan", () => {
  const document = { id: "doc", userId: "u", runId: "r", filename: "scan.png", mimeType: "image/png", sourceKey: "u/source/scan.png", pageCount: 1 } as unknown as Document;
  const depsFor = (ocrLanguage: string | undefined, output: string, calls: string[][]) => createProductionExecutorDeps({
    runId: "r",
    document,
    storage: {} as never,
    rasters: { renderSelectedPages: async () => [], sourcePath: async () => "" } as never,
    runner: {
      plan: async (_binary: string, ...args: string[]) => ({ available: true, binary: "tesseract", args }) as never,
      run: async (plan: { args: string[] }) => { calls.push(plan.args); return { stdout: output } as never; },
      florence2: async () => ({ available: false }) as never,
    },
    ocrLanguage,
    canonicalUri: () => null,
    selection: {} as never,
    allow: async () => true,
    callVision: async () => { throw new Error("no vision"); },
    recordLocalUsage: () => undefined,
  });

  it("reads with the project language instead of English", async () => {
    const calls: string[][] = [];
    const deps = depsFor("rus+ukr", tsv(Array.from({ length: 12 }, (_, i) => [92, `слово${i}`] as [number, string])), calls);
    const result = await deps.ocr({ path: "/scan/page.png", mimeType: "image/png", pageNumber: 1 }, { pageNumber: 1 });
    expect(result.text).toContain("слово0");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("rus+ukr");
    expect(calls[0]).not.toContain("eng");
  });

  it("returns empty text, never throws, when no installed pack can read the page", async () => {
    const calls: string[][] = [];
    const junk = tsv(Array.from({ length: 20 }, (_, i) => [12, `x${i}`] as [number, string]));
    const deps = depsFor("chi_sim", junk, calls);
    const result = await deps.ocr({ path: "/scan/page.png", mimeType: "image/png", pageNumber: 1 }, { pageNumber: 1 });
    expect(result.text).toBe("");
    expect(result.model).toBe("tesseract");
  });
});

describe("the canonical stage plans OCR in the project language", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  const run = async (documentExtraction: Record<string, unknown> | undefined, filename: string) => {
    const document = { id: "doc", userId: "u", runId: "r", filename, mimeType: "image/png", sourceKey: `u/source/${filename}`, pageCount: 1 } as unknown as Document;
    const state = WorkflowState.create({
      id: "r", orgId: "org", userId: "u", projectId: "ws", spentCents: 0, stats: {}, artifacts: {},
      pipeline: { ...normalizePipelineFeatures({}), ...(documentExtraction ? { documentExtraction } : {}) },
    } as unknown as ProjectRun, [document]);
    state.artifactLedger.recordDocument(document.id, "normalizedFormat", "image");
    const dir = await mkdtemp(path.join(tmpdir(), "to-canonical-"));
    dirs.push(dir);
    const planned: string[][] = [];
    const runner = Object.assign(new CommandRunner(), {
      plan: async (binary: string, ...args: string[]) => { planned.push([binary, ...args]); return { binary, args, available: true } as never; },
      tiffSplit: async () => ({ binary: "tiffcp", args: [], available: true }) as never,
      pdfInfo: async () => ({ binary: "pdfinfo", args: [], available: false }) as never,
    });
    const stored = new Map<string, unknown>();
    const storage = { uri: (key: string) => `s3://bucket/${key}`, putJson: async (key: string, value: unknown) => void stored.set(key, value), bucket: "bucket" } as never;
    await new ToCanonicalStage(runner, storage).run(state);
    return planned.find(([binary]) => binary === "tesseract");
  };

  it("plans tesseract with the named language, for images and for TIFF pages, not a hard-coded eng", async () => {
    const named = await run({ ocr: { language: "chi_sim", autoRotate: true } }, "scan.png");
    expect(named).toEqual(expect.arrayContaining(["-l", "chi_sim"]));
    const tiff = await run({ ocr: { language: "deu+eng", autoRotate: true } }, "scan.tiff");
    expect(tiff).toEqual(expect.arrayContaining(["-l", "deu+eng"]));
  });
});
