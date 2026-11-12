/*
 * Council N-H1 (PR #339): an encrypted PDF whose readers can disagree on its encryption is refused.
 *
 * A file can carry two encryption dictionaries under two trailers and a broken `startxref`, so every reader rebuilds the
 * cross-reference table and picks a trailer of its own: qpdf and poppler take the last, pdf.js the first. qpdf's
 * "decrypted" copy (what quarantine scans) is then garbage while pdf.js decrypts the hidden text into the document map.
 * This check reads the bytes (in the parser VM in production: quarantine-bytes.ts and pdf-structure-guest.ts) and reports
 * a conflict when the file is encrypted and any of these holds:
 *
 * - more than one distinct `/Encrypt` value (an indirect reference `N G R` or a direct dictionary) anywhere in the bytes;
 * - the trailers (`trailer` dictionaries and cross-reference stream dictionaries) disagree on `/Encrypt`, or on the first
 *   element of `/ID`, which is what the key is derived from (the second element legitimately changes with each update);
 * - the last `startxref`, or a trailer's `/Prev`, does not point at a cross-reference section, so readers reconstruct.
 *
 * Bounded: one pass over the name tokens (`/`), the keywords `trailer` and `startxref`, and fixed-size windows around each;
 * at most MAX_SECTIONS trailers are examined (more is itself a conflict). Escaped names (`/En#63rypt`) are decoded.
 */

/** Trailers and cross-reference sections examined; a file with more is refused as inconsistent. */
const MAX_SECTIONS = 4096;
/**
 * `/XRef` name tokens examined (council R6-L1): each costs a bounded backward search, so a file of nothing but `/XRef `
 * tokens is refused as inconsistent after this many instead of costing parser-VM minutes.
 */
const MAX_XREF_NAMES = 4 * MAX_SECTIONS;
/** How far a trailer dictionary is read past its keyword or object header. */
const DICT_WINDOW = 16 * 1024;

