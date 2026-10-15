import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadProbeBinding } from "./binding.js";
import { probeNativePdf, type NativeProbeRow } from "./probe.js";

/** A two-page PDF built by hand: prose text on page 1, an empty page 2. */
function buildPdf(): Buffer {
  const body = "The quick brown fox jumps over the lazy dog and the cat is on the mat with all of the other animals here. ";
  const lines = Array.from({ length: 8 }, (_, i) => `BT /F1 11 Tf 50 ${740 - i * 16} Td (${body.replaceAll("(", "").replaceAll(")", "")}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(lines)} >>\nstream\n${lines}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

const loaded = loadProbeBinding();

describe.skipIf(!loaded.ok)("native page probe on the real binding", () => {
  it("probes a text page and a blank page", async () => {
    if (!loaded.ok) return;
    const dir = await mkdtemp(path.join(os.tmpdir(), "probe-real-"));
    const file = path.join(dir, "doc.pdf");
    await writeFile(file, buildPdf());
    const rows: NativeProbeRow[] = [];
    for await (const row of probeNativePdf(loaded.binding, { pdfPath: file, thumbDir: dir, thumbPx: 128 })) rows.push(row);
    expect(rows.map((r) => r.textLayerStatus)).toEqual(["ok", "absent"]);
    expect(rows[0]).toMatchObject({ pageCount: 2, widthPt: 612, heightPt: 792, garbled: false, fontCount: expect.any(Number) });
    expect(rows[0]!.wordCount).toBeGreaterThan(100);
    expect(rows[0]!.textCoverage).toBeGreaterThan(0.05);
    expect(rows[0]!.brightness).toBeGreaterThan(0.8);
    expect(rows[1]).toMatchObject({ charCount: 0, imageCount: 0, unusualFeatures: [] });
    expect(rows[0]!.thumbnail).toMatch(/doc-p0001\.png$/);
  });
});
