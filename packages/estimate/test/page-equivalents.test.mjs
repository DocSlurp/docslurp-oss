// The profile's page equivalents must be what billing will measure: the shared functions core bills with
// (packages/shared/src/page-equivalents.ts) applied to the text extraction would keep and the page's CropBox size.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DENSE_PAGE_EQUIVALENTS, pageAreaEquivalentsPt, pageEquivalents, pageTextEquivalents } from "@docslurp/shared";

import { createEstimator } from "../js/index.mjs";

const estimator = await createEstimator();

/** A one-page PDF: Helvetica text blocks on a page of `width` x `height` points. */
function pdf(blocks, width = 612, height = 792) {
  const content = blocks.map(({ lines, perLine, size, mode = 0, x = 72, y = height - 72 }) => {
    let text = `BT /F1 ${size} Tf ${mode} Tr ${size * 1.2} TL ${x} ${y} Td\n`;
    for (let line = 0; line < lines; line += 1) text += `(${"x".repeat(perLine)}) Tj T*\n`;
    return `${text}ET`;
  }).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let body = "%PDF-1.7\n";
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** The text extraction keeps for these blocks (each line its own line; tiny glyphs capped, off-page lines dropped). */
function extractedText(blocks, height) {
  let tinyKept = 0;
  const lines = [];
  for (const { lines: count, perLine, size, y = height - 72 } of blocks) {
    for (let line = 0; line < count; line += 1) {
      if (y - line * size * 1.2 < 0) continue; // below the MediaBox: dropped
      let glyphs = perLine;
      if (size < 3) { glyphs = Math.min(glyphs, 50_000 - tinyKept); tinyKept += glyphs; }
      if (glyphs > 0) lines.push("x".repeat(glyphs));
    }
  }
  return lines.join("\n");
}

const cases = [
  { name: "an ordinary page", blocks: [{ lines: 40, perLine: 60, size: 11 }] },
  { name: "0.1 pt text", blocks: [{ lines: 400, perLine: 100, size: 0.1 }] },
  { name: "0.1 pt text over the tiny-glyph limit", blocks: [{ lines: 700, perLine: 100, size: 0.1 }] },
  { name: "invisible 3 pt text", blocks: [{ lines: 10, perLine: 50, size: 11 }, { lines: 200, perLine: 100, size: 3, mode: 3, y: 760 }] },
  { name: "many short lines", blocks: [{ lines: 600, perLine: 3, size: 1 }] },
  { name: "text running off the page", blocks: [{ lines: 200, perLine: 80, size: 11 }] },
  { name: "a tabloid page", blocks: [{ lines: 2, perLine: 20, size: 11 }], width: 792, height: 1_224 },
  { name: "a 200-inch page", blocks: [{ lines: 2, perLine: 20, size: 11 }], width: 14_400, height: 14_400 },
];

describe("profile page equivalents match the shared billing functions", () => {
  for (const { name, blocks, width = 612, height = 792 } of cases) {
    it(name, () => {
      const bytes = pdf(blocks, width, height);
      const profile = estimator.profile({ name: "case.pdf", size: bytes.length }, bytes);
      const text = pageTextEquivalents(extractedText(blocks, height));
      const area = pageAreaEquivalentsPt(width, height);
      const expected = pageEquivalents(text, area);
      assert.equal(profile.pdf.sampledTextEquivalents, text, "text equivalents");
      assert.equal(profile.pdf.areaEquivalentsPerPage.findIndex((pages) => pages === 1) + 1, area, "area equivalents");
      assert.equal(profile.pdf.sampledPageEquivalents, expected, "page equivalents");
      assert.equal(profile.pdf.densePages, text > DENSE_PAGE_EQUIVALENTS ? 1 : 0, "dense");
      assert.deepEqual([profile.pdf.maxPageWidthPt, profile.pdf.maxPageHeightPt], [width, height]);
    });
  }
});
