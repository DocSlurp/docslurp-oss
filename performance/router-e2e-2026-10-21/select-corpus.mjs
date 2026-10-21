// Deterministic development-split corpus for the end-to-end router benchmark.
// Orchestration only: selection is by split, format and catalog class, never by content.
// Usage: node select-corpus.mjs <evals-root> <repo-root> <output-dir>
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const [evals, repo, out] = process.argv.slice(2);
if (!evals || !repo || !out) throw new Error("usage: select-corpus.mjs <evals-root> <repo-root> <output-dir>");
mkdirSync(path.join(out, "files"), { recursive: true });

const entries = (dir) => {
  const raw = JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8"));
  return Array.isArray(raw) ? raw : raw.entries;
};
const dev = (dir) => entries(dir).filter((e) => e.split === "development").sort((a, b) => a.id.localeCompare(b.id));
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const pages = (file) => Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [file], { encoding: "utf8" }))?.[1] ?? 0);
const items = [];
const add = (source, id, file, meta) => {
  const ext = path.extname(file);
  const name = `${source}__${id}${ext}`;
  const target = path.join(out, "files", name);
  copyFileSync(file, target);
  items.push({ source, id, file: name, sha256: sha(target), pages: ext === ".pdf" ? pages(target) : 1, ...meta });
};

// 1. Routing suite v1, development split: every PDF except HTML and the 200-page sparse stress case.
const routing = path.join(evals, "routing-suite-v1");
for (const e of dev(routing)) {
  if (e.asset.format !== "pdf" || e.pages > 20) continue;
  add("routing-suite-v1", e.id, path.join(routing, e.asset.path), { kind: e.tags.includes("scan") ? "scan" : `tier-${e.tier}`, tier: e.tier, documentClass: e.documentClass, tags: e.tags, reference: path.join(routing, e.reference.path) });
}
// 2. Preservation suite v3, development split: all cases.
const preservation = path.join(evals, "preservation-suite-95-v3");
for (const e of dev(preservation)) {
  add("preservation-suite-95-v3", e.id, path.join(preservation, e.asset.path), { kind: e.tags.includes("raster-only") ? "raster-only" : "native-math", documentClass: e.documentClass, tags: e.tags, reference: e.reference ? path.join(preservation, e.reference.path) : null });
}
// 3. Repository PDF test fixtures.
const fixtures = path.join(repo, "worker/testdata/pdf-fixtures");
for (const name of readdirPdf(fixtures)) add("repo-pdf-fixtures", path.basename(name, ".pdf"), path.join(fixtures, name), { kind: "repo-fixture", reference: null });
function readdirPdf(dir) { return execFileSync("ls", [dir], { encoding: "utf8" }).split("\n").filter((n) => n.endsWith(".pdf")).sort(); }

// 4-6. pdfust development subsets: first case per class/family by sorted id.
const firstPer = (list, key, filter = () => true) => { const seen = new Map(); for (const e of list) { const k = key(e); if (filter(e) && !seen.has(k)) seen.set(k, e); } return [...seen.values()]; };
const pdfust = path.join(evals, "pdfust-dev-v1");
const pick = (subset, list, kind) => { for (const e of list) add(`pdfust-${subset}`, e.id, path.join(pdfust, subset, e.asset.path), { kind, documentClass: e.documentClass, tags: e.tags ?? [], reference: e.reference ? path.join(pdfust, subset, e.reference.path) : null }); };
pick("wild-v1", firstPer([...dev(path.join(pdfust, "wild-v1"))].sort((a, b) => b.pages - a.pages || a.id.localeCompare(b.id)), (e) => e.documentClass), "native-business");
pick("wild-v1-raster", firstPer(dev(path.join(pdfust, "wild-v1-raster")), (e) => e.documentClass, (e) => e.id.endsWith("R03_150dpi")).slice(0, 5), "scan");
pick("wild-v1-quirks", firstPer(dev(path.join(pdfust, "wild-v1-quirks")), (e) => e.documentClass), "quirk");

// 7. Standalone images rasterized from development scan and raster pages (gold references reused).
const imageSources = [
  ...dev(routing).filter((e) => e.tags.includes("no-text-layer")).map((e) => ({ src: "routing-suite-v1", e, dir: routing, fmt: "png" })),
  ...dev(preservation).filter((e) => e.tags.includes("clean") && e.tags.includes("raster-only")).slice(0, 2).map((e) => ({ src: "preservation-suite-95-v3", e, dir: preservation, fmt: "jpeg" })),
];
for (const { src, e, dir, fmt } of imageSources) {
  const prefix = path.join(out, "files", `image__${src}__${e.id}`);
  execFileSync("pdftoppm", ["-r", "150", "-singlefile", fmt === "png" ? "-png" : "-jpeg", path.join(dir, e.asset.path), prefix]);
  const file = `${prefix}.${fmt === "png" ? "png" : "jpg"}`;
  items.push({ source: `image-from-${src}`, id: e.id, file: path.basename(file), sha256: sha(file), pages: 1, kind: "image", documentClass: e.documentClass, tags: e.tags, reference: e.reference ? path.join(dir, e.reference.path) : null });
}

const manifest = { schema: "router-e2e-corpus@v1", rule: "development splits only; deterministic sorted selection; no held-out or test items", documents: items.length, pages: items.reduce((n, i) => n + i.pages, 0), byKind: Object.fromEntries([...new Set(items.map((i) => i.kind))].map((k) => [k, { documents: items.filter((i) => i.kind === k).length, pages: items.filter((i) => i.kind === k).reduce((n, i) => n + i.pages, 0) }])), items };
writeFileSync(path.join(out, "corpus.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ documents: manifest.documents, pages: manifest.pages, byKind: manifest.byKind }, null, 2));
