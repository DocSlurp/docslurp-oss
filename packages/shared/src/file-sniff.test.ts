import { describe, expect, it } from "vitest";

import { fileFactsFor, sniffFileBytes, decodeTextBytes } from "./file-sniff.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC = "application/msword";

/** A ZIP with the given stored entries; the first entry's content is kept so `mimetype` can be read back. */
function zip(entries: Array<{ name: string; data?: string }>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "x");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function utf16le(text: string, bom = true): Buffer {
  return Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, "utf16le")]);
}

function ole(stream: string): Buffer {
  return Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512), Buffer.from(stream, "utf16le")]);
}

describe("sniffFileBytes", () => {
  it("reads a UTF-16LE CSV with a byte-order mark as text, not MP3", () => {
    const sniffed = sniffFileBytes(utf16le("name,total\r\nacme,10\r\nbeta,20\r\n"), "export.csv");
    expect(sniffed).toMatchObject({ mimeType: "text/csv", encoding: "utf-16le" });
  });

  it("reads UTF-16 without a byte-order mark and UTF-16BE", () => {
    expect(sniffFileBytes(utf16le("hello world, this is text", false), "a.txt").encoding).toBe("utf-16le");
    const be = Buffer.from(utf16le("hello world, this is text", false)).swap16();
    expect(sniffFileBytes(be, "a.txt").encoding).toBe("utf-16be");
    expect(decodeTextBytes(be, "utf-16be")).toBe("hello world, this is text");
  });

  it("reads non-Latin UTF-8 as text", () => {
    for (const text of ["日本語のテキストです。これは文書です。\n二行目の文章。", "Москва — столица России. Это текст.", "Ελληνικά κείμενα και σύμβολα"]) {
      expect(sniffFileBytes(Buffer.from(text), "a.txt")).toMatchObject({ mimeType: "text/plain", encoding: "utf-8" });
    }
  });

  it("reads legacy 8-bit text, but not random bytes", () => {
    expect(sniffFileBytes(Buffer.from("Café résumé naïve façade\n", "latin1"), "a.txt").encoding).toBe("8-bit");
    const noise = Buffer.alloc(4096);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 167 + 13) & 0xff;
    expect(sniffFileBytes(noise, "a.bin").mimeType).toBeNull();
  });

  it("recognises real MPEG frames and ID3 tags as audio", () => {
    expect(sniffFileBytes(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]), "a.mp3").mimeType).toBe("audio/mpeg");
    expect(sniffFileBytes(Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000"), "a.mp3").mimeType).toBe("audio/mpeg");
  });

  it("tells OOXML, EPUB, OpenDocument and a plain ZIP apart by container contents", () => {
    expect(sniffFileBytes(zip([{ name: "[Content_Types].xml" }, { name: "word/document.xml" }]), "a.bin")).toMatchObject({ mimeType: DOCX, container: "zip" });
    expect(sniffFileBytes(zip([{ name: "mimetype", data: "application/epub+zip" }, { name: "OEBPS/ch1.xhtml" }]), "a.bin").mimeType).toBe("application/epub+zip");
    expect(sniffFileBytes(zip([{ name: "mimetype", data: "application/vnd.oasis.opendocument.text" }, { name: "content.xml" }]), "a.odt").mimeType).toBe("application/vnd.oasis.opendocument.text");
    expect(sniffFileBytes(zip([{ name: "readme.txt" }]), "a.zip").mimeType).toBe("application/zip");
  });

  it("tells OLE Word, Excel and PowerPoint apart", () => {
    expect(sniffFileBytes(ole("WordDocument"), "a.bin")).toMatchObject({ mimeType: DOC, container: "ole" });
    expect(sniffFileBytes(ole("Workbook"), "a.bin").mimeType).toBe("application/vnd.ms-excel");
    expect(sniffFileBytes(ole("PowerPoint Document"), "a.bin").mimeType).toBe("application/vnd.ms-powerpoint");
    expect(sniffFileBytes(ole("Other"), "a.bin").mimeType).toBe("application/x-ole-storage");
  });

  it("survives a hostile ZIP: truncated directory, huge entry count", () => {
    const bad = Buffer.from(zip([{ name: "word/document.xml" }]));
    bad.writeUInt16LE(0xffff, bad.length - 12);
    expect(() => sniffFileBytes(bad, "a.docx")).not.toThrow();
    expect(sniffFileBytes(bad.subarray(0, 20), "a.docx").mimeType).toBe("application/zip");
  });
});

describe("fileFactsFor", () => {
  it("accepts a CSV declared application/vnd.ms-excel as a warning, stored as CSV", () => {
    const facts = fileFactsFor(Buffer.from("a,b\n1,2\n3,4\n"), { filename: "data.csv", declaredMimeType: "application/vnd.ms-excel" });
    expect(facts).toMatchObject({ mimeType: "text/csv", format: "structured-csv", mismatch: "same-family" });
  });

  it("accepts a UTF-16LE CSV as text/csv with its encoding", () => {
    const facts = fileFactsFor(utf16le("a,b\r\n1,2\r\n3,4\r\n"), { filename: "data.csv", declaredMimeType: "text/csv" });
    expect(facts).toMatchObject({ mimeType: "text/csv", encoding: "utf-16le", mismatch: "none" });
  });

  it("stores a .docx declared application/msword as DOCX with a same-family warning", () => {
    const facts = fileFactsFor(zip([{ name: "word/document.xml" }]), { filename: "report.docx", declaredMimeType: DOC });
    expect(facts).toMatchObject({ mimeType: DOCX, format: "office-word", mismatch: "same-family" });
  });

  it("keeps a legacy .doc declared as DOCX as the OLE Word type", () => {
    const facts = fileFactsFor(ole("WordDocument"), { filename: "old.doc", declaredMimeType: DOCX });
    expect(facts).toMatchObject({ mimeType: DOC, mismatch: "same-family" });
  });

  it("routes report.pdf declared text/plain on its bytes", () => {
    const facts = fileFactsFor(Buffer.from("%PDF-1.7\n%âãÏÓ\n"), { filename: "report.pdf", declaredMimeType: "text/plain" });
    expect(facts).toMatchObject({ mimeType: "application/pdf", format: "pdf", mismatch: "corrected" });
  });

  it("leaves plain text declared as PDF unresolved (the quarantine refuses it)", () => {
    const facts = fileFactsFor(Buffer.from("just some words, not a pdf\nsecond line\n"), { filename: "fake.pdf", declaredMimeType: "application/pdf" });
    expect(facts.mismatch).toBe("unresolved");
  });

  it("leaves a generic ZIP declared as DOCX unresolved", () => {
    expect(fileFactsFor(zip([{ name: "payload.bin" }]), { filename: "x.docx", declaredMimeType: DOCX }).mismatch).toBe("unresolved");
  });

  it("falls back to the extension for application/octet-stream", () => {
    const facts = fileFactsFor(Buffer.from("%PDF-1.4\n"), { filename: "scan.pdf", declaredMimeType: "application/octet-stream" });
    expect(facts).toMatchObject({ mimeType: "application/pdf", mismatch: "none" });
  });

  it("does not read UTF-16LE text as an MP3 declared as audio/mpeg", () => {
    const facts = fileFactsFor(utf16le("this is text, not audio at all"), { filename: "a.mp3", declaredMimeType: "audio/mpeg" });
    expect(facts.mismatch).toBe("unresolved");
    expect(facts.encoding).toBe("utf-16le");
  });
});
