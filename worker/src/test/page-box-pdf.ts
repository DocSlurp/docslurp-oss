/**
 * Authored one-page PDFs for page-box tests (not third-party fixtures): `page` and `pages` are extra entries for the page
 * dictionary and its Pages node (MediaBox, CropBox, Rotate, UserUnit, inherited boxes, malformed boxes). The page draws one
 * small square so a render is never blank. Used by worker/src/test/fixtures/page-box-equivalence.json's cases.
 */
export interface PageBoxSpec {
  page: string;
  pages?: string;
}

export function pageBoxPdf({ page, pages = "" }: PageBoxSpec): Buffer {
  const content = "q 0 0 1 rg 10 10 50 50 re f Q\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [3 0 R] /Count 1 ${pages} >>`,
    `<< /Type /Page /Parent 2 0 R ${page} /Contents 4 0 R /Resources << >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let body = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
