/*
 * Legacy extractor-id aliases: a deployment that renames an extractor keeps stored and in-flight configs that name the
 * old id working, without a data rewrite between deploys.
 *
 * - Configured only, never built in: `DOCSLURP_EXTRACTOR_ID_ALIASES=<old>:<new>[,<old>:<new>]`, set on the API and the
 *   worker before the renamed extractor ships. Each process validates the list against the extractors it actually
 *   serves at startup and refuses to start on any problem (parseExtractorIdAliases).
 * - Fail closed: an alias maps to a known, served id; it never names a built-in id itself (no shadowing), never maps
 *   to another alias (no chains) and never maps an id to itself. Unknown ids are left as they are, so they still fail
 *   validation wherever they did before.
 * - One rewrite rule (normalizeDocumentExtractionAliases): every place a `documentExtraction` config names an extractor
 *   (order lists, components, pages, enrich, voting.secondary and options keys). Parsing applies it to incoming and
 *   stored configs alike, so new writes carry the canonical id.
 * - Retired extractors (RETIRED_EXTRACTOR_IDS) are built in, not configured: they were removed from every image, and
 *   their formats moved to other extractors per format, so no single alias target exists. Parsing drops them
 *   (dropRetiredExtractorIds): an order left empty falls back to the deployment's default order for that format
 *   (which is the sandboxed PDF route where one is configured), a retired voting secondary becomes next-in-order and
 *   retired options are removed. Any other unknown id is left as it is, so it still fails validation.
 */
import { builtInDocumentExtractorDescriptors } from "./extractors.js";

export const EXTRACTOR_ID_ALIASES_ENV = "DOCSLURP_EXTRACTOR_ID_ALIASES";

const EXTRACTOR_ID = /^[a-z][a-z0-9-]{1,63}$/;
const MAX_ALIASES = 16;

/**
 * Extractor ids that no longer exist. Both native addons statically linked an OCR engine into the worker process; their
 * formats are read by Pandoc, the python-pptx / openpyxl sidecars, the PDF extractors and the `ocr` extractor.
 */
export const RETIRED_EXTRACTOR_IDS: ReadonlySet<string> = new Set(["kreuzberg", "liteparse"]);

const builtInIds = (): ReadonlySet<string> => new Set(builtInDocumentExtractorDescriptors.map((entry) => entry.id));

/**
 * Parse `<old>:<new>[,<old>:<new>]` against the ids this process serves. Throws on any malformed, shadowing, chained,
 * duplicate or unknown entry; an empty value is no aliases.
 */
export function parseExtractorIdAliases(raw: string | undefined, servedIds: Iterable<string>): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  const text = raw?.trim() ?? "";
  if (!text) return aliases;
  const served = new Set(servedIds);
  const builtIn = builtInIds();
  const entries = text.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > MAX_ALIASES) throw new Error(`${EXTRACTOR_ID_ALIASES_ENV} allows at most ${MAX_ALIASES} aliases`);
  for (const entry of entries) {
    const parts = entry.split(":").map((part) => part.trim());
    const [from, to] = parts;
    if (parts.length !== 2 || !from || !to || !EXTRACTOR_ID.test(from) || !EXTRACTOR_ID.test(to)) {
      throw new Error(`${EXTRACTOR_ID_ALIASES_ENV} entries must be <old-id>:<new-id> with lowercase ids: ${JSON.stringify(entry)}`);
    }
    if (from === to) throw new Error(`${EXTRACTOR_ID_ALIASES_ENV} maps ${from} to itself`);
    if (builtIn.has(from) || served.has(from)) throw new Error(`${EXTRACTOR_ID_ALIASES_ENV} may not override the extractor id ${from}`);
    if (RETIRED_EXTRACTOR_IDS.has(from)) throw new Error(`${EXTRACTOR_ID_ALIASES_ENV} may not alias the retired extractor id ${from}; it is replaced per format`);
    if (aliases.has(from)) throw new Error(`${EXTRACTOR_ID_ALIASES_ENV} names ${from} twice`);
    if (!builtIn.has(to) || !served.has(to)) throw new Error(`${EXTRACTOR_ID_ALIASES_ENV} maps ${from} to ${to}, which this process does not serve`);
    aliases.set(from, to);
  }
  for (const [from, to] of aliases) if (aliases.has(to)) throw new Error(`${EXTRACTOR_ID_ALIASES_ENV} chains ${from} -> ${to} -> ${aliases.get(to)}`);
  return aliases;
}

let installed: ReadonlyMap<string, string> = new Map();

/**
 * Make `aliases` the process-wide rewrite used by parsing. Re-checks the built-in rules, so a hand-built map cannot
 * shadow or chain either; validate against served ids with parseExtractorIdAliases first.
 */
export function installExtractorIdAliases(aliases: ReadonlyMap<string, string>): void {
  const builtIn = builtInIds();
  for (const [from, to] of aliases) {
    if (!EXTRACTOR_ID.test(from) || builtIn.has(from) || RETIRED_EXTRACTOR_IDS.has(from) || from === to) throw new Error(`extractor id alias ${from} is not allowed`);
    if (!builtIn.has(to) || aliases.has(to)) throw new Error(`extractor id alias ${from} -> ${to} has no built-in target`);
  }
  installed = new Map(aliases);
}

/**
 * Read DOCSLURP_EXTRACTOR_ID_ALIASES, validate it against the ids this process serves and install it. Call once at
 * startup, before any config is parsed; throws so a misconfigured process does not start.
 */
