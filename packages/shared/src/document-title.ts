/**
 * Friendly document titles derived from document content.
 *
 * Every candidate (embedded metadata, headings, page-map titles) is untrusted,
 * attacker-controlled text. The result is for display only: it must never be
 * placed in a model prompt, system prompt, tool description or agent
 * instruction, nor labelled as trusted context.
 */

export const DOCUMENT_TITLE_MAX_LENGTH = 120;
const DOCUMENT_TITLE_MIN_LENGTH = 3;
/** Longer "headings" are paragraphs mis-tagged as headings, not titles. */
const DOCUMENT_TITLE_MAX_RAW_LENGTH = 400;

export type DocumentTitleSource = "metadata" | "heading";

export type DerivedDocumentTitle = {
  title: string;
  source: DocumentTitleSource;
};

// Line breaks and tabs become spaces; other control (C0, DEL, C1), zero-width,
// bidi embedding/override/isolate characters and the BOM are removed.
const BREAKING_CONTROLS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
const UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function stripUnsafeCharacters(value: string): string {
  return value.replace(BREAKING_CONTROLS, " ").replace(UNSAFE_CHARACTERS, "");
}

const PRODUCER_PREFIX =
  /^(?:microsoft\s+(?:office\s+)?(?:word|powerpoint|excel|publisher|visio)|word|powerpoint|excel|libreoffice(?:\s+\w+)?|openoffice(?:\s+\w+)?|google\s+(?:docs|slides|sheets)|pages|keynote|numbers)\s*[-–—:]\s*/i;

const FILE_EXTENSION =
  /\.(?:pdf|docx?|dotx?|pptx?|ppsx?|xlsx?|xlsm|csv|tsv|rtf|odt|odp|ods|txt|md|markdown|html?|xhtml|epub|pages|key|numbers|png|jpe?g|gif|tiff?|webp|heic|mp3|mp4|m4a|wav|mov|webm)$/i;

const GENERIC_TITLES = new Set([
  "untitled",
  "untitled document",
  "no title",
  "title",
  "document",
  "new document",
  "doc",
  "presentation",
  "untitled presentation",
  "slide",
  "slides",
  "workbook",
  "spreadsheet",
  "sheet",
  "book",
  "page",
  "contents",
  "content",
  "table of contents",
  "toc",
  "abstract",
  "summary",
  "executive summary",
  "introduction",
  "overview",
  "index",
  "cover",
  "cover page",
  "title page",
  "front matter",
  "preface",
  "foreword",
  "draft",
  "confidential",
  "home",
  "welcome",
  "default",
  "unknown",
  "none",
  "null",
  "undefined",
  "n a",
]);

/** Generic word followed only by a number, e.g. "Page 1", "Document 3", "Untitled-1", "Slide 12". */
const GENERIC_NUMBERED =
  /^(?:untitled|document|doc|page|slide|sheet|presentation|workbook|book|chapter|section|part|figure|table|scan|image|img|file|copy)\s*[-_#]?\s*\d+$/i;

/** Generic instruction/role text; titles are display-only, so anything prompt-shaped is dropped. */
const INSTRUCTION_LIKE: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all|any|the|previous|prior|above|earlier|your)\b(?:\s+\w+){0,3}\s+(?:instructions?|prompts?|rules|directions|messages?)\b/i,
  /^\s*(?:system|assistant|user|developer|human|ai)\s*[:>]/i,
  /\b(?:system|assistant|developer)\s*:/i,
  /^\s*you\s+are\b/i,
  /\byou\s+are\s+(?:now|an?|the)\s+(?:ai|assistant|chatbot|language model|llm|model|agent)\b/i,
  /\b(?:act|behave|respond)\s+as\s+(?:an?\s+)?(?:ai|assistant|system|agent)\b/i,
  /<\|/,
  /\|>/,
  /\[\/?(?:INST|SYS|SYSTEM)\]/i,
  /<<\/?SYS>>/i,
  /<\/?(?:system|assistant|user|instructions?)>/i,
  /\b(?:new|updated|hidden)\s+instructions?\s*:/i,
  /\bprompt\s+injection\b/i,
];

