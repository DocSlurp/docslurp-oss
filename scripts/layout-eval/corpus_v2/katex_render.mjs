#!/usr/bin/env node
// Typeset one LaTeX expression with KaTeX into a standalone HTML page for headless Chromium capture.
// Usage: node katex_render.mjs <katex-package-dir> <latex> <display:0|1> <font-px> <ink> <background> <out.html>
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [katexDir, latex, display, fontPx, ink, background, out] = process.argv.slice(2);
if (!out) throw new Error('expected 7 arguments');
const require = createRequire(join(katexDir, 'package.json'));
const katex = require(katexDir);
const html = katex.renderToString(latex, { displayMode: display === '1', throwOnError: true, output: 'html', strict: 'error' });
const css = pathToFileURL(join(katexDir, 'dist', 'katex.min.css')).href;
writeFileSync(out, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${css}">
<style>html,body{margin:0;background:${background};}#m{display:inline-block;padding:24px;color:${ink};font-size:${Number(fontPx)}px;}
.katex-display{margin:0}</style></head><body><div id="m">${html}</div></body></html>`);
console.log(JSON.stringify({ katex: katex.version }));
