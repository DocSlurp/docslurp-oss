/**
 * Titles and the document map hold text from the pages they were built from, and they are built before the PII scan:
 * `metadata.title` (from the first pages), `metadata.mapTitle`, the map's node titles, its index terms and the
 * `search_text` built from both. Document lists, search results and the deferred locator show them. After a scan (or a
 * deferred match) they are scrubbed: anything that matches the policy, or that came from a withheld page, is dropped.
 */

/** Pages withheld (`"all"`: the whole document, or an unpaged section whose page is the only one). */
export type WithheldPagesForMap = ReadonlySet<number> | "all";

type MapNodeLike = { title?: unknown; physicalStart?: unknown };
type MapTermLike = { term?: unknown; physicalPages?: unknown };

const withheldPage = (withheld: WithheldPagesForMap, page: unknown) =>
  withheld === "all" || (typeof page === "number" && withheld.has(page));

/**
 * The map with nodes whose title matches or whose start page is withheld removed, terms that match removed, withheld
 * pages removed from every term (a term left with no page is removed), and the title cleared when it matches or its
 * page is withheld. `matches(text)` is the policy scanner.
 */
export function scrubDocumentMap<N extends MapNodeLike, T extends MapTermLike>(
  map: { nodes: readonly N[]; terms: readonly T[]; title: string | null },
  withheld: WithheldPagesForMap,
  matches: (text: string) => boolean,
): { nodes: N[]; terms: T[]; title: string | null; changed: boolean; searchText: string } {
  const nodes = Array.isArray(map.nodes) ? (map.nodes as N[]) : [];
  const terms = Array.isArray(map.terms) ? (map.terms as T[]) : [];
  const keptNodes = nodes.filter((node) => !(typeof node.title === "string" && matches(node.title)) && !withheldPage(withheld, node.physicalStart));
  const keptTerms = terms.flatMap((term): T[] => {
    if (typeof term.term === "string" && matches(term.term)) return [];
    if (!Array.isArray(term.physicalPages)) return withheld === "all" ? [] : [term];
    const pages = term.physicalPages.filter((page) => !withheldPage(withheld, page));
    if (pages.length === 0) return [];
    return [pages.length === term.physicalPages.length ? term : { ...term, physicalPages: pages }];
  });
  // The title came from the first outline entry, a TOC node or page 1's heading: its node's page, else page 1.
  const titleNode = map.title ? nodes.find((node) => node.title === map.title) : undefined;
  const titlePage = titleNode && typeof titleNode.physicalStart === "number" ? titleNode.physicalStart : 1;
  const title = map.title && (matches(map.title) || withheldPage(withheld, titlePage)) ? null : map.title;
  const changed = keptNodes.length !== nodes.length || keptTerms.length !== terms.length
    || keptTerms.some((term, index) => term !== terms[index]) || title !== map.title;
  return { nodes: keptNodes, terms: keptTerms, title, changed, searchText: mapSearchText(keptNodes, keptTerms) };
}

/** The map's `search_text` source, as the document map builds it: node titles, then terms. */
export function mapSearchText(nodes: readonly MapNodeLike[], terms: readonly MapTermLike[]): string {
  return [...nodes.map((node) => node.title), ...terms.map((term) => term.term)].filter((text) => typeof text === "string").join(" \n");
}

/**
 * Whether the document title derived from page text (`metadata.title`, from the first two pages) must be cleared: it
 * matches the policy, or its pages are withheld. A filename-derived title is the upload's name, not page text.
 */
export function documentTitleWithheld(
  title: unknown,
  titleSource: unknown,
  withheld: WithheldPagesForMap,
  matches: (text: string) => boolean,
): boolean {
  if (typeof title !== "string" || !title.trim()) return false;
  if (matches(title)) return true;
  if (titleSource === "filename") return false;
  return withheld === "all" || withheld.has(1) || withheld.has(2);
}
