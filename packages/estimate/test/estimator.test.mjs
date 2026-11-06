import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { FILE_PROFILE_SCHEMA, decodeTextBytes, fileProfileSchema, normalizeFileProfile, textPageCount } from "@docslurp/shared";

import { createEstimator, EstimatorError, requestQuote } from "../js/index.mjs";
import { estimatePaths, profilePath } from "../js/node.mjs";
import { lazyObjectStreamBomb } from "./hostile.mjs";

const fixture = (name) => new URL(`../tests/fixtures/${name}`, import.meta.url).pathname;
const fixtureNames = ["form_amplification.pdf", "no_text_small_images.pdf", "page_tree_cycle.pdf", "scan_big_mediabox.pdf", "scan_glyph_title.pdf", "scan_inline.pdf", "scan_ocr_invisible_wrapped.pdf", "scan_plain.pdf", "text_wrapped_with_photo.pdf", "vector_page_in_text_doc.pdf"];
const PRICING_WORDS = ["credit", "price", "priced", "bill", "rich", "fast", "cost", "free", "mix", "quote", "scanned"];
const estimator = await createEstimator();

describe("@docslurp/estimate (wasm)", () => {
  it("emits the profile schema the server accepts", () => {
    assert.equal(estimator.info().profileSchema, FILE_PROFILE_SCHEMA);
  });

  it("profiles every fixture into a small, neutral profile the server schema accepts unchanged", async () => {
    for (const name of fixtureNames) {
      const { file, profile } = await profilePath(estimator, fixture(name));
      const parsed = fileProfileSchema.safeParse(profile);
      assert.ok(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`);
      assert.deepEqual(normalizeFileProfile(parsed.data, file), parsed.data, `${name}: clamping changed an honest profile`);
      const json = JSON.stringify(profile);
      assert.ok(json.length <= 4096, `${name}: ${json.length} bytes`);
      for (const word of PRICING_WORDS) assert.ok(!json.toLowerCase().includes(word), `${name}: ${word} in ${json}`);
    }
  });

  it("measures raster pages, layout-heavy pages and text layers on the fixtures", async () => {
    const { profile: scan } = await profilePath(estimator, fixture("scan_plain.pdf"));
    assert.equal(scan.kind, "pdf");
    assert.deepEqual([scan.pages, scan.pdf.rasterPages, scan.pdf.textLayerPages], [1, 1, 0]);
    const { profile: photo } = await profilePath(estimator, fixture("text_wrapped_with_photo.pdf"));
    assert.deepEqual([photo.pdf.rasterPages, photo.pdf.layoutHeavyPages, photo.pdf.textLayerPages], [0, 1, 1]);
  });

  it("returns the request body for a server quote, and asks the server only when called", async () => {
    const result = await estimatePaths(estimator, [fixture("scan_plain.pdf"), fixture("missing.pdf")]);
    assert.deepEqual(result.request.files.map((file) => Boolean(file.profile)), [true, false]);
    let sent = null;
    const answer = await requestQuote({
      files: result.request.files,
      apiKey: "key",
      origin: "https://example.test",
      fetch: async (url, init) => {
        sent = { url: String(url), init };
        return new Response(JSON.stringify({ estimate: { credits: { low: 1, high: 2 } } }), { status: 200 });
      },
    });
    assert.equal(sent.url, "https://example.test/v1/uploads/estimate");
    assert.equal(sent.init.headers.authorization, "Bearer key");
    assert.deepEqual(JSON.parse(sent.init.body).files, result.request.files);
    assert.deepEqual(answer, { estimate: { credits: { low: 1, high: 2 } } });
    await assert.rejects(
      requestQuote({ files: result.request.files, fetch: async () => new Response("no", { status: 401 }) }),
      (error) => error instanceof EstimatorError && error.code === "quote_failed",
    );
  });

  it("refuses malformed requests", () => {
    assert.throws(() => estimator.readPlan({ name: 5, size: "x" }), (error) => error instanceof EstimatorError && error.code === "invalid_request");
  });

  it("counts text pages exactly as the API does", () => {
    const samples = ["", "one line", "a\r\nb\n".repeat(400), `  ${"é".repeat(9_000)}\ufeff `, "x".repeat(3_500) + "\n".repeat(59)];
    for (const text of samples) {
      const bytes = new TextEncoder().encode(text);
      const profile = estimator.profile({ name: "notes.txt", size: bytes.length }, bytes);
      assert.equal(profile.kind, "text");
      assert.equal(profile.pages, textPageCount(text), JSON.stringify(text.slice(0, 20)));
    }
  });

  it("counts East Asian text, HTML markup and UTF-16 files as the API does", () => {
    const cjk = "日本語のテキストです。".repeat(300);
    const html = `<!doctype html><html><head><style>${"a{x:y}".repeat(3_000)}</style><SCRIPT type="x">${"var a=1;".repeat(3_000)}</SCRIPT></head><body><!-- note --><p>Hello</p>${"<div class=\"c\">word</div>\n".repeat(80)}1 < 2 and <b>bold</b></body></html>`;
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${"name,total\r\n"}${"acme,10\r\n".repeat(200)}`, "utf16le")]);
    const cases = [
      ["cjk.txt", Buffer.from(cjk), textPageCount(cjk)],
      ["page.html", Buffer.from(html), textPageCount(html, { markup: true })],
      ["rows.csv", utf16, textPageCount(decodeTextBytes(utf16))],
    ];
    for (const [name, bytes, expected] of cases) {
      const profile = estimator.profile({ name, size: bytes.length }, bytes);
      assert.equal(profile.kind, "text");
      assert.equal(profile.pages, expected, name);
    }
    // Markup and scripts are not pages: the HTML above is a few lines of text, not the ~50 KB of source.
    assert.equal(textPageCount(html, { markup: true }), 2);
    assert.ok(textPageCount(html) > 10);
  });

  it("imports a memory capped at 256 MiB", async () => {
    const module = await WebAssembly.compile(readFileSync(new URL("../dist/docslurp_estimate.wasm", import.meta.url)));
    assert.deepEqual(WebAssembly.Module.imports(module), [{ module: "env", name: "memory", kind: "memory" }]);
    assert.throws(() => new WebAssembly.Instance(module, { env: { memory: new WebAssembly.Memory({ initial: 256, maximum: 8_192 }) } }));
  });

  it("survives hostile PDFs that escape every budget, reusing one bounded memory", () => {
    const bomb = lazyObjectStreamBomb();
    const file = { name: "bomb.pdf", size: bomb.length };
    const before = process.memoryUsage().rss;
    for (let round = 0; round < 6; round += 1) {
      try {
        const profile = estimator.profile(file, bomb);
        assert.equal(profile.pdf, undefined); // refused by a budget: fine too
      } catch (error) {
        assert.ok(error instanceof EstimatorError);
        assert.equal(error.code, "crashed");
      }
    }
    // Six crashes reuse the same 256 MiB memory instead of leaving six behind for the garbage collector.
    assert.ok(process.memoryUsage().rss - before < 512 * 1024 * 1024, `rss grew ${(process.memoryUsage().rss - before) >> 20} MiB`);
    assert.deepEqual(estimator.readPlan({ name: "a.pdf", size: 10 }), { head: 10, tail: 0 });
  });

  it("reports an input larger than the module's memory as a crash and recovers", () => {
    const huge = new Uint8Array(300 * 1024 * 1024);
    assert.throws(() => estimator.profile({ name: "huge.pdf", size: huge.length }, huge), (error) => error instanceof EstimatorError && error.code === "crashed");
    assert.equal(estimator.info().profileSchema, FILE_PROFILE_SCHEMA);
  });

  it("reads a WAV duration from its header without a name hint", () => {
    const seconds = 90;
    const rate = 8_000;
    const data = rate * 2 * seconds;
    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    header.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
    view.setUint32(4, 36 + data, true);
    header.set([..."WAVEfmt "].map((c) => c.charCodeAt(0)), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    header.set([..."data"].map((c) => c.charCodeAt(0)), 36);
    view.setUint32(40, data, true);
    const file = { name: "recording", size: 44 + data };
    // No extension and no type: read as possible media (head and, when large, tail).
    assert.deepEqual(estimator.readPlan(file), { head: file.size, tail: 0 });
    assert.deepEqual(estimator.readPlan({ name: "film.mov", size: 2e9 }), { head: 4 * 1024 * 1024, tail: 8 * 1024 * 1024 });
    assert.deepEqual(estimator.readPlan({ name: "a.pdf", size: 5_000 }), { head: 5_000, tail: 0 });
    const profile = estimator.profile(file, header);
    assert.equal(profile.durationSeconds, seconds);
    assert.equal(profile.mimeType, "audio/wav");
    assert.equal(profile.kind, "audio");
  });
});
