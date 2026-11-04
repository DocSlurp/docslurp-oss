/*
 * Facts for the local `pdfimages` default producer. `pdfimages -list` reports what the PDF stores for each image
 * (type, size, colour, encoding, object id, resolution); it does not report where an image is drawn, so every
 * placement is `unknown` and nothing here guesses one. Pixel statistics are not measured either: the worker never
 * decodes image pixels.
 */
import { embeddedImageFactsSchema, type EmbeddedImageFacts, type EmbeddedImageSource, type ImageRole } from "@docslurp/shared";

import { pdfImagesListFields } from "../lib/page-yield-evidence.js";

export interface PdfImagesListRow {
  page: number;
  num: number;
  role: ImageRole;
  width: number;
  height: number;
  source: EmbeddedImageSource;
}

const ROLES = new Set<ImageRole>(["image", "mask", "smask", "stencil"]);
const COLORS = new Set(["gray", "cal", "rgb", "cmyk", "lab", "icc", "index", "sep", "devn", "-"]);
const ENCODINGS: Record<string, EmbeddedImageSource["encoding"]> = {
  image: "image", rle: "rle", ccitt: "ccitt", jpeg: "jpeg", jpx: "jpx", jp2: "jpx", jbig2: "jbig2",
};

function integer(value: string | undefined): number | null {
  return value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : null;
}

/** Stored stream size as the listing prints it (`7898B`, `15.8K`, `1.2M`), in bytes, rounded. */
function streamBytes(value: string | undefined): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)([BKMG])$/.exec(value ?? "");
  if (!match) return null;
  const scale = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2] as "B" | "K" | "M" | "G"];
  return Math.round(Number(match[1]) * scale);
}

/**
 * Parse `pdfimages -list` output. Rows it cannot read are an error, not a skip: the listing and the extracted files
 * are joined by position, so a dropped row would attach the wrong facts to every later image.
 */
export function parsePdfImagesList(text: string): PdfImagesListRow[] {
  const lines = text.split(/\r?\n/);
  const separator = lines.findIndex((line) => /^-{10,}\s*$/.test(line));
  if (separator < 1 || !/^page\s+num\s+type\s+width\s+height\s+color\s+comp\s+bpc\s+enc\s+interp\s+object\s+ID/.test(lines[separator - 1]!.trim())) {
    throw new Error("Unrecognized pdfimages -list output");
  }
  const rows: PdfImagesListRow[] = [];
  for (const line of lines.slice(separator + 1)) {
    if (!line.trim()) continue;
    // page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio; an inline (`[inline]`) or
    // unreferenced (`[none]`) image's object columns are one token, padded back to 16 columns by pdfImagesListFields.
    const cells = pdfImagesListFields(line);
    const inline = cells[10] === "[inline]";
    const [page, num, type, width, height, color, comp, bpc, enc, interp] = cells;
    const rest = cells.slice(12);
    const role = type as ImageRole;
    const pageNumber = integer(page), index = integer(num), w = integer(width), h = integer(height);
    if (pageNumber === null || index === null || w === null || h === null || !ROLES.has(role) || cells.length < 15) {
      throw new Error("Unreadable pdfimages -list row");
    }
    const objectNum = integer(cells[10]);
    const objectGen = integer(cells[11]);
    rows.push({
      page: pageNumber, num: index, role, width: w, height: h,
      source: {
        objectId: objectNum === null || objectGen === null ? null : { num: objectNum, gen: objectGen },
        inline,
        encoding: ENCODINGS[enc ?? ""] ?? "other",
        colorSpace: (COLORS.has(color ?? "") ? color : "other") as EmbeddedImageSource["colorSpace"],
        components: integer(comp),
        bitsPerComponent: integer(bpc),
        interpolate: interp === "yes",
        ppi: [integer(rest[0]), integer(rest[1])],
        streamBytes: streamBytes(rest[2]),
      },
    });
  }
  return rows;
}

/** One validated fact per listed image, with placement unknown and no pixel statistics. */
export function pdfImagesFacts(rows: readonly PdfImagesListRow[], files: ReadonlyArray<{ sha256: string; width: number; height: number }>, pageNumber: number): EmbeddedImageFacts[] {
  if (rows.length !== files.length) throw new Error("pdfimages listing and extracted files disagree");
  return rows.map((row, occurrence) => {
    const file = files[occurrence]!;
    if (row.page !== pageNumber) throw new Error("pdfimages listing names another page");
    return embeddedImageFactsSchema.parse({
      pageNumber, occurrence, role: row.role, width: file.width, height: file.height, sha256: file.sha256,
      source: row.source,
      placement: { status: "unknown", reason: "no-placement-source" },
      alt: null, signals: null, signalsUnavailable: "not-measured", anchor: null,
    });
  });
}

/** Width and height from a PNG header, without decoding pixels; null when the bytes are not a PNG. */
export function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
