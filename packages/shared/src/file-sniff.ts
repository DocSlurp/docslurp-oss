/*
 * What a file is, from its bytes. Intake sniffs once and persists the result (documents.file_facts); billing, routing and
 * the worker's quarantine read that record instead of trusting the declared MIME type or the filename.
 *
 * Pure functions over bytes: no I/O, no process spawning. Containers are inspected by listing the ZIP central
 * directory or searching an OLE2 file for its application stream, which tells OOXML from OLE and EPUB from a plain ZIP.
 */

import {
  GENERIC_ZIP_MIME,
  OLE_STORAGE_MIME,
  bareMimeType,
  canonicalMimeType,
  compatibleMimeTypes,
  detectFileFormat,
  fileExtension,
  mimeFamily,
  MIME_BY_EXTENSION,
  type NormalizedFormat,
} from "./file-formats.js";

export type FileEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "8-bit";
export type FileContainer = "zip" | "ole";

export interface SniffedBytes {
  /** Canonical MIME type of what the bytes are; null when unrecognised (or empty). */
  mimeType: string | null;
  container: FileContainer | null;
  /** Set for text files: how to decode the bytes. */
  encoding: FileEncoding | null;
}

/**
 * - `none`: declared and sniffed agree.
 * - `same-family`: declared type differs from what the bytes are but means the same kind of file (a CSV declared
 *   `application/vnd.ms-excel`, a `.docx` declared `application/msword`). Resolved, with a warning.
 * - `corrected`: the bytes are a different supported format than declared (a PDF declared `text/plain`). Routed on the bytes.
 * - `unresolved`: the declaration cannot be reconciled with the bytes (a PDF that is plain text, a "DOCX" that is a generic ZIP).
 */
export type FileMimeMismatch = "none" | "same-family" | "corrected" | "unresolved";

/** The persisted record of a file's facts; every later decision (route, quote, bill) reads this. */
export interface FileFacts {
  declaredMimeType: string | null;
  /** What the bytes are, null when unrecognised. */
  sniffedMimeType: string | null;
  /** The canonical MIME type the document is stored and processed under. */
  mimeType: string;
  format: NormalizedFormat;
  container: FileContainer | null;
  encoding: FileEncoding | null;
  mismatch: FileMimeMismatch;
}

const ZIP_SIGNATURES = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]];
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const SAMPLE_BYTES = 8192;
const MAX_ZIP_NAMES = 10_000;

function startsWith(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + expected.length && expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let index = start; index < Math.min(end, bytes.length); index++) out += String.fromCharCode(bytes[index]!);
  return out;
}

function utf16le(text: string): number[] {
  return [...text].flatMap((char) => [char.charCodeAt(0), 0]);
}

function indexOfBytes(haystack: Uint8Array, needle: readonly number[]): number {
  if (typeof Buffer !== "undefined") return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).indexOf(Uint8Array.from(needle));
  const limit = Math.min(haystack.length, 4 * 1024 * 1024) - needle.length;
  outer: for (let index = 0; index <= limit; index++) {
    for (let inner = 0; inner < needle.length; inner++) if (haystack[index + inner] !== needle[inner]) continue outer;
    return index;
  }
  return -1;
}

