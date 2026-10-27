// Turn a dataset manifest entry into split-pure dataset specs: `{ name, split, items, sourceHashes, datasetMetadata }`.
// Every adapter is data-driven: files and label fields come from the manifest, never from benchmark-specific code.
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { buildItems, buildRecordItems, datasetNameFor, hash, isHeldoutSplit, itemId } from "./langfuse.mjs";

export const DEFAULT_INLINE_REFERENCE_MAX_BYTES = 256 * 1024;
const at = (base, path) => (isAbsolute(path) ? path : resolve(base, path));
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const readJsonl = async (path) => (await readFile(path, "utf8")).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
const groupBy = (values, key) => values.reduce((groups, value) => groups.set(key(value), [...(groups.get(key(value)) ?? []), value]), new Map());

function requireLicense(spec) {
  if (typeof spec.license !== "string" || !spec.license.trim()) throw new Error(`Dataset ${spec.name ?? spec.prefix}: record its license or authorisation basis in "license"`);
}

/** File reference with verified hash. Inline the content up to the limit; above it keep a pointer and say so. */
async function referenceFor(root, ref, maxBytes) {
  if (!ref) return null;
  const path = typeof ref === "string" ? ref : ref.path;
  const raw = await readFile(at(root, path));
  const sha256 = hash(raw);
  if (ref.sha256 && ref.sha256 !== sha256) throw new Error(`Reference hash mismatch for ${path}`);
  const out = { path, sha256, bytes: raw.length };
  if (raw.length > maxBytes) return { ...out, inline: false, reason: `exceeds inline limit ${maxBytes} bytes; resolve by path and sha256` };
  const text = raw.toString("utf8");
  const content = /\.json$/i.test(path) ? JSON.parse(text) : text;
  return { ...out, inline: true, content };
}

const ADAPTERS = {
  // Existing question/answer contract (retrieval-quality, multisearch, agent capabilities). One split per entry.
  async cases(spec, base, ctx) {
    const raw = await readFile(at(base, spec.cases), "utf8");
    const parsed = JSON.parse(raw);
    const goldRaw = spec.gold ? await readFile(at(base, spec.gold), "utf8") : null;
    const provenanceRaw = spec.provenance ? await readFile(at(base, spec.provenance), "utf8") : null;
    const sourceHashes = { cases: hash(raw), ...(goldRaw ? { gold: hash(goldRaw) } : {}), ...(provenanceRaw ? { provenance: hash(provenanceRaw) } : {}), ...(spec.source ? { source: hash(await readFile(at(base, spec.source))) } : {}) };
    const items = buildItems({ name: spec.name, split: spec.split, cases: Array.isArray(parsed) ? parsed : parsed.cases, gold: goldRaw ? JSON.parse(goldRaw) : null, provenance: provenanceRaw ? JSON.parse(provenanceRaw) : null, sourceHashes, commit: ctx.commit, config: ctx.config });
    return [{ name: spec.name, split: spec.split, items, sourceHashes }];
  },

  // extract-eval-catalog@v1 and math-fidelity-catalog@v1: `{ entries: [{ id, split, asset, reference, expect, ... }] }`.
  async catalog(spec, base, ctx) {
    const catalogPath = at(base, spec.catalog);
    const raw = await readFile(catalogPath, "utf8");
    const catalog = JSON.parse(raw);
    const root = dirname(catalogPath);
    const maxBytes = spec.inlineReferenceMaxBytes ?? DEFAULT_INLINE_REFERENCE_MAX_BYTES;
    const sourceHashes = { catalog: hash(raw) };
    const out = [];
    for (const [split, entries] of groupBy(catalog.entries, (entry) => entry.split)) {
      const records = [];
      for (const entry of entries) {
        const { id, split: _split, asset, reference, expect, ...rest } = entry;
        records.push({
          id, split,
          input: { caseId: id, corpus: spec.corpus ?? spec.prefix, asset: asset ?? null },
          expectedOutput: { reference: await referenceFor(root, reference, maxBytes), expect: expect ?? null },
          metadata: { catalogSchema: catalog.schema ?? null, catalogEntry: rest, license: entry.license ?? null, licenseBasis: spec.license },
        });
      }
      const name = datasetNameFor(spec.prefix, split);
      out.push({ name, split, items: buildRecordItems({ name, split, records, commit: ctx.commit, config: ctx.config }), sourceHashes });
    }
    return out;
  },

  // Layout-region JSONL: `{ id, split, image_path, width, height, regions, metadata }` per line.
  async "layout-jsonl"(spec, base, ctx) {
    const path = at(base, spec.manifest);
    const raw = await readFile(path, "utf8");
    const rows = await readJsonl(path);
    const root = dirname(path);
    const out = [];
    for (const [split, entries] of groupBy(rows, (row) => row.split)) {
      const records = [];
      for (const { id, split: _split, image_path: imagePath, regions, metadata, ...rest } of entries) {
        let image = { path: imagePath, sha256: null, bytes: null };
        if (spec.hashImages !== false) { const bytes = await readFile(at(root, imagePath)); image = { path: imagePath, sha256: hash(bytes), bytes: bytes.length }; }
        records.push({ id, split, input: { caseId: id, corpus: spec.corpus ?? spec.prefix, image, ...rest }, expectedOutput: { regions }, metadata: { rowMetadata: metadata ?? null, licenseBasis: spec.license } });
      }
      const name = datasetNameFor(spec.prefix, split);
      out.push({ name, split, items: buildRecordItems({ name, split, records, commit: ctx.commit, config: ctx.config }), sourceHashes: { manifest: hash(raw) } });
    }
    return out;
  },

  // Retrieval query sets with relevance judgements. `qrels` is `{ qrels: { queryId: { docId: grade } } }` or inline `row.qrels`.
  async queries(spec, base, ctx) {
    const path = at(base, spec.queries);
    const raw = await readFile(path, "utf8");
    const rows = /\.jsonl$/i.test(path) ? await readJsonl(path) : (([parsed]) => (Array.isArray(parsed) ? parsed : parsed.queries))([JSON.parse(raw)]);
    const qrelsRaw = spec.qrels ? await readFile(at(base, spec.qrels), "utf8") : null;
    const qrels = qrelsRaw ? (JSON.parse(qrelsRaw).qrels ?? JSON.parse(qrelsRaw)) : null;
    const sourceHashes = { queries: hash(raw), ...(qrelsRaw ? { qrels: hash(qrelsRaw) } : {}), ...(spec.corpusManifest ? { corpusManifest: hash(await readFile(at(base, spec.corpusManifest))) } : {}) };
    const out = [];
    for (const [split, entries] of groupBy(rows, (row) => spec.splitMap?.[row.split] ?? row.split ?? spec.split)) {
      if (!split) throw new Error(`Dataset ${spec.prefix}: queries carry no split; set "split" with its provenance`);
      const records = entries.map(({ id, text, qrels: inline, split: _split, ...rest }) => {
        const judgements = inline ?? qrels?.[id];
        if (spec.requireQrels !== false && !judgements) throw new Error(`Dataset ${spec.prefix}: query ${id} has no relevance judgements`);
        return { id, split, input: { caseId: id, query: text, ...rest }, expectedOutput: judgements ? { qrels: judgements } : null, metadata: { licenseBasis: spec.license, splitBasis: spec.splitBasis ?? "source rows" } };
      });
      const name = datasetNameFor(spec.prefix, split);
      out.push({ name, split, items: buildRecordItems({ name, split, records, commit: ctx.commit, config: ctx.config }), sourceHashes });
    }
    return out;
  },

  // A harness case list (one ID per line) over a catalog that is synced separately. Items point at the parent items
  // instead of duplicating labels; lists that span splits are partitioned so every dataset stays split-pure.
  async "case-list"(spec, base, ctx) {
    const listRaw = await readFile(at(base, spec.cases), "utf8");
    const catalogRaw = await readFile(at(base, spec.catalog), "utf8");
    const byId = new Map(JSON.parse(catalogRaw).entries.map((entry) => [entry.id, entry]));
    const ids = listRaw.split(/\s+/).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new Error(`Case list ${spec.cases} repeats an ID`);
    const out = [];
    for (const [split, members] of groupBy(ids, (id) => { const entry = byId.get(id); if (!entry) throw new Error(`Case ${id} missing from ${spec.catalog}`); return entry.split; })) {
      const parentDataset = datasetNameFor(spec.parentPrefix, split);
      const records = members.map((id) => ({ id, split, input: { caseId: id, parentDataset, parentItemId: itemId(parentDataset, id) }, expectedOutput: { reference: byId.get(id).reference ?? null }, metadata: { listFile: spec.cases, order: ids.indexOf(id), licenseBasis: spec.license } }));
      const name = datasetNameFor(spec.prefix, split);
      out.push({ name, split, items: buildRecordItems({ name, split, records, commit: ctx.commit, config: ctx.config }), sourceHashes: { list: hash(listRaw), catalog: hash(catalogRaw) } });
    }
    return out;
  },
};

