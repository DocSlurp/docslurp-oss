import zlib from "node:zlib";

/**
 * Minimal dependency-free PDF writer for tests: text-layer pages, raster-only
 * ("scanned") pages, near-empty text over a page image, blank pages and pages
 * made of many tiny images. Content is generated, never taken from evaluation inputs.
 */

export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;

export interface GrayImage {
  width: number;
  height: number;
  /** 8-bit grayscale, row-major, `width * height` bytes. */
  pixels: Buffer;
}

export interface ImagePlacement {
  image: GrayImage;
  /** PDF user-space rectangle in points; defaults to the whole page. */
  rect?: { x: number; y: number; width: number; height: number };
}

export type TestPdfPage =
  /** Text layer: optional bold heading, then lines of 10.5 pt Helvetica. */
  | { kind: "text"; heading?: string; lines: string[] }
  /** Images with an optional (sparse) text layer drawn on top. */
  | { kind: "image"; images: ImagePlacement[]; lines?: string[] }
  | { kind: "blank" };

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function textOps(lines: string[], heading?: string): string[] {
  const ops: string[] = [];
  if (heading) ops.push("BT", "/F2 15 Tf", `56 ${PAGE_HEIGHT - 64} Td`, `(${escapePdfText(heading)}) Tj`, "ET");
  if (lines.length > 0) {
    ops.push("BT", "/F1 10.5 Tf", "13.5 TL", `56 ${PAGE_HEIGHT - 96} Td`);
    for (const line of lines) ops.push(`(${escapePdfText(line)}) '`);
    ops.push("ET");
  }
  return ops;
}

/**
 * A grayscale "scan": paper tone with dark bars standing in for lines of print, so the
 * raster has visible content without any text layer.
 */
export function scannedImage(options: { width?: number; height?: number; lines?: number } = {}): GrayImage {
  const width = options.width ?? 1275;
  const height = options.height ?? 1650;
  const pixels = Buffer.alloc(width * height, 242);
  const lines = options.lines ?? 40;
  const margin = Math.round(width * 0.08);
  const pitch = Math.max(4, Math.floor((height - 2 * margin) / Math.max(1, lines)));
  for (let line = 0; line < lines; line += 1) {
    const y0 = margin + line * pitch;
    const barHeight = Math.max(2, Math.floor(pitch * 0.45));
    const barWidth = Math.floor((width - 2 * margin) * (0.55 + ((line * 37) % 40) / 100));
    for (let y = y0; y < Math.min(height, y0 + barHeight); y += 1) {
      pixels.fill(40, y * width + margin, y * width + margin + barWidth);
    }
  }
  return { width, height, pixels };
}

/** A small flat-colour image (logos, bullets, tracking pixels). */
export function solidImage(width: number, height: number, value = 90): GrayImage {
  return { width, height, pixels: Buffer.alloc(width * height, value) };
}

/** Deterministic filler prose. */
export function proseLines(count: number, seed = 1): string[] {
  const words = ["ledger", "harbor", "violet", "summit", "copper", "meadow", "lantern", "orbit", "granite", "willow", "beacon", "cinder", "quarry", "falcon", "tundra", "saffron"];
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state >>> 16; // low LCG bits cycle quickly; use the high ones
  };
  return Array.from({ length: count }, () => {
    const length = 9 + (next() % 6);
    return Array.from({ length }, () => words[next() % words.length]).join(" ") + ".";
  });
}

export function buildTestPdf(pages: TestPdfPage[]): Buffer {
  const objects: Array<Buffer | string | null> = [];
  const add = (body: Buffer | string | null) => {
    objects.push(body);
    return objects.length;
  };
  const stream = (dictionary: string, data: Buffer | string) => {
    const compressed = zlib.deflateSync(Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1"));
    return Buffer.concat([
      Buffer.from(`<< ${dictionary} /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`, "latin1"),
      compressed,
      Buffer.from("\nendstream", "latin1"),
    ]);
  };

  const catalogId = add(null);
  const pagesId = add(null);
  const regularFont = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const boldFont = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const fonts = `/Font << /F1 ${regularFont} 0 R /F2 ${boldFont} 0 R >>`;
  const pageIds: number[] = [];
  for (const page of pages) {
    const ops: string[] = [];
    const xobjects: string[] = [];
    if (page.kind === "text") ops.push(...textOps(page.lines, page.heading));
    if (page.kind === "image") {
      page.images.forEach((placement, index) => {
        const { image } = placement;
        const id = add(stream(`/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8`, image.pixels));
        xobjects.push(`/Im${index} ${id} 0 R`);
        const rect = placement.rect ?? { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT };
        ops.push(`q ${rect.width} 0 0 ${rect.height} ${rect.x} ${rect.y} cm /Im${index} Do Q`);
      });
      ops.push(...textOps(page.lines ?? []));
    }
    const resources = `<< ${fonts}${xobjects.length > 0 ? ` /XObject << ${xobjects.join(" ")} >>` : ""} >>`;
    const contentId = add(stream("", ops.join("\n")));
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources ${resources} /Contents ${contentId} 0 R >>`));
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "latin1"),
      Buffer.isBuffer(body) ? body : Buffer.from(body ?? "null", "latin1"),
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n \n`),
  ].join("");
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}
