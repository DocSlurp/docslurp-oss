import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function docFilename(path) { return `docslurp-docs-${Buffer.from(path).toString('base64url')}.html`; }
/**
 * Cloudflare Email Obfuscation rewrites addresses with a random key on every
 * request, so a crawled page differed each time (forcing a re-index) and the
 * index held "[email protected]". Decode them back to the address.
 */
export function decodeCloudflareEmails(html) {
  const decode = (hex) => {
    if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  };
  return html
    .replace(/<a\b[^>]*\bdata-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/a>/gi, (match, hex) => decode(hex) ?? match)
    .replace(/<span\b[^>]*\bdata-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/span>/gi, (match, hex) => decode(hex) ?? match)
    .replace(/href="\/cdn-cgi\/l\/email-protection#([0-9a-f]+)"/gi, (match, hex) => { const email = decode(hex); return email ? `href="mailto:${email}"` : match; });
}

export function extractDoc(html) {
  html = decodeCloudflareEmails(html);
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (!main) throw new Error('Docs page has no main content');
  // `data-search-exclude` marks boilerplate repeated across pages (step numbers, agent handoffs).
  const content = main.replace(/<(script|style|nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<([a-z][a-z0-9-]*)\b[^>]*\bdata-search-exclude\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<docslurp-docs-search\b[^>]*>[\s\S]*?<\/docslurp-docs-search>/gi, '');
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? 'Documentation';
  return { title, html: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main>${content}</main></body></html>` };
}

const DOCS_ROUTE = /^\/docs(?:\/[a-z0-9-]+)*$/;

/**
 * Crawl a deployed site's docs routes (for indexing after a deploy, when the
 * build had no API key). Only the given routes on the site's own origin are
 * fetched; redirects are refused so a page can't pull in another host.
 */
export async function crawlDocs({ site, routes }, fetchImpl = fetch) {
  const origin = new URL(site).origin;
  const corpus = [];
  for (const path of [...new Set(routes)].sort()) {
    if (!DOCS_ROUTE.test(path)) throw new Error(`Invalid docs route: ${path}`);
    const response = await fetchImpl(`${origin}${path}`, { redirect: 'manual', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(30_000) });
    if (response.status !== 200) throw new Error(`Fetch ${path}: HTTP ${response.status}`);
    corpus.push({ path, filename: docFilename(path), canonicalId: `${origin}${path}`, ...extractDoc(await response.text()) });
  }
  return corpus;
}

/**
 * Rendered HTML docs need text, not page images or vision rescue: faster,
 * cheaper, fewer moving parts. Per-page summaries help search and chat.
 */
export const DEFAULT_DOCS_PIPELINE = Object.freeze({ visionFallback: false, preserveImages: false, summarize: true });

/**
 * Uploads the rendered corpus into `workspace` (ID, slug or name): the server
 * finds it, or creates a workspace with that name on the first build, so
 * repeated builds keep landing in the same one.
 */
export async function indexDocs(corpus, { apiUrl, workspace = 'DocSlurp documentation', pipeline = DEFAULT_DOCS_PIPELINE }, apiKey, fetchImpl = fetch) {
  const base = apiUrl.replace(/\/$/, '');
  const request = async (path, init = {}) => {
    const response = await fetchImpl(`${base}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`DocSlurp ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const form = new FormData();
  const canonicalIds = [];
  for (const doc of corpus) {
    form.append('files', new Blob([doc.html], { type: 'text/html' }), doc.filename);
    canonicalIds.push(doc.canonicalId);
  }
  form.set('canonicalIds', JSON.stringify(canonicalIds));
  if (pipeline) form.set('pipeline', JSON.stringify(pipeline));
  form.set('workspace', workspace);
  const hash = createHash('sha256').update(JSON.stringify({ target: workspace, corpus, pipeline: pipeline ?? null })).digest('hex');
  const result = await request('/v1/uploads/bulk', { method: 'POST', headers: { 'Idempotency-Key': `docs-${hash}` }, body: form });
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const { run } = await request(`/v1/runs/${encodeURIComponent(result.run.id)}/progress`);
    if (run.status === 'completed') return { workspaceId: result.workspace.id, runId: run.id };
    if (['failed', 'cancelled'].includes(run.status)) throw new Error(`Docs ingestion ${run.status}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Docs indexing timed out after 10 minutes; inspect the run before retrying');
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => args[args.indexOf(name) + 1];
  const options = { apiUrl: process.env.DOCSLURP_URL ?? 'https://docslurp.io', workspace: process.env.DOCSLURP_DOCS_WORKSPACE_ID || process.env.PUBLIC_DOCSLURP_DOCS_WORKSPACE_ID || 'DocSlurp documentation', ...(process.env.DOCSLURP_DOCS_PIPELINE ? { pipeline: JSON.parse(process.env.DOCSLURP_DOCS_PIPELINE) } : {}), ...JSON.parse(process.env.DOCSLURP_DOCS_INDEX_OPTIONS ?? '{}') };
  const output = value('--output');
  let corpus;
  if (args.includes('--entry')) {
    const { handler } = await import(pathToFileURL(value('--entry')).href);
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      corpus = [];
      for (const path of [...new Set(options.routes)].sort()) {
        if (!DOCS_ROUTE.test(path)) throw new Error(`Invalid docs route: ${path}`);
        const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { Host: new URL(options.site).host, 'X-Forwarded-Host': new URL(options.site).host, 'X-Forwarded-Proto': 'https' }, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Render ${path}: HTTP ${response.status}`);
        corpus.push({ path, filename: docFilename(path), canonicalId: `${options.site}${path}`, ...extractDoc(await response.text()) });
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(corpus, null, 2));
    console.log(`[docs-index] Rendered ${corpus.length} pages`);
  } else if (args.includes('--site')) {
    // Deployed site: routes from --routes (URL or file with a JSON array), else the options.
    const source = args.includes('--routes') ? value('--routes') : null;
    const routes = source
      ? JSON.parse(/^https?:/.test(source) ? await (await fetch(source, { signal: AbortSignal.timeout(30_000) })).text() : await readFile(source, 'utf8'))
      : options.routes;
    if (!Array.isArray(routes) || !routes.length) throw new Error('No docs routes to crawl');
    corpus = await crawlDocs({ site: value('--site'), routes });
    if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(corpus, null, 2)); }
    console.log(`[docs-index] Crawled ${corpus.length} pages from ${new URL(value('--site')).origin}`);
  } else corpus = JSON.parse(await readFile(output, 'utf8'));
  if (!corpus.length) throw new Error('Empty docs corpus');
  const key = process.env.DOCSLURP_API_KEY?.trim();
  if (key) {
    const indexed = await indexDocs(corpus, options, key);
    console.log('[docs-index]', indexed);
    if (args.includes('--public-config')) await writeFile(value('--public-config'), JSON.stringify({ workspace: indexed.workspaceId }));
  }
  else {
    console.log('[docs-index] No API key; remote indexing skipped');
    if (args.includes('--public-config')) await writeFile(value('--public-config'), JSON.stringify({ workspace: options.workspace ?? null }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
}
