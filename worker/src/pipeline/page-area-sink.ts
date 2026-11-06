import type { PageEquivalentRow } from "../db/page-equivalents.js";

/**
 * Where rendered page areas go (pdf-asset-cache.ts): set once per worker process to the database writer (stages/index.ts), so
 * every raster cache instance, whichever stage built it, records the area equivalents of the pages it renders. Unset in tests
 * and tools without a database; then nothing is recorded.
 */
type PageAreaSink = (args: { runId: string; documentId: string; rows: PageEquivalentRow[] }) => Promise<unknown>;
let sink: PageAreaSink | null = null;

export function configurePageAreaSink(next: PageAreaSink | null): void {
  sink = next;
}

/** Record rendered pages that measured above one standard page; fails loudly so a retry records them. */
export async function recordRenderedPageAreas(runId: string | undefined, documentId: string, rows: PageEquivalentRow[]): Promise<void> {
  const above = rows.filter((row) => (row.area ?? 1) > 1);
  if (!sink || !runId || above.length === 0) return;
  await sink({ runId, documentId, rows: above });
}
