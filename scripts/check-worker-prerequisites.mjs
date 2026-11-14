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
  lean: ['node', 'python3', 'pandoc', 'pdfinfo', 'pdftotext', 'pdftohtml', 'pdftoppm', 'pdfimages', 'cwebp', 'clamscan', 'clamdscan'],
  test: ['node', 'pandoc', 'pdfinfo', 'pdftotext', 'pdftohtml', 'pdftoppm', 'pdfimages'],
  full: ['node', 'pandoc', 'pdfinfo', 'pdftotext', 'pdftohtml', 'pdftoppm', 'pdfimages', 'cwebp', 'soffice', 'qpdf', 'gs', ...(process.platform === 'linux' ? ['catdoc'] : []), 'unrtf', 'tiffcp', 'xlsx2csv', 'clamscan', 'clamdscan'],
};
if (!Object.hasOwn(profiles, profile) || args.some((arg) => arg !== `--profile=${profile}` && arg !== '--sandbox')) {
  console.error('Usage: node scripts/check-worker-prerequisites.mjs --profile=lean|full|test|routing [--sandbox]');
  process.exit(2);
}
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
for (const name of profile === 'routing' ? [] : ['mammoth', '@lancedb/lancedb']) {
  try {
    await import(require.resolve(name));
  } catch (error) { failures.push(`cannot load Node package ${name}: ${error.message}`); }
}
// Worker images ship Doppler, the default PDF extractor, under DOCSLURP_DOPPLER_BIN_DIR (/usr/lib/doppler/bin, off PATH) and set
// DOCSLURP_DOPPLER_REQUIRED=1: the converter must be there and its pdftotext must be the fork, while pdftotext on PATH stays
// Debian's poppler-utils (no host tool is replaced by the fork).
if ((process.env.DOCSLURP_DOPPLER_REQUIRED ?? '').trim() === '1') {
  const dopplerBin = (process.env.DOCSLURP_DOPPLER_BIN_DIR ?? '').trim() || '/usr/lib/doppler/bin';
  for (const name of ['pdftomarkdown', 'doppler-md', 'pdftotext', 'pdfpagecount']) {
    if (!existsSync(path.join(dopplerBin, name))) failures.push(`missing Doppler executable: ${path.join(dopplerBin, name)}`);
  }
  const forkHelp = spawnSync(path.join(dopplerBin, 'pdftotext'), ['-h'], { encoding: 'utf8', timeout: 30000 });
  if (!`${forkHelp.stdout ?? ''}${forkHelp.stderr ?? ''}`.includes('-wordmeta')) failures.push(`${dopplerBin}/pdftotext is not the Doppler fork`);
  if (await binaryPath('pdftomarkdown')) failures.push('pdftomarkdown is on PATH: Doppler must stay off PATH (DOCSLURP_DOPPLER_BIN_DIR)');
  // The structural page count runs under prlimit (an external address-space and CPU limit around pdfpagecount).
  if (!(await binaryPath('prlimit'))) failures.push('missing prlimit (util-linux): the PDF page count runs under it');
  if (spawnSync(path.join(dopplerBin, 'pdfpagecount'), ['-v'], { timeout: 30000 }).status !== 0) failures.push(`${dopplerBin}/pdfpagecount does not run`);
}
if (profile === 'full' || profile === 'test' || profile === 'lean') {
  // Every image bakes the base parsers into its venv (runtime pip installs are off).
  const python = existsSync(path.join(venv, 'bin/python3')) ? path.join(venv, 'bin/python3') : await binaryPath('python3');
  if (!python) failures.push('missing Python interpreter');
  else {
    // pptx, openpyxl and defusedxml serve the Office extractors (scripts/office_markdown.py).
    const result = spawnSync(python, ['-c', 'import PIL, ebooklib, pptx, openpyxl, defusedxml, trafilatura'], { encoding: 'utf8', timeout: 30000 });
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
}
// OCR runtime (docs/extraction/ocr.md): docslurp_ocr.py in its own venv with sha256-pinned models. Images
// that bake it (Dockerfile.full) and local installs (scripts/install-ocr-runtime.sh) must pass its
// self-test; DOCSLURP_OCR_MODE=local without it fails here instead of at the first scanned page.
if (profile !== 'routing') {
  const ocrPython = process.env.DOCSLURP_OCR_PYTHON || '/opt/docslurp/ocr-venv/bin/python3';
  const ocrModels = process.env.DOCSLURP_OCR_MODEL_DIR || '/opt/docslurp/ocr-models';
  const ocrMode = (process.env.DOCSLURP_OCR_MODE ?? '').trim().toLowerCase();
  if (existsSync(ocrPython) && existsSync(ocrModels)) {
    const cli = path.join(root, 'worker/scripts/docslurp_ocr.py');
    const manifest = path.join(root, 'worker/ocr-models.json');
    const missing = [cli, manifest].filter((file) => !existsSync(file));
    if (missing.length) failures.push(`OCR runtime incomplete: missing ${missing.join(', ')}`);
    else {
      const result = spawnSync(ocrPython, ['-I', cli, '--self-test', '--models', ocrModels, '--manifest', manifest], { encoding: 'utf8', timeout: 120000 });
      if (result.status !== 0) {
        const detail = result.error?.message || (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ') || `exit ${result.status}`;
        failures.push(`OCR self-test failed (${ocrPython}, models ${ocrModels}): ${detail}`);
      }
    }
  } else if (ocrMode === 'local') {
    failures.push(`DOCSLURP_OCR_MODE=local needs the OCR venv (DOCSLURP_OCR_PYTHON=${ocrPython}) and models (DOCSLURP_OCR_MODEL_DIR=${ocrModels}); run scripts/install-ocr-runtime.sh`);
  }
  // Local OCR parses customer bytes on the worker host: only customer-owned self-hosting may choose it.
  if (ocrMode === 'local' && (process.env.DOCSLURP_SERVICE_PROFILE ?? '').trim().toLowerCase() !== 'self-hosted') {
    failures.push('DOCSLURP_OCR_MODE=local requires DOCSLURP_SERVICE_PROFILE=self-hosted');
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
// The parser-VM chart guest runs worker/dist/chart-export/guest.bundle.mjs. A `tsc`-only rebuild leaves it stale (or, on a
// dist from before the bundle, missing), and every chart document would then run old code or fail in the guest.
if (existsSync(path.join(root, 'worker/dist/chart-export/extractors/index.js'))) {
  try {
    const { verifyChartGuestBundle } = await import(path.join(root, 'worker/scripts/chart-guest-bundle.mjs'));
    await verifyChartGuestBundle();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}
for (const failure of failures) console.error(`[worker-prerequisites] ${failure}`);
console.log(`[worker-prerequisites] profile=${profile} status=${failures.length ? 'failed' : 'ready'} missing=${failures.length}`);
process.exitCode = failures.length ? 1 : 0;