const NAME_END = (() => {
  const table = new Uint8Array(256);
  for (let byte = 0; byte <= 0x20; byte += 1) table[byte] = 1;
  table[0x7f] = 1;
  for (const char of "()<>[]{}/%") table[char.charCodeAt(0)] = 1;
  return table;
})();
const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/** The decoded name starting at the `/` at `slash`, and the offset just past it; names longer than `max` are cut. */
function readName(bytes: Buffer, slash: number, max = 16): { name: string; end: number } {
  let name = "";
  let index = slash + 1;
  for (; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (NAME_END[byte]) break;
    if (byte === 0x23 && index + 2 < bytes.length) {
      const hex = bytes.subarray(index + 1, index + 3).toString("latin1");
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        if (name.length <= max) name += String.fromCharCode(parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    if (name.length <= max) name += String.fromCharCode(byte);
  }
  return { name, end: index };
}

/** Skip whitespace and comments from `offset`. */
function skipSpace(bytes: Buffer, offset: number, limit: number): number {
  let index = offset;
  while (index < limit) {
    const byte = bytes[index]!;
    if (WHITESPACE.has(byte)) { index += 1; continue; }
    if (byte === 0x25) {
      while (index < limit && bytes[index] !== 0x0a && bytes[index] !== 0x0d) index += 1;
      continue;
    }
    break;
  }
  return index;
}

function readInteger(bytes: Buffer, offset: number, limit: number): { value: number; end: number } | null {
  let index = offset;
  while (index < limit && bytes[index]! >= 0x30 && bytes[index]! <= 0x39 && index - offset < 12) index += 1;
  if (index === offset) return null;
  return { value: Number(bytes.subarray(offset, index).toString("latin1")), end: index };
}

/**
 * The value after a name ending at `offset`: `ref:N G` for an indirect reference, `direct` for a dictionary, `other`
 * for anything else (a string or number in an ordinary PDF's text).
 */
function readEncryptValue(bytes: Buffer, offset: number, limit: number): string {
  const start = skipSpace(bytes, offset, limit);
  if (bytes[start] === 0x3c && bytes[start + 1] === 0x3c) return "direct";
  const num = readInteger(bytes, start, limit);
  if (!num) return "other";
  const gen = readInteger(bytes, skipSpace(bytes, num.end, limit), limit);
  if (!gen) return "other";
  const r = skipSpace(bytes, gen.end, limit);
  return bytes[r] === 0x52 && (r + 1 >= limit || NAME_END[bytes[r + 1]!]) ? `ref:${num.value} ${gen.value}` : "other";
}

/** The first element of an `/ID` array, normalised (a hex string lower-cased without whitespace, or a literal string's raw bytes). */
function readIdFirst(bytes: Buffer, offset: number, limit: number): string {
  let index = skipSpace(bytes, offset, limit);
  if (bytes[index] !== 0x5b) return "malformed";
  index = skipSpace(bytes, index + 1, limit);
  if (bytes[index] === 0x3c) {
    const end = bytes.indexOf(0x3e, index + 1);
    if (end < 0 || end >= limit) return "malformed";
    return `hex:${bytes.subarray(index + 1, end).toString("latin1").replace(/\s+/g, "").toLowerCase()}`;
  }
  if (bytes[index] === 0x28) {
    let depth = 0;
    for (let cursor = index; cursor < limit && cursor - index < 1024; cursor += 1) {
      const byte = bytes[cursor]!;
      if (byte === 0x5c) { cursor += 1; continue; }
      if (byte === 0x28) depth += 1;
      else if (byte === 0x29 && --depth === 0) return `lit:${bytes.subarray(index + 1, cursor).toString("hex")}`;
    }
  }
  return "malformed";
}

/** A trailer's /Encrypt, first /ID element and /Prev, read from the dictionary at `start` (up to DICT_WINDOW bytes). */
function readTrailer(bytes: Buffer, start: number): { encrypt: string | null; id: string | null; prev: number | null } {
  const limit = Math.min(bytes.length, start + DICT_WINDOW);
  // The dictionary ends at its closing `>>` at depth 0; strings and nested dictionaries are skipped.
  let depth = 0;
  let encrypt: string | null = null;
  let id: string | null = null;
  let prev: number | null = null;
  for (let index = start; index < limit; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0x3c && bytes[index + 1] === 0x3c) { depth += 1; index += 1; continue; }
    if (byte === 0x3e && bytes[index + 1] === 0x3e) { depth -= 1; index += 1; if (depth <= 0) break; continue; }
    if (byte === 0x28) {
      let parens = 0;
      for (; index < limit; index += 1) {
        if (bytes[index] === 0x5c) { index += 1; continue; }
        if (bytes[index] === 0x28) parens += 1;
        else if (bytes[index] === 0x29 && --parens === 0) break;
      }
      continue;
    }
    if (byte === 0x25) { index = skipSpace(bytes, index, limit) - 1; continue; }
    if (byte !== 0x2f || depth !== 1) continue;
    const { name, end } = readName(bytes, index);
    if (name === "Encrypt") encrypt = encrypt === null ? readEncryptValue(bytes, end, limit) : "duplicate";
    else if (name === "ID") id = readIdFirst(bytes, end, limit);
    else if (name === "Prev") prev = readInteger(bytes, skipSpace(bytes, end, limit), limit)?.value ?? -1;
    index = end - 1;
  }
  return { encrypt, id, prev };
}

/**
 * Council R6-M1: a linearized file's main trailer legitimately omits /Encrypt (qpdf and Acrobat write `<< /Size N /ID [...] >>`
 * there; only the first-page trailer names the encryption dictionary). That trailer is the one exempt from agreeing on
 * /Encrypt, and only when: the file opens with a linearization dictionary (its first object, within the first 1 KiB), the
 * first trailer in file order names /Encrypt and its /Prev points at a section, and the trailer of exactly that section is the
 * file's only trailer without /Encrypt. A plain file whose first trailer alone names /Encrypt (round-5 trailer-enc-first)
 * has no linearization dictionary and stays refused. Since every parser reads quarantine's scanned copy (parse-source.ts),
 * which sections a reader starts from no longer decides what is parsed; this check guards the original for download.
 */
function linearizedMainTrailer<T extends { encrypt: string | null; prev: number | null; section: number }>(bytes: Buffer, trailers: T[]): T | null {
  const head = bytes.subarray(0, 1024).toString("latin1");
  const firstObject = head.search(/\d+\s+\d+\s+obj\b/);
  if (firstObject < 0 || !/^\d+\s+\d+\s+obj\s*<<[^>]*?\/Linearized\b/.test(head.slice(firstObject))) return null;
  const withoutEncrypt = trailers.filter((trailer) => trailer.encrypt === null);
  if (withoutEncrypt.length !== 1) return null;
  const ordered = trailers.filter((trailer) => trailer.section >= 0).sort((a, b) => a.section - b.section);
  const first = ordered[0];
  if (!first || first.encrypt === null || first.prev === null) return null;
  const main = withoutEncrypt[0]!;
  return main.section === first.prev || (main.section >= 0 && skipSpace(bytes, first.prev, Math.min(bytes.length, first.prev + 64)) === main.section) ? main : null;
}

/** Whether `offset` starts a cross-reference section: the `xref` keyword or an `N G obj` cross-reference stream. */
function isXrefSection(bytes: Buffer, offset: number, xrefStreams: Set<number>): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) return false;
  const start = skipSpace(bytes, offset, Math.min(bytes.length, offset + 64));
  if (bytes.subarray(start, start + 4).toString("latin1") === "xref") return true;
  return xrefStreams.has(start);
}

