import { getArtifactText, parseArtifactUri } from "../lib/artifacts.js";

export type ArtifactPreviewKind = "text" | "markdown" | "html" | "json";

export interface ArtifactPreviewPayload {
  uri: string;
  kind: ArtifactPreviewKind;
  contentType: string;
  content: string;
  truncated: boolean;
}

const MAX_PREVIEW_CHARS = 200_000;

function stripDangerousBlocks(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[\s\S]*?>/gi, "")
    .replace(/<form\b[\s\S]*?<\/form>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "");
}

function stripDangerousAttributes(html: string): string {
  return html
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/\s(href|src)\s*=\s*"(?!(#|data:image\/))[^"]*"/gi, ' $1="#"')
    .replace(/\s(href|src)\s*=\s*'(?!(#|data:image\/))[^']*'/gi, " $1='#'")
    .replace(/\s(href|src)\s*=\s*(?![#]|data:image\/)[^\s>]+/gi, ' $1="#"')
    .replace(/javascript:/gi, "")
    .replace(/vbscript:/gi, "");
}

export function sanitizeArtifactHtml(html: string): string {
  return stripDangerousAttributes(stripDangerousBlocks(html));
}

export function wrapSanitizedHtmlDocument(html: string): string {
  const safeBody = sanitizeArtifactHtml(html);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, system-ui, sans-serif;
      }
      body {
        margin: 0;
        padding: 16px;
        color: #111827;
        background: #ffffff;
        line-height: 1.6;
        overflow-wrap: anywhere;
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      img {
        max-width: 100%;
        height: auto;
      }
      table {
        border-collapse: collapse;
        width: 100%;
      }
      th, td {
        border: 1px solid #d1d5db;
        padding: 6px 8px;
        text-align: left;
        vertical-align: top;
      }
      a {
        color: #2563eb;
        text-decoration: underline;
        pointer-events: none;
      }
    </style>
  </head>
  <body>${safeBody}</body>
</html>`;
}

export function trimPreview(content: string, maxChars = MAX_PREVIEW_CHARS): { content: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }

  return {
    content: `${content.slice(0, maxChars)}\n\n[preview truncated]`,
    truncated: true
  };
}

export async function buildArtifactPreview(uri: string, kind: ArtifactPreviewKind): Promise<ArtifactPreviewPayload> {
  if (!parseArtifactUri(uri)) {
    throw new Error("unsupported artifact uri");
  }

  const raw = await getArtifactText(uri, 4 * 1024 * 1024);

  if (kind === "html") {
    const trimmed = trimPreview(raw);
    return {
      uri,
      kind,
      contentType: "text/html",
      content: wrapSanitizedHtmlDocument(trimmed.content),
      truncated: trimmed.truncated
    };
  }

  if (kind === "json") {
    const parsed = JSON.parse(raw) as unknown;
    const trimmed = trimPreview(JSON.stringify(parsed, null, 2));
    return {
      uri,
      kind,
      contentType: "application/json",
      content: trimmed.content,
      truncated: trimmed.truncated
    };
  }

  const trimmed = trimPreview(raw);
  return {
    uri,
    kind,
    contentType: kind === "markdown" ? "text/markdown" : "text/plain",
    content: trimmed.content,
    truncated: trimmed.truncated
  };
}
