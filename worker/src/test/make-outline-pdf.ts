/** Tiny PDF writer for tests: text pages, optional outline and /PageLabels. No external fixtures. */
export interface TestPdfOptions {
  pages: string[];
  outline?: Array<{ title: string; page: number; children?: Array<{ title: string; page: number }> }>;
  /** `/PageLabels` number-tree entries: [startPhysicalIndex(0-based), { style: "r"|"D", start }]. */
  pageLabels?: Array<[number, { style: "r" | "D"; start: number }]>;
}

const esc = (s: string) => s.replace(/[\\()]/g, "\\$&");

export function makeTestPdf(options: TestPdfOptions): Buffer {
  const n = options.pages.length;
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; }; // 1-based object number
  const catalog = add("");
  const pagesRoot = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];
  options.pages.forEach((text, i) => {
    const lines = text.split("\n");
    const stream = `BT /F1 11 Tf 14 TL 50 740 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
    void i;
  });
  objects[pagesRoot - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`;

  let outlinesRef = "";
  if (options.outline?.length) {
    const rootId = add("");
    type Item = { title: string; page: number; children?: Item[] };
    const build = (items: Item[], parent: number): number[] => {
      const ids = items.map(() => add(""));
      items.forEach((item, i) => {
        const kids = item.children?.length ? build(item.children, ids[i]!) : [];
        const parts = [`/Title (${esc(item.title)})`, `/Parent ${parent} 0 R`, `/Dest [${pageIds[item.page - 1]} 0 R /Fit]`];
        if (i > 0) parts.push(`/Prev ${ids[i - 1]} 0 R`);
        if (i < items.length - 1) parts.push(`/Next ${ids[i + 1]} 0 R`);
        if (kids.length) parts.push(`/First ${kids[0]} 0 R /Last ${kids[kids.length - 1]} 0 R /Count ${kids.length}`);
        objects[ids[i]! - 1] = `<< ${parts.join(" ")} >>`;
      });
      return ids;
    };
    const top = build(options.outline, rootId);
    objects[rootId - 1] = `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top[top.length - 1]} 0 R /Count ${top.length} >>`;
    outlinesRef = ` /Outlines ${rootId} 0 R`;
  }
  let labelsEntry = "";
  if (options.pageLabels?.length) {
    const nums = options.pageLabels.map(([index, l]) => `${index} << /S /${l.style} /St ${l.start} >>`).join(" ");
    labelsEntry = ` /PageLabels << /Nums [${nums}] >>`;
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRoot} 0 R${outlinesRef}${labelsEntry} >>`;

  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
