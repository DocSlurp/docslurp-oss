import { CHART_EXTRACT_LIMITS, ExtractLimitError } from "./limits.js";

/*
 * Hardened, dependency-free XML reader for customer SVG and Office chart parts.
 *
 * - No DTD processing: a DOCTYPE with an internal subset, and any other `<!...>` declaration (ENTITY, ELEMENT, ATTLIST),
 *   is refused. An external DOCTYPE identifier (matplotlib writes one) is skipped and never fetched.
 * - Only the five predefined entities, `&nbsp;` and numeric character references are decoded; nothing expands into
 *   more markup, so entity expansion (billion laughs) and external entities (XXE) cannot happen.
 * - Element, node, attribute and depth counts are capped; on any limit the parse stops with an `ExtractLimitError`.
 * - Attribute maps have no prototype, so names like `__proto__` are plain keys.
 */

export interface XmlElement {
  type: "element";
  /** Qualified name as written (`c:barChart`). */
  name: string;
  /** Local name without prefix (`barChart`). */
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export interface XmlText { type: "text"; value: string }
export interface XmlComment { type: "comment"; value: string }
export type XmlNode = XmlElement | XmlText | XmlComment;

export interface XmlParseOptions {
  keepComments?: boolean;
  maxElements?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxChars?: number;
}

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'", nbsp: " " };

// Character classes by code unit (the tokenizer's hot path; a RegExp test per character cost ~1/3 of a parse). Exported
// for the exhaustive equivalence test against the regexes they replace.
/** `[A-Za-z_:]` */
export const isNameStart = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 58;
/** `[A-Za-z0-9_:.\-]` */
export const isNameChar = (c: number) => isNameStart(c) || (c >= 48 && c <= 57) || c === 46 || c === 45;
/** Exactly JavaScript's `\s`: ASCII whitespace plus the Unicode space separators, line terminators and BOM. */
export const isSpace = (c: number) => (c >= 9 && c <= 13) || c === 32 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
  || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;

export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body]! : whole;
  });
}

export function localName(name: string): string {
  const i = name.lastIndexOf(":");
  return i >= 0 ? name.slice(i + 1) : name;
}