/** Names of a ZIP's central directory entries, or null when the directory is unreadable. Never decompresses. */
export function listZipEntryNames(bytes: Uint8Array): string[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const names: string[] = [];
  const decoder = new TextDecoder("utf-8");
  for (let index = 0; index < count && index < MAX_ZIP_NAMES; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) return names.length ? names : null;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (offset + 46 + nameLength > end) return names.length ? names : null;
    names.push(decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** The first stored (uncompressed) `mimetype` entry of an EPUB or OpenDocument ZIP, which is its first local file. */
function zipMimetypeEntry(bytes: Uint8Array): string | null {
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || bytes.length < 38) return null;
  const nameLength = bytes[26]! | (bytes[27]! << 8);
  const extraLength = bytes[28]! | (bytes[29]! << 8);
  const method = bytes[8]! | (bytes[9]! << 8);
  if (method !== 0 || ascii(bytes, 30, 30 + nameLength) !== "mimetype") return null;
  const size = bytes[22]! | (bytes[23]! << 8) | (bytes[24]! << 16);
  const start = 30 + nameLength + extraLength;
  return size > 0 && size < 256 ? ascii(bytes, start, start + size).trim() : null;
}

function sniffZip(bytes: Uint8Array, filename: string): string {
  const names = listZipEntryNames(bytes);
  if (!names) return GENERIC_ZIP_MIME;
  const mimetype = zipMimetypeEntry(bytes);
  if (mimetype === "application/epub+zip") return "application/epub+zip";
  if (mimetype === "application/vnd.oasis.opendocument.text") return "application/vnd.oasis.opendocument.text";
  if (names.some((name) => name.startsWith("word/"))) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (names.some((name) => name.startsWith("xl/"))) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (names.some((name) => name.startsWith("ppt/"))) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (fileExtension(filename) === ".epub" && names.includes("META-INF/container.xml")) return "application/epub+zip";
  return GENERIC_ZIP_MIME;
}

function sniffOle(bytes: Uint8Array): string {
  if (indexOfBytes(bytes, utf16le("WordDocument")) >= 0) return "application/msword";
  if (indexOfBytes(bytes, utf16le("Workbook")) >= 0 || indexOfBytes(bytes, utf16le("Book")) >= 0) return "application/vnd.ms-excel";
  if (indexOfBytes(bytes, utf16le("PowerPoint Document")) >= 0) return "application/vnd.ms-powerpoint";
  return OLE_STORAGE_MIME;
}

/** A valid MPEG audio frame header: sync, a real version and layer, a defined bitrate and sample rate. */
function isMpegAudioFrame(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) return false;
  const version = (bytes[1]! >> 3) & 0x03;
  const layer = (bytes[1]! >> 1) & 0x03;
  const bitrate = (bytes[2]! >> 4) & 0x0f;
  const sampleRate = (bytes[2]! >> 2) & 0x03;
  return version !== 1 && layer !== 0 && bitrate !== 0x0f && bitrate !== 0 && sampleRate !== 3;
}

/** How a text file is encoded, or null when the bytes are not text. */
export function detectTextEncoding(bytes: Uint8Array): FileEncoding | null {
  const sample = bytes.subarray(0, SAMPLE_BYTES);
  if (sample.length === 0) return null;
  if (startsWith(sample, [0xef, 0xbb, 0xbf])) return "utf-8-bom";
  const wide = startsWith(sample, [0xff, 0xfe]) ? "utf-16le" : startsWith(sample, [0xfe, 0xff]) ? "utf-16be" : wideWithoutBom(sample);
  if (wide) return looksLikeText(decodeWide(sample, wide)) ? wide : null;
  if (sample.includes(0)) return null;
  let decoded: string | null = null;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true }); } catch { /* not UTF-8 */ }
  if (decoded !== null) return looksLikeText(decoded) ? "utf-8" : null;
  let latin = "";
  for (const byte of sample) latin += String.fromCharCode(byte);
  return looksLikeText(latin) ? "8-bit" : null;
}

/** UTF-16 without a BOM: ASCII-heavy text has a zero in every other byte. */
function wideWithoutBom(sample: Uint8Array): "utf-16le" | "utf-16be" | null {
  if (sample.length < 4) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index + 1 < sample.length; index += 2) {
    if (sample[index] === 0) evenZeros++;
    if (sample[index + 1] === 0) oddZeros++;
  }
  const pairs = Math.floor(sample.length / 2);
  if (oddZeros / pairs > 0.3 && evenZeros / pairs < 0.05) return "utf-16le";
  if (evenZeros / pairs > 0.3 && oddZeros / pairs < 0.05) return "utf-16be";
  return null;
}

