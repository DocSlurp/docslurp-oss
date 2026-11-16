// The chart-export guest bundle's location, budget and staleness check, shared by the build step
// (bundle-chart-guest.mjs), the parser-VM startup contract (parser-vm-contract.mjs) and the worker prerequisites check.
// Reads only trusted build output, never customer bytes.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WORKER_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const BUNDLE_PATH = path.join(WORKER_ROOT, "dist/chart-export/guest.bundle.mjs");
export const INPUTS_PATH = path.join(WORKER_ROOT, "dist/chart-export/guest.bundle.inputs.json");
/** About 0.93 MB today; the shared package index alone would add far more. */
export const BUNDLE_MAX_BYTES = 1_250_000;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * Where to read a bundle input from, relative to the worker root, in a checkout and in the images alike: the worker's
 * own dist, and @docslurp/shared through the worker's node_modules (a workspace link here, a deployed copy in the
 * lean/full images). zod is not re-read: it is a transitive dependency at a different path after `pnpm deploy`, so a
 * startup check could refuse a good image. Its version is recorded for diagnosis; a zod change comes only with a lockfile
 * change, which rebuilds every image, and the bundle hash below still catches a swapped bundle.
 */
function sourceOf(input) {
  if (/^dist\/[\w/.-]+\.js$/.test(input) && !input.includes("..")) return { file: input };
  const shared = /^\.\.\/packages\/shared\/(dist\/[\w.-]+\.js)$/.exec(input);
  if (shared) return { file: `node_modules/@docslurp/shared/${shared[1]}` };
  if (/(^|\/)node_modules\/(\.pnpm\/zod@[^/]+\/node_modules\/)?zod\//.test(input)) return { zod: true };
  throw new Error(`chart guest bundle: unexpected input ${input}`);
}

/** Hashes of every worker and @docslurp/shared input, the zod version (recorded only), and the bundle's own SHA-256. */
export async function bundleManifest(inputs) {
  const files = [...new Set(inputs.map(sourceOf).filter((s) => s.file).map((s) => s.file))].sort();
  const hashes = {};
  for (const file of files) hashes[file] = sha256(await readFile(path.join(WORKER_ROOT, file)));
  const zod = [...new Set(inputs.map((i) => /zod@([^/]+)\//.exec(i)?.[1]).filter(Boolean))];
  return { inputs: hashes, zod, bundleSha256: sha256(await readFile(BUNDLE_PATH)) };
}

/** Throws when the bundle is missing, was changed, or was built from inputs that have since changed. */
export async function verifyChartGuestBundle() {
  const bundle = await readFile(BUNDLE_PATH).catch(() => { throw new Error(`chart guest bundle missing: ${BUNDLE_PATH} (run the worker build)`); });
  const manifest = JSON.parse(await readFile(INPUTS_PATH, "utf8").catch(() => { throw new Error(`chart guest bundle manifest missing: ${INPUTS_PATH} (run the worker build)`); }));
  const entries = Object.entries(manifest?.inputs ?? {});
  const known = (file) => /^(dist|node_modules\/@docslurp\/shared\/dist)\/[\w/.-]+\.js$/.test(file) && !file.includes("..");
  if (!entries.length || !entries.every(([file, hash]) => known(file) && typeof hash === "string") || typeof manifest.bundleSha256 !== "string") {
    throw new Error("chart guest bundle manifest is malformed");
  }
  if (sha256(bundle) !== manifest.bundleSha256) throw new Error("chart guest bundle is not the one its manifest describes (rebuild the worker)");
  for (const [file, hash] of entries) {
    const actual = await readFile(path.join(WORKER_ROOT, file)).then(sha256, () => null);
    if (actual !== hash) throw new Error(`chart guest bundle is stale: ${file} changed after it was built (run the full worker build)`);
  }
}

// Startup probe inputs (trusted, built in): a 2-category bar chart as SVG and as an XLSX chart part. Generated with the
// test fixtures in src/chart-export/extractors/__tests__/fixtures.ts:
//   genericBar(["A", "B", "C"], [1, 2, 3], 4)
//   xlsx("S", [["q", "v"], ["A", 1], ["B", 2]], chartXml({ plots: [barPlot([{ name: "v", cats: ["A", "B"], vals: [1, 2] }])] }))
const PROBE_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"400\" height=\"260\" viewBox=\"0 0 400 260\"><g><rect x=\"65\" y=\"170\" width=\"70\" height=\"50\" fill=\"#e45756\"/><rect x=\"165\" y=\"120\" width=\"70\" height=\"100\" fill=\"#e45756\"/><rect x=\"265\" y=\"70\" width=\"70\" height=\"150\" fill=\"#e45756\"/></g><line x1=\"50\" y1=\"220\" x2=\"350\" y2=\"220\" stroke=\"black\"/><text x=\"44\" y=\"220\" text-anchor=\"end\" dominant-baseline=\"middle\" font-size=\"10\">0</text><text x=\"44\" y=\"170\" text-anchor=\"end\" dominant-baseline=\"middle\" font-size=\"10\">1</text><text x=\"44\" y=\"120\" text-anchor=\"end\" dominant-baseline=\"middle\" font-size=\"10\">2</text><text x=\"44\" y=\"70\" text-anchor=\"end\" dominant-baseline=\"middle\" font-size=\"10\">3</text><text x=\"44\" y=\"20\" text-anchor=\"end\" dominant-baseline=\"middle\" font-size=\"10\">4</text><text x=\"100\" y=\"234\" text-anchor=\"middle\" font-size=\"10\">A</text><text x=\"200\" y=\"234\" text-anchor=\"middle\" font-size=\"10\">B</text><text x=\"300\" y=\"234\" text-anchor=\"middle\" font-size=\"10\">C</text></svg>";
const PROBE_XLSX_BASE64 =
  "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";

/**
 * Imports the bundle and runs one SVG and one XLSX through it, so a bundle that throws at import, resolves a dependency
 * differently or extracts nothing is refused at startup instead of failing every chart document. Throws on mismatch.
 */
export async function probeChartGuestBundle() {
  const guest = await import(pathToFileURL(BUNDLE_PATH).href);
  const svg = guest.extractDeterministicVisuals({ kind: "svg", text: PROBE_SVG });
  const office = guest.extractDeterministicVisuals({ kind: "office", bytes: new Uint8Array(Buffer.from(PROBE_XLSX_BASE64, "base64")) });
  const got = [...svg.visuals, ...office.visuals].map((v) => `${v.source}:${v.spec?.chartType ?? "none"}`).join(",");
  if (got !== "svg-geometry:bar,office-chart-xml:bar" || svg.refusals.length || office.refusals.length) {
    throw new Error(`chart guest bundle probe failed: ${got || "no visuals"}`);
  }
  if (!(guest.CHART_EXTRACT_LIMITS?.maxTextBytes > 0)) throw new Error("chart guest bundle probe failed: no limits export");
  // The production bundle carries no fault hooks (a build-time constant; council r9 L3).
  if (guest.testHooks !== null) throw new Error("chart guest bundle probe failed: test hooks are enabled");
}

// ---- Compile cache --------------------------------------------------------------------------------------------------
// A V8 compile cache for the bundle, built at image build time with the image's own Node (builder and runtime stages pin
// the same node image digest) and read, never written, by the inline chart worker in the VM. Node checks each entry
// against the source and its own version, so a mismatch only loses the speed-up; the key file lets the startup contract
// refuse an image whose cache was built for another Node or bundle.
export const COMPILE_CACHE_DIR = path.join(WORKER_ROOT, "dist/chart-export/compile-cache");
const COMPILE_CACHE_KEY = path.join(COMPILE_CACHE_DIR, "key.json");

async function fileSha256(file) {
  const hash = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function compileCacheKey() {
  return { node: process.version, nodeSha256: await fileSha256(process.execPath), bundleSha256: await fileSha256(BUNDLE_PATH) };
}

/**
 * Populate the cache the way the guest loads it: a worker thread (as #364's unit workers) enables the cache, loads
 * #364's worker script and the bundle, flushes, and exits, under the guest's V8 flag (a code cache built under other
 * flags is rejected). V8 keys the cache directory by Node version, flags and uid, so at image build (as root) it is
 * filled as the parser user (PARSER_UID, the uid the parser VM runs commands as) and then handed back to root, read-only:
 * the inline path uses it only read-only (chart-inline.mjs readOnlyCompileCache). Not root: filled as the current user.
 */
/** The uid the parser VM runs commands as (sandbox/providers/modal: uid 10001). */
export const PARSER_UID = 10001;
export async function buildCompileCache() {
  const { rm, mkdir, writeFile, mkdtemp, chown, chmod, readdir } = await import("node:fs/promises");
  const asRoot = process.getuid?.() === 0;
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  await rm(COMPILE_CACHE_DIR, { recursive: true, force: true });
  await mkdir(COMPILE_CACHE_DIR, { recursive: true });
  const scratch = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "chart-cache-"));
  try {
    const filler = path.join(scratch, "fill.mjs");
    const main = path.join(scratch, "main.mjs");
    await writeFile(filler, `import module from "node:module";
module.enableCompileCache(${JSON.stringify(COMPILE_CACHE_DIR)});
await import(${JSON.stringify(pathToFileURL(path.join(WORKER_ROOT, "scripts/chart-export-worker.mjs")).href)});
module.flushCompileCache();
process.exit(0);
`);
    await writeFile(main, `import { Worker } from "node:worker_threads";
await new Promise((resolve, reject) => {
  const w = new Worker(new URL(${JSON.stringify(pathToFileURL(filler).href)}), { env: {} });
  w.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("worker exit " + code)))); w.once("error", reject);
});
`);
    if (asRoot) {
      await chown(COMPILE_CACHE_DIR, PARSER_UID, PARSER_UID);
      await chmod(scratch, 0o755);
    }
    const run = spawnSync(process.execPath, ["--disallow-code-generation-from-strings", main], { encoding: "utf8", ...(asRoot ? { uid: PARSER_UID, gid: PARSER_UID } : {}) });
    if (run.status !== 0) throw new Error(`chart guest compile cache: ${run.stderr.slice(0, 500)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await writeFile(COMPILE_CACHE_KEY, `${JSON.stringify(await compileCacheKey(), null, 2)}\n`);
  if (asRoot) {
    // Back to root, read-only: no run can write what another document's run will load (#364 council r10).
    const walk = async (dir) => {
      await chown(dir, 0, 0);
      await chmod(dir, 0o555);
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else { await chown(p, 0, 0); await chmod(p, 0o444); }
      }
    };
    await walk(COMPILE_CACHE_DIR);
  }
}

/** Startup contract: an image that ships a cache must ship one built for this Node binary and this bundle. */
export async function verifyCompileCache() {
  const raw = await readFile(COMPILE_CACHE_KEY, "utf8").catch(() => null);
  if (raw === null) return { present: false };
  const want = JSON.parse(raw);
  const have = await compileCacheKey();
  for (const k of ["node", "nodeSha256", "bundleSha256"]) {
    if (want[k] !== have[k]) throw new Error(`chart guest compile cache was built for another ${k} (rebuild the image)`);
  }
  return { present: true };
}

/**
 * Runs the real quarantine guest (scripts/quarantine-inspect.mjs, which loads scripts/chart-inline.mjs,
 * dist/chart-export/inline-guest.js and a worker thread) on the built-in SVG, exactly as the host runs it: a fresh
 * `node --disallow-code-generation-from-strings` process. A missing, stale or broken module, or one that needs code
 * generation from strings, fails the image at startup instead of turning every chart answer into a refusal.
 */
export async function probeInlineCharts() {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const dir = await mkdtemp(path.join(tmpdir(), "chart-inline-probe-"));
  try {
    const input = path.join(dir, "probe.svg");
    const options = path.join(dir, "options.json");
    const output = path.join(dir, "out.json");
    await writeFile(input, PROBE_SVG);
    await writeFile(options, JSON.stringify({ filename: "probe.svg", charts: { kind: "svg", diagrams: true }, policy: {
      quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 10, quarantineMaxArchiveDepth: 2,
      quarantineMaxTotalUncompressedBytes: 1 << 20, quarantineMaxSingleEntryBytes: 1 << 20, quarantineMaxExpansionRatio: 10,
    } }));
    const run = spawnSync(process.execPath, ["--disallow-code-generation-from-strings", path.join(WORKER_ROOT, "scripts/quarantine-inspect.mjs"), input, options, output], { encoding: "utf8", timeout: 60_000 });
    if (run.status !== 0) throw new Error("inline chart probe failed: the quarantine guest exited " + run.status);
    const answer = JSON.parse(await readFile(output, "utf8")).charts;
    const got = answer?.status === "ok" ? answer.result.visuals.map((v) => `${v.source}:${v.spec?.chartType ?? "none"}`).join(",") : `${answer?.status}:${answer?.reason}`;
    if (got !== "svg-geometry:bar") throw new Error(`inline chart probe failed: ${got || "no visuals"}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
