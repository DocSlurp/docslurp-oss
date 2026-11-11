/** `ExtractionContract.charts[]` entries from exported visuals. */
import type { ExportedVisual, ExtractionChart } from "@docslurp/shared";

export function toExtractionCharts(visuals: readonly ExportedVisual[], documentId: string): ExtractionChart[] {
  return visuals.map((visual) => ({
    id: `chart-${visual.id}`,
    // No stored image of its own: the artifact holding every exported visual of the document, by id.
    path: `chart-export/${documentId}.json#${visual.id}`,
    description: visual.outputs.description ?? visual.spec?.summary ?? null,
    data: {
      kind: visual.kind,
      source: visual.source,
      confidence: visual.confidence,
      imageIndex: visual.imageIndex,
      spec: visual.spec,
      outputs: visual.outputs,
      model: visual.model,
      skipped: visual.skipped,
    },
    pageNumber: visual.pageNumber,
    bbox: null,
  }));
}