const URL_LIKE = /\b(?:https?:\/\/|ftp:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|ai|co|app|info|biz|xyz|ru|cn)(?:\/\S*)?\b/i;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function stripMarkup(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/^\s*(?:#{1,6}\s*|>\s*|[-+*]\s+|\d+[.)]\s+)/, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\{#[^}]*\}\s*$/, "");
}

function normalizeComparable(value: string): string {
  return value
    .toLowerCase()
    .replace(FILE_EXTENSION, "")
    .replace(/\((?:\d+|copy)\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The filename without directories or extension. */
export function filenameStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return base.replace(/\.[^.]{1,8}$/, "");
}

function truncateAtWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const slice = value.slice(0, max - 1);
  const boundary = slice.lastIndexOf(" ");
  const cut = boundary >= Math.floor(max / 2) ? slice.slice(0, boundary) : slice;
  return `${cut.replace(/[\s,;:.\-–—|/]+$/, "")}…`;
}

/**
 * Cleans one untrusted title candidate. Returns a single-line display string, or
 * null when the candidate is empty, generic, junk, prompt-shaped, a URL/email, or
 * just repeats the filename.
 */
export function cleanDocumentTitle(raw: unknown, options: { filename?: string | null } = {}): string | null {
  if (typeof raw !== "string") return null;
  let value = stripUnsafeCharacters(raw);
  if (value.trim().length === 0 || value.length > DOCUMENT_TITLE_MAX_RAW_LENGTH * 4) return null;

  value = stripUnsafeCharacters(decodeHtmlEntities(value));
  // Check before markup stripping too: chat-template tokens such as "<|...|>" look like tags.
  if (INSTRUCTION_LIKE.some((pattern) => pattern.test(value))) return null;
  value = stripMarkup(value).replace(/\s+/g, " ").trim();
  value = value.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();

  // "Microsoft Word - Q3 plan.docx" → "Q3 plan.docx" → "Q3 plan".
  for (let i = 0; i < 2 && PRODUCER_PREFIX.test(value); i++) value = value.replace(PRODUCER_PREFIX, "").trim();
  value = value.replace(FILE_EXTENSION, "").trim();

  if (value.length < DOCUMENT_TITLE_MIN_LENGTH || value.length > DOCUMENT_TITLE_MAX_RAW_LENGTH) return null;
  if (INSTRUCTION_LIKE.some((pattern) => pattern.test(value))) return null;
  if (URL_LIKE.test(value) || EMAIL_LIKE.test(value)) return null;

  const letters = (value.match(/\p{L}/gu) ?? []).length;
  if (letters < DOCUMENT_TITLE_MIN_LENGTH || letters / value.length < 0.4) return null;

  const comparable = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (GENERIC_TITLES.has(comparable) || GENERIC_NUMBERED.test(value)) return null;

  if (options.filename) {
    const stem = normalizeComparable(filenameStem(options.filename));
    if (stem && normalizeComparable(value) === stem) return null;
  }

  return truncateAtWord(value, DOCUMENT_TITLE_MAX_LENGTH);
}

type MarkdownHeading = { level: number; text: string };

function markdownHeadings(markdown: string, maxLines: number): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n").slice(0, maxLines);
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const atx = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      headings.push({ level: atx[1]!.length, text: atx[2]! });
      continue;
    }
    const next = lines[i + 1];
    if (line.trim() && next && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s*[-*+]\s/.test(line)) {
      headings.push({ level: next.trim().startsWith("=") ? 1 : 2, text: line.trim() });
      i++;
      continue;
    }
    // A short line that is entirely bold reads as a heading in OCR/plain extractions.
    const bold = /^\s*(?:\*\*|__)([^*_]{3,200})(?:\*\*|__)\s*$/.exec(line);
    if (bold) headings.push({ level: 3, text: bold[1]! });
  }
  return headings;
}

/**
 * The best heading in the opening pages: the first H1 that cleans to a title,
 * else the first strong heading (H2 or a bold line) on the first page.
 */
export function titleFromMarkdownPages(
  pages: readonly string[],
  options: { filename?: string | null; pagesToScan?: number } = {},
): string | null {
  const scanned = pages.slice(0, Math.max(1, options.pagesToScan ?? 2));
  for (const page of scanned) {
    for (const heading of markdownHeadings(page, 400)) {
      if (heading.level !== 1) continue;
      const title = cleanDocumentTitle(heading.text, options);
      if (title) return title;
    }
  }
  const first = scanned[0];
  if (!first) return null;
  for (const heading of markdownHeadings(first, 80)) {
    if (heading.level === 1 || heading.level > 3) continue;
    const title = cleanDocumentTitle(heading.text, options);
    if (title) return title;
  }
  return null;
}

/** `<meta property="og:title">` (preferred) or `<title>` from the head of an HTML document. */
export function htmlDocumentTitle(html: string): string | null {
  const head = html.slice(0, 256 * 1024);
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\b(?:property|name)\s*=\s*["']?(?:og:title|twitter:title)["'\s>/]/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const value = content?.[1] ?? content?.[2];
    if (value?.trim()) return value;
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  return title?.[1]?.trim() ? title[1] : null;
}

/**
 * Picks the document title: embedded metadata when it passes the checks, else a
 * heading from the first pages, else null (clients fall back to the filename).
 */
export function deriveDocumentTitle(input: {
  metadataTitles?: readonly (string | null | undefined)[];
  pages?: readonly string[];
  filename?: string | null;
}): DerivedDocumentTitle | null {
  const options = { filename: input.filename ?? null };
  for (const candidate of input.metadataTitles ?? []) {
    const title = cleanDocumentTitle(candidate, options);
    if (title) return { title, source: "metadata" };
  }
  const heading = input.pages ? titleFromMarkdownPages(input.pages, options) : null;
  return heading ? { title: heading, source: "heading" } : null;
}
