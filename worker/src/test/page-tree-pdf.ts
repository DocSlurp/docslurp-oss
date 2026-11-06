/**
 * Hand-built PDFs with exact page trees, for the structural page count (Doppler `pdfpagecount`) and the page-range contract:
 * forged metadata, a `/Count` that lies either way, cycles, deep nesting, no pages, and a memory bomb. Objects are written
 * verbatim, so each fixture is exactly the structure its name says.
 */

/** One page drawing `text` with Helvetica (object `font`). */
function pageObject(parent: number, contents: number, font: number): string {
  return `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contents} 0 R >>`;
}

function contentStream(text: string): string {
  const body = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
  return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
}

/** Serialize objects 1..n (object 1 is the catalog) with a classic xref table and the given trailer entries. */
export function writePdf(objects: string[], trailer = ""): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(length);
    const part = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "latin1");
    parts.push(part);
    length += part.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${length}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(xref, "latin1")]);
}

/**
 * A flat tree of `pages` pages whose root claims `/Count claimedCount` (default: the truth), each page reading "Page 1 of 1",
 * with an optional forged Info Title (UTF-16, any characters) and an XMP packet claiming a page count.
 */
export function flatTreePdf(pages: number, forged: { claimedCount?: number; title?: string; xmpPages?: number } = {}): Buffer {
  // 1 catalog, 2 pages root, 3 font, 4 info, [5 metadata], then page/content pairs.
  const xmp = forged.xmpPages === undefined ? null
    : `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmpTPg="http://ns.adobe.com/xap/1.0/t/pg/"><xmpTPg:NPages>${forged.xmpPages}</xmpTPg:NPages></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const first = xmp ? 6 : 5;
  const kids = Array.from({ length: pages }, (_, index) => `${first + index * 2} 0 R`).join(" ");
  const title = forged.title ?? "Report";
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${xmp ? " /Metadata 5 0 R" : ""} >>`,
    `<< /Type /Pages /Count ${forged.claimedCount ?? pages} /Kids [${kids}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Title <FEFF${Buffer.from(title, "utf16le").swap16().toString("hex").toUpperCase()}> >>`,
  ];
  if (xmp) objects.push(`<< /Type /Metadata /Subtype /XML /Length ${xmp.length} >>\nstream\n${xmp}\nendstream`);
  for (let index = 0; index < pages; index += 1) {
    objects.push(pageObject(2, first + index * 2 + 1, 3));
    objects.push(contentStream("Page 1 of 1"));
  }
  return writePdf(objects, "/Info 4 0 R ");
}

/** A page tree whose node 3 lists node 2 (the root) among its kids: a cycle. */
export function cyclicTreePdf(): Buffer {
  return writePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>",
    "<< /Type /Pages /Parent 2 0 R /Count 2 /Kids [2 0 R 5 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    pageObject(2, 6, 4),
    contentStream("cycle"),
  ]);
}

/** One page under `depth` intermediate /Pages nodes in a chain. */
export function deepTreePdf(depth: number): Buffer {
  // 1 catalog, 2..depth+1 nodes, then font, page, contents.
  const font = depth + 2;
  const page = depth + 3;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>"];
  for (let level = 0; level < depth; level += 1) {
    const self = 2 + level;
    const child = level === depth - 1 ? page : self + 1;
    objects.push(`<< /Type /Pages${level > 0 ? ` /Parent ${self - 1} 0 R` : ""} /Count 1 /Kids [${child} 0 R] >>`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push(pageObject(depth + 1, depth + 4, font));
  objects.push(contentStream("deep"));
  return writePdf(objects);
}

/** A page tree root with no kids at all. */
export function zeroPagePdf(): Buffer {
  return writePdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 0 /Kids [] >>"]);
}

/**
 * A memory bomb for the page walk: the root's /Kids is one array of `entries` references to a single page (each one a page
 * Poppler would build), so reading the tree allocates far more than the file's size suggests.
 */
export function memoryBombPdf(entries: number): Buffer {
  const kids = Buffer.alloc(entries * 6, "3 0 R ", "latin1").toString("latin1");
  return writePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count 1 /Kids [${kids}] >>`,
    pageObject(2, 4, 5),
    contentStream("bomb"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

const PASSWORD_PAD = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, index) => index);
  for (let i = 0, j = 0; i < 256; i += 1) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n += 1) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[n] = data[n]! ^ s[(s[i]! + s[j]!) & 255]!;
  }
  return out;
}

const md5 = async (...parts: Buffer[]) => (await import("node:crypto")).createHash("md5").update(Buffer.concat(parts)).digest();
const padded = (password: string) => Buffer.concat([Buffer.from(password, "latin1"), PASSWORD_PAD]).subarray(0, 32);

/**
 * A 3-page PDF under the Standard security handler (revision 2, RC4 40-bit; PDF 1.7 §7.6.3). An empty user password opens
 * without one, as Poppler tries it; any other needs it. `filter` other than Standard is a handler nobody implements.
 */
export async function encryptedPdf(userPassword: string, filter = "Standard"): Promise<Buffer> {
  const id = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
  const permissions = -4;
  const ownerKey = (await md5(padded("owner-secret"))).subarray(0, 5);
  const owner = rc4(ownerKey, padded(userPassword));
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions);
  const key = (await md5(padded(userPassword), owner, p, id)).subarray(0, 5);
  const user = rc4(key, PASSWORD_PAD);
  const objectKey = async (num: number) => (await md5(key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]))).subarray(0, 10);
  // 1 catalog, 2 pages, 3 font, 4 encrypt, then page/content pairs.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 3 /Kids [5 0 R 7 0 R 9 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Filter /${filter} /V 1 /R 2 /Length 40 /P ${permissions} /O <${owner.toString("hex")}> /U <${user.toString("hex")}> >>`,
  ];
  for (let index = 0; index < 3; index += 1) {
    const num = 6 + index * 2;
    const body = rc4(await objectKey(num), Buffer.from("BT /F1 12 Tf 72 700 Td (secret) Tj ET", "latin1"));
    objects.push(pageObject(2, num, 3));
    objects.push(`<< /Length ${body.length} >>\nstream\n${body.toString("latin1")}\nendstream`);
  }
  return writePdf(objects, `/Encrypt 4 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>] `);
}
