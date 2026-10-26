#!/usr/bin/env node
import { constants, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
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
// Tesseract languages the full image must ship (Debian tesseract-ocr-<lang> packages).
const FULL_TESSERACT_LANGS = ['eng', 'deu', 'fra', 'spa', 'ara', 'chi_sim', 'chi_tra', 'ell', 'heb', 'hin', 'ita', 'jpn', 'kor', 'nld', 'pol', 'por', 'rus', 'tha', 'tur', 'ukr', 'vie'];
const failures = [];
const paths = (process.env.PATH ?? '').split(path.delimiter);
const venv = path.resolve(process.env.PYTHON_VENV || process.env.DOCSLURP_WORKER_VENV || path.join(root, '.venv'));
paths.unshift(path.join(venv, 'bin'));
/** One-page PDF in a non-embedded Adobe-GB1 font with the predefined UniGB-UCS2-H CMap and no ToUnicode. */
function cmapProbePdf() {
  const stream = 'BT /F1 24 Tf 10 40 Td <4E2D6587> Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 7 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
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
  // Poppler needs poppler-data's predefined CMaps (UniGB-UCS2-H, UniCNS-UCS2-H, ...) to map CJK CID fonts
  // without a usable ToUnicode; without them pdftotext silently drops that text.
  const pdftotext = await binaryPath('pdftotext');
  if (pdftotext) {
    let dir;
    try {
      dir = mkdtempSync(path.join(os.tmpdir(), 'docslurp-cmap-probe-'));
      writeFileSync(path.join(dir, 'probe.pdf'), cmapProbePdf());
      const result = spawnSync(pdftotext, ['-q', path.join(dir, 'probe.pdf'), '-'], { encoding: 'utf8', timeout: 30000 });
      if (result.error || result.status !== 0) failures.push(`poppler CJK CMap probe could not run pdftotext: ${result.error?.message || `exit ${result.status}`}`);
      else if (!result.stdout.includes('\u4e2d\u6587')) failures.push('poppler CJK CMap data unavailable (install poppler-data): pdftotext lost UniGB-UCS2-H text');
    } catch (error) {
      failures.push(`poppler CJK CMap probe failed: ${error.message}`);
    } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
  }
  const tesseract = await binaryPath('tesseract');
  if (tesseract) {
    const result = spawnSync(tesseract, ['--list-langs'], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0 || !/^eng\r?$/m.test(result.stdout)) failures.push('Tesseract English language data (eng) unavailable');
    // The full image OCRs scripts whose PDF text layers are often unusable (Thai, Arabic, CJK, ...).
    if (profile === 'full' && result.status === 0) {
      const have = new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()));
      const missing = FULL_TESSERACT_LANGS.filter((lang) => !have.has(lang));
      if (missing.length) failures.push(`Tesseract language data unavailable: ${missing.join(', ')}`);
    }
  }
}
if (args.includes('--sandbox')) {
  // The compiled probe CLI checks whichever provider DOCSLURP_PARSER_SANDBOX selects, then runs the real parsers (ffmpeg, pdftoppm, pandoc) inside it.
  const probe = path.join(root, 'worker/dist/sandbox/probe-cli.js');
  if (!existsSync(probe)) failures.push(`parser isolation unavailable: sandbox probe not built (${probe})`);
  else {
    const result = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30000, env: process.env });
    // Exit 2 means the provider works but a real parser binary fails inside it; the CLI prints those lines ready to forward.
    if (result.status === 2) failures.push(...result.stdout.trim().split('\n'));
    else if (result.status !== 0) failures.push(`parser isolation unavailable: ${result.error?.message || result.stdout.trim() || result.stderr.trim()}`);
  }
}
for (const failure of failures) console.error(`[worker-prerequisites] ${failure}`);
console.log(`[worker-prerequisites] profile=${profile} status=${failures.length ? 'failed' : 'ready'} missing=${failures.length}`);
process.exitCode = failures.length ? 1 : 0;
