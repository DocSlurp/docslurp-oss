import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { PdfRasterCache, PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { CommandRunner } from "../tools/runner.js";
import type { Document } from "../models.js";

const execute = promisify(execFile);
const available = ["pdfinfo", "pdftoppm", "prlimit"].every(binary => spawnSync(binary, ["--help"]).error === undefined);

/** Authored blank page, not a third-party fixture. Boxes deliberately differ by 20×. */
function pdf(rotation: number, userUnit: number, crop: [number, number]): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000 2000] /CropBox [10 20 ${10 + crop[0]} ${20 + crop[1]}] /Rotate ${rotation} /UserUnit ${userUnit} /Resources << >> >>`,
  ];
  let text = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

describe.skipIf(!available)("real Poppler allocation geometry", () => {
  it.each([
    { rotation: 0, userUnit: 1, crop: [100, 100] as [number, number], expected: [417, 417] },
    { rotation: 90, userUnit: 1, crop: [100, 200] as [number, number], expected: [834, 417] },
    { rotation: 270, userUnit: 10, crop: [100, 200] as [number, number] },
    { rotation: 0, userUnit: 1, crop: [1900, 1900] as [number, number] },
  ])("renders only the measured crop before allocation ($rotation degrees, UserUnit=$userUnit)", async ({ rotation, userUnit, crop, expected }) => {
    const root = await mkdtemp(path.join(tmpdir(), "poppler-bounds-"));
    try {
      const source = path.join(root, "boxes.pdf");
      await writeFile(source, pdf(rotation, userUnit, crop));
      const runner = new CommandRunner();
      vi.spyOn(runner, "isAvailable").mockResolvedValue(true);
      const plans: string[][] = [];
      vi.spyOn(runner, "run").mockImplementation(async plan => {
        if (plan.binary === "pdftoppm") {
          plans.push(plan.args);
          // A future regression must fail rather than allocate the 8334² MediaBox.
          return execute("prlimit", ["--as=134217728", "--cpu=10", "--", plan.binary, ...plan.args], { timeout: 15_000 });
        }
        return execute(plan.binary, plan.args, { timeout: 15_000 });
      });
      let image: Buffer | undefined;
      const storage = { objectSize: async () => null, putBytes: async (_key: string, bytes: Buffer) => { image = bytes; }, uri: (key: string) => key };
      const sources = { get: async () => ({ path: source }) } as unknown as PdfSourceCache;
      const cache = new PdfRasterCache(runner, storage, sources, { engine: "pdftoppm" });
      const document = { id: "doc", userId: "user", mimeType: "application/pdf", pageCount: 1 } as Document;
      const [result] = await cache.renderSelectedPages({ document, runId: "run", pageNumbers: [1], dpi: 300 });
      expect(plans).toHaveLength(1);
      expect(plans[0]).toContain("-cropbox");
      expect(plans[0]).toContain("-scale-to");
      expect(result!.widthPx! * result!.heightPx!).toBeLessThanOrEqual(16_000_000);
      expect(Math.max(result!.widthPx!, result!.heightPx!)).toBeLessThanOrEqual(4000);
      if (expected) expect([result!.widthPx, result!.heightPx]).toEqual(expected);
      // Prove the stored bytes (WebP when cwebp is installed, else PNG), not only the planned command.
      const stored = await sharp(image!).metadata();
      expect(stored.format).toBe(result!.mimeType === "image/webp" ? "webp" : "png");
      expect([stored.width, stored.height]).toEqual([result!.widthPx, result!.heightPx]);
      expect((await readFile(source)).subarray(0, 8).toString()).toBe("%PDF-1.7");
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
});
