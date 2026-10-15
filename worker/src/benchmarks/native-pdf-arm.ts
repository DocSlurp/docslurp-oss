import { extractNativePdf } from "../native-pdf/extract.js";
import { loadNativePdfEngine } from "../native-pdf/loader.js";

/**
 * Benchmark arm for the in-process native-pdf engine. Output guards are off so a benchmark scores what the engine
 * produced instead of the fallback verdict; `text` is the engine's plain text per page joined with form feeds.
 * Throws "native-pdf unavailable" when the private binding is not installed.
 */
export async function runNativePdfArm(sourcePath: string, kind: "markdown" | "text"): Promise<string> {
  const loaded = await loadNativePdfEngine();
  if (!loaded.ok) throw new Error(`native-pdf unavailable: ${loaded.reason}`);
  if (kind === "markdown") {
    const out = await extractNativePdf(loaded.engine, sourcePath, { minTextPageRatio: 0, rejectOnDropout: false, rerouteOnLayoutRisk: false });
    return out.markdown.replaceAll("\f", "\n\n");
  }
  const doc = await loaded.engine.openPath(sourcePath);
  try {
    const pages: string[] = [];
    for (let index = 0, count = await doc.pageCount(); index < count; index += 1) pages.push(await doc.page(index).text());
    return pages.join("\n\n");
  } finally {
    await doc.close().catch(() => undefined);
  }
}