function decodeWide(bytes: Uint8Array, encoding: "utf-16le" | "utf-16be"): string {
  const start = bytes.length >= 2 && (bytes[0] === 0xff || bytes[0] === 0xfe) && (bytes[1] === 0xfe || bytes[1] === 0xff) ? 2 : 0;
  return new TextDecoder(encoding).decode(bytes.subarray(start, start + ((bytes.length - start) & ~1)));
}

/** Text has few control characters; binary has NULs and many of them. */
function looksLikeText(decoded: string): boolean {
  if (decoded.length === 0) return false;
  let controls = 0;
  for (const char of decoded) {
    const code = char.codePointAt(0)!;
    if (code === 0xfffd && decoded.length > 1) controls += 0.25;
    else if ((code < 0x20 && code !== 9 && code !== 10 && code !== 13 && code !== 12) || code === 0x7f || (code >= 0x80 && code < 0xa0)) controls++;
  }
  return controls / decoded.length < 0.02;
}

/** Decodes a text file's bytes the way it is encoded (a UTF-16 CSV is not a UTF-8 one). */
export function decodeTextBytes(bytes: Uint8Array, encoding: FileEncoding | null = detectTextEncoding(bytes)): string {
  switch (encoding) {
    case "utf-16le": return decodeWide(bytes, "utf-16le");
    case "utf-16be": return decodeWide(bytes, "utf-16be");
    case "8-bit": return new TextDecoder("windows-1252").decode(bytes);
    default: return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  }
}

function looksLikeDelimitedText(text: string, delimiter: string): boolean {
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 5);
  if (lines.length < 2) return false;
  const counts = lines.map((line) => line.split(delimiter).length);
  return counts.every((count) => count > 1) && new Set(counts).size === 1;
}

function classifyText(sample: string): string {
  const text = sample.trimStart();
  if (text.startsWith("{\\rtf")) return "application/rtf";
  if (text.startsWith("{") || text.startsWith("[")) return "application/json";
  if (/^<!doctype html|^<html|^<body|^<head/i.test(text)) return "text/html";
  if (looksLikeDelimitedText(text, "\t")) return "text/tab-separated-values";
  if (looksLikeDelimitedText(text, ",")) return "text/csv";
  return "text/plain";
}

/** What the bytes are. `filename` is used only to tell WebM audio from video. */
export function sniffFileBytes(bytes: Uint8Array, filename = ""): SniffedBytes {
  const none: SniffedBytes = { mimeType: null, container: null, encoding: null };
  if (bytes.length === 0) return none;
  if (ascii(bytes, 0, 5) === "%PDF-") return { ...none, mimeType: "application/pdf" };
  if (ZIP_SIGNATURES.some((signature) => startsWith(bytes, signature))) return { ...none, mimeType: sniffZip(bytes, filename), container: "zip" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ...none, mimeType: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ...none, mimeType: "image/jpeg" };
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return { ...none, mimeType: "image/tiff" };
  if (ascii(bytes, 0, 4) === "RIFF") {
    const kind = ascii(bytes, 8, 12);
    if (kind === "WEBP") return { ...none, mimeType: "image/webp" };
    if (kind === "WAVE") return { ...none, mimeType: "audio/wav" };
    if (kind === "AVI ") return { ...none, mimeType: "video/x-msvideo" };
  }
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12).toLowerCase();
    if (/^(heic|heix|hevc|mif1|msf1|avif|avis)/.test(brand)) return none;
    if (brand.startsWith("m4a") || brand.startsWith("m4b")) return { ...none, mimeType: "audio/mp4" };
    if (brand.startsWith("qt")) return { ...none, mimeType: "video/quicktime" };
    return { ...none, mimeType: "video/mp4" };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    const head = ascii(bytes, 0, Math.min(bytes.length, 64));
    if (head.includes("matroska")) return { ...none, mimeType: "video/x-matroska" };
    return { ...none, mimeType: fileExtension(filename) === ".weba" ? "audio/webm" : "video/webm" };
  }
  if (ascii(bytes, 0, 4) === "OggS") return { ...none, mimeType: "audio/ogg" };
  if (ascii(bytes, 0, 4) === "fLaC") return { ...none, mimeType: "audio/flac" };
  if (ascii(bytes, 0, 3) === "ID3") return { ...none, mimeType: "audio/mpeg" };
  // Text before the MPEG frame check: a UTF-16LE byte-order mark (FF FE) looks like an MPEG sync word.
  const encoding = detectTextEncoding(bytes);
  const wide = encoding === "utf-16le" || encoding === "utf-16be";
  if (!wide) {
    if (isMpegAudioFrame(bytes)) return { ...none, mimeType: "audio/mpeg" };
    if (bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return { ...none, mimeType: "audio/aac" };
  }
  if (startsWith(bytes, OLE_SIGNATURE)) return { ...none, mimeType: sniffOle(bytes), container: "ole" };
  if (encoding) return { mimeType: classifyText(decodeTextBytes(bytes.subarray(0, SAMPLE_BYTES), encoding).slice(0, 4096)), container: null, encoding };
  return none;
}

