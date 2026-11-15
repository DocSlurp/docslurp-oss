import { existsSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { scanFillPageNumbers } from "@docslurp/shared";
import { classifyAdaptivePage } from "../stages/classify-route.js";
// @ts-expect-error The built WASM JS facade has a .d.ts declaration, not .d.mts.
import { createEstimator } from "../../../packages/estimate/js/index.mjs";

const wasmAvailable = existsSync(new URL("../../../packages/estimate/dist/docslurp_estimate.wasm", import.meta.url));

function pdf(text: string, drawing = "", image = false) {
  const stream = `BT /F1 12 Tf 40 700 Td (${text}) Tj ET ${drawing}`;
  const bodies = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  if (image) {
    bodies[2] = bodies[2]!.replace("/Resources <<", "/Resources << /XObject << /Im1 6 0 R >>");
    const pixels = deflateSync(Buffer.alloc(1000 * 1000 * 3, 127)).toString("latin1");
    bodies.push(`<< /Type /XObject /Subtype /Image /Width 1000 /Height 1000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`);
  }
  let out = "%PDF-1.4\n";
  const offsets = bodies.map((body, i) => { const offset = out.length; out += `${i+1} 0 obj\n${body}\nendobj\n`; return offset; });
  const start = out.length;
  out += `xref\n0 ${bodies.length+1}\n0000000000 65535 f \n${offsets.map(n => String(n).padStart(10,"0")+" 00000 n \n").join("")}trailer\n<< /Size ${bodies.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

it.skipIf(!wasmAvailable)("runs synthetic PDFs through built WASM and production scan-fill", async () => {
  const estimator = await createEstimator();
  for (const text of ["--- !!! ...", "Letters", "12345", ""]) {
    const bytes = pdf(text, text === "" ? "40 40 m 200 200 l S" : "");
    const profile = estimator.profile({ name: "synthetic.pdf", size: bytes.length }, bytes);
    const ocr = scanFillPageNumbers([text])!.length;
    expect(profile.pdf.lexicalPages).toEqual(ocr ? [0,1,0] : [1,0,0]);
    expect(profile.pdf.routePages.slice(0,2).reduce((a: number,b: number) => a+b,0)).toBe(ocr);
  }
});

it("calls the actual classifier for explicit unknown grids and unruled text tables", () => {
  const text = "Quarterly regional figures\nNorth  100  200\nSouth  300  400\nEast  500  600\nWest  700  800\nTotal  900  1000";
  const unknown = classifyAdaptivePage(1, "Ordinary prose about regional results.", { routingV2: true, layout: { gridsUnknown: true } as any });
  expect(unknown.route).toBe("table-heavy");
  expect(unknown.signals).toContain("grids-unknown");
  expect(classifyAdaptivePage(1, text, { routingV2: true }).route).toBe("table-heavy");
  // A structural PDF probe has no extracted rows: it cannot assert this semantic/text-derived route.
});

it.skipIf(!wasmAvailable)("keeps a scan OCR layer and contrasts ruled and unruled production decisions", async () => {
  const estimator = await createEstimator();
  const bytes = pdf("12345", "q 612 0 0 792 0 0 cm /Im1 Do Q", true);
  const profile = estimator.profile({ name: "synthetic.pdf", size: bytes.length }, bytes);
  expect(profile.pdf.observedImagePlacements).toBe(1);
  expect(profile.pdf.lexicalPages).toEqual([1,0,0]);
  expect(scanFillPageNumbers(["12345"])).toEqual([]);
  const rules = Array.from({ length: 7 }, (_, i) => `40 ${100+i*30} m 400 ${100+i*30} l S`).join(" ")
    + " 40 100 m 40 280 l S 220 100 m 220 280 l S 400 100 m 400 280 l S";
  const ruled = pdf("Regional quarterly results", rules);
  const measured = estimator.profile({ name: "synthetic.pdf", size: ruled.length }, ruled);
  expect(measured.pdf.ruledTablePages).toBe(1);
  expect(classifyAdaptivePage(1, "Regional quarterly results", { routingV2: true, layout: { grids: [{ rows: 6, columns: 2, coverage: .2 }] } as any }).route).toBe("table-heavy");
  const plain = pdf("Regional quarterly results");
  expect(estimator.profile({ name: "synthetic.pdf", size: plain.length }, plain).pdf.ruledTablePages).toBe(0);
});
