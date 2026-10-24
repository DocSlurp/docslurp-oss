import type { DocumentArtifactEntry } from './document.js';

type ImageManifestPage = {
  pageNumber: number;
  filename: string;
  widthPoints: number | null;
  heightPoints: number | null;
  widthPx: number | null;
  heightPx: number | null;
};

export type ImageManifestRecord = {
  render?: {
    dpi?: number;
    sourceCoordinateSpace?: string;
    imageCoordinateSpace?: string;
    pages?: ImageManifestPage[];
  };
};

export type DocumentPreviewPage = {
  id: string; imageUrl: string; pageNumber: number | null; label: string;
  detail: string | null; widthPx: number | null; heightPx: number | null;
};

function isImageArtifact(artifact: DocumentArtifactEntry) {
  const lowered = artifact.slot.toLowerCase();
  return (
    artifact.url.endsWith('.png') ||
    artifact.url.endsWith('.jpg') ||
    artifact.url.endsWith('.jpeg') ||
    artifact.url.endsWith('.webp') ||
    /(?:page|p)[-_:\s]?\d{1,5}/i.test(lowered)
  );
}

function inferArtifactPageNumber(artifact: DocumentArtifactEntry) {
  const candidates = [artifact.slot, artifact.uri, artifact.url].join(' ');
  const match =
    candidates.match(/(?:page|p)[-_:\s]?(\d{1,5})\.(?:png|jpg|jpeg|webp)/i) ??
    candidates.match(/(?:page|p)[-_:\s]?(\d{1,5})/i);

  if (!match) {
    return null;
  }

  const page = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(page) && page > 0 ? page : null;
}

export function buildDocumentPreviewPages(args: {
  artifacts: DocumentArtifactEntry[];
  documentId: string;
  manifest: ImageManifestRecord | null;
}): DocumentPreviewPage[] {
  const { artifacts, documentId, manifest } = args;
  const imageArtifacts = artifacts
    .filter(artifact => !/:raster-v\d+-/.test(artifact.slot))
    .filter((artifact) => artifact.slot.startsWith(`${documentId}:`) || /^(?:page|p)[-_:\s]?\d/i.test(artifact.slot))
    .filter((artifact) => isImageArtifact(artifact))
    .map((artifact) => ({
      artifact,
      pageNumber: inferArtifactPageNumber(artifact)
    }))
    .sort((left, right) => {
      if (left.pageNumber !== null && right.pageNumber !== null) {
        return left.pageNumber - right.pageNumber;
      }
      if (left.pageNumber !== null) {
        return -1;
      }
      if (right.pageNumber !== null) {
        return 1;
      }
      return left.artifact.slot.localeCompare(right.artifact.slot);
    });

  if (imageArtifacts.length === 0) {
    return [];
  }

  const manifestPages = manifest?.render?.pages ?? [];
  const pagesByNumber = new Map(
    imageArtifacts
      .filter((entry) => entry.pageNumber !== null)
      .map((entry) => [entry.pageNumber as number, entry])
  );
  const usedUris = new Set<string>();
  const previewPages: DocumentPreviewPage[] = [];

  for (const manifestPage of manifestPages) {
    const match = pagesByNumber.get(manifestPage.pageNumber);
    if (!match || usedUris.has(match.artifact.uri)) {
      continue;
    }

    usedUris.add(match.artifact.uri);
    previewPages.push({
      id: `${match.artifact.uri}:${manifestPage.pageNumber}`,
      imageUrl: match.artifact.url,
      pageNumber: manifestPage.pageNumber,
      label: `Page ${manifestPage.pageNumber}`,
      detail:
        manifestPage.widthPx && manifestPage.heightPx
          ? `${manifestPage.widthPx}x${manifestPage.heightPx}px`
          : manifest?.render?.dpi
            ? `${manifest.render.dpi} DPI render`
            : 'Rendered page image',
      widthPx: manifestPage.widthPx,
      heightPx: manifestPage.heightPx
    });
  }

  imageArtifacts.forEach(({ artifact, pageNumber }, index) => {
    if (usedUris.has(artifact.uri)) {
      return;
    }

    const manifestPage = manifestPages.find((page) => page.pageNumber === pageNumber) ?? null;
    usedUris.add(artifact.uri);
    previewPages.push({
      id: artifact.uri,
      imageUrl: artifact.url,
      pageNumber,
      label: pageNumber ? `Page ${pageNumber}` : `Rendered page ${index + 1}`,
      detail:
        manifestPage?.widthPx && manifestPage.heightPx
          ? `${manifestPage.widthPx}x${manifestPage.heightPx}px`
          : manifest?.render?.dpi
            ? `${manifest.render.dpi} DPI render`
            : 'Rendered page image',
      widthPx: manifestPage?.widthPx ?? null,
      heightPx: manifestPage?.heightPx ?? null
    });
  });

  return previewPages;
}