export interface PdfEncryptionStructure {
  /** Whether any trailer names an encryption dictionary. */
  encrypted: boolean;
  /** Why readers may disagree on the encryption (null when they cannot): quarantine refuses the file. */
  conflict: string | null;
}

/** Council N-H1: whether an encrypted PDF's encryption is the same for every reader. Pure; reads only `bytes`. */
export function pdfEncryptionStructure(bytes: Buffer): PdfEncryptionStructure {
  const encryptValues = new Set<string>();
  // Cross-reference stream objects: `N G obj` whose dictionary has /Type /XRef, by the offset of their object header.
  const xrefStreams = new Map<number, number>();
  let xrefNames = 0;
  for (let slash = bytes.indexOf(0x2f); slash >= 0; slash = bytes.indexOf(0x2f, slash + 1)) {
    const { name, end } = readName(bytes, slash);
    if (name === "Encrypt") {
      const value = readEncryptValue(bytes, end, Math.min(bytes.length, end + 64));
      if (value !== "other") encryptValues.add(value);
    } else if (name === "XRef") {
      if (++xrefNames > MAX_XREF_NAMES) return { encrypted: encryptValues.size > 0, conflict: "too many cross-reference stream names" };
      // `/Type /XRef`: the dictionary opens after the nearest preceding `obj` keyword, searched for within DICT_WINDOW only
      // (council R6-L1: an unbounded backward search made a file of `/XRef ` tokens quadratic).
      const windowStart = Math.max(0, slash - DICT_WINDOW);
      const window = bytes.subarray(windowStart, slash);
      const found = window.lastIndexOf("obj", window.length, "latin1");
      const obj = found >= 0 ? windowStart + found : -1;
      if (obj >= 0) {
        let header = obj;
        // Back over `N G ` to the object number.
        let cursor = obj - 1;
        let fields = 0;
        while (cursor >= 0 && fields < 2) {
          while (cursor >= 0 && WHITESPACE.has(bytes[cursor]!)) cursor -= 1;
          const digitsEnd = cursor;
          while (cursor >= 0 && bytes[cursor]! >= 0x30 && bytes[cursor]! <= 0x39) cursor -= 1;
          if (cursor === digitsEnd) break;
          fields += 1;
          header = cursor + 1;
        }
        if (fields === 2 && !xrefStreams.has(header)) {
          const open = bytes.subarray(obj, Math.min(bytes.length, slash)).indexOf("<<", 0, "latin1");
          xrefStreams.set(header, open >= 0 ? obj + open : -1);
        }
      }
    }
    if (xrefStreams.size > MAX_SECTIONS) return { encrypted: encryptValues.size > 0, conflict: "too many cross-reference sections" };
    slash = Math.max(slash, end - 1);
  }

  // `xref` keywords (not the tail of `startxref`), in file order: the section a classic trailer closes starts at the last
  // one before it. One forward pass, so the lookup below is a binary search, never a backward scan per trailer.
  const tableStarts: number[] = [];
  for (let at = bytes.indexOf("xref", 0, "latin1"); at >= 0; at = bytes.indexOf("xref", at + 4, "latin1")) {
    if (at < 5 || bytes.subarray(at - 5, at).toString("latin1") !== "start") tableStarts.push(at);
    if (tableStarts.length > MAX_SECTIONS) return { encrypted: encryptValues.size > 0, conflict: "too many cross-reference sections" };
  }
  const sectionOf = (offset: number): number => {
    let low = 0;
    let high = tableStarts.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (tableStarts[mid]! < offset) { found = tableStarts[mid]!; low = mid + 1; } else high = mid - 1;
    }
    return found;
  };

  const trailers: Array<{ encrypt: string | null; id: string | null; prev: number | null; section: number }> = [];
  for (let at = bytes.indexOf("trailer", 0, "latin1"); at >= 0; at = bytes.indexOf("trailer", at + 7, "latin1")) {
    const open = skipSpace(bytes, at + 7, Math.min(bytes.length, at + 7 + 1024));
    if (bytes[open] !== 0x3c || bytes[open + 1] !== 0x3c) continue;
    trailers.push({ ...readTrailer(bytes, open), section: sectionOf(at) });
    if (trailers.length > MAX_SECTIONS) return { encrypted: encryptValues.size > 0, conflict: "too many trailers" };
  }
  for (const [header, dict] of xrefStreams) {
    if (dict >= 0) trailers.push({ ...readTrailer(bytes, dict), section: header });
  }

  const encrypted = trailers.some((trailer) => trailer.encrypt !== null);
  if (!encrypted) return { encrypted: false, conflict: null };
  if (encryptValues.size > 1) return { encrypted, conflict: "more than one encryption dictionary" };
  const linearizedMain = linearizedMainTrailer(bytes, trailers);
  const encrypts = new Set(trailers.filter((trailer) => trailer !== linearizedMain).map((trailer) => trailer.encrypt));
  if (encrypts.size > 1 || encrypts.has("other") || encrypts.has("duplicate") || encrypts.has(null)) return { encrypted, conflict: "trailers disagree on /Encrypt" };
  const ids = new Set(trailers.map((trailer) => trailer.id));
  if (ids.size > 1 || ids.has(null) || ids.has("malformed")) return { encrypted, conflict: "trailers disagree on /ID" };

  const offsets = new Set(xrefStreams.keys());
  const startxref = bytes.lastIndexOf("startxref", bytes.length, "latin1");
  const last = startxref >= 0 ? readInteger(bytes, skipSpace(bytes, startxref + 9, Math.min(bytes.length, startxref + 64)), bytes.length) : null;
  if (!last || !isXrefSection(bytes, last.value, offsets)) return { encrypted, conflict: "startxref does not point at a cross-reference section" };
  for (const trailer of trailers) {
    if (trailer.prev !== null && !isXrefSection(bytes, trailer.prev, offsets)) return { encrypted, conflict: "/Prev does not point at a cross-reference section" };
  }
  return { encrypted, conflict: null };
}
