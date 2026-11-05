import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import {
  OcrLowConfidenceError,
  candidateLanguageSets,
  ocrImageText,
  ocrMaxAttempts,
  ocrPageBudgetMs,
  parseOsdOutput,
  parseTesseractTsv,
} from "../lib/ocr-language.js";

const exec = promisify(execFile);

const tsv = (words: Array<[block: number, par: number, line: number, conf: number, text: string]>) =>
  ["level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext", ...words.map(([b, p, l, conf, text], i) =>
    `5\t1\t${b}\t${p}\t${l}\t${i + 1}\t0\t0\t10\t10\t${conf}\t${text}`)].join("\n");

describe("OCR output parsing", () => {
  it("reads script detection output", () => {
    expect(parseOsdOutput("Page number: 0\nOrientation in degrees: 0\nRotate: 0\nOrientation confidence: 14.25\nScript: Cyrillic\nScript confidence: 6.67\n"))
      .toEqual({ script: "Cyrillic", scriptConfidence: 6.67 });
    expect(parseOsdOutput("Too few characters. Skipping this page")).toEqual({ script: null, scriptConfidence: null });
  });

  it("rebuilds lines and mean confidence from TSV, keeping Chinese words together", () => {
    const result = parseTesseractTsv(tsv([[1, 1, 1, 90, "Hello"], [1, 1, 1, 70, "world"], [1, 1, 2, 80, "again"], [2, 1, 1, 60, "新"], [2, 1, 1, 60, "宿"]]));
    expect(result.text).toBe("Hello world\nagain\n\n新宿");
    expect(result.words).toBe(5);
    expect(result.meanConfidence).toBeCloseTo(72, 5);
  });

  it("ignores rows without a recognized word", () => {
    expect(parseTesseractTsv(tsv([[1, 1, 1, -1, ""]]))).toEqual({ text: "", words: 0, meanConfidence: null });
  });
});

describe("language sets", () => {
  const withPacks = (...codes: string[]) => (path: string) => !path.endsWith(".traineddata") || codes.some((code) => path.endsWith(`/${code}.traineddata`));

  it("maps a detected script to the matching installed packs", () => {
    const exists = withPacks("eng", "rus", "ukr", "ara", "chi_sim", "chi_tra", "jpn");
    expect(candidateLanguageSets("Cyrillic", {}, exists)).toEqual(["rus+ukr+eng", "eng"]);
    expect(candidateLanguageSets("Han", {}, exists)).toEqual(["chi_sim+eng", "chi_tra+eng", "jpn+eng", "eng"]);
    expect(candidateLanguageSets("Latin", {}, exists)).toEqual(["eng"]);
  });

  it("drops packs that are not installed and falls back to English", () => {
    expect(candidateLanguageSets("Arabic", {}, withPacks("eng"))).toEqual(["eng"]);
    expect(candidateLanguageSets("Armenian", {}, withPacks("eng"))).toEqual(["eng"]);
  });
});

