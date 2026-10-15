// ---------------------------------------------------------------------------
// H9 (HTML path): embedded / script-rendered content that static HTML text extraction does not see.
// Pure and dependency-free: a tolerant tag scanner, not a DOM. Everything listed here is content that
// was NOT extracted, so the caller records it instead of silently dropping it.
// ---------------------------------------------------------------------------

export type HtmlEmbedKind =
  | "iframe"
  | "iframe-srcdoc"
  | "embed"
  | "object"
  | "video"
  | "audio"
  | "canvas"
  | "svg-foreign-object"
  | "script-external"
  | "script-rendered";

export interface HtmlEmbeddedItem {
  kind: HtmlEmbedKind;
  /** src / data / srcdoc length hint; null when the element has none (canvas, inline script). */
  src: string | null;
  /** True when the element carries its content inline (srcdoc, <object> fallback) that text extraction may still see. */
  hasInlineFallback: boolean;
  note: string;
}

export interface HtmlEmbedReport {
  schemaVersion: "html-embeds@v1";
  items: HtmlEmbeddedItem[];
  counts: Partial<Record<HtmlEmbedKind, number>>;
  /** Some embedded content was not extracted. */
  needsAttention: boolean;
}

const RENDER_MARKERS = /\b(document\.write|innerHTML|insertAdjacentHTML|createElement|appendChild|ReactDOM|createRoot|hydrate|fetch\s*\(|XMLHttpRequest|\.render\s*\()/;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
}

export function detectHtmlEmbeds(html: string): HtmlEmbedReport {
  const items: HtmlEmbeddedItem[] = [];
  const push = (item: HtmlEmbeddedItem) => items.push(item);
  // Strip comments so commented-out markup is not reported.
  const text = html.replace(/<!--[\s\S]*?-->/g, "");

  for (const m of text.matchAll(/<(iframe|embed|object|video|audio|canvas)(\s[^>]*)?>/gi)) {
    const tag = m[0];
    const name = m[1]!.toLowerCase();
    if (name === "iframe") {
      const srcdoc = attr(tag, "srcdoc");
      if (srcdoc !== null) {
        push({ kind: "iframe-srcdoc", src: null, hasInlineFallback: true, note: `inline frame document (${srcdoc.length} chars) is not part of the page text` });
      } else {
        push({ kind: "iframe", src: attr(tag, "src"), hasInlineFallback: false, note: "framed document not fetched or extracted" });
      }
    } else if (name === "embed") {
      push({ kind: "embed", src: attr(tag, "src"), hasInlineFallback: false, note: "embedded resource not fetched or extracted" });
    } else if (name === "object") {
      push({ kind: "object", src: attr(tag, "data"), hasInlineFallback: true, note: "object resource not fetched; only fallback content is extracted" });
    } else if (name === "video" || name === "audio") {
      push({ kind: name, src: attr(tag, "src"), hasInlineFallback: false, note: `${name} track and captions not transcribed` });
    } else {
      push({ kind: "canvas", src: null, hasInlineFallback: false, note: "canvas drawing has no text alternative in static HTML" });
    }
  }

  if (/<svg[\s>][\s\S]*?<foreignObject[\s>]/i.test(text)) {
    push({ kind: "svg-foreign-object", src: null, hasInlineFallback: true, note: "SVG foreignObject content may not be extracted" });
  }

  for (const m of text.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const src = attr(m[0].slice(0, m[0].indexOf(">") + 1), "src");
    const body = m[2] ?? "";
    const type = attr(m[0].slice(0, m[0].indexOf(">") + 1), "type");
    if (type && /json|ld\+json|template|text\/plain/i.test(type)) continue;
    if (src) {
      push({ kind: "script-external", src, hasInlineFallback: false, note: "external script not executed; content it renders is not extracted" });
    } else if (RENDER_MARKERS.test(body)) {
      push({ kind: "script-rendered", src: null, hasInlineFallback: false, note: "inline script appears to render content at load time; not executed" });
    }
  }

  const counts: HtmlEmbedReport["counts"] = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  return { schemaVersion: "html-embeds@v1", items, counts, needsAttention: items.length > 0 };
}
