import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname);
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 48;

function escapePdfText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function wrapText(text, maxChars) {
  const words = text.trim().split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
      continue;
    }
    current = next;
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

class Content {
  constructor() {
    this.parts = [];
  }

  push(value) {
    this.parts.push(value);
  }

  line(x1, y1, x2, y2, width = 1) {
    this.push(`${width} w ${x1} ${y1} m ${x2} ${y2} l S\n`);
  }

  rect(x, y, width, height, fill = false) {
    this.push(`${x} ${y} ${width} ${height} re ${fill ? "f" : "S"}\n`);
  }

  fillRect(x, y, width, height, r, g, b) {
    this.push(`${r} ${g} ${b} rg ${x} ${y} ${width} ${height} re f 0 0 0 rg\n`);
  }

  text(x, y, text, font = "F1", size = 11) {
    this.push(`BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escapePdfText(text)}) Tj ET\n`);
  }

  rotateText(x, y, text, font = "F2", size = 10) {
    this.push(`BT /${font} ${size} Tf 0 1 -1 0 ${x} ${y} Tm (${escapePdfText(text)}) Tj ET\n`);
  }

  paragraph(x, y, text, options = {}) {
    const font = options.font ?? "F1";
    const size = options.size ?? 11;
    const maxChars = options.maxChars ?? 82;
    const leading = options.leading ?? Math.round(size * 1.45);
    const lines = wrapText(text, maxChars);

    for (const [index, line] of lines.entries()) {
      this.text(x, y - index * leading, line, font, size);
    }

    return y - lines.length * leading;
  }

  drawImage(name, x, y, width, height) {
    this.push(`q ${width} 0 0 ${height} ${x} ${y} cm /${name} Do Q\n`);
  }

  toString() {
    return this.parts.join("");
  }
}

class PdfBuilder {
  constructor(title) {
    this.title = title;
    this.objects = [];
    this.pageIds = [];
    this.catalogId = this.reserveObject();
    this.pagesId = this.reserveObject();
    this.fonts = new Map();
    this.images = [];
    this.addFont("F1", "Helvetica");
    this.addFont("F2", "Helvetica-Bold");
    this.addFont("F3", "Courier");
    this.addFont("F4", "Times-Italic");
  }

  reserveObject() {
    this.objects.push(Buffer.from(""));
    return this.objects.length;
  }

