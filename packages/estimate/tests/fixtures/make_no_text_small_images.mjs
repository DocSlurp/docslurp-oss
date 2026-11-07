// Builds no_text_small_images.pdf: 20 pages, no text layer, one 64x64 gray image per page placed at 180x180 pt on a
// Letter page (~6.7% coverage). The worker bills each such page Rich (page facts: text_bytes=0 and an image row).
// Usage: node make_no_text_small_images.mjs <out.pdf>
import { writeFileSync } from "node:fs";
const N = 20;
const objs = [];
const add = (s) => { objs.push(s); return objs.length; };
const img = Buffer.alloc(64 * 64, 0x80);
const catalog = add(null), pagesObj = add(null);
const imgId = add(`<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${img.length} >>\nstream\n${img.toString("latin1")}\nendstream`);
const kids = [];
for (let i = 0; i < N; i++) {
  const content = "q 180 0 0 180 72 540 cm /Im0 Do Q";
  const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${c} 0 R >>`));
}
objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${N} >>`;
let out = "%PDF-1.4\n"; const offsets = [];
objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = Buffer.byteLength(out, "latin1");
out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const path = process.argv[2]; writeFileSync(path, Buffer.from(out, "latin1"));