describe("ocrImageText with a scripted tesseract", () => {
  // Every pack counts as installed, so the outcome does not depend on the machine's tessdata.
  const allPacks = () => true;
  const word = (conf: number, count: number, text = "word") => tsv(Array.from({ length: count }, (_, i) => [1, 1, 1, conf, `${text}${i}`]));
  const scripted = (responses: Record<string, string>, calls: string[][] = []) => async (args: string[]) => {
    calls.push(args);
    if (args.includes("osd")) {
      if (!("osd" in responses)) throw new Error("Too few characters");
      return responses.osd!;
    }
    return responses[args[args.indexOf("-l") + 1]!] ?? tsv([]);
  };

  it("does not run English on a Cyrillic page", async () => {
    const calls: string[][] = [];
    const result = await ocrImageText({ exists: allPacks,
      image: "page.png",
      run: scripted({ osd: "Script: Cyrillic\nScript confidence: 6", "rus+ukr+eng": word(92, 12, "слово") }, calls),
    });
    expect(result.languages).toBe("rus+ukr+eng");
    expect(result.script).toBe("Cyrillic");
    expect(result.escalated).toBe(false);
    expect(calls.map((call) => call[call.indexOf("-l") + 1])).toEqual(["osd", "rus+ukr+eng"]);
  });

  it("retries other packs when confidence is low and keeps the better result", async () => {
    const result = await ocrImageText({ exists: allPacks,
      image: "page.png",
      run: scripted({ osd: "Script: Han\nScript confidence: 3", "chi_sim+eng": word(35, 10), "chi_tra+eng": word(88, 10) }),
    });
    expect(result.escalated).toBe(true);
    expect(result.languages).toBe("chi_tra+eng");
    expect(result.attempts.map((attempt) => attempt.languages).slice(0, 2)).toEqual(["chi_sim+eng", "chi_tra+eng"]);
  });

  it("tries the common scripts when script detection fails", async () => {
    const calls: string[][] = [];
    const result = await ocrImageText({ exists: allPacks, image: "page.png", run: scripted({ eng: word(25, 3), "chi_sim+eng": word(30, 4), "rus+ukr+eng": word(30, 3), "ara+eng": word(90, 10) }, calls) });
    expect(result.languages).toBe("ara+eng");
    expect(result.script).toBeNull();
  });

  it("caps the trial runs per page at 3 once the script is known, so a hard page is not 6 tesseract runs", async () => {
    const calls: string[][] = [];
    // Han has three packs and English after them: the old limit ran all four.
    const result = await ocrImageText({ exists: allPacks, image: "page.png", run: scripted({ osd: "Script: Han\nScript confidence: 3", "chi_sim+eng": word(50, 10), "chi_tra+eng": word(52, 10), "jpn+eng": word(51, 10), eng: word(90, 10) }, calls) });
    // Script detection plus three trials, not detection plus the fourth set that would have read it.
    expect(calls.filter((call) => call.includes("tsv"))).toHaveLength(3);
    expect(result.attempts).toHaveLength(3);
    expect(result.capped).toBe("attempts");
    expect(result.languages).not.toBe("eng");
    // An undetected script keeps five trials (an Arabic scan is the fourth set the unknown-script order tries).
    const unknown = await ocrImageText({ exists: allPacks, image: "page.png", run: scripted({ eng: word(25, 3), "chi_sim+eng": word(30, 4), "rus+ukr+eng": word(30, 3), "ara+eng": word(90, 10) }) });
    expect(unknown.languages).toBe("ara+eng");
    // The cap can be set from 1 to 5, never past it.
    expect(ocrMaxAttempts({})).toBe(3);
    expect(ocrMaxAttempts({}, false)).toBe(5);
    expect(ocrMaxAttempts({ DOCSLURP_OCR_MAX_ATTEMPTS: "1" })).toBe(1);
    expect(ocrMaxAttempts({ DOCSLURP_OCR_MAX_ATTEMPTS: "9" })).toBe(5);
    expect(ocrMaxAttempts({ DOCSLURP_OCR_MAX_ATTEMPTS: "0" })).toBe(3);
    const single = await ocrImageText({ exists: allPacks, image: "page.png", env: { ...process.env, DOCSLURP_OCR_MAX_ATTEMPTS: "1" }, run: scripted({ eng: word(25, 3), "chi_sim+eng": word(90, 10) }) });
    expect(single.attempts).toHaveLength(1);
  });

  it("starts no further trial once the page's OCR time budget is spent, but always runs the first", async () => {
    let clock = 0;
    const calls: string[][] = [];
    const slow = async (args: string[]) => {
      calls.push(args);
      clock += 25_000; // every tesseract run takes 25 s
      if (args.includes("osd")) return "Script: Han\nScript confidence: 3";
      return word(50, 10);
    };
    const result = await ocrImageText({ exists: allPacks, image: "page.png", now: () => clock, run: slow });
    // Detection 25 s, first trial 25 s, second trial 25 s (it started at 50 s, inside the 60 s budget), third refused at 75 s.
    expect(calls.filter((call) => call.includes("tsv"))).toHaveLength(2);
    expect(result.capped).toBe("time");
    // A budget of 1 s still reads the page once.
    clock = 0;
    const one = await ocrImageText({ exists: allPacks, image: "page.png", now: () => clock, env: { ...process.env, DOCSLURP_OCR_PAGE_BUDGET_MS: "1000" }, run: slow });
    expect(one.attempts).toHaveLength(1);
    expect(ocrPageBudgetMs({})).toBe(60_000);
  });

  it("stops after two empty reads when the script is unknown: the page is blank", async () => {
    const calls: string[][] = [];
    const result = await ocrImageText({ exists: allPacks, image: "blank.png", run: scripted({}, calls) });
    expect(result.text).toBe("");
    expect(calls.filter((call) => call.includes("tsv"))).toHaveLength(2);
  });

  it("refuses junk instead of returning it", async () => {
    await expect(ocrImageText({
      image: "page.png",
      run: scripted({ osd: "Script: Latin\nScript confidence: 1", eng: word(18, 20), "deu+fra+spa+ita+nld+pol+por+tur+eng": word(22, 20) }),
    })).rejects.toBeInstanceOf(OcrLowConfidenceError);
  });

  it("accepts a blank page and a short low-confidence fragment", async () => {
    expect((await ocrImageText({ exists: allPacks, image: "blank.png", run: scripted({ osd: "Script: Latin\nScript confidence: 1", eng: tsv([]) }) })).text).toBe("");
    expect((await ocrImageText({ exists: allPacks, image: "x.png", run: scripted({ osd: "Script: Latin\nScript confidence: 1", eng: word(20, 3) }) })).words).toBe(3);
  });

  it("uses the project language as given, and rejects anything that is not Tesseract codes", async () => {
    const calls: string[][] = [];
    const result = await ocrImageText({ exists: allPacks, image: "page.png", setting: "eng+deu", run: scripted({ "eng+deu": word(90, 10) }, calls) });
    expect(result.languages).toBe("eng+deu");
    expect(calls).toHaveLength(1);
    await expect(ocrImageText({ image: "page.png", setting: "eng --psm 0", run: scripted({}) })).rejects.toThrow(/invalid OCR language/);
  });
});