  setObject(id, content) {
    this.objects[id - 1] = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "binary");
  }

  addObject(content) {
    const id = this.reserveObject();
    this.setObject(id, content);
    return id;
  }

  addStream(dict, data) {
    const head = Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "binary");
    const tail = Buffer.from("\nendstream", "binary");
    return this.addObject(Buffer.concat([head, data, tail]));
  }

  addFont(alias, baseFont) {
    const id = this.addObject(`<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} >>`);
    this.fonts.set(alias, id);
  }

  addImage(name, width, height, rgbData) {
    const compressed = zlib.deflateSync(rgbData);
    const id = this.addStream(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      compressed
    );
    this.images.push({ name, id });
    return { name, id, width, height };
  }

  addPage(content, imageNames = []) {
    const contentId = this.addStream("", Buffer.from(content, "binary"));
    const fontResources = Array.from(this.fonts.entries())
      .map(([alias, id]) => `/${alias} ${id} 0 R`)
      .join(" ");
    const imageResources = imageNames
      .map((name) => {
        const image = this.images.find((entry) => entry.name === name);
        return image ? `/${name} ${image.id} 0 R` : "";
      })
      .filter(Boolean)
      .join(" ");
    const resourceParts = [`/Font << ${fontResources} >>`];
    if (imageResources) {
      resourceParts.push(`/XObject << ${imageResources} >>`);
    }
    const pageId = this.addObject(
      `<< /Type /Page /Parent ${this.pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << ${resourceParts.join(
        " "
      )} >> /Contents ${contentId} 0 R >>`
    );
    this.pageIds.push(pageId);
  }

  write(filePath) {
    this.setObject(this.pagesId, `<< /Type /Pages /Kids [${this.pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${this.pageIds.length} >>`);
    this.setObject(this.catalogId, `<< /Type /Catalog /Pages ${this.pagesId} 0 R >>`);

    const chunks = [Buffer.from("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n", "binary")];
    const offsets = [0];

    for (let index = 0; index < this.objects.length; index += 1) {
      offsets.push(Buffer.concat(chunks).length);
      chunks.push(Buffer.from(`${index + 1} 0 obj\n`, "binary"));
      chunks.push(this.objects[index]);
      chunks.push(Buffer.from("\nendobj\n", "binary"));
    }

    const xrefOffset = Buffer.concat(chunks).length;
    const xrefRows = ["0000000000 65535 f \n"];

    for (let index = 1; index < offsets.length; index += 1) {
      xrefRows.push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
    }

    chunks.push(Buffer.from(`xref\n0 ${this.objects.length + 1}\n${xrefRows.join("")}`, "binary"));
    chunks.push(Buffer.from(`trailer\n<< /Size ${this.objects.length + 1} /Root ${this.catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "binary"));
    fs.writeFileSync(filePath, Buffer.concat(chunks));
  }
}

const GLYPHS = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  "G": ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  "J": ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  ",": ["00000", "00000", "00000", "00000", "00110", "00110", "00100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  "$": ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  "#": ["01010", "11111", "01010", "01010", "11111", "01010", "01010"],
};

function createRgbBuffer(width, height, background = [255, 255, 255]) {
  const buffer = Buffer.alloc(width * height * 3);
  for (let index = 0; index < buffer.length; index += 3) {
    buffer[index] = background[0];
    buffer[index + 1] = background[1];
    buffer[index + 2] = background[2];
  }
  return buffer;
}

function setPixel(buffer, width, x, y, color) {
  if (x < 0 || y < 0) {
    return;
  }
  const offset = (y * width + x) * 3;
  if (offset < 0 || offset + 2 >= buffer.length) {
    return;
  }
  buffer[offset] = color[0];
  buffer[offset + 1] = color[1];
  buffer[offset + 2] = color[2];
}

function fillRect(buffer, width, x, y, rectWidth, rectHeight, color) {
  for (let row = 0; row < rectHeight; row += 1) {
    for (let column = 0; column < rectWidth; column += 1) {
      setPixel(buffer, width, x + column, y + row, color);
    }
  }
}

function drawBitmapText(buffer, width, x, y, text, scale = 4, color = [20, 20, 20]) {
  const chars = text.toUpperCase().split("");
  let cursorX = x;

  for (const character of chars) {
    const glyph = GLYPHS[character] ?? GLYPHS[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] === "1") {
          fillRect(buffer, width, cursorX + column * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursorX += 6 * scale;
  }
}

function drawLine(buffer, width, x1, y1, x2, y2, thickness = 2, color = [90, 90, 90]) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) || 1;
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    fillRect(buffer, width, x, y, thickness, thickness, color);
  }
}

function buildInvoiceImage() {
  const width = 820;
  const height = 1060;
  const buffer = createRgbBuffer(width, height, [252, 251, 247]);

  fillRect(buffer, width, 40, 40, width - 80, 90, [32, 62, 105]);
  drawBitmapText(buffer, width, 70, 70, "INVOICE 2025-041", 6, [250, 250, 250]);
  drawBitmapText(buffer, width, 70, 170, "BILL TO: NORTHWIND OPS", 4, [30, 30, 30]);
  drawBitmapText(buffer, width, 70, 220, "TOTAL DUE: $4281.90", 5, [30, 30, 30]);
  drawBitmapText(buffer, width, 70, 270, "DUE DATE: 2025-11-15", 4, [30, 30, 30]);
  drawBitmapText(buffer, width, 70, 350, "LINE ITEM", 4, [60, 60, 60]);
  drawBitmapText(buffer, width, 410, 350, "AMOUNT", 4, [60, 60, 60]);
  drawLine(buffer, width, 60, 390, 760, 390, 3);

  const items = [
    ["OCR RETROFIT", "$1340.00"],
    ["TABLE NORMALIZATION", "$990.00"],
    ["PAGE IMAGE EXPORT", "$670.00"],
    ["INDEX BACKFILL", "$1281.90"],
  ];

  items.forEach(([label, amount], index) => {
    const y = 430 + index * 90;
    drawBitmapText(buffer, width, 70, y, label, 4, [20, 20, 20]);
    drawBitmapText(buffer, width, 470, y, amount, 4, [20, 20, 20]);
    drawLine(buffer, width, 60, y + 55, 760, y + 55, 2, [195, 195, 195]);
  });

  drawBitmapText(buffer, width, 70, 820, "REMIT TO: DOCSLURP FINANCE", 4, [30, 30, 30]);
  drawBitmapText(buffer, width, 70, 905, "APPROVED SIGNATURE", 4, [80, 80, 80]);
  drawLine(buffer, width, 390, 950, 620, 930, 5, [45, 75, 140]);
  drawLine(buffer, width, 620, 930, 690, 960, 5, [45, 75, 140]);
  drawLine(buffer, width, 690, 960, 750, 920, 5, [45, 75, 140]);

  return { width, height, data: buffer };
}

function buildApprovalNoteImage() {
  const width = 820;
  const height = 1060;
  const buffer = createRgbBuffer(width, height, [245, 244, 238]);

  drawBitmapText(buffer, width, 80, 90, "FIELD APPROVAL NOTE", 5, [35, 35, 35]);
  drawBitmapText(buffer, width, 80, 180, "SCAN QUALITY: LOW", 4, [50, 50, 50]);
  drawBitmapText(buffer, width, 80, 260, "PLEASE OCR BEFORE INDEXING", 4, [50, 50, 50]);
  drawBitmapText(buffer, width, 80, 360, "SIGNATURE", 4, [80, 80, 80]);
  drawLine(buffer, width, 260, 420, 380, 450, 4, [50, 90, 160]);
  drawLine(buffer, width, 380, 450, 510, 400, 4, [50, 90, 160]);
  drawLine(buffer, width, 510, 400, 650, 445, 4, [50, 90, 160]);
  drawBitmapText(buffer, width, 80, 540, "HANDWRITTEN QC", 4, [80, 80, 80]);
  drawLine(buffer, width, 120, 610, 250, 670, 6, [112, 90, 70]);
  drawLine(buffer, width, 250, 670, 400, 620, 6, [112, 90, 70]);
  drawLine(buffer, width, 400, 620, 520, 675, 6, [112, 90, 70]);

  return { width, height, data: buffer };
}

function buildChartImage() {
  const width = 720;
  const height = 340;
  const buffer = createRgbBuffer(width, height, [250, 252, 255]);

  drawLine(buffer, width, 90, 280, 650, 280, 3, [70, 70, 70]);
  drawLine(buffer, width, 90, 280, 90, 60, 3, [70, 70, 70]);
  drawBitmapText(buffer, width, 110, 300, "Q1", 3, [40, 40, 40]);
  drawBitmapText(buffer, width, 220, 300, "Q2", 3, [40, 40, 40]);
  drawBitmapText(buffer, width, 330, 300, "Q3", 3, [40, 40, 40]);
  drawBitmapText(buffer, width, 440, 300, "Q4", 3, [40, 40, 40]);

  const bars = [
    { x: 120, y: 210, width: 70, height: 70, color: [70, 118, 184], label: "78" },
    { x: 230, y: 160, width: 70, height: 120, color: [86, 160, 108], label: "123" },
    { x: 340, y: 120, width: 70, height: 160, color: [205, 128, 61], label: "162" },
    { x: 450, y: 90, width: 70, height: 190, color: [169, 76, 76], label: "190" },
  ];

  for (const bar of bars) {
    fillRect(buffer, width, bar.x, bar.y, bar.width, bar.height, bar.color);
    drawBitmapText(buffer, width, bar.x + 15, bar.y - 26, bar.label, 3, [30, 30, 30]);
  }

  drawBitmapText(buffer, width, 95, 30, "LATENCY HISTOGRAM", 4, [30, 30, 30]);
  drawBitmapText(buffer, width, 525, 300, "MS", 3, [40, 40, 40]);

  return { width, height, data: buffer };
}

function buildStampImage() {
  const width = 260;
  const height = 120;
  const buffer = createRgbBuffer(width, height, [255, 250, 250]);
  fillRect(buffer, width, 8, 8, width - 16, height - 16, [255, 240, 240]);
  drawLine(buffer, width, 10, 10, width - 10, 10, 3, [166, 44, 44]);
  drawLine(buffer, width, width - 10, 10, width - 10, height - 10, 3, [166, 44, 44]);
  drawLine(buffer, width, width - 10, height - 10, 10, height - 10, 3, [166, 44, 44]);
  drawLine(buffer, width, 10, height - 10, 10, 10, 3, [166, 44, 44]);
  drawBitmapText(buffer, width, 30, 38, "REVIEWED BY OPS", 4, [166, 44, 44]);
  return { width, height, data: buffer };
}

function addPageFooter(content, pageNumber, pageCount) {
  content.line(MARGIN, 32, PAGE_WIDTH - MARGIN, 32, 0.8);
  content.text(MARGIN, 18, `DocSlurp synthetic fixture`, "F4", 9);
  content.text(PAGE_WIDTH - MARGIN - 44, 18, `${pageNumber}/${pageCount}`, "F4", 9);
}

function addTablePage(doc, title, rows, pageNumber, pageCount, options = {}) {
  const content = new Content();
  let y = PAGE_HEIGHT - MARGIN;

  content.text(MARGIN, y, title, "F2", 18);
  y -= 22;
  y = content.paragraph(
    MARGIN,
    y,
    "Regional revenue snapshot used to test page-spanning tables, repeated headers, and row continuation markers. Revenue is reported in USD millions.",
    { size: 11, maxChars: 88 }
  );
  y -= 8;

  const columns = [
    { key: "region", label: "Region", width: 82 },
    { key: "product", label: "Product", width: 118 },
    { key: "q1", label: "Q1 2025", width: 70 },
    { key: "q2", label: "Q2 2025", width: 70 },
    { key: "q3", label: "Q3 2025", width: 70 },
    { key: "q4", label: "Q4 2025", width: 70 },
    { key: "margin", label: "Gross Margin", width: 84 },
  ];
  const rowHeight = 24;
  const tableTop = y;
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
  content.fillRect(MARGIN, tableTop - rowHeight + 6, tableWidth, rowHeight, 0.92, 0.94, 0.98);
  content.rect(MARGIN, tableTop - rowHeight + 6, tableWidth, rowHeight);

  let x = MARGIN;
  for (const column of columns) {
    content.text(x + 4, tableTop - 12, column.label, "F2", 9);
    content.line(x, tableTop - rowHeight + 6, x, tableTop + 6, 0.6);
    x += column.width;
  }
  content.line(MARGIN + tableWidth, tableTop - rowHeight + 6, MARGIN + tableWidth, tableTop + 6, 0.6);

  rows.forEach((row, rowIndex) => {
    const rowTop = tableTop - rowHeight * (rowIndex + 1);
    const rowBottom = rowTop - rowHeight;
    content.rect(MARGIN, rowBottom + 6, tableWidth, rowHeight);
    let cursorX = MARGIN;
    for (const column of columns) {
      content.line(cursorX, rowBottom + 6, cursorX, rowTop + 6, 0.4);
      content.text(cursorX + 4, rowTop - 10, row[column.key], "F1", 8.5);
      cursorX += column.width;
    }
    content.line(MARGIN + tableWidth, rowBottom + 6, MARGIN + tableWidth, rowTop + 6, 0.4);
  });

  if (options.continues) {
    content.text(MARGIN, 78, "continued on next page", "F2", 11);
  } else {
    content.text(MARGIN, 78, "table end", "F2", 11);
  }

  addPageFooter(content, pageNumber, pageCount);
  doc.addPage(content.toString());
}

function buildTablesMultipageFinancials(filePath) {
  const doc = new PdfBuilder("tables-multipage-financials");
  const regions = ["North", "South", "West", "East", "Central"];
  const products = ["Crawler", "Indexer", "OCR Kit", "Vision QA", "Archive Sync", "Search API"];
  const rows = [];

  for (let index = 0; index < 30; index += 1) {
    rows.push({
      region: regions[index % regions.length],
      product: products[index % products.length],
      q1: `${120 + index * 3}.0`,
      q2: `${124 + index * 3}.5`,
      q3: `${131 + index * 3}.1`,
      q4: `${139 + index * 3}.8`,
      margin: `${41 + (index % 7)}%`,
    });
  }

  addTablePage(doc, "Northwind Components FY2025 Regional Revenue", rows.slice(0, 10), 1, 3, { continues: true });
  addTablePage(doc, "Northwind Components FY2025 Regional Revenue", rows.slice(10, 20), 2, 3, { continues: true });
  addTablePage(doc, "Northwind Components FY2025 Regional Revenue", rows.slice(20), 3, 3);
  doc.write(filePath);
}

function buildAcademicLatexLigatures(filePath) {
  const doc = new PdfBuilder("academic-latex-ligatures");
  const page1 = new Content();
  let y = PAGE_HEIGHT - MARGIN;

  page1.text(MARGIN, y, "Affine Operators for Efficient Office Inference", "F2", 20);
  y -= 30;
  y = page1.paragraph(
    MARGIN,
    y,
    "Abstract. We study affine profile operators for efficient office workflow inference. The document is intentionally saturated with ligature-prone tokens such as office, efficient, profile, offline, and coefficient to expose parser failures in born-digital academic PDFs.",
    { size: 12, maxChars: 88 }
  );
  y -= 20;
  page1.text(MARGIN, y, "1. Method", "F2", 15);
  y -= 22;
  y = page1.paragraph(
    MARGIN,
    y,
    "Let f(x) denote the normalized office traffic profile. The affine update is written in LaTeX-style text so engines that preserve literal formula strings can be scored directly.",
    { size: 11.5, maxChars: 90 }
  );
  y -= 14;
  page1.text(MARGIN + 16, y, "E[f(X)] = \\int_0^\\infty x^2 e^{-x} dx", "F3", 12);
  y -= 24;
  page1.text(MARGIN + 16, y, "\\frac{d}{dx} \\log(1 + e^x) = \\frac{e^x}{1 + e^x}", "F3", 12);
  y -= 28;
  y = page1.paragraph(
    MARGIN,
    y,
    "The affine coefficient remains stable when the profile vector is projected onto a low-rank office manifold. In practice, this efficient approximation preserves sufficient signal for retrieval while keeping the pipeline economical.",
    { size: 11.5, maxChars: 90 }
  );
  addPageFooter(page1, 1, 2);
  doc.addPage(page1.toString());

  const page2 = new Content();
  y = PAGE_HEIGHT - MARGIN;
  page2.text(MARGIN, y, "2. Appendix", "F2", 15);
  y -= 24;
  y = page2.paragraph(
    MARGIN,
    y,
    "For completeness, we restate the affine profile objective and the coefficient update in code-style math text. This page adds reading-order pressure with a narrow sidebar note and a footer citation.",
    { size: 11.5, maxChars: 90 }
  );
  y -= 12;
  page2.text(MARGIN + 18, y, "A(\\theta) = \\sum_i \\alpha_i x_i + \\beta", "F3", 12);
  y -= 22;
  page2.text(MARGIN + 18, y, "\\nabla_x L = \\frac{\\partial L}{\\partial x}", "F3", 12);
  y -= 28;
  page2.paragraph(
    MARGIN,
    y,
    "The office benchmark profile is intentionally repetitive: efficient, office, affine, profile, coefficient, offline. These tokens are enough to catch broken ligature expansion while staying readable in plain text exports.",
    { size: 11.5, maxChars: 90 }
  );
  page2.rotateText(PAGE_WIDTH - 18, 220, "supplementary note: preserve inline formulas", "F2", 9);
  addPageFooter(page2, 2, 2);
  doc.addPage(page2.toString());
  doc.write(filePath);
}

function buildImageHeavyOcr(filePath) {
  const doc = new PdfBuilder("image-heavy-ocr");
  const invoice = buildInvoiceImage();
  const note = buildApprovalNoteImage();

  doc.addImage("ImInvoice", invoice.width, invoice.height, invoice.data);
  doc.addImage("ImApproval", note.width, note.height, note.data);

  const page1 = new Content();
  page1.drawImage("ImInvoice", 55, 68, 500, 648);
  addPageFooter(page1, 1, 2);
  doc.addPage(page1.toString(), ["ImInvoice"]);

  const page2 = new Content();
  page2.drawImage("ImApproval", 55, 68, 500, 648);
  addPageFooter(page2, 2, 2);
  doc.addPage(page2.toString(), ["ImApproval"]);

  doc.write(filePath);
}

function buildMulticolumnFiguresReport(filePath) {
  const doc = new PdfBuilder("multicolumn-figures-report");
  const chart = buildChartImage();
  doc.addImage("ImChart", chart.width, chart.height, chart.data);

  const content = new Content();
  const leftX = MARGIN;
  const rightX = 328;
  let leftY = PAGE_HEIGHT - MARGIN;
  let rightY = PAGE_HEIGHT - MARGIN;

  content.text(MARGIN, PAGE_HEIGHT - MARGIN, "Operational Cache Study", "F2", 20);
  leftY -= 34;
  rightY -= 34;

  leftY = content.paragraph(
    leftX,
    leftY,
    "This two-column report fixture stresses reading order, figure anchoring, and caption extraction. The left column contains narrative text about throughput and cache hit rate. The right column mixes a chart image, caption, and compact notes.",
    { size: 11, maxChars: 34 }
  );
  leftY -= 12;
  leftY = content.paragraph(
    leftX,
    leftY,
    "We observed a throughput increase after aggressive cache priming. The cache hit rate rose from 41 percent to 78 percent while median page latency dropped by 26 milliseconds.",
    { size: 11, maxChars: 34 }
  );
  leftY -= 12;
  content.text(leftX, leftY, "Key findings", "F2", 12);
  leftY -= 18;
  content.text(leftX, leftY, "- throughput increased on every batch", "F1", 10.5);
  leftY -= 15;
  content.text(leftX, leftY, "- cache hit rate is now a first-class metric", "F1", 10.5);
  leftY -= 15;
  content.text(leftX, leftY, "- figure 2 summarizes the latency histogram", "F1", 10.5);

  content.drawImage("ImChart", rightX, 410, 230, 108);
  rightY = 392;
  content.text(rightX, rightY, "Figure 2. Latency histogram after cache warmup.", "F2", 10.5);
  rightY -= 18;
  rightY = content.paragraph(
    rightX,
    rightY,
    "The chart combines queue latency, worker throughput, and cache hit rate in one compact visual. A parser should keep the caption attached to the figure and preserve the reading order.",
    { size: 10.5, maxChars: 30 }
  );
  rightY -= 12;
  content.fillRect(rightX, rightY - 10, 220, 54, 0.95, 0.97, 0.95);
  content.text(rightX + 8, rightY + 26, "Sidebar: prioritize latency histogram over averages.", "F2", 10);

  content.rotateText(PAGE_WIDTH - 18, 176, "draft report copy", "F2", 9);
  addPageFooter(content, 1, 1);
  doc.addPage(content.toString(), ["ImChart"]);
  doc.write(filePath);
}

function buildFormRotatedNotes(filePath) {
  const doc = new PdfBuilder("form-rotated-notes");
  const stamp = buildStampImage();
  doc.addImage("ImStamp", stamp.width, stamp.height, stamp.data);

  const content = new Content();
  let y = PAGE_HEIGHT - MARGIN;
  content.text(MARGIN, y, "CONFIDENTIAL INTAKE FORM", "F2", 19);
  content.rotateText(PAGE_WIDTH - 18, 240, "CONFIDENTIAL INTAKE FORM", "F2", 9);
  y -= 34;

  const fields = [
    "Case ID",
    "Submitted by",
    "Preferred contact method",
    "Escalate within 24 hours",
    "Reviewer notes",
  ];

  for (const field of fields) {
    content.text(MARGIN, y, field, "F2", 11);
    content.line(MARGIN + 180, y - 2, PAGE_WIDTH - MARGIN, y - 2, 0.9);
    y -= 42;
  }

  content.text(MARGIN, y + 12, "Checkboxes", "F2", 11);
  content.rect(MARGIN + 120, y, 12, 12);
  content.text(MARGIN + 140, y + 2, "email", "F1", 10.5);
  content.rect(MARGIN + 220, y, 12, 12);
  content.line(MARGIN + 220, y, MARGIN + 232, y + 12, 0.9);
  content.line(MARGIN + 232, y, MARGIN + 220, y + 12, 0.9);
  content.text(MARGIN + 240, y + 2, "phone", "F1", 10.5);

  y -= 76;
  content.fillRect(MARGIN, y - 6, PAGE_WIDTH - MARGIN * 2, 82, 0.98, 0.96, 0.92);
  content.text(MARGIN + 10, y + 50, "Operator note: preserve marginalia and stamp text.", "F1", 11);
  content.text(MARGIN + 10, y + 30, "Handwritten comment: reviewed by ops before export.", "F1", 11);
  content.drawImage("ImStamp", PAGE_WIDTH - 220, y + 6, 150, 68);
  addPageFooter(content, 1, 1);
  doc.addPage(content.toString(), ["ImStamp"]);
  doc.write(filePath);
}

// ── Kreuzberg fixture: structured invoice table ─────────────────────────────

function buildKreuzbergTablesInvoice(filePath) {
  const doc = new PdfBuilder("kreuzberg-tables-invoice");
  const content = new Content();
  let y = PAGE_HEIGHT - MARGIN;

  content.text(MARGIN, y, "Invoice #INV-2025-0892", "F2", 18);
  y -= 28;
  content.text(MARGIN, y, "Issued by: DocSlurp Billing Co.   Date: 2025-10-01", "F1", 11);
  y -= 18;
  content.text(MARGIN, y, "Bill To: Acme Extractors Ltd.   Payment Terms: Net 30", "F1", 11);
  y -= 28;

  // Table header
  const cols = [MARGIN, 240, 340, 430, 510];
  const headers = ["Item Description", "Unit Price", "Quantity", "Subtotal", "Notes"];
  for (const [i, header] of headers.entries()) {
    content.text(cols[i], y, header, "F2", 10.5);
  }
  y -= 4;
  content.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, 1);
  y -= 18;

  const rows = [
    ["PDF extraction (basic)", "$12.00", "50", "$600.00", "Text layer"],
    ["PDF extraction (OCR)", "$28.00", "30", "$840.00", "With OCR"],
    ["Table normalization", "$18.00", "25", "$450.00", "Structured"],
    ["Embedding generation", "$4.00", "200", "$800.00", "1536-dim"],
    ["Vector indexing", "$6.00", "100", "$600.00", "LanceDB"],
    ["Summary generation", "$22.00", "20", "$440.00", "Anthropic"],
  ];

  for (const row of rows) {
    for (const [i, cell] of row.entries()) {
      content.text(cols[i], y, cell, "F1", 10);
    }
    y -= 4;
    content.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, 0.5);
    y -= 16;
  }

  y -= 10;
  content.line(MARGIN, y + 6, PAGE_WIDTH - MARGIN, y + 6, 1.5);
  content.text(cols[3], y - 6, "Tax (8%):", "F2", 10.5);
  content.text(cols[4] - 30, y - 6, "$265.60", "F2", 10.5);
  y -= 24;
  content.text(cols[3], y, "Total Due:", "F2", 12);
  content.text(cols[4] - 30, y, "$3,995.60", "F2", 12);
  y -= 40;

  content.text(MARGIN, y, "Bank Transfer: IBAN DE89 3704 0044 0532 0130 00", "F1", 10);
  y -= 16;
  content.text(MARGIN, y, "Payment Terms: Net 30 days from invoice date.", "F1", 10);

  addPageFooter(content, 1, 1);
  doc.addPage(content.toString());
  doc.write(filePath);
}

// ── Kreuzberg fixture: links and references ──────────────────────────────────

function buildKreuzbergLinksReferences(filePath) {
  const doc = new PdfBuilder("kreuzberg-links-references");
  const content = new Content();
  let y = PAGE_HEIGHT - MARGIN;

  content.text(MARGIN, y, "References and Further Reading", "F2", 18);
  y -= 30;

  content.text(MARGIN, y, "Abstract", "F2", 13);
  y -= 18;
  y = content.paragraph(MARGIN, y,
    "This document tests link extraction from bibliographic references, inline citations, " +
    "and hyperlinks. See also the companion dataset at https://data.docslurp.io/evals/v1. " +
    "Further reading is available in the bibliography section below.",
    { size: 11, maxChars: 80 }
  );
  y -= 20;

  content.text(MARGIN, y, "Section 1: Background", "F2", 13);
  y -= 18;
  y = content.paragraph(MARGIN, y,
    "Prior work [1] established baseline metrics. The dataset from Smith et al. [2] is " +
    "available at https://arxiv.org/abs/2501.12345. A related DOI: 10.1145/3592608 covers " +
    "structured extraction. Implementation details follow the specification at " +
    "https://github.com/docslurp/spec/blob/main/README.md.",
    { size: 11, maxChars: 80 }
  );
  y -= 20;

  content.text(MARGIN, y, "Bibliography", "F2", 13);
  y -= 18;

  const refs = [
    "[1] Johnson, A. et al. (2024). \"Table Extraction at Scale\". VLDB 2024. " +
      "https://doi.org/10.14778/1234567890",
    "[2] Smith, K., Lee, R. (2025). \"Benchmark for Document Understanding\". " +
      "https://arxiv.org/abs/2501.12345",
    "[3] DocSlurp Team (2025). \"Extraction Pipeline Reference\". " +
      "https://docs.docslurp.io/pipeline",
    "[4] OpenAI (2024). \"GPT-4V Technical Report\". " +
      "https://openai.com/research/gpt-4v",
    "[5] Anthropic (2025). \"Claude 3.5: Multimodal Document Understanding\".",
  ];

  for (const ref of refs) {
    y = content.paragraph(MARGIN, y, ref, { size: 10.5, maxChars: 82 });
    y -= 8;
  }

  addPageFooter(content, 1, 1);
  doc.addPage(content.toString());
  doc.write(filePath);
}

// ── Kreuzberg fixture: math formulas and equations ───────────────────────────

function buildKreuzbergFormulasMath(filePath) {
  const doc = new PdfBuilder("kreuzberg-formulas-math");
  const content = new Content();
  let y = PAGE_HEIGHT - MARGIN;

  content.text(MARGIN, y, "Mathematical Formulas and Equations", "F2", 18);
  y -= 30;

  content.text(MARGIN, y, "Definition 1 (Integral):", "F2", 12);
  y -= 18;
  content.text(MARGIN + 20, y, "The definite integral from a to b of f(x) dx equals F(b) - F(a).", "F1", 11);
  y -= 16;
  content.text(MARGIN + 20, y, "Formal: integral from 0 to infinity of e^(-x^2) dx = sqrt(pi)/2", "F3", 10.5);
  y -= 24;

  content.text(MARGIN, y, "Theorem 1 (Derivative Chain Rule):", "F2", 12);
  y -= 18;
  content.text(MARGIN + 20, y, "If h(x) = f(g(x)), then h'(x) = f'(g(x)) * g'(x).", "F1", 11);
  y -= 16;
  content.text(MARGIN + 20, y, "Equation: d/dx [f(g(x))] = f'(g(x)) * g'(x)", "F3", 10.5);
  y -= 24;

  content.text(MARGIN, y, "Proof:", "F2", 12);
  y -= 18;
  y = content.paragraph(MARGIN + 20, y,
    "Apply the definition of the derivative to the composed function. The limit definition " +
    "gives us h'(x) = lim_{h->0} (f(g(x+h)) - f(g(x))) / h. Factoring yields the result.",
    { size: 11, maxChars: 78 }
  );
  y -= 20;

  content.text(MARGIN, y, "Corollary 1:", "F2", 12);
  y -= 18;
  content.text(MARGIN + 20, y, "For f(x) = x^n, the derivative is f'(x) = n * x^(n-1).", "F1", 11);
  y -= 24;

  content.text(MARGIN, y, "Definition 2 (Matrix Multiplication):", "F2", 12);
  y -= 18;
  y = content.paragraph(MARGIN + 20, y,
    "Given matrices A of shape m x k and B of shape k x n, their product C = A * B " +
    "has entry C[i,j] = sum over r of A[i,r] * B[r,j]. This is the fundamental matrix " +
    "product for linear algebra and neural network computations.",
    { size: 11, maxChars: 78 }
  );
  y -= 20;

  content.text(MARGIN, y, "Equation 3:", "F2", 12);
  y -= 18;
  content.text(MARGIN + 20, y, "C[i,j] = sum_{r=1}^{k} A[i,r] * B[r,j]", "F3", 10.5);

  addPageFooter(content, 1, 1);
  doc.addPage(content.toString());
  doc.write(filePath);
}

// ── Kreuzberg fixture: handwriting simulation / meeting notes ─────────────────

function buildHandwritingNotesImage() {
  const width = 560;
  const height = 420;
  const buffer = createRgbBuffer(width, height, [252, 250, 245]);

  // Ruled lines
  for (let row = 0; row < 10; row++) {
    const y = 40 + row * 38;
    drawLine(buffer, width, 20, y, width - 20, y, 1, [200, 210, 220]);
  }

  drawBitmapText(buffer, width, 24, 10, "MEETING NOTES", 4, [40, 60, 140]);
  drawBitmapText(buffer, width, 24, 52, "DATE: OCTOBER 1, 2025", 3, [30, 30, 30]);
  drawBitmapText(buffer, width, 24, 90, "ACTION ITEMS", 3, [60, 60, 60]);
  drawBitmapText(buffer, width, 24, 128, "- FOLLOW UP WITH TEAM", 3, [20, 20, 20]);
  drawBitmapText(buffer, width, 24, 166, "- ASSIGNED TO: ALEX", 3, [20, 20, 20]);
  drawBitmapText(buffer, width, 24, 204, "- DEADLINE: NOV 15", 3, [20, 20, 20]);
  drawBitmapText(buffer, width, 24, 242, "TODO: REVIEW DOCS BEFORE", 3, [20, 20, 20]);
  drawBitmapText(buffer, width, 24, 280, "DONE: INFRA MIGRATION", 3, [20, 20, 20]);
  // Squiggly handwriting-style lines
  drawLine(buffer, width, 24, 358, 180, 362, 2, [50, 80, 180]);
  drawLine(buffer, width, 180, 362, 220, 354, 2, [50, 80, 180]);
  drawLine(buffer, width, 220, 354, 280, 366, 2, [50, 80, 180]);
  drawBitmapText(buffer, width, 24, 385, "SIGNATURE:", 3, [80, 80, 80]);

  return { data: buffer, width, height };
}

function buildKreuzbergHandwritingNotes(filePath) {
  const doc = new PdfBuilder("kreuzberg-handwriting-notes");
  const img = buildHandwritingNotesImage();
  doc.addImage("ImNotes", img.width, img.height, img.data);

  const content = new Content();
  let y = PAGE_HEIGHT - MARGIN;

  content.text(MARGIN, y, "Scanned Meeting Notes - Q4 Planning", "F2", 16);
  y -= 28;
  y = content.paragraph(MARGIN, y,
    "The following pages contain scanned handwritten meeting notes from the Q4 planning session. " +
    "OCR-capable parsers should extract action items, assignments, and deadline references from the image.",
    { size: 11, maxChars: 80 }
  );
  y -= 20;

  // Embed the simulated handwriting image
  const imgH = Math.round((img.height / img.width) * (PAGE_WIDTH - MARGIN * 2));
  content.drawImage("ImNotes", MARGIN, y - imgH, PAGE_WIDTH - MARGIN * 2, imgH);
  y -= imgH + 16;

  y = content.paragraph(MARGIN, y,
    "Key items noted: action items assigned to team leads, follow up required by deadline, " +
    "and signature line for approval. All TODO and DONE items should be identifiable.",
    { size: 10.5, maxChars: 80 }
  );

  addPageFooter(content, 1, 1);
  doc.addPage(content.toString(), ["ImNotes"]);
  doc.write(filePath);
}

// ── Kreuzberg fixture: document metadata / cover page ────────────────────────

function buildKreuzbergMetadataDocument(filePath) {
  const doc = new PdfBuilder("kreuzberg-metadata-document");
  const content = new Content();
  let y = PAGE_HEIGHT - MARGIN;

  // Cover page style
  content.fillRect(MARGIN, PAGE_HEIGHT - 140, PAGE_WIDTH - MARGIN * 2, 100, 0.12, 0.24, 0.42);
  content.text(MARGIN + 20, PAGE_HEIGHT - 60, "DocSlurp Extraction Report", "F2", 22);
  y = PAGE_HEIGHT - 170;

  content.text(MARGIN, y, "Title: Kreuzberg Extraction Evaluation — v2.1", "F2", 13);
  y -= 22;
  content.text(MARGIN, y, "Author: DocSlurp Engineering Team", "F1", 12);
  y -= 18;
  content.text(MARGIN, y, "Subject: Parser quality benchmarking for multi-format documents", "F1", 12);
  y -= 18;
  content.text(MARGIN, y, "Keywords: extraction, kreuzberg, benchmark, tables, OCR, links", "F1", 12);
  y -= 18;
  content.text(MARGIN, y, "Created: 2025-10-01", "F1", 12);
  y -= 18;
  content.text(MARGIN, y, "Version: v2.1", "F1", 12);
  y -= 30;

  content.line(MARGIN, y + 6, PAGE_WIDTH - MARGIN, y + 6, 0.8);
  y -= 20;

  content.text(MARGIN, y, "Document Scope", "F2", 13);
  y -= 18;
  y = content.paragraph(MARGIN, y,
    "This document serves as a metadata-rich test fixture. Parsers that expose document " +
    "property extraction (title, author, subject, keywords, creation date, version) " +
    "should surface these fields separately from body text content.",
    { size: 11, maxChars: 80 }
  );
  y -= 20;

  content.text(MARGIN, y, "Revision History", "F2", 13);
  y -= 18;

  const revisions = [
    ["v2.1", "2025-10-01", "Added metadata extraction fixtures"],
    ["v2.0", "2025-08-15", "Extended kreuzberg eval coverage"],
    ["v1.5", "2025-06-01", "Initial multi-extractor benchmarks"],
    ["v1.0", "2025-03-10", "First release of fixture suite"],
  ];

  for (const [ver, date, note] of revisions) {
    content.text(MARGIN + 10, y, `${ver}`, "F2", 10.5);
    content.text(MARGIN + 60, y, date, "F1", 10.5);
    content.text(MARGIN + 160, y, note, "F1", 10.5);
    y -= 18;
  }

  addPageFooter(content, 1, 1);
  doc.addPage(content.toString());
  doc.write(filePath);
}

// ── Kreuzberg fixture: mixed content (tables + formulas + references) ─────────

function buildKreuzbergMixedContent(filePath) {
  const doc = new PdfBuilder("kreuzberg-mixed-content");
  const content = new Content();
  let y = PAGE_HEIGHT - MARGIN;

  content.text(MARGIN, y, "Mixed Content Evaluation Document", "F2", 18);
  y -= 30;

  // Abstract
  content.text(MARGIN, y, "Abstract", "F2", 13);
  y -= 18;
  y = content.paragraph(MARGIN, y,
    "This document combines tables, equations, figures, and bibliographic references in a " +
    "single page to stress-test multi-element extraction. Section 1 presents a results table. " +
    "Section 2 introduces Equation 1. The conclusion references Figure 1.",
    { size: 11, maxChars: 80 }
  );
  y -= 16;

  // Table section
  content.text(MARGIN, y, "Table 1. Extraction Results by Strategy", "F2", 12);
  y -= 14;
  const cols = [MARGIN, 190, 300, 400, 490];
  const headers = ["Extractor", "Recall", "Precision", "F1", "Latency"];
  for (const [i, h] of headers.entries()) content.text(cols[i], y, h, "F2", 10);
  y -= 4; content.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, 1); y -= 14;

  const rows = [
    ["kreuzberg", "0.91", "0.88", "0.895", "120ms"],
    ["docling", "0.86", "0.84", "0.850", "380ms"],
    ["pymupdf4llm", "0.79", "0.82", "0.805", "90ms"],
    ["pdftotext", "0.70", "0.75", "0.724", "40ms"],
  ];
  for (const row of rows) {
    for (const [i, cell] of row.entries()) content.text(cols[i], y, cell, "F1", 10);
    y -= 4; content.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, 0.5); y -= 14;
  }
  y -= 12;

  // Equation section
  content.text(MARGIN, y, "Section 2: Evaluation Metric", "F2", 13);
  y -= 18;
  content.text(MARGIN + 20, y, "Equation 1: F1 = 2 * (precision * recall) / (precision + recall)", "F3", 10.5);
  y -= 18;
  y = content.paragraph(MARGIN, y,
    "The F1 score is the harmonic mean of precision and recall, providing a balanced " +
    "assessment when the class distribution is uneven. See reference [1] for derivation.",
    { size: 11, maxChars: 80 }
  );
  y -= 16;

  // Conclusion with figure reference
  content.text(MARGIN, y, "Conclusion", "F2", 13);
  y -= 18;
  y = content.paragraph(MARGIN, y,
    "Figure 1 and Table 1 together demonstrate that kreuzberg achieves the best F1 score " +
    "while maintaining competitive latency. Future work will extend Eq. 1 to a weighted " +
    "variant. See reference [2] for the full dataset.",
    { size: 11, maxChars: 80 }
  );
  y -= 16;

  // Bibliography
  content.text(MARGIN, y, "References", "F2", 12);
  y -= 16;
  content.text(MARGIN + 10, y, "[1] Manning et al. (2008). Introduction to Information Retrieval.", "F1", 10);
  y -= 14;
  content.text(MARGIN + 10, y, "[2] DocSlurp Team (2025). Kreuzberg Eval Dataset. https://data.docslurp.io/evals", "F1", 10);

  addPageFooter(content, 1, 1);
  doc.addPage(content.toString());
  doc.write(filePath);
}

// ────────────────────────────────────────────────────────────────────────────

const targets = [
  ["tables-multipage-financials.pdf", buildTablesMultipageFinancials],
  ["academic-latex-ligatures.pdf", buildAcademicLatexLigatures],
  ["image-heavy-ocr.pdf", buildImageHeavyOcr],
  ["multicolumn-figures-report.pdf", buildMulticolumnFiguresReport],
  ["form-rotated-notes.pdf", buildFormRotatedNotes],
  ["kreuzberg-tables-invoice.pdf", buildKreuzbergTablesInvoice],
  ["kreuzberg-links-references.pdf", buildKreuzbergLinksReferences],
  ["kreuzberg-formulas-math.pdf", buildKreuzbergFormulasMath],
  ["kreuzberg-handwriting-notes.pdf", buildKreuzbergHandwritingNotes],
  ["kreuzberg-metadata-document.pdf", buildKreuzbergMetadataDocument],
  ["kreuzberg-mixed-content.pdf", buildKreuzbergMixedContent],
];

for (const [fileName, builder] of targets) {
  builder(path.join(ROOT, fileName));
}

console.log(`generated ${targets.length} fixtures in ${ROOT}`);
