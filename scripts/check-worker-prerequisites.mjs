#!/usr/bin/env node
import { constants, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const profile = args.find((arg) => arg.startsWith('--profile='))?.split('=')[1] ?? 'full';
const profiles = {
  routing: ['node'],
  lean: ['node', 'python3', 'pandoc', 'pdfinfo', 'pdftotext', 'pdftohtml', 'pdftoppm', 'pdfimages', 'clamscan', 'clamdscan'],
  test: ['node', 'pandoc', 'pdfinfo', 'pdftotext', 'pdftohtml', 'pdftoppm', 'pdfimages', 'tesseract'],
  full: ['node', 'pandoc', 'pdfinfo', 'pdftotext', 'pdftohtml', 'pdftoppm', 'pdfimages', 'tesseract', 'soffice', 'qpdf', 'gs', 'ocrmypdf', ...(process.platform === 'linux' ? ['catdoc'] : []), 'unrtf', 'tiffcp', 'xlsx2csv', 'clamscan', 'clamdscan'],
};
if (!Object.hasOwn(profiles, profile) || args.some((arg) => arg !== `--profile=${profile}` && arg !== '--sandbox')) {
  console.error('Usage: node scripts/check-worker-prerequisites.mjs --profile=lean|full|test|routing [--sandbox]');
  process.exit(2);
}
const failures = [];
const paths = (process.env.PATH ?? '').split(path.delimiter);
const venv = path.resolve(process.env.PYTHON_VENV || process.env.DOCSLURP_WORKER_VENV || path.join(root, '.venv'));
paths.unshift(path.join(venv, 'bin'));
async function binaryPath(name) {
  for (const directory of paths) {
    const candidate = path.join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* try next directory */ }
  }
}
for (const name of profiles[profile]) {
  if (!await binaryPath(name)) failures.push(`missing executable: ${name}`);
}
const require = createRequire(path.join(root, 'worker/package.json'));
for (const name of profile === 'routing' ? ['@llamaindex/liteparse'] : ['@kreuzberg/node', '@llamaindex/liteparse', 'mammoth', '@lancedb/lancedb']) {
  try {
    const module = await import(require.resolve(name));
    // Kreuzberg loads native bindings lazily; import alone misses ABI failures.
    if (name === '@kreuzberg/node') {
      const result = await module.extractBytes(Buffer.from('Parser startup check.'), 'text/plain');
      if (!result.content?.includes('Parser startup check.')) throw new Error('native extraction returned no text');
    }
  } catch (error) { failures.push(`cannot load Node package ${name}: ${error.message}`); }
}
if (profile === 'full' || profile === 'test' || profile === 'lean') {
  // Every image bakes the base parsers into its venv (runtime pip installs are off).
  const python = existsSync(path.join(venv, 'bin/python3')) ? path.join(venv, 'bin/python3') : await binaryPath('python3');
  if (!python) failures.push('missing Python interpreter');
  else {
    const result = spawnSync(python, ['-c', 'import PIL, ebooklib, pptx, openpyxl, trafilatura'], { encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) failures.push(`Python parser imports failed (${python}): ${result.error?.message || result.stderr.trim()}`);
  }
  const tesseract = await binaryPath('tesseract');
  if (tesseract) {
    const result = spawnSync(tesseract, ['--list-langs'], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0 || !/^eng\r?$/m.test(result.stdout)) failures.push('Tesseract English language data (eng) unavailable');
  }
}
if (args.includes('--sandbox')) {
  // The compiled probe CLI checks whichever provider DOCSLURP_PARSER_SANDBOX selects.
  const probe = path.join(root, 'worker/dist/sandbox/probe-cli.js');
  if (!existsSync(probe)) failures.push(`parser isolation unavailable: sandbox probe not built (${probe})`);
  else {
    const result = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30000, env: process.env });
    if (result.status !== 0) failures.push(`parser isolation unavailable: ${result.error?.message || result.stdout.trim() || result.stderr.trim()}`);
  }
}
for (const failure of failures) console.error(`[worker-prerequisites] ${failure}`);
console.log(`[worker-prerequisites] profile=${profile} status=${failures.length ? 'failed' : 'ready'} missing=${failures.length}`);
process.exitCode = failures.length ? 1 : 0;