/** Parse a document or fragment. Returns a synthetic `#document` element holding the top-level nodes. */
export function parseXml(input: string, options: XmlParseOptions = {}): XmlElement {
  const maxChars = options.maxChars ?? CHART_EXTRACT_LIMITS.maxTextBytes;
  const maxElements = options.maxElements ?? CHART_EXTRACT_LIMITS.maxXmlElements;
  const maxDepth = options.maxDepth ?? CHART_EXTRACT_LIMITS.maxXmlDepth;
  const maxNodes = options.maxNodes ?? CHART_EXTRACT_LIMITS.maxXmlNodes;
  if (input.length > maxChars) throw new ExtractLimitError("xml-too-large");
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const doc: XmlElement = { type: "element", name: "#document", local: "#document", attrs: Object.create(null), children: [] };
  const stack: XmlElement[] = [doc];
  let elements = 0;
  let nodes = 0;
  let sawRoot = false;
  const addNode = (node: XmlNode) => {
    if (++nodes > maxNodes) throw new ExtractLimitError("xml-node-limit");
    stack[stack.length - 1]!.children.push(node);
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      const raw = src.slice(i, textEnd);
      if (stack.length > 1 && raw.trim() !== "") addNode({ type: "text", value: decodeEntities(raw) });
    }
    if (lt < 0) break;
    i = lt;
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end < 0) throw new ExtractLimitError("xml-unterminated-pi");
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) throw new ExtractLimitError("xml-unterminated-comment");
      if (options.keepComments && stack.length > 1) addNode({ type: "comment", value: src.slice(i + 4, end) });
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end < 0) throw new ExtractLimitError("xml-unterminated-cdata");
      if (stack.length > 1) addNode({ type: "text", value: src.slice(i + 9, end) });
      i = end + 3;
      continue;
    }
    if (src.startsWith("<!", i)) {
      if (src.slice(i + 2, i + 9).toUpperCase() !== "DOCTYPE" || sawRoot) throw new ExtractLimitError("xml-dtd-declaration");
      // Skip an external identifier only; an internal subset ("[ ... ]") could declare entities.
      let j = i + 9;
      let quote = "";
      for (; j < n; j++) {
        const c = src[j]!;
        if (quote) { if (c === quote) quote = ""; continue; }
        if (c === "\"" || c === "'") { quote = c; continue; }
        if (c === "[") throw new ExtractLimitError("xml-dtd-internal-subset");
        if (c === ">") break;
      }
      if (j >= n) throw new ExtractLimitError("xml-unterminated-doctype");
      i = j + 1;
      continue;
    }
    if (src[i + 1] === "/") {
      const end = src.indexOf(">", i + 2);
      if (end < 0) throw new ExtractLimitError("xml-unterminated-tag");
      const name = src.slice(i + 2, end).trim();
      const open = stack[stack.length - 1]!;
      if (stack.length <= 1 || open.name !== name) throw new ExtractLimitError("xml-mismatched-tag");
      stack.pop();
      i = end + 1;
      continue;
    }
    // Start tag.
    let j = i + 1;
    if (!isNameStart(src.charCodeAt(j))) throw new ExtractLimitError("xml-bad-tag");
    while (j < n && isNameChar(src.charCodeAt(j))) j++;
    const name = src.slice(i + 1, j);
    const attrs: Record<string, string> = Object.create(null);
    let attrCount = 0;
    let selfClosing = false;
    for (;;) {
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      if (j >= n) throw new ExtractLimitError("xml-unterminated-tag");
      const c = src[j]!;
      if (c === ">") { j++; break; }
      if (c === "/" && src[j + 1] === ">") { selfClosing = true; j += 2; break; }
      if (!isNameStart(src.charCodeAt(j))) throw new ExtractLimitError("xml-bad-attribute");
      const start = j;
      while (j < n && isNameChar(src.charCodeAt(j))) j++;
      const attrName = src.slice(start, j);
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      let value = "";
      if (src[j] === "=") {
        j++;
        while (j < n && isSpace(src.charCodeAt(j))) j++;
        const q = src[j];
        if (q === "\"" || q === "'") {
          const end = src.indexOf(q, j + 1);
          if (end < 0) throw new ExtractLimitError("xml-unterminated-attribute");
          value = src.slice(j + 1, end);
          j = end + 1;
        } else {
          const start2 = j;
          while (j < n && !isSpace(src.charCodeAt(j)) && src.charCodeAt(j) !== 62 && !(src[j] === "/" && src[j + 1] === ">")) j++;
          value = src.slice(start2, j);
        }
      }
      if (++attrCount > CHART_EXTRACT_LIMITS.maxXmlAttributes) throw new ExtractLimitError("xml-attribute-limit");
      if (!(attrName in attrs)) attrs[attrName] = decodeEntities(value);
    }
    if (++elements > maxElements) throw new ExtractLimitError("xml-element-limit");
    const el: XmlElement = { type: "element", name, local: localName(name), attrs, children: [] };
    addNode(el);
    sawRoot = true;
    if (!selfClosing) {
      if (stack.length > maxDepth) throw new ExtractLimitError("xml-depth-limit");
      stack.push(el);
    }
    i = j;
  }
  if (stack.length > 1) throw new ExtractLimitError("xml-unclosed-element");
  return doc;
}

export function elementChildren(el: XmlElement, local?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) if (c.type === "element" && (local === undefined || c.local === local)) out.push(c);
  return out;
}

export function firstChild(el: XmlElement | null | undefined, local: string): XmlElement | null {
  if (!el) return null;
  for (const c of el.children) if (c.type === "element" && c.local === local) return c;
  return null;
}

/** Follow a chain of local names through first children. */
export function path(el: XmlElement | null | undefined, ...locals: string[]): XmlElement | null {
  let cur: XmlElement | null = el ?? null;
  for (const l of locals) { cur = firstChild(cur, l); if (!cur) return null; }
  return cur;
}

/** Pre-order descendants with the given local name (iterative; no recursion on hostile depth). */
export function descendants(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const stack: XmlElement[] = [el];
  while (stack.length) {
    const cur = stack.pop()!;
    for (let k = cur.children.length - 1; k >= 0; k--) {
      const c = cur.children[k]!;
      if (c.type === "element") stack.push(c);
    }
    if (cur !== el && cur.local === local) out.push(cur);
  }
  return out;
}

export function textContent(el: XmlElement | null | undefined): string {
  if (!el) return "";
  let out = "";
  const stack: XmlNode[] = [el];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.type === "text") { out += cur.value; continue; }
    if (cur.type === "comment") continue;
    for (let k = cur.children.length - 1; k >= 0; k--) stack.push(cur.children[k]!);
  }
  return out;
}

export function rootElement(doc: XmlElement): XmlElement | null {
  return elementChildren(doc)[0] ?? null;
}
