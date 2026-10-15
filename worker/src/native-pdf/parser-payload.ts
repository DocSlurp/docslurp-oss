import { groupLines } from "./assemble.js";
import type { NativePdfDocument } from "./types.js";

/**
 * Block/line/span payload for the parser artifact, in the same shape the
 * canonical-document aligner reads from `get_text("dict")`-style JSON, built
 * in-process so no Python runtime is needed.
 */
export async function buildNativeParserPayload(doc: NativePdfDocument, signal?: AbortSignal): Promise<{ engine: string; pages: unknown[] }> {
  const count = await doc.pageCount();
  const pages: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    if (signal?.aborted) throw new Error("aborted");
    const page = doc.page(index);
    const [spans, size] = await Promise.all([page.spans().catch(() => []), page.size().catch(() => null)]);
    const lines = groupLines(spans);
    const blocks: Array<{ type: 0; bbox: [number, number, number, number]; lines: unknown[] }> = [];
    let current: typeof lines = [];
    const flush = () => {
      if (current.length === 0) return;
      blocks.push({
        type: 0,
        bbox: [
          Math.min(...current.map((l) => l.x0)), Math.min(...current.map((l) => l.y0)),
          Math.max(...current.map((l) => l.x1)), Math.max(...current.map((l) => l.y1)),
        ],
        lines: current.map((line) => ({
          bbox: [line.x0, line.y0, line.x1, line.y1],
          spans: line.spans.map((span) => ({ text: span.text, size: span.size, font: span.font, bbox: span.bbox })),
        })),
      });
      current = [];
    };
    for (const line of lines) {
      const prev = current[current.length - 1];
      const size0 = line.spans[0]?.size ?? 10;
      if (prev && line.y0 - prev.y1 > size0 * 0.8) flush();
      current.push(line);
    }
    flush();
    pages.push({ number: index + 1, width: size?.widthPt, height: size?.heightPt, blocks });
  }
  return { engine: "native-pdf", pages };
}
