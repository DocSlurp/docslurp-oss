/*
 * Embedded images in a document export, laid out so the Markdown can be stitched back together:
 *
 *   images/page-0001/image-001.webp        occurrence 0 on page 1 (numbering is the media map's occurrence + 1)
 *   images/page-0001/image-001.smask.webp  its soft mask, beside the image it masks (suffix = mask role)
 *   images/index.json                      the media map with each occurrence's export path
 *
 * Paths are derived from (page, occurrence), so they are collision-free, ordered and the same on every re-export.
 * An asset drawn several times is stored once, at its first occurrence; later occurrences point at that file.
 * Only the document's own artifact slots are read: an image URI that the artifact-graph manifest names but the
 * document's run does not record is never opened, and a URI the PII policy withholds is never exported.
 */
import { mediaMapSchema, parseImageAnchorLine, type MediaMapImage } from "@docslurp/shared";

export const EXPORT_IMAGE_INDEX_VERSION = "docslurp-export-images@1";
/** Manifests and media maps read for an export are capped; a larger one ships no embedded images. */
export const EXPORT_IMAGE_METADATA_MAX_BYTES = 16 * 1024 * 1024;

export interface ExportImageArtifact { uri: string; key: string }

export interface ExportImage {
  pageNumber: number;
  occurrence: number;
  role: MediaMapImage["role"];
  maskOf?: { pageNumber: number; occurrence: number };
  artifactId: string;
  /** Storage key to read, or null when the image cannot be exported. */
  key: string | null;
  /** Path inside the document folder this occurrence links to. */
  path: string;
  /** True for the occurrence that owns the file; repeats link to the owner's path. */
  owner: boolean;
  /** Why the file is not in the export, when it is not. */
  unavailable?: string;
  /** The media-map entry, when the images came from a media map. */
  entry?: MediaMapImage;
}

export interface ExportImagePlan {
  source: "media-map" | "artifacts";
  pageCount: number | null;
  mediaMap: { version: string; encoding: string; placementSource: string; coordinateSpace: string } | null;
  images: ExportImage[];
}

const PII_REASON = "withheld by the workspace's privacy (PII) policy";

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function extension(mediaType: string | undefined, uri: string): string {
  if (mediaType === "image/webp") return ".webp";
  if (mediaType === "image/png") return ".png";
  const match = /\.([a-z0-9]{1,8})$/i.exec(uri.split("?")[0] ?? "");
  return match ? `.${match[1]!.toLowerCase()}` : ".bin";
}

/** The export path of one occurrence: masks sit beside the image they mask, named by their role. */
export function exportImagePath(image: { pageNumber: number; occurrence: number; role: string; maskOf?: { occurrence: number } }, ext: string): string {
  const base = image.role === "image" ? image.occurrence : image.maskOf?.occurrence ?? image.occurrence;
  const suffix = image.role === "image" ? "" : `.${image.role}`;
  return `images/page-${pad(image.pageNumber, 4)}/image-${pad(base + 1, 3)}${suffix}${ext}`;
}

type Manifest = { artifacts?: Array<{ id?: unknown; kind?: unknown; uri?: unknown; mediaType?: unknown; placements?: Array<{ pageNumber?: unknown }> }> };

/**
 * Plan a document's embedded images from its artifact-graph manifest: the media map when there is one, else the
 * embedded-image artifacts in manifest order. `allowed` maps the document's own (not withheld) slot URIs to keys;
 * `withheld` holds the URIs the PII policy withholds.
 */
