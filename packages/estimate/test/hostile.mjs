// Hostile PDFs for the wasm tests, built in memory. lazyObjectStreamBomb is the merge council's PoC (H1c): each
// stream's /Length is a reference into an object stream, which lopdf decodes while parsing, outside the load hook's
// budget, so only the module's memory cap stops it.
import { deflateSync } from "node:zlib";

export function lazyObjectStreamBomb(containers = 24, literalBytes = 15_900_000) {
  const parts = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let length = parts[0].length;
  const offsets = new Map();
  const put = (number, body) => {
    offsets.set(number, length);
    const chunk = Buffer.concat([Buffer.from(`${number} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    parts.push(chunk);
    length += chunk.length;
  };
  const text = (value) => Buffer.from(value, "latin1");
  put(1, text("<< /Type /Catalog /Pages 2 0 R >>"));
  put(2, text("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  put(3, text("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>"));
  put(4, text("<< /Length 13 >>\nstream\nBT (hi) Tj ET\nendstream"));
  const payload = "x".repeat(8);
  const carried = new Map();
  for (let i = 0; i < containers; i += 1) put(10 + i, text(`<< /Length ${2000 + i} 0 R >>\nstream\n${payload}\nendstream`));
  for (let i = 0; i < containers; i += 1) {
    const bodies = [[2000 + i, `${payload.length}`], [3000 + i, `(${"A".repeat(literalBytes)})`]];
    let header = "";
    let offset = 0;
    for (const [number, body] of bodies) {
      header += `${number} ${offset} `;
      offset += body.length + 1;
    }
    const raw = Buffer.from(header + bodies.map(([, body]) => `${body} `).join(""), "latin1");
    const compressed = deflateSync(raw, { level: 9 });
    put(1000 + i, Buffer.concat([text(`<< /Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`), compressed, text("\nendstream")]));
    carried.set(2000 + i, [1000 + i, 0]);
    carried.set(3000 + i, [1000 + i, 1]);
  }
  const xrefNumber = 4000;
  const xrefOffset = length;
  const rows = [];
  const row = (type, a, b) => {
    const buffer = Buffer.alloc(7);
    buffer.writeUInt8(type, 0);
    buffer.writeUInt32BE(a, 1);
    buffer.writeUInt16BE(b, 5);
    rows.push(buffer);
  };
  row(0, 0, 65535);
  for (let number = 1; number <= xrefNumber; number += 1) {
    if (offsets.has(number)) row(1, offsets.get(number), 0);
    else if (carried.has(number)) row(2, ...carried.get(number));
    else if (number === xrefNumber) row(1, xrefOffset, 0);
    else row(0, 0, 0);
  }
  const compressedRows = deflateSync(Buffer.concat(rows), { level: 9 });
  parts.push(Buffer.concat([
    text(`${xrefNumber} 0 obj\n<< /Type /XRef /Size ${xrefNumber + 1} /Root 1 0 R /W [1 4 2] /Filter /FlateDecode /Length ${compressedRows.length} >>\nstream\n`),
    compressedRows,
    text(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`),
  ]));
  return new Uint8Array(Buffer.concat(parts));
}

// A PDF of `pages` text pages and `objects` small filler dictionaries in a classic xref table. lopdf's whole-document
// load keeps every object (about 1.3 KiB each on wasm32), so enough of them exhaust the module's memory while the
// file stays small. `declaredSize` overrides the trailer's /Size: a hostile file can declare far fewer objects than it
// holds, so the probe's load-cost check passes and only the memory cap stops the load.
export function manyObjectsPdf({ objects, pages = 1, declaredSize } = {}) {
  const chunks = ["%PDF-1.7\n"];
  let length = chunks[0].length;
  const offsets = [];
  const put = (number, body) => {
    offsets[number] = length;
    const chunk = `${number} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    length += chunk.length;
  };
  const firstPage = 3;
  const kids = Array.from({ length: pages }, (_, i) => `${firstPage + 2 * i} 0 R`).join(" ");
  put(1, "<< /Type /Catalog /Pages 2 0 R >>");
  put(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i += 1) {
    const content = `BT /F1 12 Tf 72 720 Td (Quarterly revenue beat the forecast on page ${i + 1}.) Tj ET`;
    put(firstPage + 2 * i, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${firstPage + 2 * i + 1} 0 R >>`);
    put(firstPage + 2 * i + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  const first = firstPage + 2 * pages;
  for (let i = 0; i < objects; i += 1) put(first + i, `<< /A ${i} /B [1 2 3] >>`);
  const count = first + objects;
  const xref = length;
  const rows = ["0000000000 65535 f \n"];
  for (let number = 1; number < count; number += 1) rows.push(`${String(offsets[number]).padStart(10, "0")} 00000 n \n`);
  chunks.push(`xref\n0 ${count}\n${rows.join("")}trailer\n<< /Size ${declaredSize ?? count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.from(chunks.join(""), "latin1"));
}
