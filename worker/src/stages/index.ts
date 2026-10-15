import type { CapacityLeaseStore } from "../media/capacity/types.js";
import type { MediaJournal } from "../media/types.js";
import { pipelineStageOrder, type PipelineRunStage } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { Stage } from "../pipeline/pipeline.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { PdfRasterCache, PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { EmbedStage } from "./embed.js";
import { ExtractHtmlStage } from "./extract-html.js";
import { ExtractMarkdownStage } from "./extract-markdown.js";
import { FormatDetectStage } from "./format-detect.js";
import { IndexStage } from "./index-vectors.js";
import { NormalizeStage } from "./normalize.js";
import { PdfToolingStage } from "./pdf-tooling.js";
import { RenderImagesStage } from "./render-images.js";
import { ClassifyRouteStage } from "./classify-route.js";
import { RoutePagesStage } from "./route-pages.js";
import { SplitPagesStage } from "./split-pages.js";
import { FormatToolingStage } from "./format-tooling.js";
import { ToCanonicalStage } from "./to-canonical.js";
import { StructuredExtractStage } from "./structured-extract.js";
import { VisionExtractStage } from "./vision-extract.js";
import { PageIndexStage } from "./page-index.js";
import { DocumentSummaryStage } from "./document-summary.js";
import { PropositionIndexStage } from "./proposition-index.js";
import { QuarantineStage } from "./quarantine.js";
import { GraphEnrichStage } from "./graph-enrich.js";
import { PiiDetectStage } from "./pii-detect.js";

export function createStages(args: {
  runner: CommandRunner;
  storage: ArtifactStore;
  config: Config;
  mediaJournal?: MediaJournal;
  capacityStore?: CapacityLeaseStore;
}): Stage[] {
  const sourceCache = new PdfSourceCache(args.storage);
  const rasterCache = new PdfRasterCache(args.runner, args.storage, sourceCache);
  const stages: Record<PipelineRunStage, () => Stage> = {
    quarantine: () => new QuarantineStage(args.runner, args.storage, args.config),
    "format-detect": () => new FormatDetectStage(args.storage),
    "to-canonical": () => new ToCanonicalStage(args.runner, args.storage),
    "format-tooling": () => new FormatToolingStage(args.runner, args.storage),
    normalize: () => new NormalizeStage(args.runner),
    "pdf-tooling": () => new PdfToolingStage(args.runner, args.storage),
    "split-pages": () => new SplitPagesStage(sourceCache, args.storage),
    "render-images": () => new RenderImagesStage(rasterCache, args.storage, args.config),
    // Classify after initial canonical/format prep so downstream stages can honor playbook overrides.
    "classify-route": () => new ClassifyRouteStage(args.storage),
    "route-pages": () => new RoutePagesStage(args.storage, args.config, sourceCache, args.runner),
    "extract-markdown": () => new ExtractMarkdownStage(args.runner, args.storage, args.config, sourceCache, args.mediaJournal, args.capacityStore),
    "extract-html": () => new ExtractHtmlStage(args.runner, args.storage, sourceCache),
    "pii-detect": () => new PiiDetectStage(args.runner, args.storage, args.config),
    "vision-extract": () => new VisionExtractStage(args.runner, args.storage, args.config, rasterCache),
    "document-summary": () => new DocumentSummaryStage(args.runner, args.storage, args.config),
    "structured-extract": () => new StructuredExtractStage(args.storage, args.config),
    embed: () => new EmbedStage(args.runner, args.storage, args.config),
    "graph-enrich": () => new GraphEnrichStage(args.runner, args.storage, args.config),
    "page-index": () => new PageIndexStage(args.runner, args.storage),
    "proposition-index": () => new PropositionIndexStage(args.runner, args.storage, args.config),
    index: () => new IndexStage(args.runner, args.storage, args.config)
  };

  return pipelineStageOrder.map((stage) => stages[stage]());
}
