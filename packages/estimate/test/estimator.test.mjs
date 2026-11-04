import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { PRICE_CARD_VERSION, estimateProfileFor, defaultPipelineFeatures, quoteUpload, textPageCount } from "@docslurp/shared";

import { createEstimator, EstimatorError } from "../js/index.mjs";
import { probePath, quotePaths } from "../js/node.mjs";
import { lazyObjectStreamBomb } from "./hostile.mjs";

const fixture = (name) => new URL(`../tests/fixtures/${name}`, import.meta.url).pathname;
const bundledCard = JSON.parse(readFileSync(new URL("../card.json", import.meta.url), "utf8"));
const estimator = await createEstimator();

function sequence(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    bool: (p = 0.5) => next() < p,
  };
}

describe("@docslurp/estimate (wasm)", () => {
  it("bundles the card @docslurp/shared generated", () => {
    const card = estimator.card();
    assert.equal(card.revision, bundledCard.revision);
    assert.equal(card.version, PRICE_CARD_VERSION);
  });

  it("quotes exactly as the TypeScript quoteUpload does, over random valid requests", () => {
    const rng = sequence(0xe57);
    const names = ["report.pdf", "deck.pptx", "scan.png", "photo.jpeg", "a.docx", "talk.mp3", "song.flac", "clip.mp4", "film.mov", "page.html", "data"];
    const types = [undefined, "image/heic", "application/pdf", "audio/aac", "video/x-msvideo", "text/plain; charset=utf-8"];
    for (let i = 0; i < 400; i += 1) {
      const profile = {
        ...estimateProfileFor({ ...defaultPipelineFeatures, quality: rng.pick(["fast", "auto", "good"]), graphRag: rng.bool(0.3) }, {
          env: rng.bool(0.9) ? { DOCSLURP_BILL_INGEST: "true" } : {},
          workerSlots: rng.bool(0.5) ? rng.pick([1, 50, 250]) : undefined,
        }),
        videoFrames: rng.bool(0.7),
      };
      const files = Array.from({ length: rng.int(1, 8) }, () => {
        const file = { name: rng.pick(names), size: rng.int(0, 80_000_000) };
        if (rng.bool(0.25)) {
          const type = rng.pick(types);
          if (type) file.type = type;
        }
        if (rng.bool(0.4)) file.pages = rng.int(1, 2_000);
        if (rng.bool(0.25)) file.durationSeconds = rng.int(1, 7_200) + (rng.bool() ? 0.25 : 0);
        if (rng.bool(0.4)) {
          file.mix = { text: rng.int(0, 5), complex: rng.int(0, 5), scanned: rng.int(0, 5) };
          if (rng.bool(0.6)) file.mixConfidence = rng.next();
        }
        return file;
      });
      const request = { files, profile, ...(rng.bool(0.3) ? { speedBoost: rng.bool() } : {}) };
      const expected = quoteUpload(request);
      const actual = estimator.quote(request);
      assert.deepStrictEqual({ estimate: actual.estimate, media: actual.media }, expected, `case ${i}: ${JSON.stringify(request)}`);
    }
  });

  it("refuses requests and cards it cannot price faithfully", () => {
    const file = { name: "a.pdf", size: 10, pages: 3 };
    const profile = bundledCard.defaultProfile;
    const code = (fn) => {
      try {
        fn();
      } catch (error) {
        assert.ok(error instanceof EstimatorError);
        return error.code;
      }
      assert.fail("expected an EstimatorError");
    };
    assert.equal(code(() => estimator.quote({ files: [file], profile: { ...profile, quality: "ultra" } })), "unsupported_rules");
    assert.equal(code(() => estimator.quote({ files: [file], profile: { ...profile, newField: 1 } })), "invalid_request");
    assert.equal(code(() => estimator.quote({ files: [{ ...file, mix: { text: 1 } }] })), "invalid_request");
    assert.equal(code(() => estimator.quote({ files: [{ ...file, mixConfidence: 2 }] })), "invalid_request");
    assert.equal(code(() => estimator.quote({ files: [] })), "invalid_request");
    return createEstimator({ card: { ...bundledCard, rules: bundledCard.rules + 1 } }).then((newer) => {
      assert.equal(code(() => newer.quote({ files: [file] })), "unsupported_rules");
    });
  });

  it("reports the card it used and a profile built for another card", async () => {
    const supplied = await createEstimator({ card: { ...bundledCard, version: "next" } });
    const quote = supplied.quote({ files: [{ name: "a.pdf", size: 10 }], profile: bundledCard.defaultProfile });
    assert.equal(quote.card.source, "supplied");
    assert.deepEqual(quote.warnings, ["profile-card-mismatch"]);
    assert.equal(estimator.quote({ files: [{ name: "a.pdf", size: 10 }] }).card.source, "bundled");
  });

  it("probes files from disk and prices what it measured", async () => {
    const { probe } = await probePath(estimator, fixture("scan_plain.pdf"));
    assert.equal(probe.kind, "pdf");
    assert.equal(probe.mix.scanned, 1);

    const quote = await quotePaths(estimator, [fixture("scan_plain.pdf"), fixture("text_wrapped_with_photo.pdf")]);
    assert.match(quote.estimate.basis, /page mix known for every file/);
    assert.equal(quote.estimate.pages, 2);
    // Probes are trusted below 1, so the range narrows around the measured mix without collapsing.
    const unknown = estimator.quote({ files: quote.estimate.pages ? [{ name: "a.pdf", size: 1, pages: 1 }, { name: "b.pdf", size: 1, pages: 1 }] : [] });
    assert.ok(quote.estimate.credits.low > unknown.estimate.credits.low);
    assert.ok(quote.estimate.credits.high - quote.estimate.credits.low < unknown.estimate.credits.high - unknown.estimate.credits.low);
  });

  it("counts text pages exactly as the API does", () => {
    const samples = ["", "one line", "a\r\nb\n".repeat(400), `  ${"é".repeat(9_000)}\ufeff `, "x".repeat(3_500) + "\n".repeat(59)];
    for (const text of samples) {
      const bytes = new TextEncoder().encode(text);
      const probe = estimator.probe({ name: "notes.txt", size: bytes.length }, bytes);
      assert.equal(probe.kind, "text");
      assert.equal(probe.pages, textPageCount(text), JSON.stringify(text.slice(0, 20)));
    }
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
        const probe = estimator.probe(file, bomb);
        assert.equal(probe.mix, undefined); // refused by a budget: fine too
      } catch (error) {
        assert.ok(error instanceof EstimatorError);
        assert.equal(error.code, "crashed");
      }
    }
    // Six crashes reuse the same 256 MiB memory instead of leaving six behind for the garbage collector.
    assert.ok(process.memoryUsage().rss - before < 512 * 1024 * 1024, `rss grew ${(process.memoryUsage().rss - before) >> 20} MiB`);
    const quote = estimator.quote({ files: [{ name: "a.pdf", size: 10, pages: 2 }] });
    assert.equal(quote.estimate.pages, 2);
  });

  it("reads a WAV duration from its header and prices it as audio without a name hint", () => {
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
    const probe = estimator.probe(file, header);
    assert.equal(probe.durationSeconds, seconds);
    assert.equal(probe.mimeType, "audio/wav");
    const quote = estimator.quote({ files: [{ ...file, type: probe.mimeType, durationSeconds: probe.durationSeconds }] });
    assert.equal(quote.media.audioFiles, 1);
    assert.equal(quote.estimate.pages, 0);
  });
});