export function configureExtractorIdAliases(servedIds: Iterable<string>, env: Record<string, string | undefined> = process.env): ReadonlyMap<string, string> {
  const aliases = parseExtractorIdAliases(env[EXTRACTOR_ID_ALIASES_ENV], servedIds);
  installExtractorIdAliases(aliases);
  if (aliases.size) console.log(`[extractor-aliases] ${[...aliases].map(([from, to]) => `${from}->${to}`).join(",")}`);
  return aliases;
}

export function extractorIdAliases(): ReadonlyMap<string, string> {
  return installed;
}

/** The canonical id for `id`: its alias target, or `id` itself. */
export function canonicalExtractorId(id: string): string {
  return installed.get(id) ?? id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `value` (a `documentExtraction` config, stored or incoming) with every aliased extractor id replaced by its target.
 * Returns `value` itself when nothing names an alias. When `options` holds both an alias and its target, the alias key
 * is left in place, so strict parsing rejects the request and stored reads drop it loudly: two option sets are never
 * merged by guessing.
 */
export function normalizeDocumentExtractionAliases(value: unknown): unknown {
  return applyConfiguredAliases(dropRetiredExtractorIds(value).value);
}

/**
 * `value` (a `documentExtraction` config) without retired extractor ids, and the paths that named one. Order lists
 * lose the retired ids; a list left empty is removed, so the format uses the deployment's default order. Component,
 * page and enrich lists lose them; a retired voting secondary becomes `next-in-order`; retired option keys are
 * removed. Returns `value` itself when nothing names a retired id.
 */
export function dropRetiredExtractorIds(value: unknown): { value: unknown; dropped: string[] } {
  if (!isRecord(value)) return { value, dropped: [] };
  const dropped: string[] = [];
  const keep = (list: unknown, path: string): unknown => {
    if (!Array.isArray(list) || !list.some((id) => typeof id === "string" && RETIRED_EXTRACTOR_IDS.has(id))) return list;
    for (const id of list) if (typeof id === "string" && RETIRED_EXTRACTOR_IDS.has(id)) dropped.push(`${path}:${id}`);
    return list.filter((id) => !(typeof id === "string" && RETIRED_EXTRACTOR_IDS.has(id)));
  };
  const next: Record<string, unknown> = { ...value };
  if (isRecord(value.order)) {
    const order: Record<string, unknown> = {};
    for (const [format, list] of Object.entries(value.order)) {
      const kept = keep(list, `order.${format}`);
      if (Array.isArray(kept) && kept.length === 0 && Array.isArray(list) && list.length > 0) continue;
      order[format] = kept;
    }
    next.order = order;
  }
  if (isRecord(value.components)) {
    next.components = Object.fromEntries(Object.entries(value.components).map(([kind, list]) => [kind, keep(list, `components.${kind}`)]));
  }
  if ("pages" in value) next.pages = keep(value.pages, "pages");
  if ("enrich" in value) next.enrich = keep(value.enrich, "enrich");
  if (isRecord(value.voting) && typeof value.voting.secondary === "string" && RETIRED_EXTRACTOR_IDS.has(value.voting.secondary)) {
    dropped.push(`voting.secondary:${value.voting.secondary}`);
    next.voting = { ...value.voting, secondary: "next-in-order" };
  }
  if (isRecord(value.options) && Object.keys(value.options).some((key) => RETIRED_EXTRACTOR_IDS.has(key))) {
    // Object.fromEntries keeps a hostile `__proto__` key as an own property, so strict parsing still sees and rejects it.
    for (const key of Object.keys(value.options)) if (RETIRED_EXTRACTOR_IDS.has(key)) dropped.push(`options.${key}`);
    next.options = Object.fromEntries(Object.entries(value.options).filter(([key]) => !RETIRED_EXTRACTOR_IDS.has(key)));
  }
  return dropped.length > 0 ? { value: next, dropped } : { value, dropped };
}

function applyConfiguredAliases(value: unknown): unknown {
  if (installed.size === 0 || !isRecord(value)) return value;
  let changed = false;
  const ids = (list: unknown): unknown => {
    if (!Array.isArray(list)) return list;
    if (!list.some((id) => typeof id === "string" && installed.has(id))) return list;
    changed = true;
    // Dedupe in order: [old, new] must not try the same extractor twice.
    return [...new Set(list.map((id) => (typeof id === "string" ? canonicalExtractorId(id) : id)))];
  };
  const next: Record<string, unknown> = { ...value };
  if (isRecord(value.order)) next.order = Object.fromEntries(Object.entries(value.order).map(([format, list]) => [format, ids(list)]));
  if (isRecord(value.components)) next.components = Object.fromEntries(Object.entries(value.components).map(([kind, list]) => [kind, ids(list)]));
  next.pages = ids(value.pages);
  next.enrich = ids(value.enrich);
  if (!("pages" in value)) delete next.pages;
  if (!("enrich" in value)) delete next.enrich;
  if (isRecord(value.voting) && typeof value.voting.secondary === "string" && installed.has(value.voting.secondary)) {
    next.voting = { ...value.voting, secondary: canonicalExtractorId(value.voting.secondary) };
    changed = true;
  }
  if (isRecord(value.options)) {
    const options = Object.entries(value.options).map(([key, option]): [string, unknown] => {
      const target = installed.get(key);
      if (target !== undefined && !Object.hasOwn(value.options as Record<string, unknown>, target)) {
        changed = true;
        return [target, option];
      }
      return [key, option];
    });
    // Object.fromEntries keeps a `__proto__` key as an own property (an assignment would set the prototype instead).
    next.options = Object.fromEntries(options);
  }
  return changed ? next : value;
}

/** Test hook. */
export function resetExtractorIdAliasesForTest(): void {
  installed = new Map();
}