const TEXT_FAMILY_MIME = (mimeType: string | null) => mimeFamily(mimeType) === "text";

/**
 * The facts of a file: the sniffed type reconciled with the declared MIME type and the extension. Pure; intake runs it once
 * and persists the result.
 */
export function fileFactsFor(bytes: Uint8Array, file: { filename: string; declaredMimeType?: string | null }): FileFacts {
  const sniffed = sniffFileBytes(bytes, file.filename);
  const declaredBare = bareMimeType(file.declaredMimeType);
  const declared = canonicalMimeType(declaredBare);
  const extensionMime = MIME_BY_EXTENSION[fileExtension(file.filename)] ?? null;
  const facts = (mimeType: string, mismatch: FileMimeMismatch): FileFacts => ({
    declaredMimeType: declaredBare || null,
    sniffedMimeType: sniffed.mimeType,
    mimeType,
    format: detectFileFormat({ filename: file.filename, mimeType }),
    container: sniffed.container,
    encoding: sniffed.encoding,
    mismatch,
  });
  const fallback = declared ?? extensionMime ?? (declaredBare || "application/octet-stream");

  if (!sniffed.mimeType) return facts(fallback, "none");

  if (sniffed.encoding) {
    // A text sniff cannot tell CSV from plain text: any member of the text family is acceptable as declared.
    if (declared && TEXT_FAMILY_MIME(declared)) return facts(declared, declared === sniffed.mimeType ? "none" : "same-family");
    if (extensionMime && TEXT_FAMILY_MIME(extensionMime)) return facts(extensionMime, declared ? "same-family" : "none");
    if (!declared && !extensionMime) return facts(sniffed.mimeType, "none");
    return facts(fallback, "unresolved");
  }

  if (declared && compatibleMimeTypes(declared, sniffed.mimeType)) {
    // The generic OLE type names no application; a declared type that does is more specific.
    const specific = sniffed.mimeType === OLE_STORAGE_MIME ? declared : sniffed.mimeType;
    return facts(specific, specific === declared ? "none" : "same-family");
  }
  if (!declared && sniffed.mimeType === OLE_STORAGE_MIME) {
    const family = mimeFamily(extensionMime);
    return facts(extensionMime && (family === "word" || family === "excel" || family === "powerpoint") ? extensionMime : OLE_STORAGE_MIME, "none");
  }
  const supported = canonicalMimeType(sniffed.mimeType);
  if (supported && sniffed.mimeType !== OLE_STORAGE_MIME) {
    // The bytes are a supported format other than the declared one: route on the bytes.
    const claimed = declared ?? extensionMime;
    return facts(supported, claimed && claimed !== supported ? "corrected" : "none");
  }
  // A generic ZIP or OLE file declared as a specific format: the declaration cannot be confirmed.
  return facts(fallback, declared || extensionMime ? "unresolved" : "none");
}