export async function planExportImages(args: {
  manifest: Manifest | null;
  allowed: ReadonlyMap<string, string>;
  withheld: ReadonlySet<string>;
  readJson: (key: string) => Promise<unknown>;
  includeAll: boolean;
}): Promise<{ plan: ExportImagePlan | null; problem?: string }> {
  const artifacts = Array.isArray(args.manifest?.artifacts) ? args.manifest!.artifacts! : [];
  const byId = new Map<string, { uri: string; kind: string; mediaType?: string; pageNumber?: number }>();
  for (const artifact of artifacts) {
    if (typeof artifact?.id !== "string" || typeof artifact.uri !== "string" || typeof artifact.kind !== "string") continue;
    const page = artifact.placements?.[0]?.pageNumber;
    byId.set(artifact.id, { uri: artifact.uri, kind: artifact.kind, mediaType: typeof artifact.mediaType === "string" ? artifact.mediaType : undefined,
      pageNumber: typeof page === "number" && Number.isSafeInteger(page) && page > 0 ? page : undefined });
  }
  const resolve = (uri: string | undefined): { key: string | null; unavailable?: string } => {
    if (!uri) return { key: null, unavailable: "image artifact missing from the run" };
    if (args.withheld.has(uri)) return { key: null, unavailable: PII_REASON };
    const key = args.allowed.get(uri);
    return key ? { key } : { key: null, unavailable: "image artifact missing from the run" };
  };

  const mapArtifact = [...byId.values()].find((artifact) => artifact.kind === "document/media-map");
  if (mapArtifact) {
    const mapAccess = resolve(mapArtifact.uri);
    if (!mapAccess.key) return { plan: null, problem: mapAccess.unavailable === PII_REASON ? PII_REASON : "media map missing from the run" };
    let parsed: ReturnType<typeof mediaMapSchema.safeParse>;
    try {
      parsed = mediaMapSchema.safeParse(await args.readJson(mapAccess.key));
    } catch (error) {
      return { plan: null, problem: `media map unreadable: ${error instanceof Error ? error.message : "read failed"}` };
    }
    if (!parsed.success) return { plan: null, problem: "media map unreadable: not a supported media map" };
    const map = parsed.data;
    const sorted = [...map.images].sort((a, b) => a.pageNumber - b.pageNumber || a.occurrence - b.occurrence);
    // Markdown-only exports ship what the Markdown references, plus the masks of those images.
    const included = new Set(sorted.filter((entry) => entry.markdown.included).map((entry) => `${entry.pageNumber}:${entry.occurrence}`));
    const selected = args.includeAll ? sorted : sorted.filter((entry) =>
      included.has(`${entry.pageNumber}:${entry.occurrence}`) || (entry.maskOf && included.has(`${entry.maskOf.pageNumber}:${entry.maskOf.occurrence}`)));
    return { plan: { source: "media-map", pageCount: map.pageCount,
      mediaMap: { version: map.version, encoding: map.encoding, placementSource: map.placementSource, coordinateSpace: map.coordinateSpace },
      images: dedupe(selected.map((entry) => {
        const artifact = byId.get(entry.artifactId);
        const access = resolve(artifact?.uri);
        return { pageNumber: entry.pageNumber, occurrence: entry.occurrence, role: entry.role, ...(entry.maskOf ? { maskOf: entry.maskOf } : {}),
          artifactId: entry.artifactId, key: access.key, ...(access.unavailable ? { unavailable: access.unavailable } : {}),
          path: exportImagePath(entry, extension(entry.mediaType, artifact?.uri ?? "")), owner: true, entry };
      })) } };
  }

  // No media map: the graph's embedded-image artifacts, numbered per page in manifest order. Nothing references them.
  if (!args.includeAll) return { plan: null };
  const perPage = new Map<number, number>();
  const images: ExportImage[] = [];
  for (const [id, artifact] of byId) {
    if (artifact.kind !== "page/embedded-image" && artifact.kind !== "page/embedded-image-mask") continue;
    if (!artifact.pageNumber) continue;
    const occurrence = perPage.get(artifact.pageNumber) ?? 0;
    perPage.set(artifact.pageNumber, occurrence + 1);
    const role = artifact.kind === "page/embedded-image-mask" ? "mask" : "image";
    const access = resolve(artifact.uri);
    images.push({ pageNumber: artifact.pageNumber, occurrence, role, artifactId: id, key: access.key, ...(access.unavailable ? { unavailable: access.unavailable } : {}),
      path: exportImagePath({ pageNumber: artifact.pageNumber, occurrence, role }, extension(artifact.mediaType, artifact.uri)), owner: true });
  }
  return { plan: images.length ? { source: "artifacts", pageCount: null, mediaMap: null, images } : null };
}