export const ADAPTER_KINDS = Object.freeze([...Object.keys(ADAPTERS), "mirror"]);

/** Load every dataset in a manifest. Mirrors are returned unresolved; sync.mjs reads them from their source target. */
export async function loadManifest(manifestPath, { commit, onlyDatasets } = {}) {
  const manifest = await readJson(manifestPath);
  const base = dirname(resolve(manifestPath));
  const auth = manifest.authorization;
  if (!auth || !Array.isArray(auth.destinations) || !auth.destinations.length || !auth.scope) throw new Error(`${manifestPath}: authorization.destinations and authorization.scope are required`);
  const ctx = { commit: manifest.sourceCommit ?? commit, config: manifest.config ?? {} };
  if (!ctx.commit) throw new Error(`${manifestPath}: sourceCommit unknown`);
  const datasets = [];
  for (const spec of manifest.datasets) {
    const kind = spec.kind ?? "cases";
    requireLicense(spec);
    const datasetMetadata = { kind, license: spec.license, family: spec.family ?? null, authorization: auth, ...(spec.metadata ?? {}) };
    if (kind === "mirror") {
      isHeldoutSplit(spec.split);
      datasets.push({ name: spec.name, split: spec.split, mirror: { fromTarget: spec.fromTarget }, datasetMetadata, sourceHashes: null, commit: ctx.commit });
      continue;
    }
    const adapter = ADAPTERS[kind];
    if (!adapter) throw new Error(`Unknown dataset kind ${kind}`);
    for (const loaded of await adapter(spec, base, ctx)) {
      if (onlyDatasets && !onlyDatasets.some((pattern) => loaded.name.includes(pattern))) continue;
      datasets.push({ ...loaded, commit: ctx.commit, datasetMetadata, heldout: isHeldoutSplit(loaded.split) });
    }
  }
  const names = datasets.map((dataset) => dataset.name);
  if (new Set(names).size !== names.length) throw new Error(`${manifestPath}: two manifest entries produce the same dataset name`);
  return { manifestPath, authorization: auth, commit: ctx.commit, datasets };
}