// Real Tesseract on rendered scans; skipped where the tool, packs or fonts are not installed.
const tesseract = (() => { try { execFileSync("tesseract", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const magick = (() => { try { execFileSync("magick", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const installed = (...codes: string[]) => {
  if (!tesseract) return false;
  const list = execFileSync("tesseract", ["--list-langs"], { encoding: "utf8" });
  return codes.every((code) => list.split("\n").includes(code));
};
const font = (path: string) => (existsSync(path) ? path : null);
const NOTO = "/usr/share/fonts/noto/NotoSans-Regular.ttf";
const NOTO_CJK = "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc";
const NOTO_ARABIC = "/usr/share/fonts/noto/NotoSansArabic-Regular.ttf";

describe.skipIf(!tesseract || !magick)("ocrImageText with real Tesseract", { timeout: 120_000 }, () => {
  const dirs: string[] = [];
  afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

  async function render(name: string, fontPath: string, text: string) {
    const dir = await mkdtemp(join(tmpdir(), "ocr-language-"));
    dirs.push(dir);
    const image = join(dir, `${name}.png`);
    await exec("magick", ["-background", "white", "-fill", "black", "-font", fontPath, "-pointsize", "48", `label:${text}`, image]);
    return image;
  }
  const run = (args: string[]) => exec("tesseract", args, { maxBuffer: 16 * 1024 * 1024 }).then((result) => result.stdout);

  it.skipIf(!installed("jpn", "osd", "eng") || !font(NOTO_CJK))("reads a Japanese scan that English OCR turns into junk", async () => {
    const image = await render("ja", NOTO_CJK, "請求書の支払期限は来月末日です。\n東京の本社で契約を締結します。");
    const english = await run([image, "stdout", "-l", "eng"]);
    expect(english).not.toContain("支払期限");
    const result = await ocrImageText({ image, run });
    expect(result.languages).toContain("jpn");
    expect(result.text.replace(/\s+/g, "")).toContain("支払期限");
  });

  it.skipIf(!installed("rus", "osd", "eng") || !font(NOTO))("reads a Russian scan", async () => {
    const image = await render("ru", NOTO, "Москва является столицей России\nи крупнейшим городом страны");
    const result = await ocrImageText({ image, run });
    expect(result.languages).toContain("rus");
    expect(result.text).toContain("Москва");
  });

  it.skipIf(!installed("ara", "osd", "eng") || !font(NOTO_ARABIC))("reads an Arabic scan even when script detection has too little to go on", async () => {
    const image = await render("ar", NOTO_ARABIC, "المعهد الوطني للبحوث العلمية\nيقع في العاصمة");
    const result = await ocrImageText({ image, run });
    expect(result.languages).toContain("ara");
    expect(result.text).toContain("العاصمة");
  });

  it.skipIf(!installed("eng", "osd") || !font(NOTO))("keeps reading English with the English pack", async () => {
    const image = await render("en", NOTO, "The tenant shall pay the rent on the\nfirst day of each month");
    const result = await ocrImageText({ image, run });
    expect(result.languages).toBe("eng");
    expect(result.text).toContain("tenant shall pay");
  });
});
