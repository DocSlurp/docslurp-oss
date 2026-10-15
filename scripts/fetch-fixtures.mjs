#!/usr/bin/env node
// Fetch third-party test fixtures that are not tracked in git (pnpm fixtures:fetch).
// Pins live in worker/testdata/third-party-fixtures.manifest.json. Files land in the gitignored cache
// (<repo>/.cache/fixtures/pdf, or $DOCSLURP_CACHE_DIR/fixtures/pdf), verified by size + sha256.
//
//   node scripts/fetch-fixtures.mjs [--only substr,substr] [--check] [--remote] [--force] [--base-url URL]
//
// source=upstream        download from the pinned public url.
// source=derived         build from another fixture with the named tool (qpdf page range); only the page
//                        count is verified because the output is not byte-reproducible.
// source=private-mirror  signed GET of the content-addressed `mirrorKey` from the private S3 bucket
//                        (DOCSLURP_ASSET_MIRROR=s3://bucket + DOCSLURP_ASSET_S3_ENDPOINT/_REGION/
//                        _ACCESS_KEY_ID/_SECRET_ACCESS_KEY, the read-only key); skipped with a "private
//                        asset, not available" notice when unset. DOCSLURP_FIXTURE_BASE_URL (plain HTTP) is
//                        a legacy fallback. Upstream files also fall back to the mirror if their url fails.
// source=derived with mirrorKey: fetched from the mirror when configured (byte-exact), else built with qpdf.
// --check   offline: exit 1 if a selected fixture is missing or invalid. Tests use `resolveFixture()`
//           to skip with a clear message instead.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MIRROR_HELP, assetMirrorConfig, cacheRoot, downloadFromMirror, downloadVerified, headCheck, headMirror, inspectFile, mirrorBase, repoRoot } from "./lib/pinned-assets.mjs";

export const FIXTURE_MANIFEST_PATH = path.join(repoRoot, "worker", "testdata", "third-party-fixtures.manifest.json");