/** One file per asset and kind (image or mask): the first occurrence in page order owns it. */
function dedupe(images: ExportImage[]): ExportImage[] {
  const owners = new Map<string, string>();
  return images.map((image) => {
    const id = `${image.artifactId}|${image.role === "image" ? "image" : "mask"}`;
    const owner = owners.get(id);
    if (owner === undefined) { owners.set(id, image.path); return image; }
    return { ...image, path: owner, owner: false };
  });
}

/** Unescape `\[`, `\]` and `\\` in alt text for plain-text output. */
function plainAlt(alt: string): string {
  return alt.replace(/\\([\\[\]])/g, "$1");
}

/**
 * Rewrite one Markdown line: an image reference becomes a relative link when its file is in the export, or its alt
 * text alone (an empty line when it has none) when it is not. Every other line is returned unchanged.
 */
export function rewriteImageLine(line: string, links: ReadonlyMap<string, string>, prefix: string): string {
  const anchor = parseImageAnchorLine(line);
  if (!anchor) return line;
  const target = links.get(`${anchor.anchor}|${anchor.artifactId}`);
  const alt = line.trim().slice(2, line.trim().lastIndexOf("](docslurp-artifact:"));
  return target ? `![${alt}](${prefix}${target})` : plainAlt(alt);
}

/** Lines end at `\n` or at a page's form feed; both separators are kept as they are. */
export function rewriteImageMarkdown(text: string, links: ReadonlyMap<string, string>, prefix: string): string {
  if (!text.includes("docslurp-artifact:")) return text;
  return text.split(/([\n\f])/).map((part) => (part === "\n" || part === "\f" ? part : rewriteImageLine(part, links, prefix))).join("");
}

/** Streams Markdown line by line through `rewriteImageLine`; lines are only ever split on `\n` or a form feed. */
export async function* rewriteImageMarkdownStream(stream: AsyncIterable<Uint8Array>, links: ReadonlyMap<string, string>, prefix: string): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const end = Math.max(pending.lastIndexOf("\n"), pending.lastIndexOf("\f"));
    if (end < 0) continue;
    yield encoder.encode(rewriteImageMarkdown(pending.slice(0, end + 1), links, prefix));
    pending = pending.slice(end + 1);
  }
  pending += decoder.decode();
  if (pending) yield encoder.encode(rewriteImageMarkdown(pending, links, prefix));
}

/** `images/index.json`: the media map entries with their export paths (null when the file is not in the export). */
export function exportImageIndex(args: { documentId: string; plan: ExportImagePlan; added: (path: string) => boolean; folder: string }): string {
  return `${JSON.stringify({
    version: EXPORT_IMAGE_INDEX_VERSION,
    documentId: args.documentId,
    source: args.plan.source,
    pageCount: args.plan.pageCount,
    mediaMap: args.plan.mediaMap,
    images: args.plan.images.map((image) => {
      const exported = image.key !== null && args.added(`${args.folder}/${image.path}`);
      const { entry } = image;
      return {
        pageNumber: image.pageNumber, occurrence: image.occurrence, role: image.role, ...(image.maskOf ? { maskOf: image.maskOf } : {}),
        anchor: `p${image.pageNumber}o${image.occurrence}`,
        path: exported ? image.path : null,
        ...(exported ? {} : { skipped: image.unavailable ?? "not included in this export" }),
        ...(entry ? {
          sha256: entry.sha256, mediaType: entry.mediaType, width: entry.width, height: entry.height,
          placement: entry.placement, alt: entry.alt, class: entry.class, route: entry.route, markdown: entry.markdown,
          ...(entry.orientation === undefined ? {} : { orientation: entry.orientation }),
        } : {}),
      };
    }),
  }, null, 2)}\n`;
}
