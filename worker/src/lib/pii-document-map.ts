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

type Sql = {
  <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  json: (value: unknown) => unknown;
};

/**
 * Scrub the stored titles and document map after a scan or a deferred match: one read of the document's titles and
 * map (primary keys); a write only when something changed. Every path that records a match calls it (pii-detect,
 * the document map and page materialization, through recordDeferredPiiMatch).
 */
export async function scrubTitlesAndMapForPii(sql: Sql, documentId: string, withheld: WithheldPagesForMap, matches: (text: string) => boolean): Promise<void> {
  const [row] = await sql<Array<{ title: string | null; title_source: string | null; map_title: string | null; nodes: unknown; terms: unknown; has_map: boolean }>>`
    select d.metadata->>'title' as title, d.metadata->>'titleSource' as title_source, d.metadata->>'mapTitle' as map_title,
           m.nodes, m.terms, m.document_id is not null as has_map
    from documents d left join document_maps m on m.document_id = d.id
    where d.id = ${documentId}
  `;
  if (!row) return;
  const clearTitle = documentTitleWithheld(row.title, row.title_source, withheld, matches);
  const map = scrubDocumentMap({
    nodes: Array.isArray(row.nodes) ? row.nodes as Array<{ title?: unknown; physicalStart?: unknown }> : [],
    terms: Array.isArray(row.terms) ? row.terms as Array<{ term?: unknown; physicalPages?: unknown }> : [],
    title: row.map_title,
  }, withheld, matches);
  if (clearTitle || map.title !== row.map_title) {
    const drop = [...(clearTitle ? ["title", "titleSource"] : []), ...(map.title !== row.map_title ? ["mapTitle"] : [])];
    await sql`update documents set metadata = coalesce(metadata, '{}'::jsonb) - ${drop}::text[] where id = ${documentId}`;
  }
  if (row.has_map && map.changed) {
    await sql`
      update document_maps set nodes = ${sql.json(map.nodes as never)}, terms = ${sql.json(map.terms as never)},
        search_text = to_tsvector('simple', ${map.searchText}), version = version + 1, updated_at = now()
      where document_id = ${documentId}
    `;
  }
}