export async function loadFixtureManifest(manifestPath = FIXTURE_MANIFEST_PATH) {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

export function fixtureCacheDir(manifest, root = cacheRoot()) {
  return path.join(root, manifest.dir);
}

/** Absolute cache path of a fixture key, or undefined when it has not been fetched. */
export function resolveFixture(key, { manifest, root = cacheRoot() } = {}) {
  const target = path.join(path.join(root, manifest?.dir ?? "fixtures/pdf"), key);
  return existsSync(target) ? target : undefined;
}

function pageCount(file) {
  const result = spawnSync("qpdf", ["--show-npages", file], { encoding: "utf8" });
  return result.status === 0 ? Number(result.stdout.trim()) : NaN;
}

async function derive(key, entry, dir, { force, mirror, s3Factory }) {
  const target = path.join(dir, key);
  if (existsSync(target) && !force) return "ok";
  if (mirror && entry.mirrorKey && entry.sha256) {
    await downloadFromMirror(mirror, entry.mirrorKey, target, entry, { s3Factory });
    return "built";
  }
  const source = path.join(dir, entry.derive.from);
  if (!existsSync(source)) throw new Error(`${key}: derive source ${entry.derive.from} is not fetched yet`);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.part`;
  const run = spawnSync(entry.derive.tool, [source, "--pages", ".", entry.derive.pages, "--", tmp], { encoding: "utf8" });
  if (run.error || (run.status !== 0 && run.status !== 3)) { await rm(tmp, { force: true }); throw new Error(`${key}: ${entry.derive.tool} failed: ${run.error?.message ?? run.stderr}`); }
  const pages = pageCount(tmp);
  if (pages !== entry.derive.expectPages) { await rm(tmp, { force: true }); throw new Error(`${key}: derived ${pages} pages, expected ${entry.derive.expectPages}`); }
  await rename(tmp, target);
  return "built";
}

export async function ensureFixtures({ manifest, root = cacheRoot(), only, baseUrl, force = false, check = false, remote = false, fetchImpl = fetch, env = process.env, s3Factory } = {}) {
  manifest ??= await loadFixtureManifest();
  const dir = fixtureCacheDir(manifest, root);
  const mirror = assetMirrorConfig(env);
  const keys = Object.keys(manifest.files).filter((key) => !only?.length || only.some((s) => key.includes(s)));
  const summary = { ok: [], fetched: [], skipped: [], failed: [] };
  // Upstream files first so derived files find their source.
  const ordered = [...keys].sort((a, b) => (manifest.files[a].source === "derived") - (manifest.files[b].source === "derived"));
  for (const key of ordered) {
    const entry = manifest.files[key];
    const target = path.join(dir, key);
    try {
      if (entry.source === "derived") {
        if (check) { if (!existsSync(target)) throw new Error("missing"); summary.ok.push(key); continue; }
        if (remote) { summary.skipped.push(`${key} (derived)`); continue; }
        const result = await derive(key, entry, dir, { force, mirror, s3Factory });
        (result === "built" ? summary.fetched : summary.ok).push(key);
        continue;
      }
      const legacyBase = mirrorBase(baseUrl, env, manifest.privateMirror?.envBaseUrl);
      const viaMirror = Boolean(mirror && entry.mirrorKey);
      if (!entry.url && !viaMirror && !legacyBase) { summary.skipped.push(`${key} (${MIRROR_HELP})`); continue; }
      const url = entry.url ?? (legacyBase && !viaMirror ? `${legacyBase}/${key.split("/").map(encodeURIComponent).join("/")}` : undefined);
      if (remote) {
        const result = url ? await headCheck(url, entry, { fetchImpl }) : await headMirror(mirror, entry.mirrorKey, entry, { s3Factory });
        if (!result.ok && url && viaMirror) {
          const fallback = await headMirror(mirror, entry.mirrorKey, entry, { s3Factory });
          if (fallback.ok) { console.error(`[fetch-fixtures] ${key} upstream ${result.detail}; mirror ${fallback.detail}`); summary.ok.push(key); continue; }
        }
        if (!result.ok) throw new Error(result.detail);
        console.error(`[fetch-fixtures] ${key} ${result.detail}`);
        summary.ok.push(key);
        continue;
      }
      const state = await inspectFile(target, entry);
      if (state.state === "ok") { summary.ok.push(key); continue; }
      if (state.state === "corrupt" && !force) throw new Error(`cached file invalid (${state.reason}); delete it or pass --force`);
      if (check) throw new Error(state.state);
      let origin = url ? "upstream" : "mirror";
      if (url) {
        try { await downloadVerified(url, target, entry, { fetchImpl }); }
        catch (error) {
          if (!viaMirror) throw error;
          console.error(`[fetch-fixtures] ${key} upstream failed (${error.message}); trying the private mirror`);
          await downloadFromMirror(mirror, entry.mirrorKey, target, entry, { s3Factory });
          origin = "mirror";
        }
      } else {
        await downloadFromMirror(mirror, entry.mirrorKey, target, entry, { s3Factory });
      }
      console.error(`[fetch-fixtures] ${key} ok (${entry.size} bytes, ${origin})`);
      summary.fetched.push(key);
    } catch (error) {
      summary.failed.push(`${key}: ${error.message}`);
    }
  }
  return summary;
}

function parseArgs(argv) {
  const out = { only: undefined, baseUrl: undefined, check: false, remote: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") out.check = true;
    else if (arg === "--remote") out.remote = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--only") out.only = argv[++i]?.split(",").filter(Boolean);
    else if (arg === "--base-url") out.baseUrl = argv[++i];
    else throw new Error(`unknown option ${arg}`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const summary = await ensureFixtures(parseArgs(process.argv.slice(2)));
    console.error(`[fetch-fixtures] ok=${summary.ok.length} fetched=${summary.fetched.length} skipped=${summary.skipped.length} failed=${summary.failed.length}`);
    for (const line of summary.skipped) console.error(`[fetch-fixtures] skipped ${line}`);
    for (const line of summary.failed) console.error(`[fetch-fixtures] FAILED ${line}`);
    process.exit(summary.failed.length ? 1 : 0);
  })().catch((error) => { console.error(`[fetch-fixtures] ${error.message}`); process.exit(1); });
}
